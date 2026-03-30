/**
 * @fileoverview Shared utilities for multi-model audit scripts.
 * Used by both openai-audit.mjs (GPT-5.4) and gemini-review.mjs (Gemini 3.1 Pro).
 * @module scripts/shared
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';

// ── Canonical Schemas ─────────────────────────────────────────────────────────
// Single source of truth for finding shapes used by all reviewers (GPT + Gemini).
// Zod schemas are the primary definition; JSON Schemas are derived explicitly.

export const FindingSchema = z.object({
  id: z.string().max(10).describe('Finding ID, e.g. H1, M3, L2, G1'),
  severity: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  category: z.string().max(80).describe('Category: e.g. "DRY Violation", "Missing Error Handling"'),
  section: z.string().max(120).describe('Which plan/code section or file this relates to'),
  detail: z.string().max(600).describe('What is wrong and why it matters'),
  risk: z.string().max(300).describe('What could go wrong if not fixed'),
  recommendation: z.string().max(600).describe('Specific, actionable fix — NOT a quick fix, must be sustainable'),
  is_quick_fix: z.boolean().describe('TRUE if the recommendation is a band-aid rather than a proper fix.'),
  is_mechanical: z.boolean().describe('TRUE if fix is deterministic with exactly one correct answer.'),
  principle: z.string().max(80).describe('Which engineering/UX principle this violates')
});

/**
 * Explicit JSON Schema for findings — used by Gemini (which needs native JSON Schema).
 * Kept in sync with FindingSchema above. No private Zod API access needed.
 */
export const FindingJsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    severity: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'] },
    category: { type: 'string' },
    section: { type: 'string' },
    detail: { type: 'string' },
    risk: { type: 'string' },
    recommendation: { type: 'string' },
    is_quick_fix: { type: 'boolean' },
    is_mechanical: { type: 'boolean' },
    principle: { type: 'string' }
  },
  required: ['id', 'severity', 'category', 'section', 'detail', 'risk', 'recommendation', 'is_quick_fix', 'is_mechanical', 'principle']
};

/**
 * Generic contract test: verify a Zod object schema and its paired JSON Schema are in sync.
 * Recursively checks keys, required fields, types, and nested object/array structures.
 * Runs at import time to fail fast on schema drift.
 * @param {z.ZodObject} zodSchema - Zod schema (source of truth)
 * @param {object} jsonSchema - JSON Schema (must match)
 * @param {string} name - Schema pair name for error messages
 * @param {string} [path=''] - Dot-path prefix for nested error reporting
 * @throws {Error} if schemas are out of sync
 */
export function verifySchemaSync(zodSchema, jsonSchema, name, path = '') {
  const errors = [];
  const prefix = path ? `${path}.` : '';

  // Only verify object schemas (leaf types and arrays are checked inline)
  if (!zodSchema?.shape || !jsonSchema?.properties) return errors;

  const zodKeys = Object.keys(zodSchema.shape).sort();
  const jsonKeys = Object.keys(jsonSchema.properties).sort();
  const jsonRequiredSet = new Set(jsonSchema.required ?? []);

  const zodSet = new Set(zodKeys);
  const jsonSet = new Set(jsonKeys);

  // Key presence
  for (const k of zodKeys) {
    if (!jsonSet.has(k)) errors.push(`${prefix}${k}: missing in JSON Schema`);
  }
  for (const k of jsonKeys) {
    if (!zodSet.has(k)) errors.push(`${prefix}${k}: extra in JSON Schema`);
  }

  // Required fields
  for (const k of zodKeys) {
    if (!jsonRequiredSet.has(k)) errors.push(`${prefix}${k}: missing from required`);
  }

  // Type checking + recursive descent
  const zodTypeMap = { string: 'string', number: 'number', boolean: 'boolean', enum: 'string', array: 'array', object: 'object', literal: null };
  for (const key of zodKeys.filter(k => jsonSet.has(k))) {
    const zodField = zodSchema.shape[key];
    const jsonField = jsonSchema.properties[key];
    const zodType = zodField?._def?.type;
    const expectedJsonType = zodTypeMap[zodType];

    if (expectedJsonType && jsonField.type && jsonField.type !== expectedJsonType) {
      errors.push(`${prefix}${key}: type mismatch — Zod=${zodType}→${expectedJsonType}, JSON=${jsonField.type}`);
    }

    // Enum value comparison (Zod 4: _def.entries = { A: 'A', B: 'B' })
    if (zodType === 'enum' && jsonField.enum) {
      const zodValues = Object.values(zodField._def?.entries ?? {}).sort();
      const jsonValues = [...jsonField.enum].sort();
      if (zodValues.length !== jsonValues.length || zodValues.some((v, i) => v !== jsonValues[i])) {
        errors.push(`${prefix}${key}: enum values differ — Zod=[${zodValues}], JSON=[${jsonValues}]`);
      }
    }

    // Recurse into nested objects
    if (zodType === 'object' && jsonField.type === 'object') {
      errors.push(...verifySchemaSync(zodField, jsonField, name, `${prefix}${key}`));
    }

    // Recurse into array element schemas (if element is an object)
    if (zodType === 'array' && jsonField.type === 'array') {
      const zodElement = zodField._def?.element;
      const jsonElement = jsonField.items;
      if (zodElement?._def?.type === 'object' && jsonElement?.type === 'object') {
        errors.push(...verifySchemaSync(zodElement, jsonElement, name, `${prefix}${key}[]`));
      }
    }
  }

  // Only throw at the top level (recursive calls return error arrays)
  if (path === '' && errors.length) {
    throw new Error(`${name} schema drift:\n  ${errors.join('\n  ')}`);
  }
  return errors;
}

// Verify FindingSchema sync on import — both scripts use this schema
verifySchemaSync(FindingSchema, FindingJsonSchema, 'FindingSchema ↔ FindingJsonSchema');
// Note: GeminiFinalReview schema sync runs in gemini-review.mjs only (scoped blast radius)

export const WiringIssueSchema = z.object({
  frontend_call: z.string().max(120),
  backend_route: z.string().max(120),
  status: z.enum(['wired', 'broken', 'missing']),
  detail: z.string().max(300)
});

// ── Adjudication Ledger & R2+ Efficiency ────────────────────────────────────

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

/** Zod 4 schema for a single adjudication ledger entry. */
export const LedgerEntrySchema = z.object({
  topicId: z.string(),
  semanticHash: z.string(),
  adjudicationOutcome: z.enum(['dismissed', 'accepted', 'severity_adjusted']),
  remediationState: z.enum(['pending', 'planned', 'fixed', 'verified', 'regressed']),
  severity: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  originalSeverity: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  category: z.string(),
  section: z.string(),
  detailSnapshot: z.string(),
  affectedFiles: z.array(z.string()),
  affectedPrinciples: z.array(z.string()),
  ruling: z.enum(['sustain', 'overrule', 'compromise']),
  rulingRationale: z.string(),
  resolvedRound: z.number(),
  pass: z.string()
});

/** Zod 4 schema for the full adjudication ledger. */
export const AdjudicationLedgerSchema = z.object({
  version: z.literal(1),
  entries: z.array(LedgerEntrySchema)
});

/**
 * Deterministic fingerprint from structured fields. No content hash (stable across rewordings).
 * @param {object} finding - Finding object with section, principle, category, _pass fields
 * @returns {string} 12-char hex topic ID
 */
export function generateTopicId(finding) {
  const normFile = normalizePath(finding._primaryFile || finding.section?.split(':')[0] || 'unknown');
  const normPrinciple = (finding.principle || 'unknown').split('/')[0].split('—')[0].trim().toLowerCase().replace(/\s+/g, '-');
  const normCategory = (finding.category || 'unknown').replace(/\[.*?\]\s*/g, '').trim().toLowerCase().replace(/\s+/g, '-');
  const pass = finding._pass || 'unknown';
  const content = `${normFile}|${normPrinciple}|${normCategory}|${pass}`;
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 12);
}

/**
 * Upsert a ledger entry by topicId. Read-modify-write (not append).
 * @param {string} ledgerPath - Path to ledger JSON file
 * @param {object} entry - LedgerEntry-shaped object
 */
export function writeLedgerEntry(ledgerPath, entry) {
  const absPath = path.resolve(ledgerPath);
  let ledger = { version: 1, entries: [] };

  // Read existing
  if (fs.existsSync(absPath)) {
    try {
      ledger = JSON.parse(fs.readFileSync(absPath, 'utf-8'));
    } catch (err) {
      process.stderr.write(`  [ledger] Failed to read ${absPath}: ${err.message}\n`);
    }
  }

  // Upsert by topicId
  const idx = ledger.entries.findIndex(e => e.topicId === entry.topicId);
  if (idx >= 0) {
    ledger.entries[idx] = entry;
  } else {
    ledger.entries.push(entry);
  }

  // Write
  try {
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, JSON.stringify(ledger, null, 2), 'utf-8');
  } catch (err) {
    process.stderr.write(`  [ledger] Failed to write ${absPath}: ${err.message}\n`);
  }
}

/**
 * Enrich GPT finding with structured fields for suppression matching.
 * @param {object} finding - Raw finding from GPT
 * @param {string} passName - Current pass name
 * @returns {object} Enriched finding (mutated in place)
 */
export function populateFindingMetadata(finding, passName) {
  // Extract file paths from GPT's free-text section field
  const section = finding.section || '';
  const fileRegex = /(?:^|[\s`(])([a-zA-Z][\w./\\-]*\.(?:js|mjs|ts|tsx|jsx|json|css|html|md|sql))/g;
  const files = [];
  let match;
  while ((match = fileRegex.exec(section)) !== null) {
    files.push(normalizePath(match[1]));
  }

  finding._primaryFile = files[0] || normalizePath(section.split(':')[0].split('(')[0].trim());
  finding.affectedFiles = files.length > 0 ? files : [finding._primaryFile];
  finding._pass = passName || finding._pass || 'unknown';
  if (!finding.principle) finding.principle = 'unknown';
  return finding;
}

/**
 * Text similarity via token set overlap (Jaccard index).
 * @param {string} a - First text
 * @param {string} b - Second text
 * @returns {number} Similarity score 0-1
 */
export function jaccardSimilarity(a, b) {
  const tokenize = s => new Set((s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean));
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 && setB.size === 0) return 0;
  const intersection = [...setA].filter(t => setB.has(t)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Three-step suppression: narrow by pass+scope, fuzzy score, reopen check.
 * @param {object[]} findings - Current round findings (with _primaryFile, _pass)
 * @param {object} ledger - Parsed adjudication ledger
 * @param {object} opts
 * @param {string[]} [opts.changedFiles] - Files changed since last round
 * @param {string[]} [opts.impactSet] - Files in the impact set
 * @returns {{kept: object[], suppressed: object[], reopened: object[]}}
 */
export function suppressReRaises(findings, ledger, { changedFiles = [], impactSet = [] } = {}) {
  // Default 0.35: calibrated from real audit data — paraphrased re-raises score 0.3-0.6, new findings <0.2
  const threshold = parseFloat(process.env.SUPPRESS_SIMILARITY_THRESHOLD || '0.35');

  // Only suppress dismissed OR fixed/verified entries
  const resolved = (ledger?.entries || []).filter(e =>
    e.adjudicationOutcome === 'dismissed' ||
    e.remediationState === 'fixed' ||
    e.remediationState === 'verified'
  );

  const kept = [], suppressed = [], reopened = [];
  const changedSet = new Set(changedFiles.map(normalizePath));

  for (const f of findings) {
    // Step 1: Narrow candidates by pass + file scope overlap
    const fFile = normalizePath(f._primaryFile || f.section || '');
    const candidates = resolved.filter(d =>
      d.pass === f._pass &&
      d.affectedFiles.some(af => normalizePath(af) === fFile || fFile.includes(normalizePath(af)))
    );

    if (candidates.length === 0) { kept.push(f); continue; }

    // Step 2: Score all candidates, pick highest
    let bestMatch = null, bestScore = 0;
    for (const d of candidates) {
      const score = jaccardSimilarity(
        `${f.category} ${f.section} ${f.detail}`,
        `${d.category} ${d.section} ${d.detailSnapshot}`
      );
      if (score > bestScore) { bestScore = score; bestMatch = d; }
    }

    // Step 3: Threshold + reopen check
    if (bestMatch && bestScore > threshold) {
      const scopeDirectlyChanged = bestMatch.affectedFiles.some(af => changedSet.has(normalizePath(af)));
      if (scopeDirectlyChanged) {
        f._reopened = true;
        f._matchedTopic = bestMatch.topicId;
        f._matchScore = bestScore;
        reopened.push(f);
      } else {
        suppressed.push({
          finding: f,
          matchedTopic: bestMatch.topicId,
          matchScore: bestScore,
          reason: `Matches ${bestMatch.adjudicationOutcome} entry, scope unchanged`
        });
      }
    } else {
      kept.push(f);
    }
  }

  return { kept, suppressed, reopened };
}

/**
 * Format ledger entries as system-prompt exclusions for a specific pass.
 * @param {string} ledgerPath - Path to ledger JSON file
 * @param {string} passName - Current pass name
 * @param {string[]} [impactSet] - Files in the impact set
 * @returns {string} Formatted rulings block for system prompt
 */
export function buildRulingsBlock(ledgerPath, passName, impactSet = []) {
  if (!ledgerPath) return '';
  const absPath = path.resolve(ledgerPath);
  if (!fs.existsSync(absPath)) {
    process.stderr.write(`  [rulings] Ledger not found: ${absPath}\n`);
    return '';
  }

  let ledger;
  try {
    ledger = JSON.parse(fs.readFileSync(absPath, 'utf-8'));
  } catch (err) {
    process.stderr.write(`  [rulings] Failed to parse ledger: ${err.message}\n`);
    return '';
  }

  const entries = (ledger.entries || []).filter(e => e.pass === passName);
  if (entries.length === 0) return '';

  // Group by outcome
  const dismissed = entries.filter(e => e.adjudicationOutcome === 'dismissed');
  const adjusted = entries.filter(e => e.adjudicationOutcome === 'severity_adjusted');
  const fixed = entries.filter(e => e.remediationState === 'fixed' || e.remediationState === 'verified');

  const lines = [
    '## YOUR PRIOR RULINGS (scoped to this pass)',
    '',
    'These items were deliberated in prior rounds. Do NOT re-raise them unless',
    'the code they affect has materially changed (in which case mark as REOPENED).',
    ''
  ];

  if (dismissed.length > 0) {
    lines.push('### DISMISSED');
    for (const d of dismissed.slice(0, 8)) {
      lines.push(`- [${d.topicId.slice(0,6)}] "${d.category}" — YOU ruled DISMISSED R${d.resolvedRound}. Reason: ${d.rulingRationale.slice(0, 100)}. Scope: ${d.affectedFiles.join(', ')}`);
    }
    if (dismissed.length > 8) lines.push(`  ... and ${dismissed.length - 8} more dismissed items`);
    lines.push('');
  }

  if (adjusted.length > 0) {
    lines.push('### SEVERITY ADJUSTED (do not re-escalate)');
    for (const a of adjusted.slice(0, 5)) {
      lines.push(`- [${a.topicId.slice(0,6)}] "${a.category}" — ${a.originalSeverity}→${a.severity} R${a.resolvedRound}. Scope: ${a.affectedFiles.join(', ')}`);
    }
    lines.push('');
  }

  if (fixed.length > 0) {
    lines.push('### FIXED (do not re-raise)');
    for (const f of fixed.slice(0, 5)) {
      lines.push(`- [${f.topicId.slice(0,6)}] "${f.category}" — FIXED R${f.resolvedRound}. Scope: ${f.affectedFiles.join(', ')}`);
    }
    lines.push('');
  }

  let block = lines.join('\n');
  // Cap at ~1500 chars
  if (block.length > 1500) {
    block = block.slice(0, 1400) + '\n\n... [rulings truncated — see ledger for full list]';
  }

  process.stderr.write(`  [rulings] ${entries.length} entries for pass "${passName}" (${block.length} chars)\n`);
  return block;
}

/** Round 2+ system prompt modifier for verification-focused auditing. */
export const R2_ROUND_MODIFIER = `ROUND 2+ VERIFICATION MODE

This is a follow-up round. Your job has CHANGED from Round 1:

Round 1: Find ALL issues in the codebase.
Round 2+: VERIFY FIXES and CHECK FOR REGRESSIONS.

FOCUS ON:
1. Do the fixes resolve the original findings?
2. Did any fix introduce NEW problems in CHANGED code?
3. Did changes cause KNOCK-ON regressions in code that imports/depends on changed files?
4. Are there genuinely NEW issues not present in Round 1?

DO NOT:
- Re-raise findings from YOUR PRIOR RULINGS section below
- Paraphrase a dismissed finding as "new" — that contradicts your own judgment
- Re-audit unchanged, unaffected code for the same issue classes

If you believe a dismissed finding should be REOPENED because changed code
materially affects its scope, raise it with is_reopened: true.`;

/**
 * Build a Round 2+ system prompt with rulings context and pass rubric.
 * @param {string} passRubric - The pass-specific rubric text
 * @param {string} rulingsBlock - Output of buildRulingsBlock()
 * @returns {string} Complete R2+ system prompt
 */
export function buildR2SystemPrompt(passRubric, rulingsBlock) {
  return `${R2_ROUND_MODIFIER}\n\n${rulingsBlock}\n\n---\n\nPASS RUBRIC (what to check):\n${passRubric}`;
}

/**
 * Parse unified diff into line ranges per file.
 * @param {string} diffPath - Path to unified diff file
 * @returns {Map<string, {hunks: Array<{startLine: number, lineCount: number}>}>}
 */
export function parseDiffFile(diffPath) {
  const absPath = path.resolve(diffPath);
  if (!fs.existsSync(absPath)) {
    process.stderr.write(`  [diff] File not found: ${absPath}\n`);
    return new Map();
  }

  let content;
  try {
    content = fs.readFileSync(absPath, 'utf-8');
  } catch (err) {
    process.stderr.write(`  [diff] Failed to read: ${err.message}\n`);
    return new Map();
  }

  const diffMap = new Map();
  let currentFile = null;

  for (const line of content.split('\n')) {
    // File header: +++ b/path/to/file.js
    const fileMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (fileMatch) {
      currentFile = normalizePath(fileMatch[1]);
      if (!diffMap.has(currentFile)) diffMap.set(currentFile, { hunks: [] });
      continue;
    }

    // Hunk header: @@ -oldStart,oldCount +newStart,newCount @@
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch && currentFile) {
      diffMap.get(currentFile).hunks.push({
        startLine: parseInt(hunkMatch[1], 10),
        lineCount: parseInt(hunkMatch[2] || '1', 10)
      });
    }
  }

  process.stderr.write(`  [diff] Parsed ${diffMap.size} files, ${[...diffMap.values()].reduce((s, d) => s + d.hunks.length, 0)} hunks\n`);
  return diffMap;
}

/**
 * Wraps readFilesAsContext with diff-based change markers.
 * @param {string[]} filePaths - Files to read
 * @param {Map} diffMap - Output of parseDiffFile()
 * @param {object} opts
 * @param {number} [opts.maxPerFile=10000]
 * @param {number} [opts.maxTotal=120000]
 * @returns {string} Annotated file context
 */
export function readFilesAsAnnotatedContext(filePaths, diffMap, { maxPerFile = 10000, maxTotal = 120000 } = {}) {
  let total = '';
  let omitted = 0;
  const cwdBoundary = path.resolve('.');

  for (const relPath of filePaths) {
    if (isSensitiveFile(relPath)) continue;
    const absPath = path.resolve(relPath);
    if (!absPath.startsWith(cwdBoundary) || !fs.existsSync(absPath)) continue;

    let raw = fs.readFileSync(absPath, 'utf-8');
    const ext = relPath.split('.').pop();
    const lang = { sql: 'sql', css: 'css', html: 'html', md: 'markdown', json: 'json', py: 'python', rs: 'rust', go: 'go', java: 'java', rb: 'ruby', sh: 'bash' }[ext] ?? 'js';

    // Apply diff annotations if this file has changes
    const normPath = normalizePath(relPath);
    const diffInfo = diffMap?.get(normPath);
    if (diffInfo && diffInfo.hunks.length > 0) {
      const lines = raw.split('\n');
      // Insert markers (reverse order to preserve line numbers)
      const sortedHunks = [...diffInfo.hunks].sort((a, b) => b.startLine - a.startLine);
      for (const hunk of sortedHunks) {
        const endLine = Math.min(hunk.startLine + hunk.lineCount - 1, lines.length);
        const startIdx = Math.max(hunk.startLine - 1, 0);
        lines.splice(endLine, 0, '// ── END CHANGED ──');
        lines.splice(startIdx, 0, '// ── CHANGED ──');
      }
      raw = lines.join('\n');
    }

    const content = raw.length > maxPerFile
      ? raw.slice(0, maxPerFile) + `\n... [TRUNCATED — ${raw.length} chars total]`
      : raw;

    const annotation = diffInfo ? ' [CHANGED]' : '';
    const block = `### ${relPath}${annotation}\n\`\`\`${lang}\n${content}\n\`\`\`\n`;

    if (total.length + block.length > maxTotal) { omitted++; continue; }
    total += block;
  }

  if (omitted > 0) total += `\n... [${omitted} file(s) omitted — context budget reached]\n`;
  return total;
}

/**
 * Compute impact set: changed files + files that import them.
 * @param {string[]} changedFiles - Files directly changed
 * @param {string[]} allFiles - All project files to scan for imports
 * @returns {string[]} Sorted list of impacted file paths (normalized)
 */
export function computeImpactSet(changedFiles, allFiles) {
  const impact = new Set(changedFiles.map(normalizePath));

  for (const file of allFiles) {
    const normFile = normalizePath(file);
    if (impact.has(normFile)) continue;

    const absPath = path.resolve(file);
    if (!fs.existsSync(absPath)) continue;

    const content = fs.readFileSync(absPath, 'utf-8');
    for (const changed of changedFiles) {
      const basename = path.basename(changed, path.extname(changed));
      const normChanged = normalizePath(changed);
      if (content.includes(`from './${basename}`) || content.includes(`from './${normChanged}`)) {
        impact.add(normFile);
        break;
      }
    }
  }

  return [...impact].sort();
}

// ── Repo-Aware Prompt Tuning (Phase 2) ───────────────────────────────────────

/**
 * Generate a repo profile for audit tuning.
 * Combines file system scanning (instant) with audit brief analysis.
 * Cached per session.
 * @returns {object} Repo profile with stack, file breakdown, pass relevance, focus areas
 */
let _repoProfileCache = null;
export function generateRepoProfile() {
  if (_repoProfileCache) return _repoProfileCache;

  // 1. File inventory by directory pattern
  const codeExts = ['.js', '.mjs', '.ts', '.tsx', '.jsx', '.css', '.html', '.sql', '.py', '.go', '.rs', '.java', '.rb'];
  const allFiles = [];

  function scanDir(dir, depth = 0) {
    if (depth > 5) return; // Max recursion depth
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build') continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(fullPath, depth + 1);
        } else if (codeExts.some(ext => entry.name.endsWith(ext))) {
          allFiles.push(path.relative(path.resolve('.'), fullPath).replace(/\\/g, '/'));
        }
      }
    } catch { /* permission errors, etc */ }
  }
  scanDir(path.resolve('.'));

  // 2. Classify files
  const fileBreakdown = { backend: 0, frontend: 0, config: 0, test: 0, total: allFiles.length };
  for (const f of allFiles) {
    if (/test|spec|__test__|fixture|benchmark/i.test(f)) fileBreakdown.test++;
    else if (/public\/|frontend\/|client\/|\.css$|\.html$/i.test(f)) fileBreakdown.frontend++;
    else if (/config\/|\.config\.|\.env\.|settings/i.test(f)) fileBreakdown.config++;
    else fileBreakdown.backend++;
  }

  // 3. Stack detection from package.json
  const stack = { backend: {}, frontend: {}, testing: {} };
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf-8'));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

    // Backend framework
    if (allDeps.express) stack.backend.framework = 'express';
    else if (allDeps.fastify) stack.backend.framework = 'fastify';
    else if (allDeps.koa) stack.backend.framework = 'koa';
    else if (allDeps.hono) stack.backend.framework = 'hono';

    // Database
    if (allDeps.pg || allDeps['@supabase/supabase-js']) stack.backend.db = 'postgresql';
    else if (allDeps.mysql2) stack.backend.db = 'mysql';
    else if (allDeps.mongoose || allDeps.mongodb) stack.backend.db = 'mongodb';
    else if (allDeps['better-sqlite3'] || allDeps.sqlite3) stack.backend.db = 'sqlite';

    // Frontend framework
    if (allDeps.react || allDeps['react-dom']) stack.frontend.framework = 'react';
    else if (allDeps.vue) stack.frontend.framework = 'vue';
    else if (allDeps.svelte) stack.frontend.framework = 'svelte';
    else if (allDeps.angular || allDeps['@angular/core']) stack.frontend.framework = 'angular';
    else if (fileBreakdown.frontend > 0) stack.frontend.framework = 'vanilla-js';

    // Testing
    if (allDeps.vitest) stack.testing.framework = 'vitest';
    else if (allDeps.jest) stack.testing.framework = 'jest';
    else if (allDeps.mocha) stack.testing.framework = 'mocha';

    // TypeScript
    if (allDeps.typescript || allFiles.some(f => f.endsWith('.ts') || f.endsWith('.tsx'))) {
      stack.backend.typescript = true;
    }
  } catch { /* no package.json */ }

  // 4. Pass relevance
  const passRelevance = {
    structure: true, // always useful
    wiring: fileBreakdown.frontend > 0 && fileBreakdown.backend > 0, // only if both exist
    backend: fileBreakdown.backend > 0,
    frontend: fileBreakdown.frontend > 0,
    sustainability: true // always useful
  };

  // 5. Focus areas from audit brief (if available)
  const brief = _auditBriefCache || '';
  const focusAreas = [];
  // Extract bullet points from the brief that contain keywords like "MUST", "CRITICAL", "NEVER", "always"
  const briefLines = brief.split('\n');
  for (const line of briefLines) {
    const trimmed = line.replace(/^[-*•]\s*/, '').trim();
    if (trimmed.length > 20 && trimmed.length < 200 && /\b(MUST|CRITICAL|NEVER|always|required|forbidden)\b/i.test(trimmed)) {
      focusAreas.push(trimmed);
    }
  }

  // 6. Fingerprint
  let fingerprint = 'unknown';
  try {
    const parts = [];
    const pkgPath = path.resolve('package.json');
    if (fs.existsSync(pkgPath)) parts.push(fs.readFileSync(pkgPath, 'utf-8'));
    const claudePath = _getClaudeMdPath();
    if (claudePath) parts.push(fs.readFileSync(claudePath, 'utf-8'));
    parts.push(allFiles.sort().join('\n')); // sorted file inventory
    fingerprint = crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
  } catch { /* */ }

  _repoProfileCache = {
    repoFingerprint: fingerprint,
    stack,
    fileBreakdown,
    passRelevance,
    focusAreas: focusAreas.slice(0, 10), // cap at 10
    codeFiles: allFiles
  };

  process.stderr.write(`  [repo-profile] ${allFiles.length} files (${fileBreakdown.backend} BE, ${fileBreakdown.frontend} FE, ${fileBreakdown.test} test)\n`);
  process.stderr.write(`  [repo-profile] Stack: ${JSON.stringify(stack.backend)} | Passes: ${Object.entries(passRelevance).filter(([,v]) => v).map(([k]) => k).join(', ')}\n`);
  if (focusAreas.length > 0) process.stderr.write(`  [repo-profile] Focus: ${focusAreas.length} priority rules\n`);

  return _repoProfileCache;
}

/**
 * Helper: get the path of the found instruction file (not the content).
 * @returns {string|null} Path to instruction file, or null
 */
function _getClaudeMdPath() {
  for (const name of ['CLAUDE.md', 'Agents.md', '.github/copilot-instructions.md']) {
    const p = path.resolve(name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ── Map-Reduce Audit Architecture ────────────────────────────────────────────

/** Estimate token count from character length (~4 chars per token). */
export function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

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

// ── Safe Parsing ──────────────────────────────────────────────────────────────

/** Safe parseInt with fallback for NaN. */
export function safeInt(val, fallback) {
  const n = parseInt(val, 10);
  return Number.isNaN(n) ? fallback : n;
}

// ── File Helpers ──────────────────────────────────────────────────────────────

export function readFileOrDie(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    console.error(`Error: File not found: ${resolved}`);
    process.exit(1);
  }
  return fs.readFileSync(resolved, 'utf-8');
}

// ── Project Context (Audit Brief) ────────────────────────────────────────────
// Two-phase context extraction: regex for structured facts + LLM for the rest.
// Fallback chain: Gemini Flash → Claude Haiku → regex-only.

let _claudeMdCache = null;
function _getClaudeMd() {
  if (_claudeMdCache !== null) return _claudeMdCache;
  for (const name of ['CLAUDE.md', 'Agents.md', '.github/copilot-instructions.md']) {
    const p = path.resolve(name);
    if (fs.existsSync(p)) {
      _claudeMdCache = fs.readFileSync(p, 'utf-8');
      return _claudeMdCache;
    }
  }
  _claudeMdCache = '';
  return _claudeMdCache;
}

let _auditBriefCache = null;

/**
 * Phase A: Regex pre-extraction of structured facts from CLAUDE.md.
 * Deterministic, zero-cost, works offline. Returns dep versions + stack info.
 * @param {string} content - Raw CLAUDE.md content
 * @returns {string} Structured facts (~200-500 chars)
 */
function _extractRegexFacts(content) {
  const facts = [];

  // 1. Stack/runtime line
  const stackMatch = content.match(/\*\*(?:Stack|Runtime|Purpose)\*\*:\s*(.+)/i);
  if (stackMatch) facts.push(`Stack: ${stackMatch[1].trim()}`);

  // 2. Dependencies from markdown tables: | package | version | ...
  const depLines = [];
  // Match dep table rows: | package | version | notes |
  // Version must start with a digit or ^/~ (excludes prose like "5-pass" or headers)
  const tableRowRegex = /\|\s*`?(@?[\w/.-]+)`?\s*\|\s*\*?\*?([~^]?\d+\.\d+[\d.]*\S*)\*?\*?\s*\|(.*)$/gm;
  let match;
  while ((match = tableRowRegex.exec(content)) !== null) {
    const pkg = match[1].trim();
    const ver = match[2].trim();
    const notes = match[3].replace(/\|/g, '').trim();
    // Skip table headers
    if (pkg === 'Package' || pkg === 'Variable' || ver === 'Version' || /^-+$/.test(ver)) continue;
    const line = notes ? `${pkg}@${ver} — ${notes.slice(0, 80)}` : `${pkg}@${ver}`;
    depLines.push(line);
  }
  // Also check inline bold format: **package**: version
  // Package must contain lowercase letter (excludes metrics like MRR, HIT@1)
  // Version must have at least one dot (excludes bare numbers)
  const inlineDepRegex = /\*\*(`?[\w@/.-]+`?)\*\*:\s*(?:version\s+)?(\d+\.\d+[\d.]*\S*)/gi;
  while ((match = inlineDepRegex.exec(content)) !== null) {
    const pkg = match[1].replace(/`/g, '');
    const ver = match[2];
    if (/[a-z]/.test(pkg) && !depLines.some(l => l.startsWith(pkg))) depLines.push(`${pkg}@${ver}`);
  }
  if (depLines.length > 0) facts.push(`Dependencies:\n${depLines.map(l => `  ${l}`).join('\n')}`);

  // 3. Fallback: read package.json if no deps found
  if (depLines.length === 0) {
    try {
      const pkgPath = path.resolve('package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        const pkgLines = Object.entries(deps).slice(0, 15).map(([k, v]) => `  ${k}@${v}`);
        if (pkgLines.length > 0) facts.push(`Dependencies (from package.json):\n${pkgLines.join('\n')}`);
      }
    } catch { /* ignore */ }
  }

  return facts.join('\n');
}

const BRIEF_SYSTEM_PROMPT = `You are extracting an audit brief from a project's developer guidelines document.
Produce a CONCISE reference that a code auditor needs to avoid false positives.

## What to extract (use these exact headings):

### Dependencies & Versions
List every dependency with its EXACT version and any API-breaking notes (e.g., "Zod 4 uses _def.type NOT _def.typeName").

### Coding Rules
- Required patterns (async/await, scoping, auth, database query patterns)
- Forbidden patterns (things marked "Do NOT", "Never", "WRONG")
- Critical constraints (sections marked "CRITICAL")

### Architecture
- How modules interact (1-2 sentences)
- Key invariants (e.g., "all queries must include cellar_id")

### Naming Conventions
- File, variable, function, CSS naming rules (one line each)

### Testing
- Test commands and key rules (mock patterns, isolation)

## Rules
- Be THOROUGH — include ALL do/don't rules, not just the first few
- Include exact version numbers — auditors need these to avoid false positives
- No deployment instructions, environment variables, MCP configs, or Git conventions
- No code examples — just the rules/patterns
- Target 800-1200 characters`;

/**
 * Phase B: LLM condensation of CLAUDE.md into audit-relevant facts.
 * Fallback chain: Claude Haiku → Gemini Flash → null.
 * Haiku is primary (better quality, captures all constraints).
 * @param {string} content - Raw CLAUDE.md content (will be truncated)
 * @returns {Promise<string|null>} LLM-generated brief, or null on failure
 */
async function _llmCondense(content) {
  const truncated = content.slice(0, 48000); // ~12K tokens, fits Haiku/Flash comfortably
  const userContent = `Extract an audit brief from this developer guidelines document:\n\n${truncated}`;

  // Try Claude Haiku first (better quality — captures all constraints)
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const model = process.env.BRIEF_MODEL_CLAUDE || 'claude-haiku-4-5-20251001';
      process.stderr.write(`  [brief] Generating via ${model}...\n`);
      const startMs = Date.now();
      const response = await anthropic.messages.create({
        model,
        max_tokens: 2000,
        system: BRIEF_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }]
      });
      const text = response.content?.[0]?.text?.trim();
      process.stderr.write(`  [brief] ${model} done in ${((Date.now() - startMs) / 1000).toFixed(1)}s (${text?.length ?? 0} chars)\n`);
      if (text && text.length > 100) return text.slice(0, 3000); // Cap at 3000 chars
    } catch (err) {
      process.stderr.write(`  [brief] Claude Haiku failed: ${err.message} — trying Gemini Flash\n`);
    }
  }

  // Fallback: Gemini Flash
  if (process.env.GEMINI_API_KEY) {
    try {
      const { GoogleGenAI } = await import('@google/genai');
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const model = process.env.BRIEF_MODEL_GEMINI || 'gemini-2.5-flash';
      process.stderr.write(`  [brief] Generating via ${model}...\n`);
      const startMs = Date.now();
      const response = await ai.models.generateContent({
        model,
        contents: userContent,
        config: {
          systemInstruction: BRIEF_SYSTEM_PROMPT,
          maxOutputTokens: 4000
        }
      });
      const text = response.text?.trim();
      process.stderr.write(`  [brief] ${model} done in ${((Date.now() - startMs) / 1000).toFixed(1)}s (${text?.length ?? 0} chars)\n`);
      if (text && text.length > 100) return text.slice(0, 3000);
    } catch (err) {
      process.stderr.write(`  [brief] Gemini Flash failed: ${err.message}\n`);
    }
  }

  return null; // Both failed — caller uses regex-only
}

/**
 * Initialize the audit brief. Call once at startup before any passes run.
 * Generates a compact context brief from the project's CLAUDE.md using:
 *   Phase A: Regex extraction of deps/versions (deterministic)
 *   Phase B: LLM condensation of constraints/rules (Gemini Flash → Claude Haiku)
 *   Fallback: regex + raw truncation if no LLM available
 * @returns {Promise<string>} The generated brief
 */
export async function initAuditBrief() {
  const content = _getClaudeMd();
  if (!content) {
    _auditBriefCache = '(No project instruction file found — checked CLAUDE.md, Agents.md, .github/copilot-instructions.md)';
    return _auditBriefCache;
  }

  // Phase A: deterministic regex facts
  const regexFacts = _extractRegexFacts(content);

  // Phase B: LLM condensation
  const llmBrief = await _llmCondense(content);

  if (llmBrief) {
    // Merge: regex facts (trusted) + LLM brief (flexible)
    _auditBriefCache = regexFacts
      ? `## Project Facts (verified)\n${regexFacts}\n\n## Audit Guidelines\n${llmBrief}`
      : `## Audit Guidelines\n${llmBrief}`;
  } else if (regexFacts && regexFacts.length > 200) {
    // Regex-only: good enough for repos with standard structure
    process.stderr.write(`  [brief] No LLM available — using regex-only brief\n`);
    _auditBriefCache = `## Project Facts\n${regexFacts}\n\n## Raw Context\n${content.slice(0, 1500)}`;
  } else {
    // Last resort: raw truncation (same as old behavior)
    process.stderr.write(`  [brief] No LLM, minimal regex — falling back to raw context\n`);
    _auditBriefCache = content.slice(0, 2000);
  }

  process.stderr.write(`  [brief] Final brief: ${_auditBriefCache.length} chars (~${Math.ceil(_auditBriefCache.length / 4)} tokens)\n`);
  return _auditBriefCache;
}

// ── Pass-Specific Addendum ───────────────────────────────────────────────────

const PASS_ADDENDUM_PATTERNS = {
  structure: ['Code Organisation'],
  wiring: ['API Design'],
  backend: ['Data Integrity', 'Multi-User', 'PostgreSQL'],
  frontend: ['Frontend Patterns', 'Content Security Policy'],
  sustainability: ['Testing'],
  plan: [],
  rebuttal: [],
  review: []
};

/**
 * Extract a small pass-specific addendum from the raw CLAUDE.md.
 * Supplements the brief with details only relevant to one pass.
 * @param {string} passName
 * @returns {string} ~200-500 chars of pass-specific context, or empty string
 */
function _getPassAddendum(passName) {
  const content = _getClaudeMd();
  if (!content) return '';

  const patterns = PASS_ADDENDUM_PATTERNS[passName];
  if (!patterns || patterns.length === 0) return '';

  const sections = [];
  for (const pat of patterns) {
    const regex = new RegExp(`(## ${pat}[\\s\\S]*?)(?=\\n## [A-Z]|$)`, 'i');
    const match = content.match(regex);
    if (match) sections.push(match[1].slice(0, 500));
  }
  return sections.join('\n\n').slice(0, 800);
}

/**
 * Get project context for a specific audit pass.
 * Returns cached brief + pass-specific addendum.
 * Must call initAuditBrief() before first use.
 * @param {string} passName
 * @returns {string}
 */
export function readProjectContextForPass(passName) {
  const brief = _auditBriefCache;
  if (!brief) {
    // initAuditBrief() wasn't called — fall back to old behavior
    const content = _getClaudeMd();
    return content ? content.slice(0, 2000) : '(No project instruction file found — checked CLAUDE.md, Agents.md, .github/copilot-instructions.md)';
  }
  if (brief.startsWith('(No CLAUDE.md')) return brief;

  const addendum = _getPassAddendum(passName);
  return addendum
    ? `${brief}\n\n### Pass-Specific Context\n${addendum}`
    : brief;
}

/** Full project context for single-call modes (plan, rebuttal, review). */
export function readProjectContext() {
  if (_auditBriefCache) return _auditBriefCache;
  const content = _getClaudeMd();
  return content ? content.slice(0, 4000) : '(No project instruction file found — auditing without project context)';
}

// ── Plan Section Extraction ──────────────────────────────────────────────────

/**
 * Extract plan sections relevant to a specific audit pass.
 * @param {string} planContent - Full plan text
 * @param {string} passName - structure|wiring|backend|frontend|sustainability
 * @returns {string}
 */
export function extractPlanForPass(planContent, passName) {
  const sectionPatterns = {
    structure: ['File.Level Plan', 'Architecture', 'Files', 'Structure'],
    wiring: ['API', 'Route', 'Endpoint', 'Contract', 'Wiring'],
    backend: ['Backend', 'Database', 'Service', 'Logic', 'Schema'],
    frontend: ['Frontend', 'UI', 'User Flow', 'Component', 'Layout', 'UX'],
    sustainability: ['Sustainability', 'Testing', 'Risk', 'Trade.off', 'Error']
  };

  const patterns = sectionPatterns[passName];
  if (!patterns) return planContent.length > 4000 ? planContent.slice(0, 4000) : planContent;

  const sections = [];
  for (const pat of patterns) {
    const regex = new RegExp(`(##+ .*${pat}[\\s\\S]*?)(?=\\n##+ |$)`, 'i');
    const match = planContent.match(regex);
    if (match) sections.push(match[1]);
  }

  if (sections.length > 0) {
    const combined = sections.join('\n\n');
    return combined.length > 4000 ? combined.slice(0, 4000) + '\n...[truncated]' : combined;
  }
  return planContent.length > 3000 ? planContent.slice(0, 3000) + '\n...[plan truncated]' : planContent;
}

// ── History Context Builder ─────────────────────────────────────────────────

/**
 * Build a compact audit history block from a history JSON file.
 * @param {string} historyPath - Path to history JSON file
 * @returns {string}
 */
export function buildHistoryContext(historyPath) {
  if (!historyPath) return '';
  const abs = path.resolve(historyPath);
  if (!fs.existsSync(abs)) {
    process.stderr.write(`  [history] File not found: ${abs} — proceeding without history\n`);
    return '';
  }

  let rounds;
  try {
    rounds = JSON.parse(fs.readFileSync(abs, 'utf-8'));
  } catch (err) {
    process.stderr.write(`  [history] Failed to parse: ${err.message}\n`);
    return '';
  }

  if (!Array.isArray(rounds) || rounds.length === 0) return '';

  const lines = ['## Prior Audit History (DO NOT re-raise resolved items)\n'];
  lines.push(`${rounds.length} prior round(s). Only raise GENUINELY NEW or UNFIXED findings.\n`);

  for (const round of rounds) {
    lines.push(`### Round ${round.round ?? '?'}`);
    const findings = round.findings ?? [];
    if (findings.length > 0) {
      lines.push(`Findings (${findings.length}):`);
      for (const f of findings) {
        const hash = f._hash ?? semanticId(f);
        lines.push(`  ${f.id} [${f.severity}] (hash:${hash}) ${(f.detail ?? f.category ?? '').slice(0, 120)}`);
      }
    }
    if (round.fixed_ids?.length) lines.push(`Fixed: ${round.fixed_ids.join(', ')}`);
    if (round.fixed_hashes?.length) lines.push(`Fixed hashes: ${round.fixed_hashes.join(', ')}`);
    if (round.dismissed_ids?.length) lines.push(`Dismissed: ${round.dismissed_ids.join(', ')}`);
    if (round.dismissed_hashes?.length) lines.push(`Dismissed hashes: ${round.dismissed_hashes.join(', ')}`);
    if (round.resolutions?.length) {
      for (const r of round.resolutions) lines.push(`  ${r.finding_id}: ${r.gpt_ruling} → ${r.final_severity}`);
    }
    lines.push('');
  }

  lines.push('IMPORTANT: Do NOT re-raise findings whose hash appears in Fixed or Dismissed lists above.');
  lines.push('Use semantic hashes (not human IDs) as the primary key for cross-round matching.\n');
  const block = lines.join('\n');
  process.stderr.write(`  [history] Loaded ${rounds.length} round(s), ${block.length} chars\n`);
  return block;
}

// ── File Path Extraction ────────────────────────────────────────────────────

/**
 * Extract source file paths from a plan. Purely regex-driven.
 * @param {string} planContent
 * @returns {{found: string[], missing: string[], allPaths: Set<string>}}
 */
export function extractPlanPaths(planContent) {
  const paths = new Set();
  let match;

  const EXT = 'js|mjs|ts|tsx|jsx|sql|css|html|json|md|py|rs|go|java|rb|sh';

  const genericPathRegex = new RegExp(`(?:^|\\s|\\\`|\\()((?:\\.?[\\w.-]+\\/)+[\\w.-]+\\.(?:${EXT}))`, 'gm');
  while ((match = genericPathRegex.exec(planContent)) !== null) {
    const p = match[1].replace(/^\.\//, '');
    if (!p.startsWith('http') && !p.startsWith('node_modules')) paths.add(p);
  }

  const btRegex = new RegExp(`\\\`((?:\\.?[\\w.-]+\\/)+[\\w.-]+\\.(?:${EXT}))\\\``, 'gm');
  while ((match = btRegex.exec(planContent)) !== null) {
    const p = match[1].replace(/^\.\//, '');
    if (!p.startsWith('http') && !p.startsWith('node_modules')) paths.add(p);
  }

  const fnRegex = /####\s+`([^/`]+\.(?:js|mjs|ts|md))`/gm;
  while ((match = fnRegex.exec(planContent)) !== null) {
    const filename = match[1];
    if ([...paths].some(p => p.endsWith('/' + filename) || p === filename)) continue;
    const searchDirs = [
      'src/config', 'src/routes', 'src/services', 'src/schemas',
      'scripts', 'lib', 'utils', '.claude/skills', '.github/skills'
    ];
    for (const dir of searchDirs) {
      const candidate = `${dir}/${filename}`;
      if (fs.existsSync(path.resolve(candidate))) { paths.add(candidate); break; }
    }
  }

  const resolved = new Map();
  for (const p of paths) {
    const abs = path.resolve(p);
    if (!resolved.has(abs)) resolved.set(abs, p);
  }

  const found = [];
  const missing = [];
  for (const p of [...resolved.values()].sort()) {
    (fs.existsSync(path.resolve(p)) ? found : missing).push(p);
  }
  return { found, missing, allPaths: new Set(resolved.values()) };
}

// ── File Reading ────────────────────────────────────────────────────────────

const SENSITIVE_PATTERNS = [
  /\.env$/i, /\.env\./i, /secret/i, /credential/i, /\.pem$/i, /\.key$/i,
  /password/i, /token/i, /\.pfx$/i, /\.p12$/i, /id_rsa/i, /id_ed25519/i
];

export function isSensitiveFile(relPath) {
  const basename = path.basename(relPath);
  return SENSITIVE_PATTERNS.some(p => p.test(basename));
}

/**
 * Read file contents, truncated per file, capped total.
 * @param {string[]} filePaths
 * @param {object} opts
 * @param {number} [opts.maxPerFile=10000]
 * @param {number} [opts.maxTotal=120000]
 * @returns {string}
 */
export function readFilesAsContext(filePaths, { maxPerFile = 10000, maxTotal = 120000 } = {}) {
  let total = '';
  let omitted = 0;
  let sensitive = 0;

  const cwdBoundary = path.resolve('.');

  for (const relPath of filePaths) {
    if (isSensitiveFile(relPath)) { sensitive++; continue; }

    const absPath = path.resolve(relPath);
    if (!absPath.startsWith(cwdBoundary)) { omitted++; continue; }
    if (!fs.existsSync(absPath)) continue;

    const raw = fs.readFileSync(absPath, 'utf-8');
    const ext = relPath.split('.').pop();
    const lang = { sql: 'sql', css: 'css', html: 'html', md: 'markdown', json: 'json', py: 'python', rs: 'rust', go: 'go', java: 'java', rb: 'ruby', sh: 'bash' }[ext] ?? 'js';
    const content = raw.length > maxPerFile
      ? raw.slice(0, maxPerFile) + `\n... [TRUNCATED — ${raw.length} chars total]`
      : raw;
    const block = `### ${relPath}\n\`\`\`${lang}\n${content}\n\`\`\`\n`;

    if (total.length + block.length > maxTotal) { omitted++; continue; }
    total += block;
  }

  if (omitted > 0) total += `\n... [${omitted} file(s) omitted — context budget reached]\n`;
  if (sensitive > 0) total += `\n... [${sensitive} sensitive file(s) excluded (.env, secrets, keys)]\n`;
  return total;
}

/**
 * Classify files as backend, frontend, or shared.
 * @param {string[]} filePaths
 * @returns {{backend: string[], frontend: string[], shared: string[]}}
 */
export function classifyFiles(filePaths) {
  const backend = [];
  const frontend = [];
  const shared = [];

  const fePatterns = [/^public\//, /\/css\//, /\/html\//, /\.css$/, /\.html$/, /\/components\//];
  const sharedPatterns = [/\/config\//, /\/schemas\//, /\/types\//, /\/shared\//, /\.json$/];

  for (const p of filePaths) {
    if (fePatterns.some(rx => rx.test(p))) {
      frontend.push(p);
    } else if (sharedPatterns.some(rx => rx.test(p))) {
      shared.push(p);
    } else {
      backend.push(p);
    }
  }

  return { backend, frontend, shared };
}

// ── Semantic ID ─────────────────────────────────────────────────────────────

/**
 * Content-hash of finding for cross-round/cross-model dedup.
 * Same issue keeps the same ID regardless of which model raised it.
 * @param {object} f - Finding with category, section, detail
 * @returns {string} 8-char hex hash
 */
export function semanticId(f) {
  const content = `${f.category}|${f.section}|${f.detail}`.toLowerCase().trim();
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 8);
}

// ── Context Size Measurement ────────────────────────────────────────────────

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

// ── Phase 3: Local Outcome Logging ──────────────────────────────────────────

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

// ── Phase 4: Effectiveness Tracking + False Positive Learning ───────────────

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
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      fs.writeFileSync(this.statePath, JSON.stringify(this.patterns, null, 2), 'utf-8');
    } catch (err) {
      process.stderr.write(`  [fp-tracker] Save failed: ${err.message}\n`);
    }
  }
}
