/**
 * @fileoverview Outcome logging, effectiveness tracking, and EWR computation.
 * Split from findings.mjs (Wave 2, Phase 3) for Single Responsibility.
 * @module scripts/lib/findings-outcomes
 */

import path from 'node:path';
import { atomicWriteFileSync } from './file-io.mjs';
import { AppendOnlyStore, readJsonlFile, acquireLock, releaseLock } from './file-store.mjs';
import { learningConfig } from './config.mjs';

// ── Module-level state ─────────────────────────────────────────────────────

/**
 * @WARNING Module-global state — safe in CLI-per-invocation model.
 * If this module is ever used as a library, this cache must be replaced
 * with dependency injection (pass repoProfile as a function parameter).
 * See: context.mjs → setRepoProfileCache() → this module
 */
let _repoProfileCache = null;

/**
 * Allow the context module to inject the repo-profile cache so that
 * appendOutcome() can stamp each record with a repo fingerprint.
 * @param {object|null} cache
 */
export function setRepoProfileCache(cache) {
  _repoProfileCache = cache;
}

// ── Outcome Logging ───────────────────────────────────────────────────────

/**
 * Append an audit outcome to the local outcomes log.
 * @param {string} logPath - Path to outcomes.jsonl (default: .audit/outcomes.jsonl)
 * @param {object} outcome - Outcome record
 */
export function appendOutcome(logPath, outcome) {
  const absPath = path.resolve(logPath || '.audit/outcomes.jsonl');
  const store = new AppendOnlyStore(absPath);
  try {
    store.append({
      ...outcome,
      timestamp: Date.now(),
      repoFingerprint: _repoProfileCache?.repoFingerprint || 'unknown'
    });
  } catch (err) {
    process.stderr.write(`  [outcomes] Failed to log: ${err.message}\n`);
  }
}

/**
 * Batch-append multiple outcome records atomically.
 * Uses atomicWriteFileSync for crash-safe batch write (G2 fix).
 * @param {string} logPath
 * @param {object[]} records
 */
export function batchAppendOutcomes(logPath, records) {
  if (!records || records.length === 0) return;
  const absPath = path.resolve(logPath || '.audit/outcomes.jsonl');
  try {
    // Read existing, append new, write atomically
    let existing = '';
    try { existing = fs.readFileSync(absPath, 'utf-8'); } catch { /* new file */ }
    const newLines = records.map(r => JSON.stringify({
      ...r,
      timestamp: r.timestamp || Date.now(),
      repoFingerprint: r.repoFingerprint || _repoProfileCache?.repoFingerprint || 'unknown'
    }));
    const combined = existing.trimEnd() + (existing ? '\n' : '') + newLines.join('\n') + '\n';
    atomicWriteFileSync(absPath, combined);
  } catch (err) {
    process.stderr.write(`  [outcomes] Batch write failed: ${err.message}\n`);
  }
}

/**
 * Load outcomes — pure read, no side effects.
 * @param {string} logPath
 * @returns {object[]}
 */
export function loadOutcomes(logPath) {
  const absPath = path.resolve(logPath || '.audit/outcomes.jsonl');
  const outcomes = readJsonlFile(absPath);

  const now = Date.now();
  for (const o of outcomes) {
    if (!o.timestamp && !o._importedAt) {
      o._importedAt = now;
    }
  }
  return outcomes;
}

/**
 * Compact outcomes file: backfill _importedAt + prune stale entries.
 * @param {string} logPath
 * @param {object} options
 */
export function compactOutcomes(logPath, options = {}) {
  const absPath = path.resolve(logPath || '.audit/outcomes.jsonl');
  const {
    maxAgeMs = learningConfig.outcomeMaxAgeMs,
    pruneEnabled = learningConfig.outcomePruneEnabled
  } = options;

  const lockPath = absPath + '.lock';
  acquireLock(lockPath);
  try {
    const outcomes = readJsonlFile(absPath);
    const now = Date.now();
    let backfilled = 0;

    for (const o of outcomes) {
      if (!o.timestamp && !o._importedAt) {
        o._importedAt = now;
        backfilled++;
      }
    }

    let fresh = outcomes;
    if (pruneEnabled) {
      fresh = outcomes.filter(o => {
        const ts = o.timestamp || o._importedAt || now;
        return (now - ts) < maxAgeMs;
      });
    }

    const pruned = outcomes.length - fresh.length;
    if (backfilled > 0 || pruned > 0) {
      atomicWriteFileSync(absPath, fresh.map(o => JSON.stringify(o)).join('\n') + '\n');
      if (backfilled > 0) process.stderr.write(`  [outcomes] Backfilled ${backfilled} legacy entries with _importedAt\n`);
      if (pruned > 0) process.stderr.write(`  [outcomes] Pruned ${pruned} stale entries\n`);
    }
  } finally {
    releaseLock(lockPath);
  }
}

// ── Effectiveness Tracking ────────────────────────────────────────────────

/**
 * Compute pass effectiveness with exponential time decay.
 * @param {object[]} outcomes
 * @param {string} passName
 * @param {object} options
 * @returns {object} Effectiveness metrics
 */
export function computePassEffectiveness(outcomes, passName = null, options = {}) {
  const {
    halfLifeMs = learningConfig.outcomeHalfLifeMs,
    maxAgeMs = learningConfig.outcomeMaxAgeMs
  } = options;

  const now = Date.now();
  const lambda = Math.LN2 / halfLifeMs;

  let filtered = passName ? outcomes.filter(o => o.pass === passName) : outcomes;

  filtered = filtered.filter(o => {
    const ts = o.timestamp || o._importedAt || now;
    return (now - ts) < maxAgeMs;
  });

  if (filtered.length === 0) return { acceptanceRate: 0, signalScore: 0, total: 0, accepted: 0, dismissed: 0, effectiveWeight: 0 };

  let weightedAccepted = 0, weightedTotal = 0;
  let accepted = 0, dismissed = 0;

  for (const o of filtered) {
    const ts = o.timestamp || o._importedAt || now;
    const age = now - ts;
    const weight = Math.exp(-lambda * age);
    weightedTotal += weight;
    if (o.accepted) { weightedAccepted += weight; accepted++; }
    else dismissed++;
  }

  return {
    acceptanceRate: weightedTotal > 0 ? weightedAccepted / weightedTotal : 0,
    signalScore: weightedTotal > 0 ? weightedAccepted / weightedTotal : 0,
    total: filtered.length,
    accepted,
    dismissed,
    effectiveWeight: weightedTotal
  };
}

/**
 * Canonical pass quality metric: Expected Weighted Reward (EWR).
 * @param {object[]} outcomes
 * @param {string} passName
 * @param {object} options
 * @returns {{ ewr: number, confidence: number, n: number }}
 */
export function computePassEWR(outcomes, passName, options = {}) {
  const { halfLifeMs = learningConfig.outcomeHalfLifeMs } = options;
  const now = Date.now();
  const lambda = Math.LN2 / halfLifeMs;

  const passOutcomes = outcomes.filter(o => o.pass === passName && o.reward != null);
  if (passOutcomes.length === 0) return { ewr: 0, confidence: 0, n: 0 };

  let weightedRewardSum = 0, weightSum = 0;
  for (const o of passOutcomes) {
    const ts = o.timestamp || o._importedAt || now;
    const weight = Math.exp(-lambda * (now - ts));
    weightedRewardSum += o.reward * weight;
    weightSum += weight;
  }

  const ewr = weightSum > 0 ? weightedRewardSum / weightSum : 0;
  const confidence = Math.min(1, weightSum / 10);

  return { ewr, confidence, n: passOutcomes.length };
}
