# Plan: Skill Progressive Disclosure Refactor
- **Date**: 2026-04-19
- **Status**: Draft
- **Author**: Claude + Louis

---

## 1. Context Summary

### Current state (measured, not estimated)

The 6 skills are each a single monolithic `SKILL.md`:

| Skill | Lines | Chars | ~Tokens |
|---|---:|---:|---:|
| audit-loop | 724 | 31,771 | 7,942 |
| persona-test | 879 | 39,221 | 9,805 |
| plan-backend | 267 | 13,287 | 3,321 |
| plan-frontend | 386 | 20,027 | 5,006 |
| ship | 361 | 13,861 | 3,465 |
| ux-lock | 487 | 16,898 | 4,224 |
| **Total** | **3,104** | **135,065** | **33,763** |

Per-turn baseline cost (YAML frontmatter only, always loaded): **~1.5K tokens** across all 6 skills. This is fine.

Per-invocation cost (SKILL.md body loaded when the skill fires): **3.3K → 9.8K tokens** depending on skill. `persona-test` and `audit-loop` are the outliers.

### Audit findings (from Explore agent survey)

Section classification (as % of each file):

| Skill | CANONICAL | REFERENCE | INTEGRATION | EDGE | DIAGNOSTICS |
|---|---:|---:|---:|---:|---:|
| audit-loop | 65% | 20% | 5% | 8% | 2% |
| persona-test | 55% | 15% | 15% | 10% | 5% |
| plan-backend | 85% | 10% | 2% | 0% | 3% |
| plan-frontend | 80% | 15% | 2% | 0% | 3% |
| ship | 75% | 10% | 15% | 5% | — |
| ux-lock | 70% | 15% | 10% | 8% | 5% |

**Real cross-skill duplication**: ~200 tokens of stack-detection logic repeated verbatim in `plan-backend` Phase 0, `plan-frontend` Phase 0, and `ship` Step 0. Everything else the audit flagged as "similar" is contextually distinct (Python backend ≠ Python frontend ≠ Python pre-push discovery).

**Zero sibling files exist**. No `references/`, no `examples/`, no per-skill `scripts/`. Every skill is a single flat file.

### Installer + sync constraints (discovered in Phase 1)

The sync and install machinery currently assumes one file per skill:

- `scripts/lib/schemas-install.mjs` — `SkillEntrySchema = { path: string, sha, size, summary }` (single path)
- `scripts/build-manifest.mjs` — iterates `skills/<name>/SKILL.md`, registers one entry per skill
- `scripts/lib/install/surface-paths.mjs` — `resolveSkillTargets()` returns one `filePath` per surface
- `scripts/sync-to-repos.mjs` — `SKILL_FILES` array hardcodes 12 paths (6 skills × 2 surfaces for `.claude/` + `.github/`)

If we add sibling reference files and don't update this chain, downstream repos get broken skills — SKILL.md says *"read `references/interop.md`"* but the file was never shipped.

### Why this refactor, why now

The recent data-loop work (this session) added content to `persona-test`, `ux-lock`, `ship`, and `plan-frontend`. `persona-test` grew past 9.8K tokens. Every future cross-skill integration adds to every skill that participates. Without progressive disclosure, the drift only gets worse.

---

## 2. Proposed Architecture

### 2.1 Target directory structure (per skill)

```
.claude/skills/<name>/
├── SKILL.md                    ← canonical flow only; ≤3K tokens target
├── references/
│   ├── <topic-a>.md            ← rare/edge content, loaded on demand
│   └── <topic-b>.md
└── examples/                   ← optional; full output samples
    └── <example>.md
```

`examples/` is optional — only present when the skill emits long structured output (report templates, debriefs, spec files).

### 2.2 Reference-index format spec

Every SKILL.md ends with exactly one section matching this shape:

```markdown
## Reference files

This skill's canonical flow is above. The files below cover specialised
situations — read them only when the trigger applies.

| File | Summary | Read when |
|---|---|---|
| `references/interop.md` | How this skill feeds /audit-loop, /ship, /plan-*. | The user asks about cross-skill effects, OR you need to emit a correlation row. |
| `references/session-history.md` | Querying + summarising prior sessions. | Step 6c fires AND there are ≥2 prior sessions for this URL. |
| `references/troubleshooting.md` | Recovery from mid-session failures. | A browser tool call fails twice in a row, OR the user asks "what went wrong". |
```

**Rules**:
- Table is the fixed shape (parser can regex-match it for lint).
- `File` is always a relative path from the skill directory.
- `Summary` is one sentence — what's in the file.
- `Read when` is a trigger clause — a **specific, detectable condition**, not "if relevant" (too vague to prevent over-reading).
- Entries are sorted by expected read frequency (most-likely first).

**Anti-patterns for `Read when` triggers** (to call out in the format spec doc):
- ❌ "when relevant" — every ref is "relevant"; this defeats the point
- ❌ "before responding" — every invocation goes to responding
- ✅ "when the user asks about X" — trigger is detectable
- ✅ "when step Y fails" — trigger is observable in the flow

### 2.3 Installer manifest extension

`SkillEntrySchema` in `scripts/lib/schemas-install.mjs` gains a `files: Array<FileEntry>` field:

```js
export const FileEntrySchema = z.object({
  relPath: z.string(),   // 'SKILL.md' or 'references/interop.md'
  sha: z.string(),
  size: z.number(),
});

export const SkillEntrySchema = z.object({
  path: z.string(),        // kept for backward compat: always 'skills/<name>/SKILL.md'
  sha: z.string(),         // SHA of SKILL.md specifically
  size: z.number(),
  summary: z.string(),
  files: z.array(FileEntrySchema).default([{relPath: 'SKILL.md', ...}]),  // NEW
});
```

- `path` + `sha` + `size` stay pointing at SKILL.md so existing consumers don't break.
- `files` lists everything that must be installed for the skill to work.
- `schemaVersion` bumps from 1 → 2.
- Installer reads `files` when present, falls back to single-file behaviour when absent (old manifests still parse).

### 2.4 Shared-library extractions

Only one true cross-skill duplication is worth extracting:

**`scripts/lib/repo-stack.mjs`** — detection shared by `plan-backend`, `plan-frontend`, `ship`:

```js
export function detectRepoStack(cwd = process.cwd()) { /* ... */ }
export function detectPythonFramework(deps) { /* ... */ }
export function detectPythonEnvironmentManager(cwd) { /* ship-specific */ }
```

The three skills' Phase 0 / Step 0 sections become 3–5 lines each, pointing to the library. Output shape is well-defined so skills can render the stack profile sections without having to reason about the detection logic inline.

**NOT extracting**: browser tool detection (currently in persona-test Phase 1 only — no real duplication yet). Flagged as preemptive-extraction candidate only when `/ux-lock verify` grows anti-bot support.

### 2.5 Replacing curl recipes with `cross-skill.mjs`

`persona-test` still hand-writes 4 curl blocks (lines 58–59, 109–119, 195–197, 640–666). These all go through `scripts/cross-skill.mjs` or need new subcommands:

- List personas → new subcommand `list-personas --url <url>` (reads from the persona_dashboard view)
- Add persona → new subcommand `add-persona --json {...}`
- Save session → new subcommand `record-persona-session --json {...}` (returns session_id)
- Update persona stats → handled inside `record-persona-session` (same txn)

This eliminates ~400 tokens of curl recipe from `persona-test` SKILL.md and gives all skills a consistent persistence API. The skill file says `node scripts/cross-skill.mjs add-persona --json '...'` — short, learnable, testable.

---

## 3. Sustainability Notes

### Assumptions that could change

| Assumption | What if it changes | Mitigation |
|---|---|---|
| Claude Code loads only SKILL.md on invocation; sibling files require explicit Read() | Auto-preloading would make progressive disclosure moot | The refactor still pays off for maintainability; content organisation remains useful |
| The "Read when" trigger approach works — model decides to Read based on trigger | Model might over-Read (load everything) or under-Read (miss needed content) | Tune trigger phrasing; monitor in practice; fall back to embedding in SKILL.md if over-/under-reading is systemic |
| Installer manifest schema v1 consumers can handle v2 gracefully | Old installers crash on `files` field | `files` is additive + optional; v1 `SkillEntrySchema.parse()` will reject unknown fields → we bump schemaVersion so old installers know to skip |
| The 3 skill copies (`.claude/` + `.github/` + top-level `skills/`) stay in sync manually | Copies drift | Add a CI check (`npm run check-sync` or similar) comparing the 3 copies of each skill directory |

### How the design accommodates future change

- **New skill**: copy the structure (SKILL.md + empty `references/`). No new sync config unless the manifest builder walks the directory (which it will, post-refactor).
- **New reference type**: add to `references/`; the reference-index table updates; no global changes.
- **Cross-skill content migration**: a ref file can move from one skill to another by filesystem move + index update in both files.
- **Schema v3 (hypothetical future)**: installer already speaks versioned manifests.

### Extension points deliberately built in

1. **Manifest walks the skill directory, not a hardcoded list** — new files auto-register.
2. **Trigger syntax is a free-form `Read when:` clause** — can be tightened later into structured metadata (e.g. YAML triggers) without breaking existing skills.
3. **`examples/` directory is optional** — skills that don't need it pay zero tokens; skills that do can add large output bodies there without inflating SKILL.md.

---

## 4. File-Level Plan

Grouped by work-phase. Each file has purpose + imports + what-imports-it.

### Phase A — Format spec + library foundations (no skill changes yet)

| File | Purpose | Imports | Imported by |
|---|---|---|---|
| `docs/skill-reference-format.md` (NEW) | Canonical spec for the SKILL.md ref-index table format. Documents the required 3-column table, trigger rules, anti-patterns. Source of truth for the lint script. | — | Referenced by every SKILL.md; read by lint script authors |
| `scripts/lib/skill-refs-parser.mjs` (NEW) | Parse the "Reference files" section of a SKILL.md into structured entries. Validates format. | `node:crypto` | `scripts/check-skill-refs.mjs`, future meta tools |
| `scripts/check-skill-refs.mjs` (NEW) | CLI lint: for each skill, parse its ref-index, verify every listed file exists, verify no orphan files in `references/` that aren't listed. Exits non-zero on violations. | `skill-refs-parser.mjs`, `node:fs` | `npm test` (added to `package.json` test scripts) |
| `tests/skill-refs-parser.test.mjs` (NEW) | Unit tests for the parser (valid formats pass; missing files / malformed table fail). | — | `npm test` |
| `scripts/lib/repo-stack.mjs` (NEW) | Shared stack-detection library. `detectRepoStack`, `detectPythonFramework`, `detectPythonEnvironmentManager`. | `node:fs` | Indirectly referenced by SKILL.md files; no Node import (skills invoke via shell) |
| `tests/repo-stack.test.mjs` (NEW) | Tests for stack detection — JS/TS, Python, mixed, unknown; Python framework detection. | `node:fs` (fixtures) | `npm test` |

**Why these files**:
- `docs/skill-reference-format.md` → Principle 10 (Single Source of Truth — one place defines the format).
- `scripts/lib/skill-refs-parser.mjs` → Principle 11 (Testability — extracted from CLI so it can be unit tested).
- `scripts/check-skill-refs.mjs` → Principle 19 (Observability — catches ref rot before it ships).
- `scripts/lib/repo-stack.mjs` → Principle 1 (DRY — eliminates 3x duplication).

### Phase B — Installer extension

| File | Purpose | Imports | Imported by |
|---|---|---|---|
| `scripts/lib/schemas-install.mjs` (MODIFY) | Add `FileEntrySchema`; extend `SkillEntrySchema` with `files` array. Bump `MANIFEST_SCHEMA_VERSION` to 2. | zod | `build-manifest.mjs`, installer |
| `scripts/build-manifest.mjs` (MODIFY) | Walk each `skills/<name>/` directory recursively; compute SHA for each file; populate `files` array. Keep `path`/`sha`/`size` pointing at SKILL.md for backward-compat. | `schemas-install.mjs` | CI + manual rebuild |
| `scripts/lib/install/surface-paths.mjs` (MODIFY) | `resolveSkillTargets` returns `{surface, dir, filePath}` as before BUT adds `resolveSkillFiles(name, surface, repoRoot, files[])` that returns per-file targets. | `node:fs`, `node:path` | `install-skills.mjs`, `transaction.mjs` |
| `scripts/lib/install/transaction.mjs` (MODIFY) | Install every file in the manifest's `files` array into the skill's target dir, not just SKILL.md. Receipts track all installed files. | existing | `install-skills.mjs` |
| `scripts/lib/install/receipt.mjs` (MODIFY) | `managedFiles` already supports multiple entries per skill — no schema change, but ensure the installer populates them all. | existing | `install-skills.mjs` |
| `scripts/lib/install/conflict-detector.mjs` (MODIFY) | Check conflicts on every file in a skill, not just SKILL.md. | existing | `install-skills.mjs` |
| `scripts/sync-to-repos.mjs` (MODIFY) | Replace the hardcoded `SKILL_FILES` array with a directory-walking helper: for each skill name × each surface (`.claude/skills/<n>/`, `.github/skills/<n>/`, `skills/<n>/`), enumerate all files under that directory. | `node:fs`, `node:path` | CI + manual sync |
| `tests/install-multi-file-skill.test.mjs` (NEW) | Integration test: build a mock skill dir with references/, run buildManifest, verify `files` array is correct; run a dry-run install, verify all files would be written. | existing installer libs | `npm test` |

**Why these files**:
- Principle 14 (Transaction Safety — installer already uses transactional installs; extending to multi-file must preserve all-or-nothing semantics).
- Principle 18 (Backward Compatibility — `schemaVersion: 2` lets old installers detect and fail gracefully rather than silently skip files).

### Phase C — Per-skill refactors

Work order by leverage (biggest token saving first):

#### C1 — persona-test (879 → ~350 lines, saves ~5.5K tokens on invocation)

Move to `references/`:
- `references/interop.md` — current "Engineering Skills Interplay" section (lines 774–841; 68 lines). Trigger: *user asks about `/ship`, `/plan-*`, or `/audit-loop` integration*.
- `references/audit-correlation.md` — Phase 6b (92–741; 50 lines, emit correlations). Trigger: *`audit_link = true` AND ≥1 P0/P1 finding in this session*.
- `references/session-history.md` — Phase 6c (745–771). Trigger: *session save succeeded AND Supabase configured*.
- `references/browser-tool-detection.md` — Phase 1 detailed tier logic (248–295; 48 lines). Trigger: *setup failing OR first-run environment*.
- `references/persona-debrief-format.md` — Phase 5b full tone-rules + template (577–620). Trigger: *about to generate the debrief section*.
- `references/supabase-persistence-recipes.md` — the 4 curl blocks → replaced by `cross-skill.mjs` CLI calls. Trigger: *CLI unavailable, fall back to raw curl*.

Kept canonical:
- Phase 0 routing + sub-command entries
- Phase 1 tool selection (condensed to 10 lines: "Use Playwright MCP for own apps, BrightData for external")
- Phase 2 persona mental model
- Phase 3 safety policy + exploration loop (shortened)
- Phase 4 severity model
- Phase 5 structured report format (keep — short)

#### C2 — audit-loop (724 → ~400 lines, saves ~3K tokens)

Move to `references/`:
- `references/r2-plus-mode.md` — R2+ auto-skip logic, Round 6 cap, suppression details (~60 lines across Steps 2–5).
- `references/debt-ledger.md` — Step 3.6 debt capture details (94 lines).
- `references/gemini-arbiter.md` — Step 7 full deliberation protocol (76 lines).
- `references/convergence-criteria.md` — triage decision rules, convergence conditions (~30 lines).
- `examples/transcript-format.md` — sample Gemini input transcript (verbose JSON).

Kept canonical:
- Mode parsing + routing
- Step 1 (plan gen)
- Step 2 (GPT audit, core scope modes)
- Step 3 (triage basics; deep rules in debt-ledger.md ref)
- Step 4–6 (fix + verify + convergence summary)
- Step 7 (short invocation; deep protocol in gemini-arbiter.md ref)

#### C3 — ux-lock (487 → ~250 lines, saves ~1.8K tokens)

Two modes share a file. Each mode gets its canonical flow kept in SKILL.md; deep templates go to refs:

- `references/lock-mode-templates.md` — full spec template + fix-type assertion map (LOCK Step 3 body).
- `references/verify-mode-translation-rules.md` — the translation-rules table and full generated spec template (VERIFY Step V2).
- `references/obsidian-limitations.md` — Electron app caveats (Step 6 scope limitations).
- `examples/verify-report.md` — sample verify-mode report output.

Kept canonical:
- Phase 0 routing
- Both modes' step list with 1-line descriptions + CLI commands
- Persistence invocations (these are the integration point)

#### C4 — plan-frontend (386 → ~280 lines, saves ~1.2K tokens)

- `references/ux-principles.md` — the 26 principle tables (Phases 2–4: Gestalt, interaction, cognitive load, accessibility, state). Trigger: *exploring a design decision AND need to cite specific principles*.
- `references/acceptance-criteria-format.md` — Section 9 worked example + category/severity rules. Trigger: *writing or validating Section 9 entries*.
- `references/stacked-modals.md` — LIFO cascade anti-pattern detail. Trigger: *plan includes modal interactions*.

Kept canonical:
- Phase 0 → `scripts/lib/repo-stack.mjs` wrapper
- Phase 1 explore
- Phases 2–4 condensed to "cite principles from `references/ux-principles.md` for each design choice"
- Phase 5 output structure (short — format docs are in refs)
- Phase 6 persist

#### C5 — ship (361 → ~280 lines, saves ~1K tokens)

- `references/python-environment-discovery.md` — Step 0 environment manager + tool detection (lines 40–65).
- `references/status-md-format.md` — Step 2 full session log template.

Kept canonical:
- All steps in overview form
- Step 0.5 (pre-ship gates — critical)
- Step 7 (ship event — always fires)

#### C6 — plan-backend (267 → ~220 lines, saves ~400 tokens)

- `references/python-backend-profile.md` — the Python backend profile section (lines 44–78).
- `references/engineering-principles.md` — the 20 principles table (Phase 2).

Kept canonical:
- Phase 0 → `scripts/lib/repo-stack.mjs` wrapper
- Phase 1 explore
- Phase 1.5 execution model (short, critical)
- Phases 2–4 condensed

### Phase D — Cross-skill CLI extensions (new subcommands)

| File | Purpose |
|---|---|
| `scripts/cross-skill.mjs` (MODIFY) | Add `list-personas`, `add-persona`, `record-persona-session` subcommands. Move the 4 curl recipes from `persona-test` SKILL.md into these. |
| `scripts/learning-store.mjs` (MODIFY) | Add `listPersonasForApp`, `upsertPersona`, `recordPersonaSession` functions behind the CLI subcommands. |
| `tests/cross-skill-persona.test.mjs` (NEW) | Unit tests for the new subcommands (no-op when cloud unavailable). |

### Phase E — Sync + validation

| File | Purpose |
|---|---|
| `scripts/check-sync.mjs` (MODIFY) | Detect the 3 skill-directory copies (`.claude/` + `.github/` + top-level `skills/`) and flag any drift including reference files. |
| `package.json` (MODIFY) | Add `npm run check-skills` → runs `check-skill-refs.mjs` + `check-sync.mjs` together. |
| CI config (if any) | Add `check-skills` to PR checks. |

---

## 5. Risk & Trade-off Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Over-reading — model reads every ref "just in case" | Medium | Erases the token savings | Write tight triggers; measure via a quick check after Phase C1 (count Read() calls on persona-test across 5 sample invocations) |
| Under-reading — model misses needed content that moved to a ref | Medium | Skill quality degrades silently | For each ref, keep a 1-line *semantic summary* in SKILL.md alongside the trigger, so model has enough to decide; keep triggers specific enough to fire when content matters |
| Ref rot — summaries in the index drift from the ref bodies | High over time | Triggers fire for wrong content | `check-skill-refs.mjs` lint: parse each ref's first paragraph; compare to index summary; flag large divergence |
| Installer v1 → v2 migration breaks downstream repos | Low if done right | Skills stop working in downstream repos | Ship v2 schema with `files` as optional (default: `[{relPath: 'SKILL.md', ...}]`); old installers reading v2 manifests work fine for single-file skills |
| 3-way skill copies drift after refactor | High (this already happens) | Inconsistent behaviour in consumer repos | `check-sync.mjs` enforces byte equality across all 3 copies; CI gate |
| "Read when" triggers are subjective | Always | Inconsistent reading behaviour across runs | Anti-pattern section in `docs/skill-reference-format.md` catches the worst cases ("when relevant" etc.); over time, trigger phrasing converges through review |
| Refactor breaks a skill mid-session | Low | User-visible bug | Each skill refactors atomically: write the refs, update SKILL.md, sync the 3 copies, test the canonical invocation. Each skill is its own commit. |
| `persona-test`'s embedded curl becomes CLI subcommands that don't exist yet | Dependency risk | Skill broken during Phase C1 | Sequence: Phase D (CLI subcommands + tests) **before** Phase C1 (persona-test refactor). |

### Trade-offs made

- **Keep 3 skill copies** rather than symlinks or a single source: the existing installer architecture assumes copies; symlinks don't work on Windows; we instead rely on `check-sync` to enforce byte equality. Accepted cost: duplication disk footprint; duplication maintenance burden (mitigated by sync script).
- **Reference-index table rather than YAML frontmatter**: table is human-writable and human-readable inline; YAML would be more machine-friendly but fragments the skill author's flow. The parser is strict enough to reject malformed tables, so this is safe.
- **`files` array is additive, not replacing `path`**: kept both for backward compat. Slight data duplication (`path` points at same SKILL.md as `files[0]`) but old manifest readers still work. Accepted cost: schema size grows marginally.

### Deliberately deferred

- Browser-tool-detection library extraction — defer until `/ux-lock verify` grows anti-bot support. YAGNI.
- Automatic reference-index generation — defer. Human-authored triggers are higher quality than LLM-generated ones at this stage.
- Structured trigger metadata (YAML instead of free-form clauses) — defer. Free-form is sufficient for the current 6 skills; revisit if we grow to 15+.
- `examples/` directories — create only when a specific skill needs one (audit-loop + ux-lock likely qualify).

---

## 6. Testing Strategy

### Unit tests (added in Phase A)

- `tests/skill-refs-parser.test.mjs` — valid formats parse; malformed rows emit errors; missing files flagged; orphan files flagged.
- `tests/repo-stack.test.mjs` — each stack detection case (JS-only, Python-only, mixed, unknown); Python framework detection (FastAPI / Django / Flask / none).
- `tests/cross-skill-persona.test.mjs` — new persona subcommands return graceful no-op when cloud unavailable, validate required fields.
- `tests/install-multi-file-skill.test.mjs` — manifest v2 round-trips; dry-run install lists all files from `files` array.

### Integration tests (Phase C, per skill)

After each skill refactors, run a smoke test:
1. Read the new `SKILL.md` end-to-end — is the canonical flow still self-contained for the main success path?
2. Parse the ref-index — does every listed file exist?
3. For `persona-test` and `ux-lock verify` specifically: ensure no ref is needed for the "happy path" (minimum-viable P0 run).

### Lint (Phase E)

`npm run check-skills` composes:
- `scripts/check-skill-refs.mjs` — ref-index format + file existence + orphan files.
- `scripts/check-sync.mjs` — 3-way copy equality.

Added to `npm test` and (optionally) a CI gate.

### Regression check — does a refactor degrade skill behaviour?

Hard to test mechanically for LLM-driven skills. Instead:
- Keep each skill's canonical flow acceptance-testable at the CLI level where possible (e.g. `plan-satisfaction` subcommand returns the same shape).
- For skills with pure LLM orchestration (persona-test, audit-loop), do a **dogfood run** after each refactor: invoke the skill on the same task that was invoked pre-refactor; compare the output shape (report sections, severity counts, save-to-DB success) for parity.

### Token-cost measurement

Before-and-after metric captured in the plan's close-out:
- Per-skill SKILL.md token count (the 1-line target table in Section 1 is the before snapshot).
- A sample invocation trace showing which refs Claude Read(s) in practice.
- Goal: average invocation loads SKILL.md + ≤1 ref — total ≤4K tokens for heavy skills.

---

## 7. Phased Execution Order

| Phase | What | Depends on | Atomicity |
|---|---|---|---|
| **A** | Format spec, parser, lint script, repo-stack lib, tests | — | Single commit (format + lint + lib are independent, but all required for safety net) |
| **B** | Installer + sync multi-file support, manifest schema v2 | A (lint script is ready) | Single commit; bump `MANIFEST_SCHEMA_VERSION` |
| **D** | Cross-skill CLI subcommands for persona-test curl replacement | — (can start anytime) | One commit per subcommand + tests |
| **C1** | Refactor persona-test | A, B, D (D subcommands must exist) | One commit: refs created + SKILL.md trimmed + sync copies |
| **C2** | Refactor audit-loop | A, B | One commit |
| **C3** | Refactor ux-lock | A, B | One commit |
| **C4** | Refactor plan-frontend | A, B, + repo-stack lib | One commit |
| **C5** | Refactor ship | A, B, + repo-stack lib | One commit |
| **C6** | Refactor plan-backend | A, B, + repo-stack lib | One commit |
| **E** | check-sync extension, CI gate, `npm run check-skills` | All C phases | Single commit |

C1–C6 can run in parallel (independent files). Sequential order is suggested above (biggest saving first) so we can validate the approach on `persona-test` before propagating.

### Success metrics

Measured after Phase E completion:

| Metric | Target | How measured |
|---|---|---|
| Per-skill SKILL.md size | ≤3,000 tokens each | `wc -c` / 4 |
| First-invocation cost (SKILL.md + refs Read) | ≤4,000 tokens avg | Sample 5 invocations per heavy skill; count tokens in the Read() arguments |
| Cross-skill duplication | ≤50 tokens | Manual inspection after `repo-stack.mjs` extraction |
| All tests pass | 100% | `npm test` |
| `check-skills` lint | Zero violations | CI |
| No UX regression | User still calls `/skill-name`; same output shape | Dogfood per C-phase |

---

## Appendix A — Reference-index format quick card

For skill authors:

```markdown
## Reference files

This skill's canonical flow is above. Load a reference only when its trigger applies.

| File | Summary | Read when |
|---|---|---|
| `references/<topic>.md` | <one sentence> | <specific, detectable condition> |
```

**Good triggers**:
- *"user asks how this skill interacts with /ship"*
- *"step 4 fails twice in a row"*
- *"generating the final debrief section"*
- *"plan includes modal interactions"*

**Bad triggers (reject in review)**:
- *"when relevant"* / *"if useful"* / *"before proceeding"*
- *"for context"* — every invocation has context

---

## Appendix B — Anticipated post-refactor file counts

| Skill | SKILL.md lines | `references/` files | Approx SKILL.md tokens |
|---|---:|---:|---:|
| audit-loop | ~400 | 5 | ~3,000 |
| persona-test | ~350 | 6 | ~2,800 |
| plan-backend | ~220 | 2 | ~1,800 |
| plan-frontend | ~280 | 3 | ~2,200 |
| ship | ~280 | 2 | ~2,200 |
| ux-lock | ~250 | 4 | ~2,000 |
| **Total** | **~1,780** | **22** | **~14,000** |

vs. current **3,104 lines / 33,763 tokens** — **~42% reduction in canonical-flow tokens** and a much larger reduction in per-invocation cost once the "Read only when triggered" pattern operates as designed.
