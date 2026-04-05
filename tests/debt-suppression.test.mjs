/**
 * @fileoverview Phase D — source-aware suppression filter tests.
 * Covers the ledger.mjs suppressReRaises() update: debt entries suppress unless
 * escalated; session semantics unchanged.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { suppressReRaises, populateFindingMetadata } from '../scripts/lib/ledger.mjs';

function makeFinding(overrides = {}) {
  const f = {
    category: 'Test Category',
    section: 'src/x.js:10',
    detail: 'duplicate logic should be extracted into a helper',
    principle: 'DRY',
    _pass: 'backend',
    ...overrides,
  };
  populateFindingMetadata(f, f._pass);
  return f;
}

function sessionEntry(overrides = {}) {
  return {
    topicId: 's1',
    source: 'session',
    adjudicationOutcome: 'dismissed',
    remediationState: 'pending',
    severity: 'MEDIUM',
    category: 'Test Category',
    section: 'src/x.js:10',
    detailSnapshot: 'duplicate logic should be extracted into a helper',
    affectedFiles: ['src/x.js'],
    affectedPrinciples: ['DRY'],
    pass: 'backend',
    ...overrides,
  };
}

function debtEntry(overrides = {}) {
  return {
    topicId: 'd1',
    source: 'debt',
    severity: 'MEDIUM',
    category: 'Test Category',
    section: 'src/x.js:10',
    detailSnapshot: 'duplicate logic should be extracted into a helper',
    affectedFiles: ['src/x.js'],
    affectedPrinciples: ['DRY'],
    pass: 'backend',
    deferredReason: 'out-of-scope',
    escalated: false,
    ...overrides,
  };
}

describe('suppressReRaises — source-aware filter', () => {
  test('suppresses findings matching a debt entry on unchanged files', () => {
    const findings = [makeFinding()];
    const ledger = { entries: [debtEntry()] };
    const { kept, suppressed, reopened } = suppressReRaises(findings, ledger, {
      changedFiles: [],
      impactSet: [],
    });
    assert.equal(kept.length, 0);
    assert.equal(suppressed.length, 1);
    assert.equal(reopened.length, 0);
    assert.equal(suppressed[0].matchedSource, 'debt');
    assert.match(suppressed[0].reason, /deferred debt entry.*out-of-scope/);
  });

  test('reopens debt entries when files changed', () => {
    const findings = [makeFinding()];
    const ledger = { entries: [debtEntry()] };
    const { kept, suppressed, reopened } = suppressReRaises(findings, ledger, {
      changedFiles: ['src/x.js'],
      impactSet: ['src/x.js'],
    });
    assert.equal(kept.length, 0);
    assert.equal(suppressed.length, 0);
    assert.equal(reopened.length, 1);
    assert.equal(reopened[0]._reopened, true);
  });

  test('does NOT suppress escalated debt entries', () => {
    const findings = [makeFinding()];
    const ledger = { entries: [debtEntry({ escalated: true })] };
    const { kept, suppressed } = suppressReRaises(findings, ledger, {});
    assert.equal(kept.length, 1);
    assert.equal(suppressed.length, 0);
  });

  test('session dismissals still suppress (backward compat)', () => {
    const findings = [makeFinding()];
    const ledger = { entries: [sessionEntry()] };
    const { kept, suppressed } = suppressReRaises(findings, ledger, {});
    assert.equal(kept.length, 0);
    assert.equal(suppressed.length, 1);
    assert.equal(suppressed[0].matchedSource, 'session');
    assert.match(suppressed[0].reason, /dismissed/);
  });

  test('session entries without source field default to session behavior', () => {
    const findings = [makeFinding()];
    // source field absent — should default to session semantics
    const legacy = sessionEntry();
    delete legacy.source;
    const { kept, suppressed } = suppressReRaises(findings, { entries: [legacy] }, {});
    assert.equal(kept.length, 0);
    assert.equal(suppressed.length, 1);
  });

  test('accepted session entries do NOT suppress (only dismissed/fixed/verified)', () => {
    const findings = [makeFinding()];
    const ledger = { entries: [sessionEntry({ adjudicationOutcome: 'accepted' })] };
    const { kept, suppressed } = suppressReRaises(findings, ledger, {});
    assert.equal(kept.length, 1);
    assert.equal(suppressed.length, 0);
  });

  test('fixed session entries suppress (existing R2+ behavior preserved)', () => {
    const findings = [makeFinding()];
    const ledger = {
      entries: [sessionEntry({ adjudicationOutcome: 'accepted', remediationState: 'fixed' })],
    };
    const { kept, suppressed } = suppressReRaises(findings, ledger, {});
    assert.equal(kept.length, 0);
    assert.equal(suppressed.length, 1);
  });

  test('mixed ledger: debt + session entries both suppress their own matches', () => {
    const findings = [
      makeFinding({ section: 'src/x.js:10', category: 'Cat A' }),
      makeFinding({ section: 'src/y.js:20', category: 'Cat B', detail: 'totally different concern here' }),
    ];
    const ledger = {
      entries: [
        debtEntry({ topicId: 'd1', affectedFiles: ['src/x.js'], category: 'Cat A', section: 'src/x.js:10' }),
        sessionEntry({ topicId: 's1', affectedFiles: ['src/y.js'], category: 'Cat B', section: 'src/y.js:20', detailSnapshot: 'totally different concern here' }),
      ],
    };
    const { kept, suppressed } = suppressReRaises(findings, ledger, {});
    assert.equal(kept.length, 0);
    assert.equal(suppressed.length, 2);
    const sources = suppressed.map(s => s.matchedSource).sort();
    assert.deepEqual(sources, ['debt', 'session']);
  });

  test('empty ledger → all findings kept', () => {
    const findings = [makeFinding()];
    const { kept, suppressed, reopened } = suppressReRaises(findings, { entries: [] }, {});
    assert.equal(kept.length, 1);
    assert.equal(suppressed.length, 0);
    assert.equal(reopened.length, 0);
  });

  test('unrelated findings are kept', () => {
    const findings = [makeFinding({
      category: 'Different', section: 'src/z.js:5',
      detail: 'totally unrelated issue about something else entirely',
    })];
    const ledger = { entries: [debtEntry()] };
    const { kept, suppressed } = suppressReRaises(findings, ledger, {});
    assert.equal(kept.length, 1);
    assert.equal(suppressed.length, 0);
  });
});

describe('escalation gate — flipping escalated=true bypasses suppression', () => {
  test('non-escalated debt suppresses as normal', () => {
    const findings = [makeFinding()];
    const ledger = { entries: [debtEntry({ escalated: false })] };
    const { kept, suppressed } = suppressReRaises(findings, ledger, {});
    assert.equal(kept.length, 0);
    assert.equal(suppressed.length, 1);
  });

  test('escalated debt is re-raised (not suppressed)', () => {
    const findings = [makeFinding()];
    const entry = debtEntry({ escalated: true, escalatedAt: '2026-04-05T10:00:00.000Z' });
    const ledger = { entries: [entry] };
    const { kept, suppressed } = suppressReRaises(findings, ledger, {});
    assert.equal(kept.length, 1);
    assert.equal(suppressed.length, 0);
  });

  test('mix of escalated + non-escalated: only non-escalated suppressed', () => {
    const findings = [
      makeFinding({ section: 'src/a.js:1', category: 'cat-A', detail: 'duplicate logic in module A' }),
      makeFinding({ section: 'src/b.js:1', category: 'cat-B', detail: 'similar issue over in module B' }),
    ];
    const ledger = {
      entries: [
        debtEntry({ topicId: 'd1', affectedFiles: ['src/a.js'], section: 'src/a.js:1', category: 'cat-A', detailSnapshot: 'duplicate logic in module A', escalated: true }),
        debtEntry({ topicId: 'd2', affectedFiles: ['src/b.js'], section: 'src/b.js:1', category: 'cat-B', detailSnapshot: 'similar issue over in module B', escalated: false }),
      ],
    };
    const { kept, suppressed } = suppressReRaises(findings, ledger, {});
    assert.equal(kept.length, 1);       // escalated entry re-raised
    assert.equal(suppressed.length, 1); // non-escalated entry suppressed
    assert.equal(suppressed[0].matchedTopic, 'd2');
  });
});
