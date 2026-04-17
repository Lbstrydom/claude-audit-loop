/**
 * @fileoverview Predictive audit strategy — uses historical run data to prioritize
 * files and size MAP units. Pass skipping is explicit opt-in only (--predictive-skip flag).
 *
 * Default behavior: prioritize file order + recommend unit sizes.
 * Opt-in (--predictive-skip): skip passes with 0 HIGH findings in last 20 repo runs.
 *
 * Graceful degradation: all methods return safe defaults when store is unavailable.
 * @module scripts/lib/predictive-strategy
 */

/**
 * Predictive strategy for audit pass and file prioritization.
 * Data-driven: learns from Supabase learning store run history.
 */
export class PredictiveStrategy {
  constructor() {
    this._passStats = new Map();   // passName → { highCount, totalRuns }
    this._fileRisk = new Map();    // filePath → risk score 0-1
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
    // Attempt to load pass stats if the store exposes that API
    if (typeof store.getPassStats === 'function') {
      const stats = await store.getPassStats();
      if (isAborted()) return; // Timeout fired — do not mutate state
      for (const row of (stats || [])) {
        this._passStats.set(row.passName, {
          highCount: row.highCount || 0,
          totalRuns: row.totalRuns || 0,
        });
      }
    }
    // Attempt to load file risk scores
    if (typeof store.getFileRiskScores === 'function') {
      const scores = await store.getFileRiskScores();
      if (isAborted()) return; // Timeout fired — do not mutate state
      for (const row of (scores || [])) {
        this._fileRisk.set(row.filePath, row.riskScore || 0);
      }
    }
  }

  /**
   * Predict which passes are likely to be active.
   * Returns a Map<passName, {confidence: 0-1, recommendSkip: boolean}>.
   * recommendSkip is ONLY true when --predictive-skip is enabled AND confidence is high.
   * @param {string} repoId
   * @param {object} [diffStats]
   * @param {boolean} [allowSkip=false] - Must be true (--predictive-skip flag) to enable skipping
   * @returns {Map<string, {confidence: number, recommendSkip: boolean}>}
   */
  predictActivePasses(repoId, diffStats = {}, allowSkip = false) {
    const result = new Map();
    for (const [passName, stats] of this._passStats) {
      const confidence = stats.totalRuns >= 20
        ? stats.highCount / stats.totalRuns
        : 1; // Not enough data — assume active
      const recommendSkip = allowSkip
        && stats.totalRuns >= 20
        && stats.highCount === 0
        && confidence < 0.05;
      result.set(passName, { confidence, recommendSkip });
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
      return riskB - riskA; // descending risk
    });
  }

  /**
   * Recommend MAP unit token size for a pass based on historical timeout rate.
   * Returns null when no recommendation (caller uses default).
   * @param {string[]} files
   * @param {string} passName
   * @returns {number|null}
   */
  recommendUnitSize(files, passName) {
    // Phase 7 placeholder — return null (use default) until enough data is collected
    return null;
  }
}
