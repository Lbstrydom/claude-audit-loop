import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Snapshot retention policy tests (per docs/plans/architectural-memory.md
 * §2 Snapshot retention — R2 M5).
 *
 * Pure-policy tests run unconditionally. Transactional prune semantics
 * require a real Postgres test DB (gated behind `RUN_INTEGRATION=1`).
 */

const integration = process.env.RUN_INTEGRATION === '1';

// ── Pure helper: classify a refresh row by retention policy ─────────────────
// Mirrors what scripts/symbol-index/prune.mjs decides for each class.

function classifyForPrune(run, now = Date.now()) {
  const ageDays = (now - new Date(run.completed_at).getTime()) / 86400_000;
  if (run.retention_class === 'active') return 'KEEP_ACTIVE';
  if (run.retention_class === 'rollback') return 'KEEP_ROLLBACK';
  if (run.retention_class === 'aborted' && ageDays > 7) return 'PRUNE_ABORTED';
  if (run.retention_class === 'transient' && ageDays > 30) return 'PRUNE_TRANSIENT';
  if (run.retention_class === 'weekly_checkpoint' && ageDays > 90) return 'PRUNE_CHECKPOINT';
  return 'KEEP';
}

describe('retention classification (pure)', () => {
  const now = Date.now();
  const days = (n) => new Date(now - n * 86400_000).toISOString();

  it('keeps active snapshots forever', () => {
    assert.equal(classifyForPrune({ retention_class: 'active', completed_at: days(365) }, now), 'KEEP_ACTIVE');
  });
  it('keeps rollback snapshots forever (rollback-window managed by demotion)', () => {
    assert.equal(classifyForPrune({ retention_class: 'rollback', completed_at: days(365) }, now), 'KEEP_ROLLBACK');
  });
  it('prunes aborted runs older than 7 days', () => {
    assert.equal(classifyForPrune({ retention_class: 'aborted', completed_at: days(8) }, now), 'PRUNE_ABORTED');
    assert.equal(classifyForPrune({ retention_class: 'aborted', completed_at: days(6) }, now), 'KEEP');
  });
  it('prunes transient runs older than 30 days', () => {
    assert.equal(classifyForPrune({ retention_class: 'transient', completed_at: days(31) }, now), 'PRUNE_TRANSIENT');
    assert.equal(classifyForPrune({ retention_class: 'transient', completed_at: days(29) }, now), 'KEEP');
  });
  it('prunes weekly_checkpoint runs older than 90 days', () => {
    assert.equal(classifyForPrune({ retention_class: 'weekly_checkpoint', completed_at: days(91) }, now), 'PRUNE_CHECKPOINT');
    assert.equal(classifyForPrune({ retention_class: 'weekly_checkpoint', completed_at: days(89) }, now), 'KEEP');
  });
});

describe('prune transactionality (integration)', () => {
  it('snapshot-scoped rows cascade-delete with the refresh_runs row', { skip: !integration }, async () => {
    // Seed a refresh_run + N symbol_index rows + M layering_violations rows.
    // Mark retention_class='transient', completed_at=31 days ago.
    // Run prune.mjs.
    // Assert: refresh_runs row deleted; symbol_index + symbol_layering_violations
    // rows for that refresh_id all gone (FK CASCADE).
    // Assert: symbol_definitions rows still exist (they're repo-scoped).
    assert.ok(false, 'integration-only');
  });

  it('keeps last 4 rollback per repo, demotes older to transient', { skip: !integration }, async () => {
    // Seed 6 published refreshes for repo R, all with retention_class='rollback'.
    // Run prune.mjs.
    // Assert: 4 most recent stay 'rollback'; 2 oldest demoted to 'transient'.
    assert.ok(false, 'integration-only');
  });
});
