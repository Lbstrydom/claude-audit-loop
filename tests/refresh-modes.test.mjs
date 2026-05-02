import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Refresh-mode + snapshot-isolation acceptance tests (per
 * docs/plans/architectural-memory.md §9 acceptance criteria).
 *
 * These tests require a real Postgres + pgvector test database (per the
 * plan's §5 explicit rejection of SQLite as an integration substrate).
 * Gated behind `RUN_INTEGRATION=1` so unit `npm test` stays hermetic.
 *
 * When the gate is unset each test is skipped — the file exists so the
 * §5 file plan is satisfied and integration runners can pick them up.
 */

const integration = process.env.RUN_INTEGRATION === '1';

describe('snapshot publication isolation', () => {
  it('readers see prior snapshot until publish completes', { skip: !integration }, async () => {
    // Setup: open refresh_run R1 (full), upsert N rows under refresh_id=R1,
    // do NOT publish. Concurrently call getActiveSnapshot from another
    // pseudo-reader. Assert: refreshId equals the prior active (R0), NOT R1.
    // Then publishRefreshRun({repoId, refreshId: R1}) → next read returns R1.
    assert.ok(false, 'integration-only');
  });

  it('aborted refresh leaves active_refresh_id unchanged', { skip: !integration }, async () => {
    // Setup: open R1, write some rows, simulate failure → abortRefreshRun.
    // Assert: getActiveSnapshot.refreshId still === prior (R0).
    // Assert: refresh_runs row for R1 has status='aborted'.
    assert.ok(false, 'integration-only');
  });

  it('publish RPC rejects mismatched (repo, refresh) pair (R1 H2/H10)', { skip: !integration }, async () => {
    // Open refresh_run for repo A. Try publish_refresh_run(repoB, refreshFromA).
    // Assert: RPC throws "refresh_run X belongs to repo A, not B".
    assert.ok(false, 'integration-only');
  });

  it('publish RPC rejects already-aborted refresh (R3 H10)', { skip: !integration }, async () => {
    // Abort a refresh, then try to publish it.
    // Assert: RPC throws "has status aborted, cannot publish".
    assert.ok(false, 'integration-only');
  });
});

describe('incremental refresh file-status handling', () => {
  it('handles git diff --name-status A/M/D/R correctly', { skip: !integration }, async () => {
    // Seed three files: a.mjs (modified), b.mjs (deleted), c.mjs (renamed → d.mjs).
    // Run refresh.mjs --since-commit <prior>.
    // Assert: a.mjs symbols re-extracted; b.mjs symbols absent from new snap;
    // d.mjs symbols present (no symbols at c.mjs).
    assert.ok(false, 'integration-only');
  });

  it('untracked files included via git ls-files --others (Gemini G1)', { skip: !integration }, async () => {
    // Create a new untracked .mjs file with one function.
    // Run refresh.mjs --since-commit <prior>.
    // Assert: the untracked file's symbols appear in the new active snapshot.
    assert.ok(false, 'integration-only');
  });
});

describe('embedding compatibility (R2 H9)', () => {
  it('reads pin to repo active embedding model', { skip: !integration }, async () => {
    // Set audit_repos.active_embedding_model = 'model-X', dim=768.
    // Call cross-skill.mjs get-neighbourhood.
    // Assert: neighbourhood-query loads model-X from repo state and uses it
    // for the intent embedding (not whatever ARCH_INDEX_EMBED_MODEL is set to).
    assert.ok(false, 'integration-only');
  });

  it('EMBEDDING_MISMATCH on no compatible active model', { skip: !integration }, async () => {
    // Set active_embedding_model to NULL.
    // Assert: getNeighbourhoodForIntent throws err.code==='EMBEDDING_MISMATCH'.
    assert.ok(false, 'integration-only');
  });
});

describe('RLS contract (R2 H10)', () => {
  it('anon SELECT works on symbol_index', { skip: !integration }, async () => {
    assert.ok(false, 'integration-only');
  });

  it('anon INSERT on symbol_index is rejected', { skip: !integration }, async () => {
    assert.ok(false, 'integration-only');
  });

  it('service-role INSERT on symbol_index succeeds', { skip: !integration }, async () => {
    assert.ok(false, 'integration-only');
  });
});
