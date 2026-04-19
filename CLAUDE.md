# CLAUDE.md - Claude Engineering Skills

## Project Overview

**Purpose**: A bundle of 6 AI-pair-programming skills covering the full development quality lifecycle — from planning through code audit to live UX testing and shipping.
**Runtime**: Node.js (ESM modules, `"type": "module"`)
**Deployment**: CLI scripts + skill files, invoked by AI coding assistants (Claude Code, Copilot, Cursor, Windsurf)
**Repo**: Renamed from `claude-audit-loop` to `claude-engineering-skills` (Phase E)

## Skill Chain

```
/plan-backend + /plan-frontend   → architecture & UX planning
        ↓
/audit-loop                      → code quality gate (GPT-5.4 + Gemini arbiter)
        ↓
/ux-lock                         → Playwright e2e spec for each fix (locks in DOM contract)
        ↓
deploy to Railway / live URL
        ↓
/persona-test                    → live UX testing as a persona (browser + screenshots)
        ↓
/ship                            → commit + push (with UX P0 warning from persona-test)
```

Each skill is a sibling — they share env vars and Supabase stores but have distinct scopes:
- **plan-***: code that doesn't exist yet. `/plan-frontend` produces a machine-parseable "Section 9 — Acceptance Criteria" that `/ux-lock verify` consumes.
- **audit-loop**: code that was just written (static analysis + LLM audit)
- **ux-lock**: code that was just fixed (Playwright e2e regression lock). **Verify mode** (`/ux-lock verify <plan.md>`) grades a plan-frontend plan against its live implementation — each criterion becomes a Playwright test case; results populate `plan_verification_runs` + `plan_verification_items`.
- **persona-test**: deployed app (live browser, user flows, UX findings)
- **ship**: packaging and delivery

## Browser Tool Setup (persona-test)

`/persona-test` drives a real browser. **Playwright MCP is the preferred tool** — it's free, no credentials needed, works on your own apps.

`.mcp.json` is included in this repo. Claude Code auto-discovers it and prompts you to enable Playwright MCP on first open. Just click **Allow** when prompted.

**First-time setup — install the browser:**
```bash
npx playwright install chromium
```
This is required before the MCP server will start. Without it, the server crashes silently and no tools appear.

**Verify it's working:**
```bash
npx @playwright/mcp@latest --version   # should print a version number
```

**Windows users** — if Playwright tools still don't appear after installing Chromium and restarting, add this override to `~/.claude/settings.json`:
```json
"mcpServers": {
  "playwright": {
    "command": "npx.cmd",
    "args": ["@playwright/mcp@latest", "--headless"]
  }
}
```
Then restart Claude Code. Windows requires `npx.cmd` (the `.cmd` wrapper) rather than bare `npx` for Claude Code's process spawner to resolve it correctly.

BrightData Scraping Browser is also supported (handles anti-bot/CAPTCHA) but requires a paid account and KYC approval. Playwright is preferred for testing your own apps.

---

## Dependencies (CRITICAL — check versions before flagging issues)

| Package | Version | Notes |
|---------|---------|-------|
| `zod` | **4.0.0** | Zod 4 API — NOT Zod 3. `_def.type` is a string (`'object'`, `'array'`, `'enum'`), NOT `_def.typeName` (`'ZodObject'`). `shape` is a direct property on object schemas, NOT `_def.shape()`. `_def.entries` for enums, NOT `_def.values`. |
| `openai` | 6.17.0 | Uses `responses.parse()` with `zodTextFormat()` for structured output |
| `@google/genai` | ^1.47.0 | Google Generative AI SDK. Uses `responseMimeType: 'application/json'` + `responseSchema` for structured output |
| `dotenv` | 17.0.0 | Auto-loads `.env` via `import 'dotenv/config'` |

## Architecture

```
scripts/
├── lib/                    # Focused modules (split from former shared.mjs monolith)
│   ├── schemas.mjs         # Zod schemas + zodToGeminiSchema() — single source of truth
│   ├── file-io.mjs         # Core I/O (atomic writes, paths) + barrel re-exports
│   ├── audit-scope.mjs     # Sensitive file filtering, audit-infra exclusion, context assembly
│   ├── diff-annotation.mjs # Diff parsing, CHANGED/UNCHANGED markers for audit context
│   ├── plan-paths.mjs      # Plan path extraction (regex + fuzzy keyword discovery)
│   ├── ledger.mjs          # Adjudication ledger, R2+ suppression, finding metadata
│   ├── code-analysis.mjs   # Chunking, dependency graphs, audit units, map-reduce
│   ├── context.mjs         # Repo profiling, audit brief generation, CLAUDE.md parsing
│   ├── findings.mjs        # Semantic IDs + barrel re-exports for findings subsystem
│   ├── findings-format.mjs # Finding display formatting (pure renderer)
│   ├── findings-tracker.mjs # FP tracker (v2), lazy-decay EMA, multi-scope counters
│   ├── findings-outcomes.mjs # Outcome logging, effectiveness tracking, EWR
│   ├── findings-tasks.mjs  # Remediation task CRUD + persistence
│   └── config.mjs          # Centralized validated config (all env var reads)
├── shared.mjs              # Barrel re-export — backwards-compatible, imports from lib/
├── openai-audit.mjs        # GPT-5.4 multi-pass auditor (plan, code, rebuttal modes) — links audit_runs to commit_sha + plan_id
├── gemini-review.mjs       # Gemini 3.1 Pro independent final reviewer (Claude Opus fallback)
├── bandit.mjs              # Thompson Sampling + user-impact-aware reward (consumes persona_audit_correlations)
├── learning-store.mjs      # Supabase cloud persistence for audit outcomes + learning + cross-skill data loop
├── cross-skill.mjs         # CLI facade invoked by /ux-lock /persona-test /ship — writes plans, regression_specs, persona_audit_correlations, ship_events
├── refine-prompts.mjs      # LLM-driven prompt refinement from outcome data
└── phase7-check.mjs        # Pre-flight check for Step 7 readiness

tests/                      # Node.js built-in test runner (node --test)
├── shared.test.mjs         # 33 tests: schemas, atomic writes, ledger, FP tracker
└── bandit.test.mjs         # 14 tests: Thompson Sampling, reward computation

.claude/skills/audit-loop/SKILL.md   # Claude Code skill definition
.github/skills/audit-loop/SKILL.md   # VS Code / Copilot skill definition (identical)
```

### Script Responsibilities

- **lib/*.mjs**: Focused modules — import directly from `./lib/<module>.mjs` for explicit deps, or from `./shared.mjs` barrel for convenience. Schemas are the single source of truth (JSON Schemas derived via `zodToGeminiSchema()`).
- **openai-audit.mjs**: 5-pass parallel code audit (structure, wiring, backend, frontend, sustainability). Plan audit. Rebuttal deliberation. Uses GPT-5.4 with `responses.parse()` + Zod schemas. Integrates bandit reward updates + Supabase cloud sync.
- **gemini-review.mjs**: Independent final review (MANDATORY — not gated by convergence). Receives full audit transcript. Detects bias, false consensus, missed issues. Uses Gemini 3.1 Pro (16K thinking budget), with Claude Opus fallback. Claude deliberates on CONCERNS, then Gemini re-verifies.
- **learning-store.mjs**: Cloud persistence via Supabase — repos, runs, findings, pass stats, bandit arms, FP patterns, adjudication events. Graceful fallback to local-only mode.

### Key Patterns

- **Adaptive sizing**: `computePassLimits()` scales token limits and timeouts based on context size
- **Graceful degradation**: `safeCallGPT()` catches failures and returns empty results instead of crashing
- **Semantic dedup**: Content-hash IDs (`semanticId()`) enable exact cross-round and cross-model finding matching
- **Targeted context**: `readProjectContextForPass()` sends only relevant CLAUDE.md sections per pass (~1500 chars vs 8000)
- **Sensitive file filtering**: `.env`, credentials, keys are never sent to external APIs
- **Atomic persistence**: `atomicWriteFileSync()` — temp file + rename for crash-safe writes (ledger, bandit, FP tracker)
- **Fuzzy file discovery**: When plan paths don't match exact filenames, Phase 2 extracts PascalCase/backtick identifiers and matches against repo files
- **Schema validation at boundaries**: `callGemini()` throws on validation failure, `writeLedgerEntry()` validates entries before write
- **Thompson Sampling**: `PromptBandit` — Beta posterior updates from deliberation outcomes, synced to Supabase
- **Closed Gemini loop**: Step 7.1 — Claude deliberates on Gemini findings, fixes, then Gemini re-verifies (not GPT)

### Testing

Run: `npm test` (uses Node.js built-in test runner, 47 tests)
Covers: atomic writes, schema derivation, ledger operations, finding identity, FP tracker, bandit posterior, reward computation.

## Environment Variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `OPENAI_API_KEY` | Yes | — | GPT-5.4 access |
| `GEMINI_API_KEY` | No | — | Gemini final review (Step 7 falls back to Claude Opus if absent) |
| `OPENAI_AUDIT_MODEL` | No | `gpt-5.4` | Override GPT model |
| `OPENAI_AUDIT_REASONING` | No | `high` | Reasoning effort |
| `GEMINI_REVIEW_MODEL` | No | `gemini-3.1-pro-preview` | Override Gemini model |
| `GEMINI_REVIEW_TIMEOUT_MS` | No | `120000` | Gemini timeout |
| `ANTHROPIC_API_KEY` | No | — | Claude Haiku fallback for brief generation |
| `CLAUDE_FINAL_REVIEW_MODEL` | No | `claude-opus-4-1` | Override Claude Opus model for Step 7 fallback |
| `BRIEF_MODEL_GEMINI` | No | `gemini-2.5-flash` | Override brief generation Gemini model |
| `BRIEF_MODEL_CLAUDE` | No | `claude-haiku-4-5-20251001` | Override brief generation Claude model |
| `SUPPRESS_SIMILARITY_THRESHOLD` | No | `0.35` | Jaccard threshold for R2+ suppression (0.0-1.0) |
| `SUPABASE_AUDIT_URL` | No | — | Supabase project URL for audit-loop cloud learning store |
| `SUPABASE_AUDIT_ANON_KEY` | No | — | Supabase anon key for audit-loop (falls back to local-only mode) |
| `AUDIT_STORE` | No | auto | Storage backend: `supabase` (REST), `postgres` (direct — use with dedicated pooler on Pro), `sqlite`, `github`, `noop` |
| `AUDIT_STORE_POSTGRES_URL` | No | — | Direct Postgres URL — use dedicated pooler string from Supabase dashboard → Connect (port 6543, transaction mode) for Pro plan |
| `PERSONA_TEST_SUPABASE_URL` | No | — | Supabase project URL for persona-test session memory |
| `PERSONA_TEST_SUPABASE_ANON_KEY` | No | — | Supabase anon key for persona-test |
| `PERSONA_TEST_APP_URL` | No | — | Default app URL for persona-test list/add (per-project `.env`) |
| `PERSONA_TEST_REPO_NAME` | No | — | Repo name for cross-referencing audit-loop findings (per-project `.env`) |

## Cross-Skill Data Loop

Migration `20260419120000_cross_skill_data_loop.sql` closes the feedback loop
between the 6 skills. Every skill writes to a shared learning store via
`scripts/cross-skill.mjs` — graceful no-op when Supabase is off.

### Tables

| Table | Writer | Reader | Purpose |
|-------|--------|--------|---------|
| `plans` | `/plan-backend`, `/plan-frontend`, `openai-audit.mjs` | `/audit-loop`, `/ux-lock verify` | Register plan artefact, link audit_runs via plan_id |
| `regression_specs` | `/ux-lock`, `/ux-lock verify` | `/ship` | Record every Playwright spec authored (lock or verify mode) |
| `regression_spec_runs` | `/ux-lock`, CI | `meta-assess.mjs` | Per-run pass/fail history — `captured_regression=true` is a "save" |
| `persona_audit_correlations` | `/persona-test` | `bandit.mjs` | The highest-leverage table — persona P0/P1 ↔ audit finding ground-truth labels |
| `ship_events` | `/ship` | Dashboards | Outcome log: shipped / blocked / warned / overridden / aborted |
| `plan_verification_runs` | `/ux-lock verify` | `/ship`, dashboards | One row per verify invocation; totals for satisfaction % |
| `plan_verification_items` | `/ux-lock verify` | `/ship`, meta-assess | Per-criterion pass/fail with stable `criterion_hash` for time-series |

### Added columns

| Column | Table | Writer |
|--------|-------|--------|
| `commit_sha`, `branch`, `plan_id` | `audit_runs` | `openai-audit.mjs` in `runMultiPassCodeAudit` |
| `commit_sha`, `deployment_id` | `persona_test_sessions` | `/persona-test` Phase 6 |

### Views

| View | Query for | Used by |
|------|-----------|---------|
| `audit_effectiveness` | User-visible precision + recall per repo | `meta-assess.mjs` (prompt evolution) |
| `unlocked_fixes` | Recent HIGH fixes without a /ux-lock spec | `/ship` Step 0.5b |
| `regression_saves` | Spec runs that caught a real regression | Dashboards |
| `ship_gate_effectiveness` | How often each block reason fires + override rate | Dashboards |
| `plan_satisfaction` | Latest verify run per plan + failing P0/P1 criteria | `/ship`, `/ux-lock verify` report |
| `persistent_plan_failures` | Criteria that have failed ≥2 consecutive runs | Meta-assess (chronic gaps) |

### Bandit reward extension

`computeReward(resolution, evaluationRecord, userImpact)` — when a
`persona_audit_correlations` row exists for a finding, the reward formula
shifts from 40/30/30 (procedural/substantive/deliberation) to
35/25/25/15 with the user-impact term weighted by persona severity. See
`computeUserImpactReward()` in [scripts/bandit.mjs](scripts/bandit.mjs).

**Design rule**: all cross-skill writes go through `scripts/cross-skill.mjs`.
Never hand-write curl POSTs in a SKILL.md for these tables — the CLI handles
auth, graceful no-op, git-derived commit_sha, and error normalisation.

## R2+ Audit Mode (Phase 1)

When `--round >= 2`, the audit script enables three-layer defence against finding churn:

1. **Rulings injection** (Layer 1): `buildRulingsBlock()` formats prior rulings as system-prompt exclusions
2. **R2+ prompts** (Layer 2): `R2_ROUND_MODIFIER` + pass rubric (not "find all issues")
3. **Post-output suppression** (Layer 3): `suppressReRaises()` fuzzy-matches findings against ledger

### R2+ CLI Flags

| Flag | Purpose |
|------|---------|
| `--round <n>` | Round number (triggers R2+ mode if >= 2) |
| `--ledger <path>` | Adjudication ledger JSON (rulings + suppression) |
| `--diff <path>` | Unified diff (git diff output) for line-level annotations |
| `--changed <list>` | Files modified this round (authoritative for reopen detection) |

### Adjudication Ledger

Two-axis state model: `adjudicationOutcome` (dismissed/accepted/severity_adjusted) + `remediationState` (pending/planned/fixed/verified/regressed). Written by orchestrator via `writeLedgerEntry()`.

## Code Style

- ESM modules (`import`/`export`, not `require`)
- `process.stderr.write()` for progress logging (keeps stdout clean for JSON output)
- `--out <file>` pattern: JSON to file, 1-line summary to stdout
- Zod schemas define structured output contracts for all LLM calls
- Functions follow `{result, usage, latencyMs}` return contract

## Do NOT

- Use `_def.typeName` or `_def.shape()` — these are Zod 3 patterns, we use Zod 4
- Send `.env` or credential files to external APIs
- Use `require()` — project is ESM-only
- Create new Anthropic/OpenAI client instances per call — reuse the client created in `main()`

## Accepted Technical Debt

These items were evaluated and deliberately accepted:

| Item | Rationale | Revisit trigger |
|------|-----------|-----------------|
| `atomicWriteFileSync` no fsync | CLI tool, not a database. Rename atomicity protects against process crash (the real failure mode). | Never — unless used in a daemon/server context |
| `atomicWriteFileSync` temp naming (PID+timestamp) | Collision requires same PID + same millisecond + same directory. Probability negligible. | Never |
| `readFileOrDie` process.exit(1) | Name is self-documenting. Only called from CLI entry points. | If ever called from a library context |
| `normalizePath()` lowercasing | Correct for Windows (case-insensitive FS). On case-sensitive Linux, distinct files could collide — acceptable for local-repo auditing. | If deployed as a CI service on Linux |
| Module-global caches (`_repoProfileCache`, `_taskStore`) | Safe in CLI-per-invocation model. Each process starts fresh. | If extracting as a library or running as a long-lived server |
