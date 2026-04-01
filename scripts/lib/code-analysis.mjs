/**
 * Code analysis and chunking utilities for map-reduce audit architecture.
 * Extracted from shared.mjs — handles file chunking, dependency graphs, and audit units.
 */

import fs from 'node:fs';
import path from 'node:path';
import { normalizePath } from './file-io.mjs';

// ── Token Estimation ─────────────────────────────────────────────────────────

/** Estimate token count from character length (~4 chars per token). */
export function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

// ── Source Splitting ─────────────────────────────────────────────────────────

/**
 * Extract everything before the first function/class/const export.
 * @param {string} source - Source code
 * @returns {string} Import/header block
 */
export function extractImportBlock(source) {
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/^(?:export\s+)?(?:async\s+)?(?:function|class)\s|^export\s+(?:const|let|var)\s+\w+\s*=/.test(lines[i])) {
      return lines.slice(0, i).join('\n');
    }
  }
  return source.slice(0, Math.min(source.length, 2000)); // No boundary found
}

/**
 * Split source at function/class/export const boundaries.
 * @param {string} source - Source code
 * @returns {Array<{source: string, startLine: number}>} Chunks with line numbers
 */
export function splitAtFunctionBoundaries(source) {
  const boundaryRegex = /^(?:export\s+)?(?:async\s+)?(?:function|class)\s|^export\s+(?:const|let|var)\s+\w+\s*=/;
  const lines = source.split('\n');
  const chunks = [];
  let currentStart = -1;

  for (let i = 0; i < lines.length; i++) {
    if (boundaryRegex.test(lines[i])) {
      if (currentStart >= 0) {
        chunks.push({ source: lines.slice(currentStart, i).join('\n'), startLine: currentStart + 1 });
      }
      currentStart = i;
    }
  }
  if (currentStart >= 0) {
    chunks.push({ source: lines.slice(currentStart).join('\n'), startLine: currentStart + 1 });
  }

  return chunks.length > 0 ? chunks : [{ source, startLine: 1 }]; // Fallback: whole file as one chunk
}

// ── File Chunking ────────────────────────────────────────────────────────────

/**
 * Chunk a large file by function boundaries, with import block prepended to each chunk.
 * Falls back to line-count splitting if no function boundaries found.
 * @param {string} source - Source code
 * @param {string} filePath - File path (for logging)
 * @param {number} [maxChunkTokens=6000] - Maximum tokens per chunk
 * @returns {Array<{imports: string, items: Array<{source: string, startLine: number}>, tokens: number}>}
 */
export function chunkLargeFile(source, filePath, maxChunkTokens = 6000) {
  const imports = extractImportBlock(source);
  const functions = splitAtFunctionBoundaries(source);

  if (functions.length <= 1) {
    // No function boundaries found — line-count fallback
    const lines = source.split('\n');
    const linesPerChunk = Math.floor(maxChunkTokens * 4 / 80); // ~80 chars per line avg
    const chunks = [];
    for (let i = 0; i < lines.length; i += linesPerChunk) {
      chunks.push({
        imports,
        items: [{ source: lines.slice(i, i + linesPerChunk).join('\n'), startLine: i + 1 }],
        tokens: estimateTokens(imports) + estimateTokens(lines.slice(i, i + linesPerChunk).join('\n'))
      });
    }
    return chunks;
  }

  const chunks = [];
  let current = { imports, items: [], tokens: estimateTokens(imports) };

  for (const fn of functions) {
    const fnTokens = estimateTokens(fn.source);
    if (current.tokens + fnTokens > maxChunkTokens && current.items.length > 0) {
      chunks.push(current);
      current = { imports, items: [], tokens: estimateTokens(imports) };
    }
    current.items.push(fn);
    current.tokens += fnTokens;
  }
  if (current.items.length) chunks.push(current);
  return chunks;
}

// ── Export Extraction ────────────────────────────────────────────────────────

/**
 * Extract just the export signatures from a file (for peripheral files in oversized clusters).
 * @param {string} filePath - File path to extract exports from
 * @returns {string} Export signatures as a comment block
 */
export function extractExportsOnly(filePath) {
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) return '';
  const source = fs.readFileSync(absPath, 'utf-8');
  const lines = source.split('\n');
  const exports = lines.filter(l => /^export\s/.test(l));
  return `// ${filePath} — exports only\n${exports.join('\n')}`;
}

// ── Dependency Graph ─────────────────────────────────────────────────────────

/**
 * Build a simple import graph from file list.
 * @param {string[]} files - File paths to analyze
 * @returns {Map<string, Set<string>>} file -> Set of files it imports
 */
export function buildDependencyGraph(files) {
  const graph = new Map(); // file -> Set of files it imports
  const normFiles = files.map(normalizePath);

  for (const file of files) {
    const normFile = normalizePath(file);
    graph.set(normFile, new Set());
    const absPath = path.resolve(file);
    if (!fs.existsSync(absPath)) continue;

    const content = fs.readFileSync(absPath, 'utf-8');
    const importRegex = /(?:import|from)\s+['"]([^'"]+)['"]/g;
    let match;
    while ((match = importRegex.exec(content)) !== null) {
      const specifier = match[1];
      if (!specifier.startsWith('.')) continue; // skip node_modules

      // Resolve relative import to a file in our list
      const dir = path.dirname(file);
      const resolved = normalizePath(path.join(dir, specifier));
      // Try with common extensions
      for (const candidate of [resolved, resolved + '.js', resolved + '.mjs', resolved + '.ts']) {
        if (normFiles.includes(candidate)) {
          graph.get(normFile).add(candidate);
          break;
        }
      }
    }
  }
  return graph;
}

// ── Audit Units ──────────────────────────────────────────────────────────────

/**
 * Group files into audit units that fit within a context window.
 * Uses greedy bin-packing sorted by descending token count.
 * Files exceeding the budget are chunked by function boundaries.
 * @param {string[]} files - File paths to group
 * @param {number} [maxTokensPerUnit=30000] - Maximum tokens per audit unit
 * @returns {Array<{files: string[], tokens: number, chunk?: object, strategy?: string}>}
 */
export function buildAuditUnits(files, maxTokensPerUnit = 30000) {
  // Score and sort files
  const scored = files.map(f => {
    const absPath = path.resolve(f);
    const size = fs.existsSync(absPath) ? fs.statSync(absPath).size : 0;
    return { path: f, tokens: Math.ceil(size / 4), size };
  }).sort((a, b) => b.tokens - a.tokens);

  // Simple greedy bin-packing into units
  const units = [];
  let current = { files: [], tokens: 0 };

  for (const file of scored) {
    if (current.tokens + file.tokens > maxTokensPerUnit && current.files.length > 0) {
      units.push(current);
      current = { files: [], tokens: 0 };
    }

    // If single file exceeds budget, it needs chunking
    if (file.tokens > maxTokensPerUnit) {
      const absPath = path.resolve(file.path);
      if (fs.existsSync(absPath)) {
        const source = fs.readFileSync(absPath, 'utf-8');
        const chunks = chunkLargeFile(source, file.path, Math.floor(maxTokensPerUnit * 0.8));
        for (const chunk of chunks) {
          units.push({ files: [file.path], tokens: chunk.tokens, chunk, strategy: 'chunked' });
        }
      }
      continue;
    }

    current.files.push(file.path);
    current.tokens += file.tokens;
  }
  if (current.files.length > 0) units.push(current);

  process.stderr.write(`  [map-reduce] ${files.length} files → ${units.length} audit units\n`);
  return units;
}

// ── Reduce Prompt ────────────────────────────────────────────────────────────

/** System prompt for the REDUCE phase of map-reduce auditing. */
export const REDUCE_SYSTEM_PROMPT = `You are a SENIOR CODE REVIEWER synthesizing findings from multiple parallel audit passes.

Multiple reviewers have independently audited different parts of the same codebase. Your job:

1. DEDUPLICATE: Remove findings that describe the same issue (different wording, same problem)
2. ELEVATE PATTERNS: If 3+ reviewers found the same class of issue in different files, create ONE systemic finding at elevated severity
3. CROSS-FILE ISSUES: Identify issues that span multiple files (e.g., inconsistent error handling, missing auth in related routes)
4. RANK: Order findings by severity (HIGH first), then by systemic impact

Do NOT:
- Add new findings that no reviewer mentioned
- Change the substance of findings (only merge/elevate)
- Lower severity unless merging duplicates

Mark systemic findings with category prefix [SYSTEMIC].`;

// ── Context Measurement ──────────────────────────────────────────────────────

/**
 * Measure total character count of files that would be sent in a context block.
 * @param {string[]} filePaths
 * @param {number} maxPerFile
 * @returns {number}
 */
export function measureContextChars(filePaths, maxPerFile = 10000) {
  let total = 0;
  for (const p of filePaths) {
    const abs = path.resolve(p);
    if (fs.existsSync(abs)) {
      const size = fs.statSync(abs).size;
      total += Math.min(size, maxPerFile);
    }
  }
  return total;
}
