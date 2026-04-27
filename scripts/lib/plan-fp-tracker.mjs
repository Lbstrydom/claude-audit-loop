/**
 * @fileoverview Plan false-positive tracker for recurring "scope pressure" findings.
 * Tracks dismissed plan-audit findings using EMA-weighted Jaccard similarity.
 * Separate from the code FP tracker (findings.mjs) — plan findings are text-keyed,
 * not file+category keyed.
 * @module scripts/lib/plan-fp-tracker
 */

import fs from 'node:fs';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { jaccardSimilarity } from './ledger.mjs';
import { atomicWriteFileSync } from './file-io.mjs';
import { AUDIT_DIR } from './robustness.mjs';

const EMA_DECAY = 0.8;
const SUPPRESS_THRESHOLD = 0.7;
const SUPPRESS_MIN_CONSECUTIVE = 3;
const DEFAULT_DATA_PATH = path.join(AUDIT_DIR, 'plan-fp-patterns.json');
const LOCK_STALE_MS = 10_000;

/**
 * Tracks dismissed plan findings to suppress recurring "scope pressure" patterns.
 * Keyed by finding text similarity (Jaccard) rather than file+category.
 */
export class PlanFpTracker {
  /** @param {string} [dataPath] */
  constructor(dataPath = DEFAULT_DATA_PATH) {
    this._dataPath = path.resolve(dataPath);
    /** @type {Array<{text: string, emaScore: number, consecutiveCount: number, lastSeen: string}>} */
    this._patterns = [];
    this._loaded = false;
  }

  /** Load patterns from disk. Safe to call multiple times. */
  load() {
    if (this._loaded) return this;
    try {
      if (fs.existsSync(this._dataPath)) {
        const raw = JSON.parse(fs.readFileSync(this._dataPath, 'utf-8'));
        this._patterns = Array.isArray(raw.patterns) ? raw.patterns : [];
      }
    } catch (err) {
      process.stderr.write(`  [plan-fp-tracker] WARNING: ${this._dataPath} corrupted (${err.message}) — starting fresh\n`);
    }
    this._loaded = true;
    return this;
  }

  /**
   * Record a plan-finding outcome.
   * @param {string} text - Normalized finding text (category + detail)
   * @param {'dismissed'|'accepted'} action
   */
  recordOutcome(text, action) {
    if (!text) return;
    const existing = this._findBestMatch(text);
    if (existing) {
      if (action === 'dismissed') {
        existing.emaScore = EMA_DECAY * existing.emaScore + (1 - EMA_DECAY);
        existing.consecutiveCount++;
      } else {
        existing.emaScore = EMA_DECAY * existing.emaScore;
        existing.consecutiveCount = 0;
      }
      existing.lastSeen = new Date().toISOString();
    } else if (action === 'dismissed') {
      this._patterns.push({
        text,
        emaScore: 1 - EMA_DECAY,
        consecutiveCount: 1,
        lastSeen: new Date().toISOString(),
      });
    }
  }

  /**
   * Returns true if this finding should be suppressed (recurrently dismissed).
   * @param {string} text
   * @returns {boolean}
   */
  shouldSuppress(text) {
    if (!text || this._patterns.length === 0) return false;
    const match = this._findBestMatch(text);
    if (!match) return false;
    return match.emaScore >= SUPPRESS_THRESHOLD && match.consecutiveCount >= SUPPRESS_MIN_CONSECUTIVE;
  }

  /**
   * Save patterns to disk with proper-lockfile + atomicWriteFileSync.
   */
  save() {
    const dir = path.dirname(this._dataPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // Ensure file exists for proper-lockfile (requires the target to exist).
    // Use exclusive-create (flag 'wx') so only the first writer creates it —
    // concurrent processes racing here each see EEXIST and proceed safely.
    try {
      fs.writeFileSync(this._dataPath, JSON.stringify({ patterns: [] }, null, 2), { flag: 'wx' });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // File already exists — another process beat us here, continue to lock
    }

    let release;
    try {
      release = lockfile.lockSync(this._dataPath, { stale: LOCK_STALE_MS });
      // Read-merge-write under the lock to avoid lost updates from concurrent processes.
      // Merge strategy: iterate over our in-memory patterns and apply them on top of what's on disk.
      let diskPatterns = [];
      try {
        const raw = JSON.parse(fs.readFileSync(this._dataPath, 'utf-8'));
        diskPatterns = Array.isArray(raw.patterns) ? raw.patterns : [];
      } catch { /* file missing or corrupt — start from empty */ }

      // Build merged map: disk state is the base, our updates take precedence
      const merged = new Map(diskPatterns.map(p => [p.text, p]));
      for (const p of this._patterns) merged.set(p.text, p);

      atomicWriteFileSync(this._dataPath, JSON.stringify({ patterns: [...merged.values()] }, null, 2));
    } finally {
      if (release) release();
    }
  }

  /** @private */
  _findBestMatch(text) {
    let best = null;
    let bestScore = 0;
    for (const p of this._patterns) {
      const score = jaccardSimilarity(text, p.text);
      if (score > 0.4 && score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    return best;
  }
}
