/**
 * @fileoverview `scoreAgainstGroundTruth` + `toRawContext` — the adjudicator
 * role's ground-truth scoring mechanism (D7a/D7c, plan:
 * comparison-tooling-consolidation.md, Cluster D).
 *
 * Moved verbatim from `scripts/model-eval-adjudicator.mjs` (D7a's layering
 * fix, round-3 gate H2) — a lib module (`executors.mjs`) must not import a
 * top-level `scripts/*.mjs` entry point, so the function moves here instead;
 * `model-eval-adjudicator.mjs` imports it back for its existing 1-vs-1 CLI
 * path (unchanged behaviour) and `EXECUTORS.adjudicator` (D7c) imports the
 * SAME function — neither entry point imports the other.
 *
 * **Extended to bubble up `usage` (D7c, Gemini gate G2) — a bounded extension
 * of the same edit, not new unplanned scope.** `extractStructured` already
 * returns raw provider `usage` per call; this function now sums it across
 * every internal call and returns it alongside the existing metrics, because
 * an `ExecutorAttempt`'s `'ok'` branch requires `usage` unconditionally and
 * none of these per-row calls' cost previously escaped the function.
 *
 * **Null-propagation rule (Cluster B round-2 finding H7/H8's deferred
 * concern, resolved here): `costUsd` is the sum of every row's cost ONLY
 * when every row priced — if any row is unpriced/unmeterable, the summed
 * `costUsd` is `null`, never a partial sum silently treated as the whole.**
 * A hardcoded/derived 0 or partial total reads as "measured and free/cheap"
 * when it is really "some of this is unknown" — the same false-zero class
 * `model-pricing.mjs`'s own null-cost policy exists to prevent, applied here
 * to a SUM rather than a single call. `inputTokens`/`outputTokens` are always
 * summed (never null — `sanitizeTokens` clamps absent/garbage to 0, and a
 * token count observed as 0 is a real, meaningful measurement even when the
 * dollar cost is not).
 *
 * @module scripts/lib/model-eval/adjudicator-executor
 */

import { extractStructured } from './structured-extractor.mjs';
import { scoreBinaryClassification } from './deterministic-scorer.mjs';
import { costFromUsage } from '../model-pricing.mjs';

/** Ground-truth row -> a rawContext {findingText, severity} extractStructured accepts. */
export function toRawContext(row) {
  const findingText = [row.category, row.primaryFile, row.detailSnapshot].filter(Boolean).join(' — ') || '(no detail captured)';
  return { findingText, severity: row.severity || 'UNKNOWN' };
}

/**
 * @param {{route: object, rows: Array<object>}} args
 * @returns {Promise<{recall: number, falsePositiveRate: number, f1: number,
 *   usage: {inputTokens: number, outputTokens: number, costUsd: number|null}}>}
 */
export async function scoreAgainstGroundTruth({ route, rows }) {
  const candidatePredictions = [];
  const groundTruthLabels = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let allPriced = true;
  for (const row of rows) {
    const { data, usage: rawUsage } = await extractStructured({ role: 'adjudicator', route, rawContext: toRawContext(row) });
    candidatePredictions.push(data.verdict);
    // `triageLabel`, not `humanLabel` (renamed 2026-09-07): it records the
    // audit loop's own disposition, and 86% of the dismissals were written by
    // the deliberation ledger rather than a person. The store now excludes the
    // four self-contradicting dismissal classes, but the remaining label is
    // still "agreement with triage" and should not be read as ground truth
    // about whether a claim was true.
    groundTruthLabels.push(row.triageLabel);
    const cost = costFromUsage(rawUsage, route.pricingModel);
    inputTokens += cost.inputTokens;
    outputTokens += cost.outputTokens;
    if (cost.totalUsd == null) {
      allPriced = false;
    } else {
      costUsd += cost.totalUsd;
    }
  }
  const scored = scoreBinaryClassification(candidatePredictions, groundTruthLabels);
  return {
    recall: scored.recall, falsePositiveRate: scored.falsePositiveRate, f1: scored.f1,
    usage: { inputTokens, outputTokens, costUsd: allPriced ? costUsd : null },
  };
}

/**
 * **Stratified ground-truth draw.** `getAdjudicatorGroundTruth` returns rows
 * ordered `decided_at DESC`, so a plain `rows.slice(0, n)` takes the n most
 * RECENTLY adjudicated findings — which in practice come from a single audit
 * session and therefore often share one label. The first real run of this
 * harness drew 10 rows that were all `true_positive`: `falsePositiveRate` came
 * back `null` (correctly — there were no negatives to get wrong) and the
 * verdict rested on recall alone, while the surrounding corpus held 150/50.
 *
 * FP-rate is the metric the runbook says should DECIDE an adjudicator swap, so
 * a sample that structurally cannot measure it is not a cheaper measurement —
 * it is a different, unstated one. This draws as close to 50/50 as the corpus
 * allows, newest-first within each class so the sample still tracks current
 * adjudication behaviour.
 *
 * Deterministic: no RNG, so two runs over one corpus draw the same sample and
 * a verdict is reproducible.
 *
 * @param {Array<{triageLabel: string}>} rows - as returned by getAdjudicatorGroundTruth
 * @param {number} size - desired sample size
 * @returns {{sample: Array<object>, composition: Record<string, number>,
 *   balanced: boolean, classesPresent: number}}
 */
export function selectBalancedSample(rows, size) {
  if (!Number.isInteger(size) || size < 1) throw new Error(`selectBalancedSample: size must be a positive integer, got ${size}`);
  const positives = rows.filter((r) => r.triageLabel === 'true_positive');
  const negatives = rows.filter((r) => r.triageLabel === 'false_positive');

  // Round-robin from each class until `size` is met or both are exhausted.
  // Whichever class is scarce contributes everything it has; the other fills
  // the rest, so a lopsided corpus degrades to "as balanced as possible"
  // rather than silently reverting to recency order.
  const sample = [];
  let i = 0;
  let j = 0;
  while (sample.length < size && (i < positives.length || j < negatives.length)) {
    if (i < positives.length && sample.length < size) sample.push(positives[i++]);
    if (j < negatives.length && sample.length < size) sample.push(negatives[j++]);
  }

  const composition = {};
  for (const r of sample) composition[r.triageLabel] = (composition[r.triageLabel] || 0) + 1;
  const classesPresent = Object.keys(composition).length;
  return {
    sample,
    composition,
    // "Balanced" is a claim about MEASURABILITY, not about a 50/50 split: both
    // classes present is exactly the condition under which falsePositiveRate
    // is defined.
    balanced: classesPresent >= 2,
    classesPresent,
  };
}

/**
 * The margin by which a candidate must beat the best degenerate classifier
 * before its score counts as discrimination rather than arithmetic.
 *
 * Not a tunable policy knob, so deliberately NOT in `adjudicator-thresholds
 * .json`: `minF1` there encodes "how good must a working adjudicator be", a
 * judgement call. This encodes "did it classify at all", which is a property of
 * the measurement. 0.05 is a judgement about noise at these sample sizes
 * (n=10..50), not a proof.
 */
export const DEGENERATE_MARGIN = 0.05;

/**
 * **Score the two classifiers that read nothing.** On a BALANCED binary sample,
 * always answering `true_positive` scores precision 0.5, recall 1.0 and
 * **F1 0.667** — while the production incumbent measured **F1 0.677** (n=50,
 * 2026-09-07). A gate keyed on F1 alone therefore cannot tell a working
 * adjudicator from a stuck one; the incumbent cleared always-yes by 0.010 and
 * nothing in the harness noticed.
 *
 * This is the "audit your success paths" rule pointed at a scorer: *can this
 * emit a passing-shaped number without having discriminated anything?* Here it
 * could, so every run now scores both constants over its OWN sample and reports
 * them beside the candidate. Free — no model is called; the labels are enough.
 *
 * @param {Array<{triageLabel: string}>} rows - the sample actually scored
 * @returns {{alwaysTruePositive: object, alwaysFalsePositive: object, bestF1: number}}
 */
export function degenerateBaselines(rows) {
  const labels = rows.map((r) => r.triageLabel);
  const constant = (v) => scoreBinaryClassification(labels.map(() => v), labels);
  const alwaysTruePositive = constant('true_positive');
  const alwaysFalsePositive = constant('false_positive');
  // A null F1 (undefined for a degenerate confusion matrix) is NOT a zero — it
  // is "no bar established", and treating it as 0 would let a candidate clear a
  // bar that was never measured. Coalesce to 0 only for the MAX, and let the
  // caller see the raw pair.
  const bestF1 = Math.max(alwaysTruePositive.f1 ?? 0, alwaysFalsePositive.f1 ?? 0);
  return { alwaysTruePositive, alwaysFalsePositive, bestF1 };
}
