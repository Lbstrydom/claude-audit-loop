/**
 * @fileoverview Pure robustness utilities for the audit pipeline.
 * Error classification, payload truncation, finding normalization, ledger path resolution.
 * All functions are side-effect-free and testable in isolation.
 */

import fs from 'node:fs';
import path from 'node:path';
import { openaiConfig } from './config.mjs';

// ── Constants ────────────────────────────────────────────────────────────────
export const MAX_REDUCE_JSON_CHARS = 120_000;
export const MAX_DETAIL_CHARS = 200;
export const MAP_FAILURE_THRESHOLD = 0.5;
export const RETRY_MAX_ATTEMPTS = 1;
export const RETRY_BASE_DELAY_MS = 2000;
export const RETRY_429_MAX_DELAY_MS = 8000;
export const SEV_ORDER = { HIGH: 0, MEDIUM: 1, LOW: 2 };

/** Stable directory for all local audit state. */
export const AUDIT_DIR = '.audit';
/** Canonical session ledger filename (always in AUDIT_DIR). */
export const SESSION_LEDGER_FILE = 'session-ledger.json';
/** Prefix for SID-scoped session manifest files. */
export const SESSION_MANIFEST_PREFIX = 'session-';

// ── LLM Error Classification ─────────────────────────────────────────────────

/**
 * Structured LLM error — carries usage and category for retry/accounting.
 */
export class LlmError extends Error {
  constructor(message, { category, usage = null, retryable = false } = {}) {
    super(message);
    this.name = 'LlmError';
    this.llmCategory = category;
    this.llmUsage = usage;
    this.llmRetryable = retryable;
  }
}

/**
 * Classify an LLM API error into retryable vs permanent categories.
 * Uses structured fields where available, avoids message-string matching.
 */
export function classifyLlmError(err) {
  if (err.llmCategory) return { retryable: err.llmRetryable, category: err.llmCategory };
  if (err.status) {
    if ([429, 500, 502, 503, 504].includes(err.status)) return { retryable: true, category: `http-${err.status}` };
    if (err.status >= 400 && err.status < 500) return { retryable: false, category: `http-${err.status}` };
  }
  if (err.name === 'AbortError' || err.code === 'ABORT_ERR') return { retryable: true, category: 'timeout' };
  if (err.cause?.code === 'ECONNRESET' || err.cause?.code === 'ENOTFOUND') return { retryable: true, category: 'network' };
  return { retryable: false, category: 'permanent' };
}

// ── Reduce Payload Builder ──────────────────────────────────────────────────

/**
 * Build a budget-safe JSON payload for the REDUCE phase.
 * Owns the sort invariant (HIGH > MEDIUM > LOW, tie-break by id).
 * Drops lowest-severity findings until under budget.
 */
export function buildReducePayload(findings, budget = MAX_REDUCE_JSON_CHARS) {
  const sorted = [...findings].sort((a, b) => {
    const sd = (SEV_ORDER[a.severity] ?? 2) - (SEV_ORDER[b.severity] ?? 2);
    return sd !== 0 ? sd : (a.id ?? '').localeCompare(b.id ?? '');
  });

  const summarize = (f) => ({
    id: f.id, severity: f.severity, category: f.category,
    section: f.section, detail: f.detail?.slice(0, MAX_DETAIL_CHARS),
    is_quick_fix: f.is_quick_fix, _mapUnit: f._mapUnit
  });

  let subset = sorted.map(summarize);
  let json = JSON.stringify(subset, null, 2);

  while (json.length > budget && subset.length > 1) {
    subset.pop();
    json = JSON.stringify(subset, null, 2);
  }

  if (json.length > budget && subset.length === 1) {
    const f = subset[0];
    for (const field of ['detail', 'category', 'section']) {
      if (json.length <= budget) break;
      const maxLen = Math.max(30, (f[field]?.length ?? 0) - (json.length - budget));
      f[field] = f[field]?.slice(0, maxLen);
      subset[0] = { ...f };
      json = JSON.stringify(subset, null, 2);
    }
  }

  if (json.length > budget) {
    return { json: '[]', includedCount: 0, totalCount: findings.length, degraded: true };
  }

  return { json, includedCount: subset.length, totalCount: findings.length, degraded: false };
}

/**
 * Normalize findings for output: semantic dedup, stable sort.
 * Used by both REDUCE output and raw MAP survivors for consistent downstream behavior.
 * @param {Array} findings
 * @param {Function} [semanticIdFn] - Hash function for dedup (defaults to JSON.stringify)
 */
export function normalizeFindingsForOutput(findings, semanticIdFn) {
  const seen = new Set();
  const deduped = [];
  for (const f of findings) {
    const hash = f._hash || (semanticIdFn ? semanticIdFn(f) : JSON.stringify(f));
    if (seen.has(hash)) continue;
    seen.add(hash);
    deduped.push({ ...f, _hash: hash });
  }
  deduped.sort((a, b) => {
    const sd = (SEV_ORDER[a.severity] ?? 2) - (SEV_ORDER[b.severity] ?? 2);
    return sd !== 0 ? sd : (a.id ?? '').localeCompare(b.id ?? '');
  });
  return deduped;
}

// ── JSON Repair ──────────────────────────────────────────────────────────────

/**
 * Attempt to repair truncated JSON using a deterministic bracket-balance algorithm.
 * Never fabricates content — only closes open brackets/quotes.
 * Handles common GPT truncation patterns: open arrays, objects, strings.
 *
 * @param {string} raw - Possibly truncated JSON string
 * @returns {{ ok: boolean, result?: object, repaired?: boolean, error?: string }}
 */
export function tryRepairJson(raw) {
  // Fast path — already valid
  try { return { ok: true, result: JSON.parse(raw) }; } catch {}

  // Strip trailing comma before closing (e.g. `[{"id":"1"},` → `[{"id":"1"}`)
  // and trailing whitespace before attempting repair
  let trimmed = raw.trimEnd().replace(/,\s*$/, '');

  // Balance-aware repair: track open structures and string state
  const stack = [];
  let inString = false;
  let escaped = false;

  for (const ch of trimmed) {
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    else if (ch === '}' || ch === ']') stack.pop();
  }

  // Close open string (handle trailing backslash edge case — G4 fix)
  let repaired = trimmed;
  if (inString) {
    if (escaped) repaired = repaired.slice(0, -1); // remove trailing '\'
    repaired += '"';
  }
  // Close open structures in reverse order
  while (stack.length > 0) repaired += stack.pop();

  try {
    const result = JSON.parse(repaired);
    return { ok: true, result, repaired: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── Ledger Path Resolution ──────────────────────────────────────────────────

/**
 * Resolve canonical ledger path.
 * - Explicit --ledger always wins
 * - Round 2+ without explicit: tries SID-scoped manifest, then stable session ledger
 * - Round 1 without explicit: derive from --out, or default to .audit/session-ledger.json
 * - --no-ledger: null
 */
export function resolveLedgerPath({ explicitLedger, outFile, round, noLedger, sessionId }) {
  if (noLedger) return null;
  if (explicitLedger) return path.resolve(explicitLedger);

  if (round >= 2) {
    // R2+: try SID-scoped manifest first, then stable session ledger fallback
    const sid = sessionId || process.env.AUDIT_SESSION_ID;
    if (sid) {
      const manifestPath = path.resolve(AUDIT_DIR, `${SESSION_MANIFEST_PREFIX}${sid}.json`);
      if (fs.existsSync(manifestPath)) {
        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
          if (manifest.ledgerPath) return path.resolve(manifest.ledgerPath);
        } catch { /* fall through */ }
      }
    }
    // Fallback: stable session ledger
    return path.resolve(AUDIT_DIR, SESSION_LEDGER_FILE);
  }

  // Derive from --out when available
  if (outFile) {
    const parsed = path.parse(outFile);
    const baseName = parsed.name.replace(/-result$/, '');
    const ledgerName = `${baseName}-ledger${parsed.ext}`;
    return path.resolve(parsed.dir, ledgerName);
  }

  // Default to .audit/ in repo root
  return path.resolve(AUDIT_DIR, SESSION_LEDGER_FILE);
}

// ── Adaptive Sizing ──────────────────────────────────────────────────────────

/**
 * Compute per-pass token limits and timeouts based on actual file content size.
 * Moved here from openai-audit.mjs to give robustness.mjs single ownership of budget math.
 *
 * Heuristics (calibrated from live GPT-5.4 runs):
 *   - ~4 chars per token (input estimation)
 *   - reasoning: high uses ~40-60% of output tokens for thinking
 *   - GPT-5.4 generates ~150-250 tokens/sec depending on reasoning effort
 *   - Each finding in the schema is ~200-400 output tokens
 *
 * @param {number} contextChars - Total chars being sent as user prompt
 * @param {string} reasoning - 'low' | 'medium' | 'high'
 * @param {number} [minTokens=0] - Floor for maxTokens (prevents reduce starvation)
 * @returns {{ maxTokens: number, timeoutMs: number }}
 */
// Per-reasoning-level constants (lookup tables avoid nested ternaries)
const REASONING_MULTIPLIER  = { high: 0.4,   medium: 0.25,  low: 0.1  };
const REASONING_BASE_TOKENS = { high: 10000,  medium: 6000,  low: 4000 };
const REASONING_TOKENS_PER_SEC = { high: 100, medium: 150,   low: 250  };
const REASONING_FLOOR_SEC   = { high: 150,   medium: 60,    low: 30   };

export function computePassLimits(contextChars, reasoning = 'high', minTokens = 0) {
  const MAX_OUTPUT_TOKENS_CAP = openaiConfig.maxOutputTokensCap;
  const TIMEOUT_MS_CAP = openaiConfig.timeoutMsCap;

  const level = reasoning in REASONING_MULTIPLIER ? reasoning : 'low';
  const estimatedInputTokens = Math.ceil(contextChars / 4);

  // Output tokens: base for findings + proportional to input size for reasoning
  // High reasoning needs a higher base because ~60% of tokens go to internal thinking
  const baseOutputTokens = REASONING_BASE_TOKENS[level];
  const reasoningOverhead = Math.ceil(estimatedInputTokens * REASONING_MULTIPLIER[level]);
  const maxTokens = Math.min(
    MAX_OUTPUT_TOKENS_CAP,
    Math.max(minTokens, baseOutputTokens + reasoningOverhead)
  );

  // Timeout: based on expected generation speed + reasoning overhead
  // GPT-5.4 with reasoning: high spends 90-150s thinking BEFORE output starts
  const tokensPerSec = REASONING_TOKENS_PER_SEC[level];
  const reasoningFloorSec = REASONING_FLOOR_SEC[level];
  const estimatedGenerationSec = maxTokens / tokensPerSec;
  const minTimeoutMs = (reasoningFloorSec + 60) * 1000; // floor + generous network buffer
  const timeoutMs = Math.min(
    TIMEOUT_MS_CAP,
    Math.max(minTimeoutMs, Math.ceil((estimatedGenerationSec + reasoningFloorSec) * 1000))
  );

  return { maxTokens, timeoutMs };
}
