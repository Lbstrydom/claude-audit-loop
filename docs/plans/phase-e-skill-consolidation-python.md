# Plan: Phase E — Skill Consolidation + Python Profiles + Rename

- **Date**: 2026-04-05
- **Status**: Draft, pending audit-loop review
- **Author**: Claude + Louis
- **Parent**: [skill-bundle-mega-plan.md](./skill-bundle-mega-plan.md)
- **Scope**: Vendor the 4 external engineering skills (`plan-backend`, `plan-frontend`, `ship`, `audit`) into this repo alongside `audit-loop`. Add Python language profiles. Rename the repo. NO installer, NO storage adapters, NO public-distribution work.

---

## 1. Context

This repo currently houses only `audit-loop`. Four other skills live in Louis's
global `~/.claude/skills/`. That's the pain point: skill edits happen in one
place (Louis's laptop), consumer repos get stale copies, Python teams have
no Python-aware planning principles.

Phase E is the **content phase**: move the skills in, add Python, rename. No
new infrastructure, no new dependencies. Result: the bundle exists as a coherent
set of authoritative files, Python teams get first-class support, future phases
(F/G/H) have a stable foundation to build installers and adapters against.

### Key Requirements

1. **Byte-faithful vendoring**: copy each skill verbatim before editing. Preserves git-diffable "before/after" visibility.
2. **Python as first-class**: plan-backend, plan-frontend, ship, audit each gain a "Repo Stack Detection" section + Python-specific principles + commands.
3. **Repo rename preserves old URLs**: GitHub auto-redirects, existing clones keep working.
4. **No new runtime dependencies**: this is a content-only phase.
5. **Tests stay green**: 604/604 must remain passing.

### Non-Goals

- Installer / update-check infrastructure (Phase F)
- Storage adapters (Phase G)
- Supply-chain signing (Phase H)
- Python data-science profiles (Jupyter, Streamlit) — web services only
- Consumer-repo "install" automation — Phase E consumers copy files manually

---

## 2. Proposed Architecture

### 2.1 Directory Layout

**New canonical location**: `skills/` at repo root.

```
claude-engineering-skills/
├── skills/                          # canonical source of truth
│   ├── audit-loop/SKILL.md
│   ├── plan-backend/SKILL.md
│   ├── plan-frontend/SKILL.md
│   ├── ship/SKILL.md
│   └── audit/SKILL.md
├── .claude/skills/                  # mirrored copies for this repo's own use
│   └── audit-loop/SKILL.md          # (other 4 skills NOT mirrored — those are Louis's global)
└── .github/skills/                  # mirrored for Copilot when using this repo
    └── audit-loop/SKILL.md
```

**Rationale for `skills/` as canonical**: puts authoritative files in a visible,
top-level location separate from `.claude/` / `.github/` installed mirrors. When
Phase F ships the installer, `skills/` becomes the source that `install-skills.mjs`
reads.

**Why not mirror all 5 skills into `.claude/skills/` immediately?** Because Louis's
`~/.claude/skills/` already has 4 of them. Adding per-repo mirrors in this repo
would cause conflicts with his global install. Per-repo `.claude/skills/audit-loop/`
exists only because `audit-loop` is THIS repo's self-referential skill.

### 2.2 Vendoring Process

**One commit per skill**, in this order:

1. **plan-backend**: copy `~/.claude/skills/plan-backend/SKILL.md` → `skills/plan-backend/SKILL.md` verbatim
2. **plan-frontend**: copy → `skills/plan-frontend/SKILL.md` verbatim
3. **ship**: copy → `skills/ship/SKILL.md` verbatim
4. **audit**: copy → `skills/audit/SKILL.md` verbatim
5. **audit-loop**: copy `.claude/skills/audit-loop/SKILL.md` → `skills/audit-loop/SKILL.md` verbatim (this is the only skill already in the repo)

After these 5 commits, git diff from main shows "5 files added, byte-identical to external copies". No semantic changes yet. Verifiable.

**Verification command** (one-liner):
```bash
diff ~/.claude/skills/plan-backend/SKILL.md skills/plan-backend/SKILL.md
# ... repeat for each skill, all should produce zero output
```

### 2.3 Python Profile Additions

Each of plan-backend, plan-frontend, ship, audit gains a **Phase 0 — Repo Stack Detection** section (inserted BEFORE existing Phase 1).

**Shared detection logic** (same block in each skill):

```markdown
## Phase 0 — Repo Stack Detection

Before Phase 1, detect the repo's primary language(s):

- **JS/TS**: `package.json` present with `dependencies` or `devDependencies`
- **Python**: `pyproject.toml`, `requirements.txt`, `Pipfile`, `setup.py`, or `uv.lock` present
- **Mixed**: both present (e.g. Python backend + TS frontend)
- **Unknown**: neither → proceed with universal principles only, skip stack-specific sections

Based on detection, reference the **stack profile** section below (JS/TS profile OR Python profile).
When mixed, apply BOTH profiles — the skill covers multiple concerns.
```

**plan-backend Python profile** (appended to existing content):

- File-layout expectations: `src/<pkg>/` or `<pkg>/`, `routes/api/views/`, `services/domain/`, `models/schemas/`, `migrations/`, `tests/`
- Python-specific principle checks:
  - Type hints (`mypy --strict` clean)
  - Pydantic validation at boundaries (no dict-bashing)
  - Async consistency (no sync-in-async)
  - Dependency injection (`Depends()` vs module-level singletons)
  - DB session scope (one per request)
  - ORM N+1 prevention (`select_related` / `joinedload` / `prefetch_related`)
  - Exception hierarchy (custom `AppException` base, no bare `except:`)
  - Settings via typed `pydantic-settings` BaseSettings
- Stack commands: `pytest`, `ruff check`, `ruff format`, `mypy`/`pyright`, `uv sync`/`poetry install`
- Python-specific anti-patterns: global DB session, sync-in-async, any-typed returns, dict-passing, Django fat views

**plan-frontend Python profile** (appended):

Focus on server-rendered (Jinja, Django templates, HTMX) since that's ~90% of Python "frontend":

- File layout: `templates/`, `static/`, optional `frontend/` for separate JS build
- Python FE principle checks: template inheritance, HTMX progressive enhancement, CSRF on mutations, server-side form validation, context data discipline, static asset versioning
- Python-specific anti-patterns: logic in templates, `|safe` without justification, direct ORM access from templates

**ship Python profile** (appended):

- Test command discovery: `pytest`, `python -m pytest`, `poetry run pytest`, `uv run pytest`
- Lint check: `ruff check .` (or `flake8 .`)
- Type check: `mypy .` or `pyright .` (if configured)
- Format check: `ruff format --check .` or `black --check .`
- Pre-push: run **all four** (test/lint/type/format), fail-fast on any error
- Status.md section naming: "Python Package Structure" (vs "Backend Structure"), "Dependencies" from pyproject.toml, "Database Migrations" (Alembic/Django), "API Endpoints"

**audit Python profile** (appended):

Same principle checks as plan-backend's Python profile, used when the audit
detects a Python repo during its file-classification phase.

### 2.4 Repo Rename

**Action**: `gh repo rename claude-engineering-skills`

**Consequences**:
- GitHub automatically creates a redirect from `claude-audit-loop` → `claude-engineering-skills`
- Existing clones continue to work (`git remote -v` shows old URL until user runs `git remote set-url`)
- Internal references updated in one commit: `package.json` name, `README.md` title, `CLAUDE.md` project overview
- Commit messages going forward don't mention the rename

**README rewrite** (Phase E scope):
- New title: "Claude Engineering Skills"
- Tagline: "A bundle of 5 AI-pair-programming skills for planning, auditing, shipping"
- Per-skill one-liner + link to each SKILL.md
- Installation section: for now, manual copy instructions (Phase F replaces this)
- Python support mention
- Link to mega-plan for the multi-phase roadmap

**CLAUDE.md update**: Project Overview section now describes the bundle instead of "multi-model audit loop". Architecture and dependencies sections remain accurate (still the audit-loop's internals).

### 2.5 What Happens to Louis's Global `~/.claude/skills/`

**Unchanged by Phase E.** Phase E is additive to this repo only. Louis's global
skills keep working as-is. When Phase F ships the installer, Louis will run it
once to align his global install with this repo's `skills/` directory.

**Migration checklist for Louis after Phase E**:
- [ ] `skills/` in this repo now exists; external copies in `~/.claude/skills/` are still authoritative UNTIL Phase F
- [ ] Louis continues editing skills in `~/.claude/skills/` OR in this repo's `skills/` — whichever he prefers
- [ ] If edits happen in both places, Louis manually syncs until Phase F ships
- [ ] Post-Phase-F: `~/.claude/skills/` is overwritten by the installer, becoming a managed mirror of this repo's `skills/`

This is explicit tech debt that Phase F resolves. Called out in the plan so it's not a surprise.

---

## 3. File Impact Summary

| File | Action |
|---|---|
| `skills/audit-loop/SKILL.md` | **Copy** from `.claude/skills/audit-loop/SKILL.md` (already in repo) |
| `skills/plan-backend/SKILL.md` | **Copy** from `~/.claude/skills/plan-backend/SKILL.md` + add Python profile |
| `skills/plan-frontend/SKILL.md` | **Copy** from `~/.claude/skills/plan-frontend/SKILL.md` + add Python profile |
| `skills/ship/SKILL.md` | **Copy** from `~/.claude/skills/ship/SKILL.md` + add Python profile |
| `skills/audit/SKILL.md` | **Copy** from `~/.claude/skills/audit/SKILL.md` + add Python profile |
| `package.json` | Rename `name` field: `claude-audit-loop` → `claude-engineering-skills` |
| `README.md` | Rewrite for bundle scope + link to mega-plan + Python support |
| `CLAUDE.md` | Update Project Overview section |
| GitHub repo name | One-time `gh repo rename` action |

**NOT touched by Phase E**: `.claude/skills/`, `.github/skills/`, `.agents/skills/`, any scripts, any tests. The audit-loop existing tests continue passing unchanged.

---

## 4. Testing Strategy

Phase E is content changes — no new runtime code. Tests are verification steps:

| Verification | How |
|---|---|
| All 5 skills present in `skills/` | `ls skills/*/SKILL.md \| wc -l` = 5 |
| Vendored skills byte-match their external sources (before Python edits) | `diff ~/.claude/skills/<name>/SKILL.md skills/<name>/SKILL.md` = empty for each (AT VENDORING STEP, before Python additions) |
| Python profiles added to 4 skills | `grep -l "Python Backend Profile\|Python Frontend Profile\|Python Repo Stack" skills/*/SKILL.md \| wc -l` = 4 |
| `package.json` name updated | `jq .name package.json` = `"claude-engineering-skills"` |
| Existing audit-loop tests still pass | `npm test` = 604/604 passing |
| No new dependencies | `git diff package.json` shows only `name` field changed |
| Repo rename effective | `gh repo view` shows new name; old URL redirects |
| Frontmatter valid on all vendored skills | each SKILL.md has `name:` + `description:` YAML frontmatter |

**Manual verification** (operator-run after ship):
- Open `skills/plan-backend/SKILL.md` in a Python repo context with Claude Code, verify it cites Python principles
- Invoke each skill by name once to confirm frontmatter parses correctly

**No new automated tests** — Phase E is pure content. Phase F adds infrastructure tests.

---

## 5. Rollback Strategy

- **Repo rename**: `gh repo rename claude-audit-loop` reverses it. GitHub preserves redirects both ways.
- **Vendored skills**: delete `skills/` directory. External copies in `~/.claude/skills/` untouched.
- **Python profile additions**: git revert the specific commit that added them.
- **Package.json name**: one-field change, trivial revert.
- **README/CLAUDE.md**: git revert.

Nothing in Phase E is destructive. Every change is reversible via git + one GitHub API call.

---

## 6. Implementation Order

1. **Ship D.8 first** — close remaining PR comment gaps (independent, clears the decks)
2. **Rename repo** — `gh repo rename claude-engineering-skills`. Update `package.json` name, `README.md` title, `CLAUDE.md` overview. One commit.
3. **Vendor audit-loop** — copy `.claude/skills/audit-loop/SKILL.md` → `skills/audit-loop/SKILL.md`. One commit.
4. **Vendor plan-backend** — copy from `~/.claude/skills/plan-backend/SKILL.md` → `skills/plan-backend/SKILL.md` byte-faithful. One commit.
5. **Vendor plan-frontend** — same pattern. One commit.
6. **Vendor ship** — same pattern. One commit.
7. **Vendor audit** — same pattern. One commit.
8. **Add Python profile to plan-backend** — append Phase 0 detection + Python principles. One commit.
9. **Add Python profile to plan-frontend** — same. One commit.
10. **Add Python profile to ship** — same. One commit.
11. **Add Python profile to audit** — same. One commit.
12. **README rewrite** — bundle scope, 5-skill quick reference, Python support note, link to mega-plan. One commit.
13. **Manual verification** — Louis tests plan-backend in a Python repo, confirms principles land. Documented in commit or follow-up note.

**Estimated commits**: ~11-12. Each is focused, auditable, and reversible.

---

## 7. Known Limitations (accepted for Phase E)

1. **Parallel edit channels remain** — Louis can edit in `~/.claude/skills/` OR in this repo's `skills/`. Until Phase F ships the installer, no sync mechanism. Operator discipline required.
2. **No consumer-repo install** — team members still manually copy skill files. Phase F solves this.
3. **Python profile quality untested** — Phase E ships the content; effectiveness gets validated via real Python audits post-ship. First audit in a Python repo may surface profile gaps, which become Phase E follow-up fixes (not Phase F blockers).
4. **Repo rename may confuse bookmarks** — GitHub redirect covers URLs; team members with local clones see old remote name until they manually update.
5. **`.github/skills/audit-loop/` and `.claude/skills/audit-loop/` remain the active mirrors** during Phase E — not auto-synced with `skills/audit-loop/`. This repo will briefly have 3 copies of the audit-loop SKILL.md. Resolved in Phase F when the installer becomes the single sync path.

---

## 8. Resolved Design Decisions

| # | Question | Decision | Why |
|---|---|---|---|
| Q1 | Where to put vendored skills? | `skills/` at repo root | Visible, top-level, separate from install mirrors |
| Q2 | Vendor verbatim first, then edit? | Yes — one commit per skill, byte-faithful copy | Git-diffable before/after for reviewers |
| Q3 | Add Python profiles in Phase E or defer? | Add in Phase E | Content phase is the right time; delay forces a 2nd content pass later |
| Q4 | Which Python stacks to cover? | Web services (FastAPI/Django/Flask) + server-rendered FE (Jinja/HTMX/Django templates) | Team's primary use case |
| Q5 | Keep data-science / Jupyter out? | Yes, Phase E web services only | Data-science is a different audit surface entirely |
| Q6 | Sync `.claude/skills/` mirrors during Phase E? | No — defer to Phase F installer | Phase E is content only, no sync logic |
| Q7 | Rename before or after vendoring? | Before — ensures all new files reference new repo name | Cleaner, no retrofit |
| Q8 | Manual test of Python profiles blocks ship? | No — documented as known-limitation, validated post-ship | Blocks phase on something operator can fix incrementally |
