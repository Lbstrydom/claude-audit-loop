/**
 * @fileoverview Core file I/O utilities + barrel re-exports.
 *
 * Core: atomic writes, path normalization, safe parsing, readFileOrDie, writeOutput.
 * Re-exports: audit-scope, diff-annotation, plan-paths (backward compat for all 19+ importers).
 *
 * @module scripts/lib/file-io
 */

import fs from 'fs';
import path from 'path';

// ── Atomic File Writes ──────────────────────────────────────────────────────
// Write to a temp file in the same directory, then rename for crash-safety.

export function atomicWriteFileSync(filePath, data) {
  const absPath = path.resolve(filePath);
  const dir = path.dirname(absPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.tmp-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(tmpPath, data, 'utf-8');
    fs.renameSync(tmpPath, absPath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch (cleanupErr) {
      process.stderr.write(`  [atomic-write] Temp file cleanup failed: ${cleanupErr.message}\n`);
    }
    throw err;
  }
}

// ── Path Normalization ──────────────────────────────────────────────────────

/**
 * Canonicalize file paths to cwd-relative, forward-slash, lowercase form.
 * @param {string} p - File path (absolute or relative)
 * @returns {string} Normalized path
 */
export function normalizePath(p) {
  const resolved = path.resolve(p);
  const cwdPrefix = path.resolve('.');
  return resolved.replace(cwdPrefix, '').replace(/\\/g, '/').replace(/^\//, '').toLowerCase();
}

// ── Safe Parsing ────────────────────────────────────────────────────────────

/** Safe parseInt with fallback for NaN. */
export function safeInt(val, fallback) {
  const n = parseInt(val, 10);
  return Number.isNaN(n) ? fallback : n;
}

// ── File Helpers ────────────────────────────────────────────────────────────

export function readFileOrDie(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    console.error(`Error: File not found: ${resolved}`);
    process.exit(1);
  }
  return fs.readFileSync(resolved, 'utf-8');
}

// ── Output Helpers ──────────────────────────────────────────────────────────

/**
 * Write output to file or stdout.
 * @param {object} data
 * @param {string} outPath
 * @param {string} summaryLine
 */
export function writeOutput(data, outPath, summaryLine) {
  const json = JSON.stringify(data, null, 2);
  if (outPath) {
    const abs = path.resolve(outPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, json, 'utf-8');
    process.stderr.write(`  [out] Results written to ${abs}\n`);
    console.log(summaryLine);
  } else {
    console.log(json);
  }
}

// ── Barrel Re-exports (backward compat) ─────────────────────────────────────
// All 19+ importers of file-io.mjs continue working unchanged.

export { isSensitiveFile, isAuditInfraFile, readFilesAsContext, classifyFiles, safeReadFile, AUDIT_INFRA_BASENAMES, MAX_FILE_SIZE } from './audit-scope.mjs';
export { parseDiffFile, readFilesAsAnnotatedContext, getCommentStyle } from './diff-annotation.mjs';
export { extractPlanPaths } from './plan-paths.mjs';
