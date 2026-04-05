# Mega-Plan: Skill-Bundle Consolidation + Public Distribution

- **Date**: 2026-04-05
- **Status**: Parent doc — split into 4 sub-phases (E/F/G/H) after 2-round audit surfaced scope-too-large
- **Author**: Claude + Louis
- **Scope**: Consolidate the 5 engineering skills (`audit-loop`, `plan-backend`, `plan-frontend`, `ship`, `audit`) into this repo as a bundle, add Python support, ship cross-platform install + update infrastructure, add pluggable storage backends, and prepare the repo for public distribution.
- **Why split**: original combined plan hit HIGH count growth R1→R2 (7→8) during audit-loop review — classic signal of too many architectural concerns at once. Splitting into 4 focused phases makes each auditable in 2-3 rounds and shippable independently.

---

## Phase Sequence

Each sub-phase ships independently. Dependencies flow forward: E before F, F before G, G before H.

### [Phase E — Skill Consolidation + Python Profiles + Rename](./phase-e-skill-consolidation-python.md)

**Scope**: vendor the 4 external skills into this repo, add Python sections to each planning skill, rename repo to `claude-engineering-skills`.

**Delivers**:
- All 5 skills as byte-authoritative copies in `skills/` directory
- Python language profiles in `plan-backend`, `plan-frontend`, `ship`, `audit`
- Repo renamed, README rewritten for bundle scope
- Install-by-copy documented for consumers (pre-infra)

**Does NOT deliver** (out of scope):
- Automated installer
- Update-check mechanism
- Storage adapters beyond existing Supabase
- Public release hardening

**Ship when**: Louis's team has Python-aware skills + one source of truth for skill editing.

---

### [Phase F — Install + Update Infrastructure](./phase-f-install-update-infra.md)

**Scope**: bootstrap script + installer CLI + update-check CLI with 24hr cache. Consumer repos can `curl | node` install once, then `bootstrap.mjs` manages fetching/updating.

**Delivers**:
- `.audit-loop/bootstrap.mjs` deployed to consumer repos (~50 LoC stable entry point)
- `scripts/install-skills.mjs` (local + remote modes)
- `scripts/check-skill-updates.mjs` (deterministic SHA diff, 24hr cached)
- `skills.manifest.json` with content-hash versioning
- Managed-marker file-ownership (no clobbering operator edits)
- Block-marker merge for `.github/copilot-instructions.md`
- Atomic two-phase install commit

**Does NOT deliver**:
- Storage adapters (Phase G)
- Supply-chain signing (Phase H)

**Depends on**: Phase E complete.

**Ship when**: consumer repos can self-update skills without manual copy-paste.

---

### [Phase G — Pluggable Storage Adapters](./phase-g-storage-adapters.md)

**Scope**: refactor `learning-store.mjs` into pluggable adapters. 5 backends: noop (default), sqlite (local cross-repo), github (no-external-DB), postgres (generic cloud), supabase (existing).

**Delivers**:
- `LearningStoreInterface` + facade that dispatches on `AUDIT_STORE` env
- Backward-compat auto-detect preserves existing Supabase user behavior
- `stores/noop-store.mjs` — silent no-op (default)
- `stores/sqlite-store.mjs` — local `~/.audit-loop/shared.db`, cross-repo learning
- `stores/postgres-store.mjs` — generic Postgres (AWS RDS, Azure, Neon, Railway, self-hosted)
- `stores/supabase-store.mjs` — refactored from current `learning-store.mjs`
- `stores/github-store.mjs` — dedicated `audit-events/main` branch + Issues
- Setup scripts per adapter (`setup-sqlite.mjs`, `setup-postgres.mjs`, etc.)
- Data scoping policy enforced: per-entity scope (debt=per-repo, bandit=per-repo+global, prompts=global)
- Schema portability: Postgres migrations work on any Postgres; SQLite-dialect variant auto-generated

**Does NOT deliver**:
- Databricks adapter (reserved enum slot, future contribution)
- Cross-backend migration tools
- Adapter-level encryption

**Depends on**: Phase F (install infrastructure needed to deploy setup scripts).

**Ship when**: public users can run audit-loop with no cloud OR bring their own backend of choice.

---

### [Phase H — Public-Distribution Hardening](./phase-h-public-distribution.md)

**Scope**: supply-chain integrity, signed checksums, release channels, security audit, first public launch.

**Delivers**:
- Signed SHA manifest (released as GitHub Release asset)
- Release channels: `main` (latest) vs `stable` (tagged, verified)
- Checksum verification in installer + bootstrap
- Security audit: env-var handling, secret-pattern coverage, CODEOWNERS defaults
- Automated release workflow (GitHub Action)
- SECURITY.md, CONTRIBUTING.md, CODE_OF_CONDUCT.md
- Public launch blog post / release notes

**Depends on**: Phase G complete.

**Ship when**: repo is publishable to wider audience with integrity guarantees.

---

## Why These Boundaries

Each phase has **one primary architectural concern**:

| Phase | Primary concern | Architectural risk | Complexity bound |
|---|---|---|---|
| E | Content + structure | Low — content moves, principles clarify | ~400 lines plan, ~30 new tests |
| F | Client-side machinery | Medium — cross-platform paths, file-ownership | ~500 lines plan, ~40 new tests |
| G | Backend abstractions + concurrency | High — 5 adapters, each with own consistency story | ~700 lines plan, ~100 new tests |
| H | Release engineering + security | Medium — process + signing, no new runtime code | ~300 lines plan, ~20 new tests |

Phase G is the biggest and should be split further if its own audit surfaces complexity issues.

---

## Shared Context (referenced by all sub-phases)

### Copilot Skills Conventions (Dec 2025+ official)

GitHub Copilot officially supports `SKILL.md` files under:
- `.github/skills/<name>/SKILL.md` — primary location for Copilot
- `.claude/skills/<name>/SKILL.md` — also recognized
- `.agents/skills/<name>/SKILL.md` — also recognized

The `SKILL.md` format with YAML frontmatter (`name`, `description`, optional `license`, `allowed-tools`) is **identical** to Claude Code's format. Same file works on both surfaces.

Reference libraries: [anthropic/skills](https://github.com/anthropic/skills), [github/awesome-copilot](https://github.com/github/awesome-copilot).

Sources:
- [Creating agent skills for GitHub Copilot](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/create-skills)
- [Use Agent Skills in VS Code](https://code.visualstudio.com/docs/copilot/customization/agent-skills)
- [GitHub Copilot now supports Agent Skills (Dec 2025 changelog)](https://github.blog/changelog/2025-12-18-github-copilot-now-supports-agent-skills/)

### Current State (as of Phase D.7 ship)

**Skills currently living in** `~/.claude/skills/` (Louis's global install):
- `audit-loop` (~28KB, already this repo's `.claude/skills/audit-loop/SKILL.md`)
- `plan-backend` (~8.5KB) — 20 engineering principles, language-agnostic
- `plan-frontend` (~13KB) — Gestalt + engineering principles, moderate JS coupling
- `ship` (~7.7KB) — commit/push/docs flow, stack-agnostic
- `audit` (~15KB) — single-pass plan audit

**Existing storage backend**: Supabase-only. Graceful fallback to local files when unconfigured. See `.env.example` for full env-var surface.

**Known pain points** (what this mega-plan addresses):
- Skills drift between Louis's global copies and team repos (no update mechanism)
- No Python support in planning skills (team is Python-first)
- Installation is manual copy-paste across surfaces
- Current repo name `claude-audit-loop` no longer reflects broader scope
- Supabase-only backend blocks public distribution

### Invariants Across All Phases

1. **Zero behavioral change for current Supabase users** — all 4 phases preserve existing env vars + existing data
2. **No breaking changes to Louis's existing repos** — install is always additive
3. **No npm/PyPI publish required** — distribution via GitHub raw URLs
4. **Atomic file writes** — every persisted file uses `atomicWriteFileSync` (from Phase 0)
5. **Tests green at each phase end** — current 604/604 must grow monotonically

### Out of Scope Across All Phases

- Copilot Plugins packaging (defer — watch API stability)
- Python data-science profiles (Jupyter, Streamlit) — web services only
- Multi-language skills beyond JS/TS/Python (Go, Rust, Java) — per request
- GitLab/Bitbucket native adapters — future if demand materializes
- Automatic skill updates (requires operator-run command)
- Skill marketplace / discovery UI
- Databricks adapter (reserved enum slot, post-H)
- Cross-backend migration tools

---

## Audit Trail

This mega-plan supersedes the original unified `phase-e-skill-bundle-consolidation.md` that was
audit-looped and showed HIGH count growth (R1 H:7 → R2 H:8) — the signal that scope
needed splitting. Original plan preserved in git history at commit d6b7f16+ for reference.

Each sub-phase will be audit-looped independently when it's ready to build.
