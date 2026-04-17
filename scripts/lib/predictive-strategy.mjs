/**
 * @fileoverview Predictive audit strategy — uses historical run data to prioritize
 * files, size MAP units, predict costs, and recommend pass selection.
 *
 * Default behavior: prioritize file order + recommend unit sizes + predict cost.
 * Opt-in (--predictive-skip): skip passes with high FP rates (exploration floor enforced).
 *
 * Graceful degradation: all methods return safe defaults when store is unavailable.
 * @module scripts/lib/predictive-strategy
 */

import { modelPricing, predictiveConfig } from './config.mjs';

/**
 * Predictive strategy for audit pass and file prioritization.
 * Data-driven: learns from Supabase learning store run history.
 */
export class PredictiveStrategy {
  constructor() {
    this._passStats = new Map();   // passName → { highCount, totalRuns, lastRunAt }
    this._fileRisk = new Map();    // filePath → risk score 0-1
    this._passTimings = new Map(); // passName → { avgInputTokens, avgOutputTokens, avgLatencyMs, runCount }
    this._loaded = false;
  }

  /**
   * Load historical data from the learning store.
   * Times out after 5 seconds — audit must not block on this.
   * @param {object} [store] - Learning store (from learning-store.mjs)
   */
  async load(store) {
    if (!store) return this;
    let aborted = false;
    const timeout = new Promise((_, reject) =>
      setTimeout(() => { aborted = true; reject(new Error('predictive load timeout')); }, 5000)
    );
    try {
      await Promise.race([this._loadFromStore(store, () => aborted), timeout]);
    } catch (err) {
      process.stderr.write(`  [predictive] Load failed (${err.message}) — using defaults\n`);
    }
    this._loaded = true;
    return this;
  }

  /** @private */
  async _loadFromStore(store, isAborted = () => false) {
    // Load pass stats
    if (typeof store.getPassStats === 'function') {
      const stats = await store.getPassStats();
      if (isAborted()) return;
      for (const row of (stats || [])) {
        this._passStats.set(row.passName, {
          highCount: row.highCount || 0,
          totalRuns: row.totalRuns || 0,
          lastRunAt: row.lastRunAt || null,
        });
      }
    }
    // Load file risk scores
    if (typeof store.getFileRiskScores === 'function') {
      const scores = await store.getFileRiskScores();
      if (isAborted()) return;
      for (const row of (scores || [])) {
        this._fileRisk.set(row.filePath, row.riskScore || 0);
      }
    }
    // Load pass timings for cost prediction
    if (typeof store.getPassTimings === 'function') {
      const timings = await store.getPassTimings();
      if (isAborted()) return;
      for (const row of (timings || [])) {
        this._passTimings.set(row.passName, {
          avgInputTokens: row.avgInputTokens || 0,
          avgOutputTokens: row.avgOutputTokens || 0,
          avgLatencyMs: row.avgLatencyMs || 0,
          runCount: row.runCount || 0,
        });
      }
    }
  }

  /**
   * Predict which passes are likely to produce accepted findings.
   * With exploration floor, freshness window, and repo-change triggers.
   * @param {string} repoId
   * @param {object} [diffStats]
   * @param {boolean} [allowSkip=false] - Must be true (--predictive-skip flag)
   * @returns {Map<string, {confidence: number, recommendSkip: boolean, forceExplore: boolean, stale: boolean}>}
   */
  predictActivePasses(repoId, diffStats = {}, allowSkip = false) {
    const result = new Map();
    const freshnessMs = predictiveConfig.freshnessWindowDays * 24 * 60 * 60 * 1000;

    for (const [passName, stats] of this._passStats) {
      const confidence = stats.totalRuns >= 20
        ? stats.highCount / stats.totalRuns
        : 1; // Not enough data — assume active

      // Exploration floor: run every Nth time regardless
      const forceExplore = stats.totalRuns % predictiveConfig.explorationInterval === 0;

      // Freshness: re-run if last run was too long ago
      const lastRunMs = stats.lastRunAt ? new Date(stats.lastRunAt).getTime() : 0;
      const stale = lastRunMs > 0 && (Date.now() - lastRunMs > freshnessMs);

      // Repo change trigger
      const repoChanged = diffStats.profileChanged === true;

      const recommendSkip = allowSkip
        && stats.totalRuns >= 20
        && stats.highCount === 0
        && confidence < 0.05
        && !forceExplore
        && !stale
        && !repoChanged;

      result.set(passName, { confidence, recommendSkip, forceExplore, stale });
    }
    return result;
  }

  /**
   * Rank files by predicted risk (highest-risk first).
   * Falls back to original order when no data available.
   * @param {string[]} files
   * @returns {string[]} Sorted files (highest risk first)
   */
  rankFilesByRisk(files) {
    if (this._fileRisk.size === 0) return [...files];
    return [...files].sort((a, b) => {
      const riskA = this._fileRisk.get(a) ?? 0.5;
      const riskB = this._fileRisk.get(b) ?? 0.5;
      return riskB - riskA;
    });
  }

  /**
   * Predict cost and time for an audit run based on historical averages.
   * Groups passes into waves (parallel execution) for time estimation.
   * @param {string[]} selectedPasses
   * @returns {{ estimatedCostUsd: number, estimatedMinutes: number, estimatedTokens: number, confidence: string }}
   */
  predictCost(selectedPasses) {
    if (this._passTimings.size === 0) {
      return { estimatedCostUsd: 0, estimatedMinutes: 0, estimatedTokens: 0, confidence: 'none' };
    }

    const pricing = modelPricing['gpt-5.4'];
    const geminiPricing = modelPricing['gemini-3.1'];

    // Group passes into parallel waves
    const waves = [
      selectedPasses.filter(p => ['structure', 'wiring'].includes(p)),
      selectedPasses.filter(p => ['backend', 'frontend', 'be-routes', 'be-services'].includes(p)),
      selectedPasses.filter(p => p === 'sustainability'),
    ].filter(w => w.length > 0);

    let totalCost = 0;
    let totalMinutes = 0;
    let totalTokens = 0;

    for (const wave of waves) {
      let waveMaxLatency = 0;
      for (const pass of wave) {
        const stats = this._passTimings.get(pass);
        if (!stats) continue;
        totalCost += (stats.avgInputTokens * pricing.input + stats.avgOutputTokens * pricing.output) / 1_000_000;
        totalTokens += stats.avgInputTokens + stats.avgOutputTokens;
        waveMaxLatency = Math.max(waveMaxLatency, stats.avgLatencyMs);
      }
      totalMinutes += waveMaxLatency / 60000;
    }

    // Add Gemini final review estimate
    totalCost += (8000 * geminiPricing.input + 4000 * geminiPricing.output) / 1_000_000;
    totalMinutes += 2;

    const confidence = this._passTimings.size >= 3 ? 'high' : 'low';

    return {
      estimatedCostUsd: Math.round(totalCost * 100) / 100,
      estimatedMinutes: Math.round(totalMinutes * 10) / 10,
      estimatedTokens: Math.round(totalTokens),
      confidence,
    };
  }

  /**
   * Recommend MAP unit token size for a pass based on historical timeout rate.
   * Returns null when no recommendation (caller uses default).
   * @param {string[]} files
   * @param {string} passName
   * @returns {number|null}
   */
  recommendUnitSize(files, passName) {
    return null; // Deferred until sufficient timeout data is collected
  }
}
