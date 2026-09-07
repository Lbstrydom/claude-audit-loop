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

import { selectBalancedSample, degenerateBaselines, DEGENERATE_MARGIN } from '../scripts/lib/model-eval/adjudicator-executor.mjs';
import { resolveCandidateRoute } from '../scripts/lib/model-eval/route-catalog.mjs';

const tp = (i) => ({ triageLabel: 'true_positive', id: `tp${i}` });
const fp = (i) => ({ triageLabel: 'false_positive', id: `fp${i}` });

describe('selectBalancedSample', () => {
  it('draws both classes from a corpus whose head is single-label', () => {
    // The exact live shape: every recent row is a true_positive, negatives sit
    // deeper in the corpus. A recency slice sees only the head.
    const rows = [...Array.from({ length: 20 }, (_, i) => tp(i)), ...Array.from({ length: 10 }, (_, i) => fp(i))];
    assert.equal(new Set(rows.slice(0, 10).map((r) => r.triageLabel)).size, 1, 'precondition: the head is single-label');

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

describe('degenerateBaselines — a score must beat a classifier that reads nothing', () => {
  const balanced = [...Array.from({ length: 25 }, () => tp(0)), ...Array.from({ length: 25 }, () => fp(0))];

  it('reproduces the 0.667 that the incumbent cleared by 0.010', () => {
    // The measured defect: gemini-pro-latest scored F1 0.677 at n=50 (2026-09-07)
    // while always-yes scores 0.667 on the same balanced sample. `minF1` was the
    // screen tier's ONLY threshold, so nothing in the harness could see that.
    const b = degenerateBaselines(balanced);
    assert.ok(Math.abs(b.alwaysTruePositive.f1 - 2 / 3) < 1e-9, `always-yes F1 was ${b.alwaysTruePositive.f1}`);
    assert.equal(b.alwaysTruePositive.recall, 1, 'always-yes catches every positive');
    assert.equal(b.alwaysTruePositive.falsePositiveRate, 1, '...and every negative too');
    assert.ok(Math.abs(b.bestF1 - 2 / 3) < 1e-9);
    assert.ok(0.677 < b.bestF1 + DEGENERATE_MARGIN, 'the real incumbent score must NOT clear the margin');
  });

  it('treats an undefined baseline F1 as no-bar, never as zero', () => {
    // always-`false_positive` has no true positives, so its F1 is null. Reading
    // that as 0 would let a candidate clear a bar that was never established.
    const b = degenerateBaselines(balanced);
    assert.equal(b.alwaysFalsePositive.f1, null);
    assert.ok(b.bestF1 > 0, 'bestF1 still comes from the arm that DID score');
  });

  it('does not fire on a genuinely discriminating candidate (the direction it must NOT block)', () => {
    // A candidate at F1 0.90 on this sample clears 0.667 + 0.05 comfortably.
    // Without this case the suite would pass against a guard that rejects
    // everything.
    const b = degenerateBaselines(balanced);
    assert.ok(0.90 >= b.bestF1 + DEGENERATE_MARGIN);
  });

  it('raises the bar on a skewed sample, where always-yes scores higher', () => {
    // 90% positives: always-yes reaches F1 0.947, so a candidate needs ~1.0.
    // The bar is a property of the SAMPLE, which is why it is computed per run
    // rather than pinned as a constant.
    const skewed = [...Array.from({ length: 45 }, () => tp(0)), ...Array.from({ length: 5 }, () => fp(0))];
    const b = degenerateBaselines(skewed);
    assert.ok(b.bestF1 > 0.94, `expected a high bar on a skewed sample, got ${b.bestF1}`);
  });
});
