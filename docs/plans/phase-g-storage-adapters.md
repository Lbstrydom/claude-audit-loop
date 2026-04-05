# Plan: Phase G — Pluggable Storage Adapters

- **Date**: 2026-04-05
- **Status**: Draft (follows Phase F)
- **Author**: Claude + Louis
- **Parent**: [skill-bundle-mega-plan.md](./skill-bundle-mega-plan.md)
- **Depends on**: Phase F complete (install infra deploys setup scripts)
- **Scope**: refactor `learning-store.mjs` into pluggable adapters. 5 backends: `noop` (default), `sqlite` (local cross-repo), `github` (no-external-DB), `postgres` (generic cloud), `supabase` (existing, refactored).

This is the **biggest** phase in the mega-plan. If its own audit surfaces complexity issues, we may split further: Phase G.1 (facade + noop + supabase refactor + backward-compat), G.2 (sqlite + postgres), G.3 (github adapter).

---

## 1. Context

The repo currently has Supabase-only cloud persistence for audit history,
bandit arms, FP patterns, and debt ledger. Public distribution requires
pluggability — teams use different storage (their own Postgres, GitHub
Issues, local SQLite, or nothing at all).

Phase G refactors `scripts/learning-store.mjs` into a facade that dispatches
on `AUDIT_STORE` env var. Each adapter lives in `scripts/lib/stores/<name>.mjs`.

**Key invariant**: zero behavioral change for current Supabase users. They
keep running without touching their config.

### Key Requirements

1. **Facade dispatches by env var** — `AUDIT_STORE=noop|sqlite|github|postgres|supabase`
2. **Backward-compat auto-detect** — unset `AUDIT_STORE` + set `SUPABASE_AUDIT_URL` → `supabase` adapter (with deprecation nudge)
3. **`noop` is the public default** — works out of the box, no config
4. **Data scoping enforced at facade level** — every query takes explicit `repoId`, per-entity scope documented (debt=per-repo, bandit=per-repo+global, prompts=global)
5. **Schema portability** — existing Postgres migrations work on any Postgres; SQLite-dialect variant auto-generated
6. **Adapter methods may no-op** — adapters declare which methods they support, facade tolerates no-ops
7. **Optional-dependency loading** — `better-sqlite3`, `pg`, `@octokit/rest`, `@supabase/supabase-js` loaded lazily, only when the corresponding adapter is selected
8. **All existing tests pass unchanged** — refactor preserves existing behavior

### Non-Goals

- Databricks adapter (reserved enum, post-Phase-G)
- Cross-backend migration tools (phase-out tooling, future)
- Adapter-level encryption — existing sensitivity flag + secret-pattern redaction from Phase D.2 are the only protection
- Multi-repo federation via github adapter (per-repo only)
- Read-replica support / write sharding — single connection per process

---

## 2. Proposed Architecture

### 2.1 Adapter Interface

**New module**: `scripts/lib/stores/interface.mjs`

```javascript
/**
 * LearningStoreInterface — contract all adapters implement.
 * Methods marked "core" must be functional for the adapter to be useful.
 * Methods marked "optional" may return no-op values.
 */
export const LearningStoreInterface = {
  // ── Lifecycle (core for all adapters) ──
  async init() -> boolean                      // true = connected/ready
  isConnected() -> boolean
  async close() -> void                         // release resources

  // ── Repo management (core) ──
  async upsertRepo(profile, repoName) -> string|null
  async getRepoByFingerprint(fingerprint) -> object|null

  // ── Audit runs (optional, per-run tracking) ──
  async recordRunStart(repoId, planFile, mode) -> string|null
  async recordRunComplete(runId, stats) -> void

  // ── Findings (optional) ──
  async recordFindings(runId, findings, passName, round) -> void
  async recordPassStats(runId, passName, stats) -> void
  async recordAdjudicationEvent(runId, fingerprint, event) -> void
  async recordSuppressionEvents(runId, result) -> void

  // ── Learning state (optional, degrades to local files) ──
  async syncBanditArms(arms) -> void
  async loadBanditArms() -> object|null
  async syncFalsePositivePatterns(repoId, patterns) -> void
  async loadFalsePositivePatterns(repoId) -> {repoPatterns, globalPatterns}
  async syncExperiments(experiments) -> void
  async syncPromptRevision(passName, revisionId, text) -> void

  // ── Debt ledger (core for github/sqlite/postgres/supabase, noop-only for noop) ──
  async upsertDebtEntries(repoId, entries) -> {ok, error?}
  async readDebtEntries(repoId) -> object[]
  async removeDebtEntry(repoId, topicId) -> {ok, error?}
  async appendDebtEvents(repoId, events) -> {inserted, error?}
  async readDebtEvents(repoId) -> object[]
};
```

**Adapter capability declaration**: each adapter exports a `capabilities` object:

```javascript
// stores/noop-store.mjs
export const capabilities = {
  name: 'noop',
  cloudEnabled: false,
  supportsDebtLedger: false,      // debt-ledger calls bypass noop adapter, use local file
  supportsAuditHistory: false,
  supportsCrossRepoLearning: false,
};
```

The facade uses `capabilities` to decide whether to bypass the adapter
(e.g., for debt-ledger calls on `noop`, the facade reads/writes
`.audit/tech-debt.json` directly instead of calling adapter methods).

### 2.2 Facade (refactored `learning-store.mjs`)

The existing `scripts/learning-store.mjs` becomes a thin facade:

```javascript
// scripts/learning-store.mjs — facade, dispatches to adapter

import { selectAdapter } from './lib/stores/index.mjs';

let _adapter = null;

export async function initLearningStore() {
  const adapterName = pickAdapterFromEnv();
  _adapter = await loadAdapterModule(adapterName);
  const ok = await _adapter.init();
  process.stderr.write(`  [learning] Adapter: ${adapterName} ${ok ? '(connected)' : '(init failed, degrading to noop)'}\n`);
  return ok;
}

// Facade methods delegate to adapter, honor capabilities for routing
export async function upsertRepo(profile, name) {
  return _adapter ? _adapter.upsertRepo(profile, name) : null;
}
// ... etc. for all methods
```

**Backward-compat shim**: the old method names with "Cloud" suffix (e.g.,
`readDebtEntriesCloud`) remain as deprecation wrappers that log-once and
forward to new names:

```javascript
let _deprecationsLogged = new Set();
export async function readDebtEntriesCloud(repoId) {
  if (!_deprecationsLogged.has('readDebtEntriesCloud')) {
    process.stderr.write('  [learning] readDebtEntriesCloud is deprecated, use readDebtEntries\n');
    _deprecationsLogged.add('readDebtEntriesCloud');
  }
  return readDebtEntries(repoId);
}
```

These shims stay for Phase G then are removed in a future phase.

### 2.3 Adapter Selection (`pickAdapterFromEnv`)

Order of checks:

1. `AUDIT_STORE` explicitly set → use it
2. `AUDIT_STORE` unset + `SUPABASE_AUDIT_URL` + `SUPABASE_AUDIT_ANON_KEY` set → **`supabase`** + log one-time notice: "auto-detected Supabase config — set AUDIT_STORE=supabase to silence this notice"
3. `AUDIT_STORE` unset + `AUDIT_STORE_POSTGRES_URL` set → **`postgres`** + notice
4. `AUDIT_STORE` unset + `AUDIT_STORE_SQLITE_PATH` set → **`sqlite`** + notice
5. None → **`noop`** (silent, no notice)

**Fail-fast on explicit-but-broken config**: if `AUDIT_STORE=supabase` but required env vars missing, exit with clear error listing missing vars. Do NOT silently fall back to noop.

### 2.4 Adapter: `noop`

**Default when no config**. Silent no-op for every method. Returns:
- `null` for ID-returning methods (`upsertRepo`, `recordRunStart`)
- `[]` for list-returning methods (`readDebtEntries`, `loadBanditArms`)
- `{ok: true}` for write methods
- `true` from `init()`, `isConnected()`

**Why it exists**: operators who haven't configured anything get a working
audit-loop. Every cloud call silently no-ops. Debt ledger + event log + all
other local-file features keep working via the `.audit/` directory (Phase D).

**No dependencies** beyond Node built-ins.

### 2.5 Adapter: `sqlite` (local cross-repo)

**Env**: `AUDIT_STORE=sqlite` + optional `AUDIT_STORE_SQLITE_PATH` (default: `~/.audit-loop/shared.db`)

**Use case**: solo dev working across N repos on one machine. All repos share
bandit arms + FP patterns + audit history. Debt is per-repo (scoped by
`repoId` in every query).

**Storage**: single SQLite file with schema adapted from existing Postgres
migrations. Adapter init runs migrations if tables missing.

**Schema portability**: auto-translates Postgres → SQLite:
- `UUID` → `TEXT`
- `JSONB` → `TEXT` (with JSON1 extension for queries)
- `TIMESTAMPTZ` → `TEXT` (ISO-8601)
- `gen_random_uuid()` → `lower(hex(randomblob(16)))`

Translation is mechanical — a small script (`scripts/lib/stores/sqlite-schema.mjs`)
generates the SQLite-dialect SQL from the canonical Postgres migrations.

**Dependencies**: `better-sqlite3` (optional dep, only required when `AUDIT_STORE=sqlite`).

**Concurrency**: WAL mode enabled. Two parallel audit-loop processes serialize
writes via SQLite's own locking. No corruption possible.

**Setup command**: `node scripts/setup-sqlite.mjs` — creates `~/.audit-loop/`,
initializes DB, runs migrations. One-shot.

### 2.6 Adapter: `github` (no external DB)

**Env**: `AUDIT_STORE=github` + `GITHUB_TOKEN`

**Use case**: team wants audit history visible to the team via GitHub, but
doesn't want to manage a database. Data lives in the repo itself.

**Storage strategy** (hybrid):

| Data | Location | Format |
|---|---|---|
| Debt ledger | `.audit/tech-debt.json` on main branch | Committed JSON (already Phase D) |
| Debt events | Dedicated `audit-events/main` branch | JSONL append-only log |
| Audit runs | GitHub Issues with label `audit-run` | Issue body = JSON metadata |
| Findings per run | Comments on the run's Issue | JSON in each comment |
| Bandit arms + FP patterns | `.audit/learning-state.json` on `audit-events/main` branch | JSON blob, per-repo |

**Why dedicated branch**: keeps high-frequency event writes out of main's
commit history.

**Consistency + concurrency**:

| Concern | Behavior |
|---|---|
| Idempotency | Every write carries a client-generated UUID; duplicates detected + skipped |
| Parallel writers | `git push --force-with-lease` + retry on conflict (5 attempts, exp. backoff) |
| Pagination | Auto-paginate reads (`per_page=100`), stream results |
| Retry | Transient failures retried 3x (1s/2s/4s); 429 → sleep until `X-RateLimit-Reset` |
| Compaction | Every 1000 events OR 30 days (whichever first), squash event log → snapshot commit. Old events preserved in archive branches (`audit-events/archive/YYYY-MM`) |
| Visibility | Sensitive-flagged debt entries (Phase D.2 `sensitive: true`) NEVER written to public Issues. Event log excludes `rationale` text for sensitive entries |
| Schema version | Each event carries `schemaVersion`. Reader tolerates older; writer emits current |

**Rate limits**: GitHub API 5000/hr authenticated. Normal usage well under.
Tight for CI at scale — document `--batch` hint for CI operators.

**Required GitHub permissions** (documented for PAT / Actions workflow):
- `contents: write` (commit to `audit-events/main`)
- `issues: write` (create + comment on audit-run Issues)
- `metadata: read`

**Dependencies**: `@octokit/rest` (optional, only when `AUDIT_STORE=github`).

**Setup command**: `node scripts/setup-github-store.mjs` — creates
`audit-events/main` branch from scratch, commits initial empty state.

**Limitations**:
- Per-repo only (no multi-repo federation on GitHub-native — users wanting cross-repo learning combine github adapter per-repo with postgres for cross-repo bandit arms)
- GitHub-specific (GitLab/Bitbucket adapters are future phases)

### 2.7 Adapter: `postgres` (generic)

**Env**: `AUDIT_STORE=postgres` + `AUDIT_STORE_POSTGRES_URL`

**Use case**: team has existing Postgres (AWS RDS, Azure DB, GCP Cloud SQL,
Neon, Railway, Fly, Render, Crunchy Bridge, self-hosted) and doesn't want
Supabase.

**Storage**: same schema as Supabase (existing `supabase/migrations/*.sql`
are standard Postgres — verified portable during Phase G implementation).
Migrations applied via `scripts/setup-postgres.mjs` at init if tables missing.

**Dependencies**: `pg` (node-postgres, optional dep).

**Connection**: standard `pg.Pool`. TLS honored via connection string params.

**Setup command**: `node scripts/setup-postgres.mjs --url "$AUDIT_STORE_POSTGRES_URL"` — runs all migrations, verifies schema version.

**Works with** (documented in `docs/setup/postgres.md`):
- AWS RDS for PostgreSQL
- Azure Database for PostgreSQL
- Google Cloud SQL Postgres
- Neon (serverless, free tier)
- Railway, Fly, Render, Crunchy Bridge
- Self-hosted Postgres 13+

### 2.8 Adapter: `supabase` (existing, refactored)

**Env**: `AUDIT_STORE=supabase` + `SUPABASE_AUDIT_URL` + `SUPABASE_AUDIT_ANON_KEY`

**Behavior**: exact existing behavior of `scripts/learning-store.mjs` before
Phase G. Current Supabase users see zero change.

**Refactor**: extract existing code into `scripts/lib/stores/supabase-store.mjs`,
make `@supabase/supabase-js` an optional dep, wire through facade.

**Setup command**: `node scripts/setup-supabase.mjs` — unchanged from
current behavior (already applies migrations via Management API).

### 2.9 Adapter: `databricks` (DEFERRED — reserved enum slot)

Documented in the `AUDIT_STORE` enum + `docs/setup/storage-backends.md` as a
future contribution slot. NOT implemented in Phase G. Zero code. If an
enterprise user needs it, they contribute the adapter following the interface.

### 2.10 Data Scoping Policy

Per-entity scope enforced at the facade (adapter-independent):

| Entity | Scope |
|---|---|
| `debt_entries`, `debt_events` | per-repo |
| `audit_runs`, `audit_findings`, `audit_pass_stats` | per-repo |
| `suppression_events`, `finding_adjudication_events` | per-repo |
| `bandit_arms` | per-repo (primary) + global (cross-repo priors) |
| `false_positive_patterns` | per-repo (primary) + global |
| `prompt_variants`, `prompt_revisions`, `prompt_experiments` | global (codebase-agnostic, about audit-loop itself) |

**Enforcement**: every facade query takes explicit `repoId` parameter. Methods
that read global data are named explicitly (e.g., `listGlobalPromptVariants`).
Adapters receive pre-scoped queries from the facade — they don't need to
enforce scoping themselves, but MUST pass the filter through to the backend
(SQL WHERE clause, API filter, etc.).

**sqlite adapter specifically**: stores multiple repos in one `.db` file,
every query is parametrized with `repoId`, no cross-repo leakage possible.

**github adapter specifically**: inherently per-repo (data lives on the repo's
own branches + Issues). Global-scoped entities (`prompt_variants`) are NOT
available via this adapter — documented limitation. Users wanting prompt-variant
sharing combine github + postgres.

### 2.11 Optional Dependency Loading

`better-sqlite3`, `pg`, `@octokit/rest`, `@supabase/supabase-js` are declared
as **`optionalDependencies`** in `package.json`. `npm install` tries to install
them but doesn't fail if a native binary can't build.

Facade loads adapter modules via dynamic `import()` — only the selected
adapter's deps are required at runtime. Missing dep → clear error at adapter
init time: "adapter X requires package Y — run `npm install Y`".

**Why this matters**: a public user who only wants `noop` shouldn't need to
build `better-sqlite3` binaries or install `pg`. Optional deps keep install
lightweight for the common case.

---

## 3. File Impact Summary

**New files**:

| File | Purpose |
|---|---|
| `scripts/lib/stores/interface.mjs` | Documents `LearningStoreInterface` |
| `scripts/lib/stores/index.mjs` | Facade helpers, adapter selection |
| `scripts/lib/stores/noop-store.mjs` | No-op adapter (default) |
| `scripts/lib/stores/sqlite-store.mjs` | Local cross-repo DB |
| `scripts/lib/stores/github-store.mjs` | Branch + Issues backend |
| `scripts/lib/stores/postgres-store.mjs` | Generic Postgres backend |
| `scripts/lib/stores/supabase-store.mjs` | Refactored from existing `learning-store.mjs` |
| `scripts/lib/stores/sqlite-schema.mjs` | Postgres-to-SQLite migration translator |
| `scripts/setup-sqlite.mjs` | One-shot local DB setup |
| `scripts/setup-github-store.mjs` | Creates `audit-events/main` branch |
| `scripts/setup-postgres.mjs` | Applies migrations to user's Postgres |
| `scripts/setup-supabase.mjs` | Unchanged from current |
| `docs/setup/storage-backends.md` | Decision tree + capability matrix |
| `docs/setup/sqlite.md` | Local setup walkthrough |
| `docs/setup/github.md` | GitHub-native setup |
| `docs/setup/postgres.md` | Per-provider walkthrough (AWS/Azure/Neon/etc.) |
| `docs/setup/supabase.md` | BYO Supabase walkthrough |
| `tests/stores/*.test.mjs` | Per-adapter tests + shared conformance suite |

**Modified files**:

| File | Change |
|---|---|
| `scripts/learning-store.mjs` | Becomes facade, dispatches to adapter |
| `package.json` | Add optionalDependencies: `better-sqlite3`, `pg`, `@octokit/rest` |
| `.env.example` | Document all 5 `AUDIT_STORE` values + per-adapter env vars |

**NOT touched**: debt ledger code (`scripts/lib/debt-ledger.mjs`), existing skills, Phase E/F infrastructure.

---

## 4. Testing Strategy

### Shared Adapter Conformance Suite

Every adapter runs the same suite of ~40 tests covering:
- Lifecycle (`init`, `isConnected`, `close`)
- Repo upsert + retrieval
- Debt entry CRUD (if supported)
- Debt event append + read (if supported)
- Scoping: query with `repoId=A` doesn't return rows from repo B
- Idempotency: duplicate writes tolerated
- Per-adapter capability declarations accurate

Each adapter's test file calls `runConformance(adapter)` + adds adapter-specific tests.

### Per-Adapter Tests

| Adapter | Specific tests |
|---|---|
| `noop` | Every call returns no-op value; facade routes debt-ledger to local files |
| `sqlite` | Schema translation correct; WAL mode enabled; concurrent writes serialize; cross-repo scoping enforced |
| `github` | Idempotency keys work; pagination streams correctly; rate-limit backoff; sensitive entries excluded; compaction |
| `postgres` | Connection pool; TLS; migration runner; schema version check |
| `supabase` | Existing tests — MUST pass unchanged |

### Integration Tests

- Auto-detect: unset `AUDIT_STORE` + set Supabase vars → supabase adapter
- Auto-detect: unset everything → noop adapter
- Explicit `AUDIT_STORE=supabase` + missing anon key → fail-fast with clear error
- Facade deprecation wrappers log-once and forward correctly
- Data scoping: global-scoped queries don't leak repo data

### Smoke Tests (gated `AUDIT_LOOP_SMOKE=1`)

- Real SQLite round-trip against temp `.db` file
- Real Postgres round-trip against CI-provided test DB
- Real GitHub adapter round-trip against a disposable test repo
- Existing Supabase smoke test (passes unchanged)

---

## 5. Rollback Strategy

- **Revert to Supabase-only**: set `AUDIT_STORE=supabase`; facade dispatches to old code path (extracted adapter is identical to pre-refactor behavior).
- **Per-adapter rollback**: delete adapter module + remove from `pickAdapterFromEnv()`; fall back to remaining adapters.
- **Full revert of Phase G**: git revert; `learning-store.mjs` restored; deprecation wrappers gone.
- **Consumer rollback**: change `AUDIT_STORE` to different value; data in old backend remains untouched (no migration happens).

---

## 6. Implementation Order

1. **Interface definition** — `stores/interface.mjs` + capabilities schema
2. **Schema portability audit** — verify `supabase/migrations/*.sql` is standard Postgres; extract any Supabase-only RLS policies into separate file
3. **Extract Supabase adapter** — `stores/supabase-store.mjs` byte-faithful refactor of existing code. Facade dispatches. ALL EXISTING TESTS PASS.
4. **Build facade** — `scripts/learning-store.mjs` becomes dispatcher. Add `pickAdapterFromEnv` with auto-detect.
5. **Implement `noop`** — trivial, becomes new default.
6. **Shared conformance test suite** — exercises every interface method against each adapter.
7. **Implement `sqlite`** — dialect translator, init, migrations, WAL mode, concurrency tests.
8. **Implement `postgres`** — `pg.Pool`, migration runner, setup script. Tests against CI Postgres.
9. **Implement `github`** — Octokit client, branch handling, Issues, compaction, retry/rate-limit. Tests against fixture repo.
10. **Data scoping enforcement** — facade always passes `repoId`; per-entity scope tests for each adapter.
11. **Optional dependency loading** — lazy imports, clear errors on missing deps.
12. **Documentation** — `docs/setup/*.md` files, decision tree, capability matrix.
13. **Deprecation wrappers** — old `*Cloud` method names log-once + forward.
14. **Backward-compat integration test** — existing Supabase env vars → supabase adapter auto-detected.
15. **Final `npm test`** — baseline + ~100 new tests.

---

## 7. Known Limitations (accepted for Phase G)

1. **Data migration between adapters not automated** — switching from sqlite to postgres requires manual export/import.
2. **`github` adapter is per-repo only** — no cross-repo federation on GitHub-native.
3. **`github` adapter rate limits** — 5000/hr tight for heavy CI; documented with `--batch` guidance.
4. **Native dep builds** — `better-sqlite3` requires C compiler on some platforms; documented in setup guide.
5. **Schema evolution** — adding new tables/columns requires coordinated migration across all 4 cloud adapters. For now, Phase G locks the schema; schema changes are future-phase work.
6. **No adapter-level encryption** — sensitivity handled at Phase D.2's redaction layer.
7. **Backward-compat shims live forever (ish)** — the `*Cloud` deprecation wrappers stay through Phase G. Future phase can remove them when no users depend on old names.

---

## 8. Resolved Design Decisions

| # | Question | Decision | Why |
|---|---|---|---|
| Q1 | Which adapters in Phase G? | 5: noop, sqlite, github, postgres, supabase | Covers 95% of real-world storage needs |
| Q2 | Default adapter? | `noop` | Zero-config, works out of the box |
| Q3 | How to preserve existing Supabase users? | Auto-detect on legacy env vars | No action required from them |
| Q4 | Where does interface live? | `stores/interface.mjs` as documented JSDoc types | Simple, no runtime enforcement needed |
| Q5 | Optional deps packaging? | `optionalDependencies` + lazy import | Lightweight for `noop` default users |
| Q6 | github adapter data split? | Debt → main commit; events/history → dedicated `audit-events/main` branch; runs → Issues | Matches write-frequency to storage type |
| Q7 | Rename `readDebtEntriesCloud` → `readDebtEntries`? | Yes, with deprecation wrappers | Interface should be backend-agnostic |
| Q8 | Data scoping enforced at adapter or facade? | Facade passes explicit `repoId`; adapter filters at query time | Single enforcement point, adapter-agnostic |
| Q9 | Schema portability strategy? | Keep Postgres migrations canonical; auto-translate to SQLite | No schema duplication |
| Q10 | Cross-backend migration tooling in Phase G? | No — operator exports/imports manually | Scope tight; future phase if demand |
| Q11 | Databricks adapter in Phase G? | No — reserved enum slot, future contribution | Enterprise-scale, needs validated demand |
| Q12 | Unit test strategy? | Shared conformance suite + per-adapter specifics | Reduces test-maintenance burden |
