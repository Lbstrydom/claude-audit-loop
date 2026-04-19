---
name: ship
description: |
  Sync all project documentation, optionally update a plan, then commit and push to git.
  Updates status.md (session log), syncs CLAUDE.md to AGENTS.md, and handles git workflow.
  Use when the user is ready to commit and push their work.
  Usage: /ship — sync docs + commit + push
  Usage: /ship docs/plans/feature.md — also update the plan before committing
  Triggers on: "ship it", "commit and push", "push my changes", "ready to ship".
  IMPORTANT: This command runs autonomously — no confirmation prompts. The user invoking
  /ship is their approval to update docs, commit, and push in one uninterrupted flow.
disable-model-invocation: true
---

# Ship: Sync Docs → Commit → Push

You are running the ship workflow. This is a single command that ensures all project
documentation is current, then commits and pushes. Follow every step in order.

**Arguments**: `$ARGUMENTS` — optional path to a plan file to update (e.g., `docs/plans/feature.md`)

---

## Phase 0 — Repo Stack Detection

Before Step 1, detect the repo's primary language(s) to determine which pre-push checks to run:

- **JS/TS**: `package.json` present with `dependencies` or `devDependencies`
- **Python**: `pyproject.toml`, `requirements.txt`, `Pipfile`, `setup.py`, or `uv.lock` present
- **Mixed**: both present -- run checks for BOTH stacks
- **Unknown**: neither -- skip stack-specific checks, proceed with universal git workflow

When Python is detected, also identify the **framework** (affects status.md section naming):

- **FastAPI**: `fastapi` in deps
- **Django**: `django` in deps, or `manage.py` present
- **Flask**: `flask` in deps
- **None/custom**: generic Python

### Python Pre-Push Command Discovery

Detection ORDER: detect the environment manager FIRST, then probe commands through that wrapper:

1. **Environment wrapper** (detected first):
   - `poetry.lock` present -- all subsequent probes use `poetry run <cmd> --version`
   - `uv.lock` or `uv.toml` present -- use `uv run <cmd> --version`
   - `Pipfile.lock` present -- use `pipenv run <cmd> --version`
   - `.venv/` or `venv/` present -- use `./<venv>/bin/<cmd> --version`
   - None detected -- fall back to global PATH (`<cmd> --version`)

2. **Then** discover tools IN the detected environment:
   - **Test runner**: probe for `pytest` through the env wrapper, else `python -m pytest`, else MISSING
   - **Linter**: `ruff check --version` if `[tool.ruff]` in pyproject or `ruff` in locked deps; else `flake8 --version`; else MISSING
   - **Type checker**: `mypy --version` if `[tool.mypy]` or `mypy.ini` present; else `pyright --version`; else MISSING
   - **Format check**: `ruff format` if ruff detected; else `black --version` if `[tool.black]` or `black` in locked deps; else MISSING

### Python Pre-Push Contract

| Category | If MISSING |
|---|---|
| Test runner | **BLOCK push**, log: "no test runner detected (pytest). Add `pytest` to dev deps or override with `ship --no-tests`." |
| Linter | Warn, do NOT block |
| Type checker | Warn, do NOT block |
| Format check | Warn, do NOT block |

For each DISCOVERED tool: any non-zero exit BLOCKS the push.

**Override flag**: `ship --no-tests` acknowledges the absence explicitly. Logged prominently.

### Python status.md Sections

When generating/updating status.md for Python repos:
- "Python Package Structure" (vs "Backend Structure")
- "Dependencies" from `pyproject.toml` `[project.dependencies]` or `requirements.txt`
- "Database Migrations" (Alembic/Django migrations)
- "API Endpoints" (FastAPI/Django REST Framework/Flask routes)

---

## Step 0.5 — Pre-Ship Gate Queries (non-blocking by default)

Collect signals before proceeding so the ship_event emitted at the end is
accurate. All queries are best-effort; if any fails, log it and proceed.

### 0.5a — Recent persona-test P0s for this repo

If `PERSONA_TEST_SUPABASE_URL` and `PERSONA_TEST_REPO_NAME` are set:

```bash
curl -s "$PERSONA_TEST_SUPABASE_URL/rest/v1/persona_test_sessions?repo_name=eq.$PERSONA_TEST_REPO_NAME&p0_count=gt.0&order=created_at.desc&limit=1&select=persona,focus,verdict,p0_count,p1_count,created_at,debrief_md" \
  -H "apikey: $PERSONA_TEST_SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $PERSONA_TEST_SUPABASE_ANON_KEY"
```

Capture `open_p0_count` and `open_p1_count` from the latest session (within
the last 14 days). These feed the ship_event record. If a session has P0s:

```
⚠ UX GATE (non-blocking)
  Last persona test: "<persona>" — <N> days ago → <verdict> (P0: <n>, P1: <n>)
  Unresolved P0s detected. These are user-visible broken flows.
  Shipping anyway — consider fixing before next user-facing release.
```

### 0.5b — Fixes that lack a /ux-lock regression spec

Query the `unlocked_fixes` view for recent HIGH-severity fixes without a
regression spec (these are the refactor-fragile spots):

```bash
node scripts/cross-skill.mjs list-unlocked-fixes
```

The command prints `{"ok":true,"cloud":true,"rows":[...]}`. Count the rows
as `missing_spec_count`. If > 0:

```
⚠ REGRESSION LOCK GATE (non-blocking)
  <n> recent HIGH-severity fix(es) have no /ux-lock spec:
    • <primary_file>: <one-line detail>
  These will silently regress under future refactors.
  Consider: /ux-lock <commit-hash> for each.
```

### 0.5c — Override flags

If `$ARGUMENTS` contains `--no-tests`, `--ignore-p0`, or `--skip-ux-lock`,
note which override was used — it's recorded with the ship_event.

## Step 1 — Assess What Changed

Before updating any docs, understand the current state:

1. **Run `git status`** to see all modified, added, and untracked files
2. **Run `git diff --stat`** to see a summary of changes
3. **Run `git diff` on key changed files** to understand what was actually done
4. **Run `git log -5 --oneline`** to see recent commit style and context

Build a mental model of:
- What features/fixes were implemented
- Which files were created vs modified
- What area of the codebase was affected (backend, frontend, both)
- Whether new patterns or conventions were established

---

## Step 2 — Update status.md

Append a new session log entry to `status.md` in the project root.

**If `status.md` does not exist**, create it with a header:

```markdown
# Project Status Log

## <Today's Date> — <Brief Summary of Work>

### Changes
- <Bullet list of what was done, grouped logically>

### Files Affected
- <List of key files created or modified, with one-line purpose>

### Decisions Made
- <Any architectural or design decisions taken during this session>

### Next Steps
- <What remains to be done, if anything>

---
```

**If `status.md` already exists**, append the new entry at the TOP (below the header),
so the most recent session is always first.

**Rules for the log entry**:
- Be specific — name actual files, functions, and endpoints
- Be concise — this is a log, not documentation
- Include decisions — these are valuable context for future sessions
- Include blockers or open questions if any remain
- Date format: YYYY-MM-DD

---

## Step 3 — Update CLAUDE.md (If Needed)

Review whether the current session introduced anything that should be captured in CLAUDE.md:

### Check for new patterns:
- [ ] New route files or API endpoints added? → Update Backend Structure section
- [ ] New frontend modules added? → Update Frontend Structure section
- [ ] New service patterns established? → Document the pattern
- [ ] New environment variables introduced? → Update Environment Variables table
- [ ] New conventions or rules discovered? → Add to Do/Do NOT sections
- [ ] New test files or testing patterns? → Update Testing section

### Check for outdated information:
- [ ] File structure descriptions still accurate?
- [ ] Code examples still reflect current patterns?
- [ ] Configuration values still correct?

**If changes are needed**: Make the edits to CLAUDE.md, keeping the existing style and structure.

**If no changes needed**: Skip this step — do not make unnecessary edits.

---

## Step 4 — Sync AGENTS.md

AGENTS.md must mirror CLAUDE.md exactly. After any CLAUDE.md changes:

1. **Read CLAUDE.md** content
2. **Write to AGENTS.md** with identical content
3. **Verify** the files are in sync

If CLAUDE.md was not modified in Step 3, check whether AGENTS.md is already in sync.
If it is already identical, skip this step. If it has drifted, re-sync it.

**Important**: AGENTS.md should live in the same directory as CLAUDE.md (project root).

---

## Step 5 — Update Plan (If Plan Path Provided)

Only execute this step if `$ARGUMENTS` contains a plan file path.

1. **Read the plan file** at the provided path
2. **Compare against git diff** — which planned items were implemented in this session?
3. **Update the plan metadata**:
   - Change `Status: Draft` → `Status: In Progress` (if first implementation session)
   - Change `Status: In Progress` → `Status: Complete` (if all items done)
4. **Update the file-level plan** — mark completed items:

```markdown
| Planned Item | Status | Notes |
|-------------|--------|-------|
| `src/routes/feature.js` | ✅ Done | Implemented as planned |
| `src/services/feature.js` | ✅ Done | Added extra helper function |
| `public/js/feature.js` | ⏳ In Progress | Basic structure, needs event wiring |
| `tests/unit/feature.test.js` | ❌ Not Started | — |
```

5. **Add an implementation log entry** at the bottom of the plan:

```markdown
## Implementation Log

### <Today's Date>
- Completed: <what was built>
- Remaining: <what is left>
- Deviations: <any changes from the original plan and why>
```

6. **Flag any deviations** — if the implementation diverged from the plan,
   note what changed and why so the next session has context.

---

## Step 6 — Stage, Commit, and Push

### 6.1 Stage files

Stage all relevant files. Be specific — add files by name:

```bash
git add <list of changed source files>
git add status.md
git add CLAUDE.md AGENTS.md    # Only if they were modified
git add docs/plans/<plan>.md   # Only if plan was updated
```

**Do NOT stage**:
- `.env` or any file containing secrets
- `node_modules/`
- Temporary or generated files

If there are untracked files that look unintentional (random temp files, OS files),
skip them silently. Include all source code, docs, tests, and config files.

### 6.2 Generate commit message

Analyse the staged changes and create a commit message following the project convention:

```
<type>: <concise description of what changed>

<optional body with details if the change is significant>
```

**Types**: `feat`, `fix`, `refactor`, `docs`, `style`, `test`, `chore`

- If changes span multiple types, use the primary type and mention others in the body
- Keep the first line under 72 characters
- The body should explain WHY, not WHAT (the diff shows what)

### 6.3 Commit and push

**The `/ship` command IS the user's approval.** Do NOT ask for confirmation.
Proceed directly — stage, commit, and push in one flow.

```bash
git commit -m "<message>"
git push origin <current-branch>
```

If push fails (e.g., behind remote), inform the user and suggest the fix.
Do NOT force push.

---

## Step 7 — Emit Ship Event (always)

After the commit + push completes (or is blocked), record the outcome so the
cross-skill store has a full history of what was gated, overridden, or let
through. This runs even on block/abort so gate effectiveness can be measured.

```bash
node scripts/cross-skill.mjs record-ship-event --json '{
  "outcome": "shipped" | "blocked" | "warned" | "overridden" | "aborted",
  "blockReasons": ["test-failure","lint-failure","type-check-failure","format-failure","open-p0","missing-regression-spec","secrets-detected"],
  "openP0Count": <from Step 0.5a>,
  "openP1Count": <from Step 0.5a>,
  "missingSpecCount": <from Step 0.5b>,
  "overriddenByUser": <true if any override flag was used>,
  "overrideFlag": "<e.g. --no-tests or null>",
  "stackDetected": "js-ts" | "python" | "mixed" | "unknown",
  "framework": "<fastapi|django|flask|null>",
  "durationMs": <wall-clock ms from step 0.5 to now>
}'
```

**Outcome semantics**:
- `shipped` — everything passed, commit pushed
- `warned` — shipped despite non-blocking warnings (UX gate triggered but still pushed)
- `overridden` — user passed `--no-tests` or similar to bypass a block
- `blocked` — a blocking check failed and the push did not occur
- `aborted` — Claude aborted before pushing (e.g. secrets detected, nothing to commit)

`blockReasons` is always an array — empty on `shipped`, populated otherwise.

The command is fire-and-forget; do not block on its output. If cloud mode is
off, the CLI prints `{"ok":true,"cloud":false}` and returns 0.

---

## Quick Reference

| Syntax | What Happens |
|--------|-------------|
| `/ship` | Update status.md → sync CLAUDE.md/AGENTS.md → commit → push |
| `/ship docs/plans/feature.md` | All of the above + update the plan file |

## Reminders

- **Always check git diff first** — understand what changed before documenting
- **status.md is a log** — append, never rewrite history
- **CLAUDE.md only changes when needed** — do not make cosmetic edits
- **AGENTS.md is a mirror** — always identical to CLAUDE.md
- **No confirmation needed** — `/ship` is the approval. Execute the full flow autonomously
- **Be specific in the log** — name files, functions, endpoints. Vague entries are useless
- **The commit message matters** — it is the permanent record in git history
