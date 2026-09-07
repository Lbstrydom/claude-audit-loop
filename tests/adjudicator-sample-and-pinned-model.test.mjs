/**
 * @fileoverview Two deterministic seams behind the adjudicator eval's first
 * real run (2026-09-07), both of which let a run report a verdict it had not
 * actually measured.
 *
 * 1. `selectBalancedSample` — the ground-truth read returns rows ordered
 *    `decided_at DESC`, and the CLI took `rows.slice(0, n)`. The n most
 *    recently adjudicated findings tend to come from ONE audit session and
 *    share one label: the first real run drew 10 rows that were all
 *    `true_positive`, so `falsePositiveRate` came back `null` while the
 *    surrounding corpus held 150/50. FP-rate is the metric an adjudicator swap
 *    turns on, so that sample could not answer the question being asked.
 *
 * 2. `pinned-model` routes — a candidate could only be named by SENTINEL, and
 *    `latest-flash` resolves to the floating `gemini-flash-latest` alias. A run
 *    launched to evaluate `gemini-3.8-flash` recorded
 *    `resolvedModel: "gemini-flash-latest"`, which is unreproducible and may
 *    not even be the model under test.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { selectBalancedSample } from '../scripts/lib/model-eval/adjudicator-executor.mjs';
import { resolveCandidateRoute } from '../scripts/lib/model-eval/route-catalog.mjs';

const tp = (i) => ({ humanLabel: 'true_positive', id: `tp${i}` });
const fp = (i) => ({ humanLabel: 'false_positive', id: `fp${i}` });

describe('selectBalancedSample', () => {
  it('draws both classes from a corpus whose head is single-label', () => {
    // The exact live shape: every recent row is a true_positive, negatives sit
    // deeper in the corpus. A recency slice sees only the head.
    const rows = [...Array.from({ length: 20 }, (_, i) => tp(i)), ...Array.from({ length: 10 }, (_, i) => fp(i))];
    assert.equal(new Set(rows.slice(0, 10).map((r) => r.humanLabel)).size, 1, 'precondition: the head is single-label');

    const drawn = selectBalancedSample(rows, 10);
    assert.equal(drawn.sample.length, 10);
    assert.deepEqual(drawn.composition, { true_positive: 5, false_positive: 5 });
    assert.equal(drawn.balanced, true);
  });

  it('is deterministic — a verdict must be reproducible from one corpus', () => {
    const rows = [...Array.from({ length: 9 }, (_, i) => tp(i)), ...Array.from({ length: 9 }, (_, i) => fp(i))];
    const a = selectBalancedSample(rows, 6).sample.map((r) => r.id);
    const b = selectBalancedSample(rows, 6).sample.map((r) => r.id);
    assert.deepEqual(a, b);
  });

  it('degrades to as-balanced-as-possible, and REPORTS the imbalance', () => {
    const rows = [...Array.from({ length: 10 }, (_, i) => tp(i)), fp(0)];
    const drawn = selectBalancedSample(rows, 6);
    assert.equal(drawn.sample.length, 6);
    assert.deepEqual(drawn.composition, { true_positive: 5, false_positive: 1 });
    assert.equal(drawn.balanced, true, 'one negative is enough to define falsePositiveRate');
  });

  it('flags a single-class draw rather than silently returning one', () => {
    // The direction the guard must fire. `balanced:false` is what the CLI
    // turns into a refusal — without it the run reports recall-only metrics
    // in a verdict shape that reads as comparative.
    const drawn = selectBalancedSample(Array.from({ length: 10 }, (_, i) => tp(i)), 10);
    assert.equal(drawn.balanced, false);
    assert.equal(drawn.classesPresent, 1);
    assert.deepEqual(drawn.composition, { true_positive: 10 });
  });

  it('never returns more than the corpus holds', () => {
    const drawn = selectBalancedSample([tp(0), fp(0)], 10);
    assert.equal(drawn.sample.length, 2);
  });

  it('rejects a nonsense size instead of quietly returning everything', () => {
    assert.throws(() => selectBalancedSample([tp(0)], 0), /positive integer/);
  });
});

describe('pinned-model candidate routes', () => {
  it('resolves a concrete id to itself, not through a floating alias', () => {
    const route = resolveCandidateRoute({ role: 'adjudicator', candidateSpec: { kind: 'pinned-model', value: 'gemini-3.8-flash' } });
    assert.equal(route.resolvedModel, 'gemini-3.8-flash');
    assert.equal(route.pricingModel, 'gemini-3.8-flash');
    assert.equal(route.provider, 'google');
    assert.equal(route.modelLineage, 'google:flash');
  });

  it('shares a lineage with its own tier sentinel', () => {
    // A pinned 3.8 Flash and `latest-flash` are the SAME family — pinning must
    // not mint a separate lineage that would look independent of itself.
    const pinned = resolveCandidateRoute({ role: 'adjudicator', candidateSpec: { kind: 'pinned-model', value: 'gemini-3.8-flash' } });
    const sentinel = resolveCandidateRoute({ role: 'adjudicator', candidateSpec: { kind: 'sentinel', value: 'latest-flash' } });
    assert.equal(pinned.modelLineage, sentinel.modelLineage);
  });

  it('fails closed on an id no catalog knows — an unverified id is not a trusted family', () => {
    // No catalog refresh has run in this process, so getLiveCatalog is empty and
    // NOTHING can be catalog-verified. That is the safe direction: unknown
    // lineage ⇒ independenceEligible false, so it can never reach Tier A/B.
    const route = resolveCandidateRoute({ role: 'adjudicator', candidateSpec: { kind: 'pinned-model', value: 'gemini-99.9-flash' } });
    assert.equal(route.lineageStatus, 'unknown');
    assert.equal(route.independenceEligible, false);
  });

  it('rejects an unparseable id rather than inventing a provider', () => {
    assert.throws(
      () => resolveCandidateRoute({ role: 'adjudicator', candidateSpec: { kind: 'pinned-model', value: 'not-a-real-model' } }),
      /not a recognizable first-party model id/,
    );
  });

  it('still rejects a bare concrete id passed as a sentinel', () => {
    // The old error path must stay — `pinned-model` is a new, explicit opt-in,
    // not a loosening of the sentinel contract.
    assert.throws(
      () => resolveCandidateRoute({ role: 'adjudicator', candidateSpec: { kind: 'sentinel', value: 'gemini-3.8-flash' } }),
      /is not a registered sentinel/,
    );
  });
});
