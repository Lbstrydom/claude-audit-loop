# Claude Engineering Skills

A bundle of **AI-pair-programming skills** for planning, auditing, testing, and shipping code. Works with Claude Code, VS Code Copilot, Cursor, Windsurf, and any terminal.

Includes a **multi-model audit loop** — Claude plans/codes, GPT-5.4 audits, Gemini 3.1 Pro does independent final review — with adaptive learning that improves both auditor and reviewer prompts over time. A **persona-test** skill closes the loop with real-user UX simulation against live URLs. An **architectural-memory** layer indexes every symbol in the repo with embeddings so AI agents catch duplicate-function drift before code gets written.

> Renamed from `claude-audit-loop`. GitHub auto-redirects old URLs.

## Skills

| Skill | Purpose | Invoke |
|-------|---------|--------|
| **[plan](skills/plan/SKILL.md)** | Unified planner — auto-detects backend/frontend/full-stack scope; one consolidated plan output | `/plan <task>` |
| **[audit-plan](skills/audit-plan/SKILL.md)** | Iteratively audit a plan with GPT-5.4 + Gemini final gate (max 3 rounds) | `/audit-plan docs/plans/X.md` |
| **[audit-code](skills/audit-code/SKILL.md)** | Multi-pass code audit against a plan with R2+ ledger suppression + Gemini final review | `/audit-code docs/plans/X.md` |
| **[cycle](skills/cycle/SKILL.md)** | End-to-end orchestrator — chains plan → audit-plan → impl gate → audit-code → persona-test → ux-lock → ship | `/cycle <task>` |
| **[explain](skills/explain/SKILL.md)** | "Why is this code shaped this way?" — synthesises arch-memory + git history + AGENTS.md principles | `/explain <file:line>` |
| **[ux-lock](skills/ux-lock/SKILL.md)** | Generate Playwright e2e regression specs that lock in a fix's public DOM contract; verify-mode grades a plan against live impl | `/ux-lock <commit-or-description>` |
| **[persona-test](skills/persona-test/SKILL.md)** | Persona-driven exploratory browser testing with Plan→Act→Reflect, P0–P3 findings, qualitative debrief, Supabase session memory | `/persona-test "first-time user" https://myapp.com` |
| **[ship](skills/ship/SKILL.md)** | Pre-push quality gate: test, lint, format, commit, push (warns on open persona-test P0s + missing regression specs) | `/ship` |
| **[ai-context-management](skills/ai-context-management/SKILL.md)** | Manages AGENTS.md / CLAUDE.md alignment across AI agents (Claude, Copilot, Cursor, Windsurf) | `/ai-context-management audit` |

**Deprecated aliases** (kept for muscle memory): `/plan-backend` and `/plan-frontend` delegate to `/plan` with a scope hint; `/audit-loop` delegates to `/cycle` (chained mode) or atomic `/audit-plan` / `/audit-code`.

All skills support **JavaScript/TypeScript** and **Python** (FastAPI, Django, Flask) with automatic stack detection.

## Skill Lifecycle Chain

The skills form a complete code-to-production loop, orchestrated by `/cycle`:

```
/plan                            ← Design with 20 eng + 26 UX + 17 technical principles (lazy-loaded by scope)
        |
        v
/audit-plan                      ← Iterative plan refinement with GPT-5.4 + Gemini final gate
        |
        v  (human implementation gate)
        |
/audit-code                      ← Multi-pass code audit + R2+ ledger suppression + Gemini final
        |
        v
/persona-test                    ← Real-user simulation against live URL (P0–P3)
        |
        v
/ux-lock                         ← Playwright e2e spec locks every fix's public DOM contract
        |
        v
/ship                            ← Quality gate + commit + push (warns on open P0s, missing specs)

/cycle                           ← Orchestrates the whole chain end-to-end
/explain                         ← "Why is this here?" — read-only synthesis from arch-memory + git
```

**Architectural-memory hook** (`UserPromptSubmit`) auto-fires before any ad-hoc code change — when your prompt contains "fix", "add", "implement", "create", etc., it queries the symbol-index for near-duplicates and prepends a "consider reuse" callout to Claude's context. Catches drift that bypasses planning entirely.

Each skill reads the outputs of previous skills:
- **plan-backend / plan-frontend** query persona-test session history for recurring user pain points before designing
- **audit-loop** queries persona-test for P0/P1s tied to the current repo when building code context
- **ux-lock** reads the audit-loop fix or persona-test P0 and generates a Playwright spec asserting on semantic DOM contracts (role, aria-*, data-testid) — not CSS classes
- **ship** queries persona-test for open P0s and blocks or warns before pushing; also warns if recent fixes lack regression specs
- **persona-test** queries audit-loop for HIGH findings and cross-references them against UX observations

## Quick Start

```bash
# 1. Clone this repo (once)
git clone https://github.com/Lbstrydom/claude-engineering-skills.git
cd claude-engineering-skills

# 2. Run the setup wizard
node setup.mjs

# 3. Done — skills are available in every repo you open in VS Code
#    Run `git pull` in this repo anytime to get updates (auto-installs via hook)
```

The setup wizard configures API keys (including optional persona-test Supabase), installs all 6 skills globally, and sets up a git hook for auto-updates.

Once installed, the typical workflow is:

```bash
/plan add a wine recommendation endpoint            # design with principles (auto-detects scope)
/audit-plan docs/plans/my-feature.md                # iterative plan refinement
# (implement)
/audit-code docs/plans/my-feature.md                # multi-pass code audit
/ship                                                # quality gate + push
/persona-test "first-time user" https://myapp.com   # UX simulation on live URL

# OR run the whole chain in one command:
/cycle add a wine recommendation endpoint           # plan → audit-plan → impl gate → audit-code → persona-test → ux-lock → ship

# At any time, ask "why is this code shaped this way?":
/explain scripts/openai-audit.mjs:412               # arch-memory + git history + principles
```

### Install skills into a specific repo

For Copilot/Cursor/Agents support in a specific repo (not just Claude Code):

```bash
node scripts/install-skills.mjs --local --target /path/to/your/repo --force
```

This copies SKILL.md files, installs npm dependencies, and sets up `.gitignore` patterns.

## Three-Model Audit Architecture

```
Claude/Copilot (plans + implements)
    |
    v
GPT-5.4 (5 parallel audit passes: structure, wiring, backend, frontend, sustainability)
    |
    v (deliberation: accept / challenge / compromise)
Gemini 3.1 Pro (independent final review: bias, consensus, missed issues)
    |
    v
Adaptive Learning (bandit arms, FP tracker, meta-assessment, prompt evolution)
```

### What the audit loop does

1. **GPT-5.4 audits** your code in 5 focused passes (structure, wiring, backend, frontend, sustainability)
2. **Claude triages** each finding -- accept, challenge, or defer
3. **GPT deliberates** on challenges -- sustain, overrule, or compromise
4. **Fixes are applied**, then R2+ re-audits with suppression of already-resolved findings
5. **Gemini 3.1 Pro** provides an independent final review (catches blind spots in the GPT-Claude loop)
6. **Debt review** triggers automatically when deferred findings reach critical mass
7. **Meta-assessment** periodically evaluates audit-loop quality and recommends prompt improvements

### CLI entry point

```bash
# Full orchestrated loop (all steps)
node scripts/audit-loop.mjs code docs/plans/my-feature.md

# Or via npm
npm run audit -- code docs/plans/my-feature.md

# Individual scripts
node scripts/openai-audit.mjs code docs/plans/X.md     # GPT audit only
node scripts/gemini-review.mjs review <plan> <transcript>  # Gemini review only
node scripts/meta-assess.mjs --force                    # Meta-assessment
node scripts/check-deps.mjs                             # Dependency check
```

### Scope control

```bash
# Default: audit only git-changed files (recommended)
node scripts/openai-audit.mjs code <plan> --scope diff

# Exclude vendored/upstream files
node scripts/openai-audit.mjs code <plan> --exclude-paths 'scripts/**,vendor/**'

# Or use a .auditignore file (one glob per line)
echo 'scripts/**' > .auditignore
```

## Learning System

The audit loop gets smarter over time:

| Component | What it does |
|-----------|-------------|
| **Thompson Sampling** | Selects the best-performing prompt variant per pass (bandit arms) |
| **FP Tracker** | Tracks recurring false positives with exponential decay; auto-suppresses patterns with <15% acceptance |
| **Meta-Assessment** | Every ~4 runs, evaluates FP rate, severity calibration, convergence speed; recommends prompt changes |
| **Prompt Evolution** | Creates experimental prompt variants, tests them via bandit, promotes winners |
| **Debt Review** | Clusters deferred findings by file/principle/recurrence; ranks refactor candidates by leverage |
| **User-Impact Reward** | Bandit also rewards findings that `/persona-test` later confirmed in a live browser (ground-truth labels via `persona_audit_correlations`) |

Learning applies to **both GPT audit passes and Gemini final review**.

### Cross-Skill Data Loop

All 6 skills write to a shared Supabase store (graceful no-op when unconfigured)
via [`scripts/cross-skill.mjs`](scripts/cross-skill.mjs). Migration
`20260419120000_cross_skill_data_loop.sql` adds:

| Table | Written by | Closes which gap |
|-------|-----------|------------------|
| `plans` | `/plan-*`, `/audit-loop` | Plan ↔ audit_runs linkage via `plan_id`, commit-anchored |
| `regression_specs` + `regression_spec_runs` | `/ux-lock` | Every Playwright spec recorded with source finding + pass/fail history |
| `persona_audit_correlations` | `/persona-test` | Ground-truth labels feeding bandit user-impact reward |
| `ship_events` | `/ship` | Outcome + block reason log (which gates fire, which get overridden) |
| `commit_sha` on `audit_runs` + `persona_test_sessions` | orchestrator + `/persona-test` | Ties every run to a concrete code version |

Views surface the rollups: `audit_effectiveness` (user-visible precision/recall),
`unlocked_fixes` (fixes without a `/ux-lock` spec), `regression_saves` (specs
that caught a real regression), `ship_gate_effectiveness` (block rate + override rate).

## Persona Testing

The `/persona-test` skill simulates how a real user with a specific background and goal experiences your live app. It drives the browser step-by-step, screenshots key moments, and produces both a structured findings report and a first-person qualitative debrief in the persona's voice.

### How it works

```
/persona-test "first-time wine collector" https://myapp.railway.app "adding first bottle"
```

1. **Persona profile** — builds a UXAgent-style profile: background, intent, technical comfort, patience, abandonment threshold, first actions
2. **Plan→Act→Reflect loop** — 8–12 exploration steps; each action is planned, executed, then reflected on before proceeding
3. **Confidence-scored findings** — each issue logged with a 0.0–1.0 confidence score; only findings ≥0.6 appear in the report
4. **Severity model** — P0 BROKEN · P1 DEGRADED · P2 COSMETIC · P3 OBSERVATION
5. **Audit correlation** — P0/P1 findings are cross-referenced against open HIGH issues in the audit-loop store for the same repo
6. **Qualitative debrief** — 400–700 word first-person narrative in the persona's voice (product discovery artifact, not a bug list)
7. **Session memory** — results saved to Supabase; recurring issues surface automatically across sessions

### Persona registry

```bash
# List all personas for the current app (sorted by most overdue)
/persona-test list

# Register a new persona
/persona-test add "Pieter, 55yo wine farmer, mobile-only, low tech comfort" https://myapp.com "Wine Cellar App"
```

The registry tracks test history, last verdict, and days since last test — so you always know which persona is most overdue for a check.

## UX Regression Locking (`/ux-lock`)

After a bug fix converges through the audit loop — or after `/persona-test` finds a P0 that you patch — the fix is only half-done. Without a regression spec, the next refactor can silently re-break it.

`/ux-lock` generates a Playwright e2e spec that **locks in the fix's public DOM contract**:

```bash
/ux-lock "modal closes before retry"              # plain-English description
/ux-lock abc1234                                  # commit hash — reads the diff
/ux-lock "role=list on wine grid" --url https://myapp.railway.app
```

### What it asserts on (and what it deliberately does not)

| Good assertions (stable)                    | Bad assertions (brittle)                    |
|---|---|
| Element with `role="list"` exists           | Element has class `wine-list-v3`            |
| Modal closes when action button clicked     | Internal state variable changes             |
| Button is `aria-disabled` when form invalid | CSS opacity is 0.5                          |
| Axe-core reports no WCAG violations         | `document.querySelector('.grid-abc')`       |

The spec tests **public DOM contracts** — roles, aria attributes, `data-testid` hooks, user-visible behaviour. It survives CSS rewrites and internal refactors, and fails only when the user-observable contract regresses.

### Browser setup (Playwright MCP)

`/persona-test` and `/ux-lock` both use Playwright. An `.mcp.json` is included in this repo — Claude Code will prompt you to enable Playwright MCP on first open.

**First-time install (required):**
```bash
npx playwright install chromium
```

**Windows users** — if Playwright tools still don't appear after install, add this override to `~/.claude/settings.json` (Windows needs the `.cmd` wrapper for Claude Code's process spawner):

```json
"mcpServers": {
  "playwright": {
    "command": "npx.cmd",
    "args": ["@playwright/mcp@latest", "--headless"]
  }
}
```

BrightData Scraping Browser is also supported for sites behind anti-bot/CAPTCHA, but requires a paid account. For testing your own apps, Playwright MCP is preferred — it's free and needs no credentials.

### Obsidian plugins (limitation)

Playwright can't attach to Obsidian's Electron process. For Obsidian plugins, unit-test logic with vitest and test extracted UI in a mock HTML harness. Full Electron e2e (`_electron.launch()`) works but is heavy — reserve for critical user flows only.

## Supported Platforms

| Platform | Skill Location | How to Invoke |
|----------|---------------|---------------|
| **Claude Code** (CLI, VS Code, Desktop) | `~/.claude/skills/<name>/` (global) | `/<skill-name>` |
| **VS Code Copilot** | `.github/skills/<name>/` (per-repo) | `/<skill-name>` in Copilot Chat |
| **Cursor** | `.github/skills/` or `.cursor/rules/` | `/<skill-name>` or terminal |
| **Windsurf** | `.github/skills/` | `/<skill-name>` or terminal |
| **Any terminal** | N/A | `node scripts/audit-loop.mjs` |

## Environment Variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `OPENAI_API_KEY` | **Yes** | -- | GPT-5.4 auditing |
| `GEMINI_API_KEY` | No | -- | Gemini final review + Flash context briefs |
| `ANTHROPIC_API_KEY` | No | -- | Claude Opus fallback + Haiku context briefs |
| `AUDIT_STORE` | No | `noop` | Storage adapter: `noop`, `sqlite`, `supabase`, `postgres` |
| `SUPABASE_AUDIT_URL` | No | -- | Cloud learning store URL (when AUDIT_STORE=supabase) |
| `SUPABASE_AUDIT_ANON_KEY` | No | -- | Cloud learning store key |
| `AUDIT_POSTGRES_URL` | No | -- | Postgres connection (when AUDIT_STORE=postgres) |
| `META_ASSESS_INTERVAL` | No | `4` | Run meta-assessment every N audits |
| `PERSONA_TEST_SUPABASE_URL` | No | -- | Persona-test session memory URL |
| `PERSONA_TEST_SUPABASE_ANON_KEY` | No | -- | Persona-test session memory anon key |
| `PERSONA_TEST_APP_URL` | No | -- | Default app URL for `/persona-test list` |
| `PERSONA_TEST_REPO_NAME` | No | -- | Repo name for cross-referencing audit findings (e.g. `wine-cellar-app`) |

## Storage Adapters

| Adapter | Config | Use case |
|---------|--------|----------|
| `noop` (default) | No config needed | Local JSON files only, zero cloud |
| `sqlite` | `AUDIT_STORE=sqlite` | Local cross-repo persistence |
| `supabase` | `SUPABASE_AUDIT_URL` + key | Existing Supabase users |
| `postgres` | `AUDIT_POSTGRES_URL` | Generic cloud Postgres |
| `github` | `AUDIT_GITHUB_TOKEN` + owner/repo | GitHub-only infra |

## Python Support

Each planning skill auto-detects your repo's stack:

- **JS/TS**: `package.json` present
- **Python**: `pyproject.toml`, `requirements.txt`, `Pipfile`, `setup.py`, or `uv.lock` present
- **Mixed**: both present -- routes to the profile matching the task's cited files

Python framework detection: **FastAPI**, **Django**, **Flask** (falls back to generic Python principles).

## Architectural Memory

Per-repo symbol-index stored in Supabase (with embeddings) catches duplicate-function drift before code gets written.

**What it indexes**: every function, class, component, hook, route, method, and exported constant in the repo. For each: name, file path, signature, body checksum, LLM-generated 1-line purpose summary, embedding vector. Snapshot-isolated per refresh; `audit_repos.active_refresh_id` points at the published snapshot readers consume.

**How it catches drift**:

1. **Plan-time** — `/plan` (and the deprecated `/plan-backend` / `/plan-frontend` aliases) consult the index in Phase 0.5 with the user's intent description; near-duplicates appear as a "Neighbourhood considered" callout in the plan output.
2. **Ad-hoc-fix time** — `.claude/hooks/arch-memory-check.sh` (a `UserPromptSubmit` hook) auto-fires when prompts contain intent verbs (`fix`, `add`, `implement`, `create`, `build`, `write`, `refactor`, `make`, `wire`, `hook`, `introduce`, `replace`, `extend`). The result is prepended to Claude's context as a `> **Architectural-memory consultation**` callout. Catches the casual "fix the X bug" path that bypasses planning entirely.
3. **Audit-time** — `/audit-code --scope=full` inlines the full symbol catalogue so the auditor can spot cross-file duplication.
4. **Drift sweep** — weekly GH workflow (`.github/workflows/architectural-drift.yml`) computes a drift score and opens a sticky issue if cosine-similar symbol pairs cluster.
5. **Render** — `npm run arch:render` produces a committed `docs/architecture-map.md` with Mermaid C4-style diagrams + a flat table per domain (regenerated on `/ship`).

**Setup per consumer repo**:

```bash
# 1. Add SUPABASE_AUDIT_SERVICE_ROLE_KEY to .env (writes use service role; reads use anon)
# 2. Populate the index:
npm run arch:refresh:full
# 3. Commit the artefacts:
git add .audit-loop/repo-id docs/architecture-map.md package.json
git commit -m "feat(arch-memory): initial index"
```

**Cost**: ~$0.50 for the first full refresh of a 1000-symbol repo (Haiku purpose summaries + Gemini text-embedding-004). Steady-state ~$0 thanks to signature-hash caching. Per-prompt hook consultation: ~$0.0003.

**Files committed in consumer repos**: `.audit-loop/repo-id` (stable per-repo UUID), `docs/architecture-map.md` (rendered map), `package.json` (new `arch:*` scripts + `ts-morph` + `dependency-cruiser` deps), AGENTS.md (the "Pre-fix Consultation" section). Synced runtime files (`scripts/lib/symbol-index.mjs` etc., `scripts/symbol-index/*`, `.claude/hooks/arch-memory-check.sh`, `.audit-loop/cache/`) are gitignored — they're managed by `npm run sync` from the source repo.

Full plan: [docs/plans/architectural-memory.md](docs/plans/architectural-memory.md) (audited via 3-round GPT + 2-round Gemini cycle).

## Security

- `.env` files are gitignored; API keys are never logged
- Sensitive file patterns excluded from external API calls
- All subprocess calls use `execFileSync` (no shell string interpolation)
- Installer verifies SHA checksums against manifest before writing files

See [SECURITY.md](SECURITY.md) for vulnerability reporting and verification instructions.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and PR guidelines.

## License

MIT -- see [LICENSE](LICENSE)
