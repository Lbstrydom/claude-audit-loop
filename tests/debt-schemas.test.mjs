/**
 * @fileoverview Phase D — schema tests.
 * Covers persisted/hydrated split, per-reason required fields, source markers.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PersistedDebtEntrySchema,
  HydratedDebtEntrySchema,
  DebtEntrySchema,
  DebtEventSchema,
  DebtLedgerSchema,
  LedgerEntrySchema,
  DeferredReasonEnum,
} from '../scripts/lib/schemas.mjs';

const baseEntry = {
  source: 'debt',
  topicId: 'abc12345',
  semanticHash: 'hash01',
  severity: 'HIGH',
  category: 'Test Category',
  section: 'src/x.js:10',
  detailSnapshot: 'some details about the finding',
  affectedFiles: ['src/x.js'],
  affectedPrinciples: ['SRP'],
  pass: 'backend',
  deferredReason: 'out-of-scope',
  deferredAt: '2026-04-05T10:00:00.000Z',
  deferredRun: 'audit-r1',
  deferredRationale: 'this is a sufficiently long rationale string',
  contentAliases: [],
  sensitive: false,
};

test('PersistedDebtEntrySchema — accepts valid out-of-scope entry', () => {
  const r = PersistedDebtEntrySchema.safeParse(baseEntry);
  assert.equal(r.success, true, r.error?.message);
});

test('PersistedDebtEntrySchema — rejects deferredRationale < 20 chars', () => {
  const r = PersistedDebtEntrySchema.safeParse({ ...baseEntry, deferredRationale: 'too short' });
  assert.equal(r.success, false);
});

test('PersistedDebtEntrySchema — rejects invalid deferredReason', () => {
  const r = PersistedDebtEntrySchema.safeParse({ ...baseEntry, deferredReason: 'lazy' });
  assert.equal(r.success, false);
});

test('PersistedDebtEntrySchema — blocked-by without blockedBy fails', () => {
  const r = PersistedDebtEntrySchema.safeParse({ ...baseEntry, deferredReason: 'blocked-by' });
  assert.equal(r.success, false);
  assert.match(r.error.message, /blockedBy/);
});

test('PersistedDebtEntrySchema — blocked-by with blockedBy passes', () => {
  const r = PersistedDebtEntrySchema.safeParse({
    ...baseEntry, deferredReason: 'blocked-by', blockedBy: 'owner/repo#42',
  });
  assert.equal(r.success, true, r.error?.message);
});

test('PersistedDebtEntrySchema — deferred-followup without followupPr fails', () => {
  const r = PersistedDebtEntrySchema.safeParse({ ...baseEntry, deferredReason: 'deferred-followup' });
  assert.equal(r.success, false);
  assert.match(r.error.message, /followupPr/);
});

test('PersistedDebtEntrySchema — accepted-permanent requires approver AND approvedAt', () => {
  const missing = PersistedDebtEntrySchema.safeParse({
    ...baseEntry, deferredReason: 'accepted-permanent', approver: 'alice',
  });
  assert.equal(missing.success, false);
  assert.match(missing.error.message, /approvedAt/);

  const complete = PersistedDebtEntrySchema.safeParse({
    ...baseEntry,
    deferredReason: 'accepted-permanent',
    approver: 'alice',
    approvedAt: '2026-04-05T10:00:00.000Z',
  });
  assert.equal(complete.success, true, complete.error?.message);
});

test('PersistedDebtEntrySchema — policy-exception requires policyRef AND approver', () => {
  const r = PersistedDebtEntrySchema.safeParse({
    ...baseEntry, deferredReason: 'policy-exception', policyRef: 'SEC-001', approver: 'alice',
  });
  assert.equal(r.success, true, r.error?.message);
});

test('PersistedDebtEntrySchema — source must be literal "debt"', () => {
  const r = PersistedDebtEntrySchema.safeParse({ ...baseEntry, source: 'session' });
  assert.equal(r.success, false);
});

test('HydratedDebtEntrySchema — accepts derived fields', () => {
  const r = HydratedDebtEntrySchema.safeParse({
    ...baseEntry,
    occurrences: 3,
    distinctRunCount: 3,
    matchCount: 7,
    lastSurfacedRun: 'audit-r5',
    lastSurfacedAt: '2026-04-05T15:00:00.000Z',
    escalated: true,
    escalatedAt: '2026-04-05T16:00:00.000Z',
  });
  assert.equal(r.success, true, r.error?.message);
});

test('HydratedDebtEntrySchema — derived fields default to 0/false when absent', () => {
  const r = HydratedDebtEntrySchema.safeParse(baseEntry);
  assert.equal(r.success, true);
  assert.equal(r.data.occurrences, 0);
  assert.equal(r.data.distinctRunCount, 0);
  assert.equal(r.data.matchCount, 0);
  assert.equal(r.data.escalated, false);
});

test('DebtEntrySchema === HydratedDebtEntrySchema (alias)', () => {
  assert.equal(DebtEntrySchema, HydratedDebtEntrySchema);
});

test('DebtEventSchema — accepts all event types', () => {
  const events = ['deferred', 'surfaced', 'reopened', 'escalated', 'resolved', 'reconciled'];
  for (const ev of events) {
    const r = DebtEventSchema.safeParse({
      ts: '2026-04-05T10:00:00.000Z', runId: 'r1', topicId: 'a', event: ev,
    });
    assert.equal(r.success, true, `event=${ev}: ${r.error?.message}`);
  }
});

test('DebtEventSchema — rejects invalid event type', () => {
  const r = DebtEventSchema.safeParse({
    ts: '2026-04-05T10:00:00.000Z', runId: 'r1', topicId: 'a', event: 'frozen',
  });
  assert.equal(r.success, false);
});

test('DebtEventSchema — topicId optional (for reconciled markers)', () => {
  const r = DebtEventSchema.safeParse({
    ts: '2026-04-05T10:00:00.000Z', runId: 'r1', event: 'reconciled',
  });
  assert.equal(r.success, true, r.error?.message);
});

test('DebtEventSchema — surfaced may carry matchCount', () => {
  const r = DebtEventSchema.safeParse({
    ts: '2026-04-05T10:00:00.000Z', runId: 'r1', topicId: 'a', event: 'surfaced', matchCount: 3,
  });
  assert.equal(r.success, true);
  assert.equal(r.data.matchCount, 3);
});

test('LedgerEntrySchema — backward compat (source defaults to "session")', () => {
  // Old ledger without source field should still validate
  const r = LedgerEntrySchema.safeParse({
    topicId: 'a', semanticHash: 'b',
    adjudicationOutcome: 'dismissed', remediationState: 'pending',
    severity: 'HIGH', originalSeverity: 'HIGH',
    category: 'c', section: 's', detailSnapshot: 'd',
    affectedFiles: [], affectedPrinciples: [],
    ruling: 'sustain', rulingRationale: 'r',
    resolvedRound: 1, pass: 'p',
  });
  assert.equal(r.success, true, r.error?.message);
  assert.equal(r.data.source, 'session');
});

test('DebtLedgerSchema — accepts empty ledger', () => {
  const r = DebtLedgerSchema.safeParse({ version: 1, entries: [] });
  assert.equal(r.success, true);
});

test('DebtLedgerSchema — rejects version != 1', () => {
  const r = DebtLedgerSchema.safeParse({ version: 2, entries: [] });
  assert.equal(r.success, false);
});

test('DebtLedgerSchema — budgets map accepts globs with numbers', () => {
  const r = DebtLedgerSchema.safeParse({
    version: 1,
    entries: [],
    budgets: { 'scripts/lib/**': 20, 'scripts/openai-audit.mjs': 5 },
  });
  assert.equal(r.success, true);
});

test('DeferredReasonEnum — 5 valid reasons', () => {
  assert.deepEqual(DeferredReasonEnum.options.sort(), [
    'accepted-permanent', 'blocked-by', 'deferred-followup', 'out-of-scope', 'policy-exception',
  ]);
});
