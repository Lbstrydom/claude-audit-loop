/**
 * Finding-related operations: hashing, formatting, outcome logging,
 * effectiveness tracking, and false-positive learning.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from './file-io.mjs';

// ── Module-level state ─────────────────────────────────────────────────────

let _repoProfileCache = null;

/**
 * Allow the context module to inject the repo-profile cache so that
 * appendOutcome() can stamp each record with a repo fingerprint.
 * @param {object|null} cache
 */
export function setRepoProfileCache(cache) {
  _repoProfileCache = cache;
}

// ── Semantic Hashing ───────────────────────────────────────────────────────

/**
 * Content-addressable finding ID — deterministic, model-agnostic.
 * Same issue keeps the same ID regardless of which model raised it.
 * @param {object} f - Finding with category, section, detail
 * @returns {string} 8-char hex hash
 */
export function semanticId(f) {
  const content = `${f.category}|${f.section}|${f.detail}`.toLowerCase().trim();
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 8);
}

// ── Formatting ─────────────────────────────────────────────────────────────

/**
 * Format findings as readable markdown.
 * @param {object[]} findings
 * @returns {string}
 */
export function formatFindings(findings) {
  const groups = { HIGH: [], MEDIUM: [], LOW: [] };
  for (const f of findings) (groups[f.severity] ?? groups.LOW).push(f);

  let output = '';
  for (const [sev, items] of Object.entries(groups)) {
    if (!items.length) continue;
    output += `\n### ${sev} Severity\n\n`;
    for (const f of items) {
      output += `#### [${f.id}] ${f.category}: ${f.section}\n`;
      output += `- **Detail**: ${f.detail}\n`;
      if (sev !== 'LOW') {
        output += `- **Risk**: ${f.risk}\n`;
        output += `- **Principle**: ${f.principle}\n`;
      }
      output += `- **Recommendation**: ${f.recommendation}\n`;
      if (f.is_quick_fix) output += `- **WARNING**: Quick fix — needs proper sustainable solution\n`;
      output += '\n';
    }
  }
  return output;
}

// ── Phase 3: Local Outcome Logging ─────────────────────────────────────────

/**
 * Append an audit outcome to the local outcomes log.
 * This is the foundation for all learning features (Phases 4-6).
 * @param {string} logPath - Path to outcomes.jsonl (default: .audit/outcomes.jsonl)
 * @param {object} outcome - Outcome record
 */
export function appendOutcome(logPath, outcome) {
  const absPath = path.resolve(logPath || '.audit/outcomes.jsonl');
  try {
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.appendFileSync(absPath, JSON.stringify({
      ...outcome,
      timestamp: Date.now(),
      repoFingerprint: _repoProfileCache?.repoFingerprint || 'unknown'
    }) + '\n', 'utf-8');
  } catch (err) {
    process.stderr.write(`  [outcomes] Failed to log: ${err.message}\n`);
  }
}

/**
 * Load outcomes from the local JSONL log.
 * @param {string} logPath
 * @returns {object[]}
 */
export function loadOutcomes(logPath) {
  const absPath = path.resolve(logPath || '.audit/outcomes.jsonl');
  if (!fs.existsSync(absPath)) return [];
  try {
    return fs.readFileSync(absPath, 'utf-8')
      .trim().split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
  } catch (err) {
    process.stderr.write(`  [outcomes] Failed to load: ${err.message}\n`);
    return [];
  }
}

// ── Phase 4: Effectiveness Tracking + False Positive Learning ──────────────

/**
 * Compute pass effectiveness from outcome history.
 * @param {object[]} outcomes - From loadOutcomes()
 * @param {string} passName - Optional filter by pass
 * @returns {object} Effectiveness metrics
 */
export function computePassEffectiveness(outcomes, passName = null) {
  const filtered = passName
    ? outcomes.filter(o => o.pass === passName)
    : outcomes;

  if (filtered.length === 0) return { acceptanceRate: 0, signalScore: 0, total: 0 };

  const accepted = filtered.filter(o => o.accepted).length;
  const dismissed = filtered.filter(o => !o.accepted).length;
  const total = filtered.length;

  return {
    acceptanceRate: total > 0 ? accepted / total : 0,
    signalScore: total > 0 ? accepted / total : 0,
    total,
    accepted,
    dismissed
  };
}

/**
 * False positive tracker using exponential moving average.
 * Auto-suppresses patterns with consistently high dismiss rates.
 */
export class FalsePositiveTracker {
  constructor(statePath = '.audit/fp-tracker.json') {
    this.statePath = path.resolve(statePath);
    this.patterns = this._load();
  }

  /** Generate a pattern key from a finding. */
  patternKey(finding) {
    const category = (finding.category || '').replace(/\[.*?\]\s*/g, '').trim().toLowerCase();
    const principle = (finding.principle || 'unknown').toLowerCase();
    return `${category}::${finding.severity || 'UNKNOWN'}::${principle}`;
  }

  /** Record outcome and update EMA (alpha=0.3 — ~70% weight on last 3). */
  record(finding, accepted) {
    const key = this.patternKey(finding);
    if (!this.patterns[key]) {
      this.patterns[key] = { dismissed: 0, accepted: 0, ema: 0.5 };
    }
    const p = this.patterns[key];
    if (accepted) p.accepted++;
    else p.dismissed++;
    p.ema = 0.3 * (accepted ? 1 : 0) + 0.7 * p.ema;
    this._save();
  }

  /** Should this finding pattern be auto-suppressed? */
  shouldSuppress(finding) {
    const p = this.patterns[this.patternKey(finding)];
    if (!p) return false;
    const total = p.accepted + p.dismissed;
    return total >= 5 && p.ema < 0.15; // 85%+ dismiss rate after 5+ observations
  }

  /** Get suppression report for all tracked patterns. */
  getReport() {
    return Object.entries(this.patterns)
      .map(([key, p]) => ({
        pattern: key,
        total: p.accepted + p.dismissed,
        acceptRate: p.ema,
        suppressed: p.accepted + p.dismissed >= 5 && p.ema < 0.15
      }))
      .sort((a, b) => a.acceptRate - b.acceptRate);
  }

  _load() {
    try {
      if (fs.existsSync(this.statePath)) {
        return JSON.parse(fs.readFileSync(this.statePath, 'utf-8'));
      }
    } catch { /* */ }
    return {};
  }

  _save() {
    try {
      atomicWriteFileSync(this.statePath, JSON.stringify(this.patterns, null, 2));
    } catch (err) {
      process.stderr.write(`  [fp-tracker] Save failed: ${err.message}\n`);
    }
  }
}
