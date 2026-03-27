#!/usr/bin/env node
/**
 * @fileoverview GPT-5.4 plan/code auditor for the plan-audit feedback loop.
 *
 * Architecture: Multi-pass parallel auditing for code mode.
 * Instead of one monolithic GPT call that times out, code audits run 5 focused
 * passes with tiered reasoning (low for mechanical, high for quality):
 *
 *   Pass 1 (structure) + Pass 2 (wiring)  → parallel, reasoning: low   ~20-30s
 *   Pass 3 (backend)   + Pass 4 (frontend) → parallel, reasoning: high  ~60-90s
 *   Pass 5 (sustainability)                → sequential, reasoning: medium ~30-45s
 *
 * Total wall time: ~2-3 min vs 5+ min monolithic (which often timed out).
 *
 * Usage:
 *   node scripts/openai-audit.mjs plan <plan-file>                    # Audit a plan
 *   node scripts/openai-audit.mjs code <plan-file>                    # Multi-pass code audit
 *   node scripts/openai-audit.mjs rebuttal <plan-file> <rebuttal-file> # Send Claude's rebuttals
 *   node scripts/openai-audit.mjs plan <plan-file> --json              # JSON output
 *   node scripts/openai-audit.mjs code <plan-file> --out /tmp/r.json   # Write results to file (clean terminal)
 *   node scripts/openai-audit.mjs code <plan-file> --history /tmp/h.json # Inject prior round history
 *
 * Requires: OPENAI_API_KEY in .env or environment
 *
 * @module scripts/openai-audit
 */

import 'dotenv/config';  // Auto-load .env — no manual export needed
import OpenAI from 'openai';
import { z } from 'zod';
import { zodTextFormat } from 'openai/helpers/zod';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// ── Configuration ──────────────────────────────────────────────────────────────

const MODEL = process.env.OPENAI_AUDIT_MODEL || 'gpt-5.4';
const REASONING_EFFORT = process.env.OPENAI_AUDIT_REASONING || 'high';

// Hard ceilings — adaptive sizing stays below these
// Safe parseInt: NaN falls back to default
function safeInt(val, fallback) { const n = parseInt(val, 10); return Number.isNaN(n) ? fallback : n; }
const MAX_OUTPUT_TOKENS_CAP = safeInt(process.env.OPENAI_AUDIT_MAX_TOKENS, 32000);
const TIMEOUT_MS_CAP = safeInt(process.env.OPENAI_AUDIT_TIMEOUT_MS, 300000); // 5 min absolute max
const BACKEND_SPLIT_THRESHOLD = safeInt(process.env.OPENAI_AUDIT_SPLIT_THRESHOLD, 12);

// ── Adaptive Sizing ────────────────────────────────────────────────────────────

/**
 * Compute per-pass token limits and timeouts based on actual file content size.
 * This makes the script portable across codebases — a 3-file project gets small
 * limits, a 30-file project gets large ones, all within hard ceilings.
 *
 * Heuristics (calibrated from live GPT-5.4 runs):
 *   - ~4 chars per token (input estimation)
 *   - reasoning: high uses ~40-60% of output tokens for thinking
 *   - GPT-5.4 generates ~150-250 tokens/sec depending on reasoning effort
 *   - Each finding in the schema is ~200-400 output tokens
 *
 * @param {number} contextChars - Total chars being sent as user prompt
 * @param {string} reasoning - 'low' | 'medium' | 'high'
 * @returns {{ maxTokens: number, timeoutMs: number }}
 */
function computePassLimits(contextChars, reasoning = 'high') {
  const estimatedInputTokens = Math.ceil(contextChars / 4);

  // Reasoning multiplier: high reasoning needs more output tokens for thinking
  const reasoningMultiplier = reasoning === 'high' ? 0.4 : reasoning === 'medium' ? 0.25 : 0.1;

  // Output tokens: base for findings + proportional to input size for reasoning
  // High reasoning needs a higher base because ~60% of tokens go to internal thinking
  // Minimum: low=4000, medium=6000, high=10000
  const baseOutputTokens = reasoning === 'high' ? 10000 : reasoning === 'medium' ? 6000 : 4000;
  const reasoningOverhead = Math.ceil(estimatedInputTokens * reasoningMultiplier);
  const maxTokens = Math.min(
    MAX_OUTPUT_TOKENS_CAP,
    Math.max(baseOutputTokens, baseOutputTokens + reasoningOverhead)
  );

  // Timeout: based on expected generation speed + reasoning overhead
  // GPT-5.4 with reasoning: high spends 30-60s thinking BEFORE output starts
  // low: ~250 tok/s, medium: ~200 tok/s, high: ~150 tok/s
  const tokensPerSec = reasoning === 'high' ? 150 : reasoning === 'medium' ? 200 : 250;
  const estimatedGenerationSec = maxTokens / tokensPerSec;
  // Reasoning think-time floor: high=90s, medium=45s, low=30s (before output starts)
  const reasoningFloorSec = reasoning === 'high' ? 90 : reasoning === 'medium' ? 45 : 30;
  const minTimeoutMs = (reasoningFloorSec + 30) * 1000; // floor + network buffer
  const timeoutMs = Math.min(
    TIMEOUT_MS_CAP,
    Math.max(minTimeoutMs, Math.ceil((estimatedGenerationSec + reasoningFloorSec) * 1000))
  );

  return { maxTokens, timeoutMs };
}

/**
 * Measure total character count of files that would be sent in a context block.
 * @param {string[]} filePaths
 * @param {number} maxPerFile
 * @returns {number}
 */
function measureContextChars(filePaths, maxPerFile = 10000) {
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

// ── Shared Schemas ─────────────────────────────────────────────────────────────

const FindingSchema = z.object({
  id: z.string().max(10).describe('Finding ID, e.g. H1, M3, L2'),
  severity: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  category: z.string().max(80).describe('Category: e.g. "DRY Violation", "Missing Error Handling", "Gestalt: Proximity"'),
  section: z.string().max(120).describe('Which plan/code section or file this relates to'),
  detail: z.string().max(600).describe('What is wrong and why it matters'),
  risk: z.string().max(300).describe('What could go wrong if not fixed'),
  recommendation: z.string().max(600).describe('Specific, actionable fix — NOT a quick fix, must be sustainable'),
  is_quick_fix: z.boolean().describe('TRUE if the recommendation is a band-aid rather than a proper fix.'),
  is_mechanical: z.boolean().describe('TRUE if fix is deterministic with exactly one correct answer (missing await, wrong operator, missing import). FALSE for architectural/design judgment calls.'),
  principle: z.string().max(80).describe('Which engineering/UX principle this violates')
});

// ── Plan Audit Schema ──────────────────────────────────────────────────────────

const PlanAuditResultSchema = z.object({
  verdict: z.enum(['READY_TO_IMPLEMENT', 'NEEDS_REVISION', 'SIGNIFICANT_GAPS']),
  structural_completeness: z.string().max(100).describe('e.g. "8/10 sections present"'),
  principle_coverage_pct: z.number().min(0).max(100),
  specificity: z.enum(['High', 'Medium', 'Low']),
  sustainability: z.enum(['Strong', 'Adequate', 'Weak', 'Missing']),
  findings: z.array(FindingSchema).max(25),
  ambiguities: z.array(z.object({
    location: z.string().max(120),
    vague_language: z.string().max(200),
    clarification_needed: z.string().max(300)
  })).max(20),
  quick_fix_warnings: z.array(z.string().max(300)).max(10),
  overall_reasoning: z.string().max(1000)
});

// ── Code Audit Pass Schemas (one per pass, smaller = faster) ───────────────────

const PassFindingsSchema = z.object({
  pass_name: z.string().max(30),
  findings: z.array(FindingSchema).max(15).describe('Top 15 findings, sorted by severity (HIGH first). Prefer fewer deep findings over many shallow ones.'),
  quick_fix_warnings: z.array(z.string().max(300)).max(5),
  summary: z.string().max(500).describe('Brief summary of this pass')
});

const StructurePassSchema = z.object({
  pass_name: z.literal('structure'),
  files_planned: z.number().int(),
  files_found: z.number().int(),
  files_missing: z.number().int(),
  missing_files: z.array(z.string().max(120)).max(30),
  export_mismatches: z.array(z.object({
    file: z.string().max(120),
    expected: z.string().max(200),
    actual: z.string().max(200)
  })).max(20),
  findings: z.array(FindingSchema).max(15),
  summary: z.string().max(500)
});

const WiringPassSchema = z.object({
  pass_name: z.literal('wiring'),
  wiring_issues: z.array(z.object({
    frontend_call: z.string().max(120),
    backend_route: z.string().max(120),
    status: z.enum(['wired', 'broken', 'missing']),
    detail: z.string().max(300)
  })).max(20),
  findings: z.array(FindingSchema).max(10),
  summary: z.string().max(500)
});

const SustainabilityPassSchema = z.object({
  pass_name: z.literal('sustainability'),
  findings: z.array(FindingSchema).max(15),
  dead_code: z.array(z.string().max(200)).max(20),
  quick_fix_warnings: z.array(z.string().max(300)).max(10),
  summary: z.string().max(500)
});

// ── Merged Code Audit Result (assembled from passes) ───────────────────────────

const CodeAuditResultSchema = z.object({
  verdict: z.enum(['PASS', 'NEEDS_FIXES', 'SIGNIFICANT_ISSUES']),
  files_planned: z.number().int(),
  files_found: z.number().int(),
  files_missing: z.number().int(),
  findings: z.array(FindingSchema).max(50),
  wiring_issues: z.array(z.object({
    frontend_call: z.string().max(120),
    backend_route: z.string().max(120),
    status: z.enum(['wired', 'broken', 'missing']),
    detail: z.string().max(300)
  })).max(20),
  quick_fix_warnings: z.array(z.string().max(300)).max(10),
  dead_code: z.array(z.string().max(200)).max(20),
  overall_reasoning: z.string().max(1000)
});

// ── Rebuttal Schema ────────────────────────────────────────────────────────────

const RebuttalResolutionSchema = z.object({
  resolutions: z.array(z.object({
    finding_id: z.string().max(10),
    claude_position: z.enum(['accept', 'partial_accept', 'challenge']),
    gpt_ruling: z.enum(['sustain', 'overrule', 'compromise']),
    final_severity: z.enum(['HIGH', 'MEDIUM', 'LOW', 'DISMISSED']),
    final_recommendation: z.string().max(800),
    reasoning: z.string().max(600),
    is_quick_fix: z.boolean()
  })).max(40),
  uncontested_findings: z.array(z.string().max(10)).max(40),
  deliberation_summary: z.string().max(1000)
});

// ── System Prompts ─────────────────────────────────────────────────────────────

const PLAN_AUDIT_SYSTEM = `You are an elite software architecture auditor reviewing a plan BEFORE implementation.
Your job is to find REAL issues that will cause rework, bugs, or architectural regret.

CRITICAL RULES:
1. Never accept quick fixes or band-aids. Every recommendation must be a PROPER, sustainable solution.
   If you see a recommendation that papers over a problem, set is_quick_fix=true and propose the real fix.
2. Check for SOLID principles (all 5), DRY, modularity, no dead code paths, no hardcoding.
3. Check long-term codebase sustainability — will this design accommodate change in 6 months?
4. Check code efficiency — no N+1 queries, no unbounded loops, no unnecessary complexity.
5. For frontend plans: apply Gestalt principles (proximity, similarity, continuity, closure, figure-ground,
   common region, common fate), check usability, consistency, navigability, cognitive load.
6. The plan must be detailed enough for a code team to execute WITHOUT guessing.
7. Flag vague language: "as needed", "handle appropriately", "etc.", "TBD", "probably".
8. Check that error states, loading states, and empty states are all specified.
9. Verify data flow is traceable end-to-end (UI → API → Service → DB and back).
10. Anti-patterns to flag: God functions, shotgun surgery, feature envy, leaky abstractions.

SEVERITY GUIDE:
- HIGH: Implementation will fail, produce bugs, or require significant rework
- MEDIUM: Implementation will work but quality/maintainability/UX will suffer
- LOW: Plan is functional but could be clearer or more thorough

Be ruthlessly honest but constructive. Cite specific sections.`;

const REBUTTAL_SYSTEM = `You are an elite software architecture auditor in a DELIBERATION round with a peer engineer (Claude).

You previously audited a plan or codebase and produced findings. Claude has reviewed your findings and
is pushing back on some of them — accepting some, partially accepting others, and challenging others.

YOUR JOB: For each challenged or partially accepted finding, decide fairly:

1. **SUSTAIN** — Your original finding stands. You MUST explain WHY Claude's counter-argument is insufficient.
2. **OVERRULE** — Claude is right. Set final_severity to DISMISSED or reduce it. Be honest when you are wrong.
3. **COMPROMISE** — Both sides have merit. Produce a modified recommendation that addresses both concerns.

CRITICAL RULES:
1. You are NOT always right. Claude has deep context about this specific codebase that you lack.
2. Do NOT sustain findings out of ego. If Claude's alternative is genuinely better, overrule yourself.
3. Quick-fix detection still applies — if the compromise is a band-aid, flag it.
4. Be specific in your reasoning. "I disagree" is not acceptable — explain WHY.
5. For findings Claude fully accepted, list them in uncontested_findings.
6. A challenge on severity is valid — you can adjust severity without dismissing.
7. If Claude proposes a better fix than yours, adopt it. The goal is the BEST outcome, not winning.
8. Hold firm on genuine safety/security/data-integrity issues regardless of pushback.`;

// ── Code Audit Pass Prompts (focused, one concern per pass) ────────────────────

const PASS_STRUCTURE_SYSTEM = `You are auditing CODE STRUCTURE against a plan.
FOCUS ONLY on: Do planned files exist? Are key exports/functions present? Are dependencies correct?
Do NOT check code quality, style, or logic — other passes handle that.
Be precise: cite exact file paths and function names.`;

const PASS_WIRING_SYSTEM = `You are auditing API WIRING between frontend and backend.
FOCUS ONLY on: Does every frontend API call have a matching backend route? Do HTTP methods match?
Are request/response shapes compatible? Are auth headers included (apiFetch, not raw fetch)?
Do NOT check code quality or logic — other passes handle that.`;

const PASS_BACKEND_SYSTEM = `You are auditing BACKEND CODE quality against engineering principles.
FOCUS ONLY on these files: routes, services, DB queries, config, schemas.
Check: SOLID (all 5), DRY, async/await correctness, error handling, input validation,
transaction safety, cellar_id scoping on ALL queries, auth middleware, N+1 queries,
hardcoded values, dead code, single source of truth.
Do NOT check frontend files or wiring — other passes handle that.
Every recommendation must be a PROPER sustainable solution, not a band-aid.

SEVERITY: HIGH = bugs/security/data-loss. MEDIUM = quality/maintainability. LOW = hygiene.`;

const PASS_FRONTEND_SYSTEM = `You are auditing FRONTEND CODE quality against UX and engineering principles.
FOCUS ONLY on these files: public/js/*, public/css/*, HTML templates.
Check: CSP compliance (no inline handlers), apiFetch (not raw fetch), event listener cleanup,
loading/error/empty state handling, accessibility (ARIA, keyboard, focus management),
Gestalt principles (proximity, similarity, continuity, closure, figure-ground),
cognitive load, consistency, responsive design, CSS variables, debounce on scroll/resize.
Do NOT check backend files or wiring — other passes handle that.
Every recommendation must be a PROPER sustainable solution, not a band-aid.

SEVERITY: HIGH = broken UX/accessibility. MEDIUM = degraded quality. LOW = polish.`;

const PASS_SUSTAINABILITY_SYSTEM = `You are auditing CODE SUSTAINABILITY and long-term health.
FOCUS on: Quick fixes that paper over problems, dead code (unused exports, unreachable branches),
hardcoded values that should be config, copy-pasted logic that should be extracted,
error swallowing (catch + ignore), coupling assessment, extension points, migration paths,
TODO/FIXME/HACK comments, console.log in production, file/function size (>500 lines / >50 lines).
Flag anything that is a band-aid instead of a proper fix (set is_quick_fix=true).
Check if the implementation will accommodate change in 6 months without major rework.

SEVERITY: HIGH = architectural debt that blocks change. MEDIUM = quality erosion. LOW = hygiene.`;

// ── File Helpers ───────────────────────────────────────────────────────────────

function readFileOrDie(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    console.error(`Error: File not found: ${resolved}`);
    process.exit(1);
  }
  return fs.readFileSync(resolved, 'utf-8');
}

// ── Project Context (Targeted) ───────────────────────────────────────────────
// Instead of sending 8000 chars of CLAUDE.md to every pass, extract only the
// sections relevant to each pass type. Saves ~2000 tokens per pass.

let _claudeMdCache = null;
function _getClaudeMd() {
  if (_claudeMdCache !== null) return _claudeMdCache;
  // Check both CLAUDE.md (Claude Code) and Agents.md (VS Code Copilot)
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

/**
 * Extract targeted CLAUDE.md sections for a specific audit pass.
 * Each pass gets only ~800-1500 chars instead of 8000.
 * @param {string} passName - structure|wiring|backend|frontend|sustainability|plan|rebuttal
 * @returns {string}
 */
function readProjectContextForPass(passName) {
  const content = _getClaudeMd();
  if (!content) return '(No CLAUDE.md found)';

  // Extract sections by heading (## Heading ... up to next ## or end)
  function extractSections(patterns) {
    const results = [];
    for (const pat of patterns) {
      const regex = new RegExp(`(## ${pat}[\\s\\S]*?)(?=\\n## [A-Z]|$)`, 'i');
      const match = content.match(regex);
      if (match) results.push(match[1].slice(0, 1500));
    }
    return results.join('\n\n').slice(0, 3000) || content.slice(0, 1500);
  }

  switch (passName) {
    case 'structure':
      return extractSections(['Code Organisation', 'Naming Conventions']);
    case 'wiring':
      return extractSections(['API Design', 'Frontend.*(API|Patterns)', 'Frontend API']);
    case 'backend':
      return extractSections(['Data Integrity', 'Multi-User', 'PostgreSQL', 'Code Style']);
    case 'frontend':
      return extractSections(['Frontend Patterns', 'Content Security Policy', 'CSP']);
    case 'sustainability':
      return extractSections(['Testing', 'Do NOT', 'Do ']);
    case 'plan': case 'rebuttal':
      // Plan audit gets a broader but still trimmed context
      return content.slice(0, 4000);
    default:
      return content.slice(0, 2000);
  }
}

// Backward compat: full context for single-call modes (plan, rebuttal)
function readProjectContext() {
  const content = _getClaudeMd();
  return content ? content.slice(0, 4000) : '(No CLAUDE.md found — auditing without project context)';
}

// ── Plan Section Extraction ──────────────────────────────────────────────────
// Instead of sending 6000 chars of plan to every pass, extract targeted sections.

/**
 * Extract plan sections relevant to a specific audit pass.
 * Falls back to truncated full plan if sections can't be found.
 * @param {string} planContent - Full plan text
 * @param {string} passName - structure|wiring|backend|frontend|sustainability
 * @returns {string}
 */
function extractPlanForPass(planContent, passName) {
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
  // Fallback: truncated full plan
  return planContent.length > 3000 ? planContent.slice(0, 3000) + '\n...[plan truncated]' : planContent;
}

// ── History Context Builder ─────────────────────────────────────────────────
// Compresses prior round results into an efficient context block for GPT,
// so it knows what was already found, fixed, challenged, and resolved.

/**
 * Build a compact audit history block from a history JSON file.
 * @param {string} historyPath - Path to history JSON file
 * @returns {string} Markdown block for injection into prompt, or empty string
 */
function buildHistoryContext(historyPath) {
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
      for (const f of findings) lines.push(`  ${f.id} [${f.severity}] ${(f.detail ?? f.category ?? '').slice(0, 120)}`);
    }
    if (round.fixed_ids?.length) lines.push(`Fixed: ${round.fixed_ids.join(', ')}`);
    if (round.dismissed_ids?.length) lines.push(`Dismissed: ${round.dismissed_ids.join(', ')}`);
    if (round.resolutions?.length) {
      for (const r of round.resolutions) lines.push(`  ${r.finding_id}: ${r.gpt_ruling} → ${r.final_severity}`);
    }
    lines.push('');
  }

  lines.push('IMPORTANT: Do NOT re-raise findings in the Fixed or Dismissed lists above.\n');
  const block = lines.join('\n');
  process.stderr.write(`  [history] Loaded ${rounds.length} round(s), ${block.length} chars\n`);
  return block;
}

// ── Output Helpers ──────────────────────────────────────────────────────────

/**
 * Write output to file or stdout. When --out is specified, JSON goes to file
 * and only a 1-line summary goes to stdout (keeps terminal clean for copilots).
 */
function writeOutput(data, outPath, summaryLine) {
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
 * Extract source file paths from a plan. Purely regex-driven, works for any plan.
 * @param {string} planContent
 * @returns {{found: string[], missing: string[], allPaths: Set<string>}}
 */
function extractPlanPaths(planContent) {
  const paths = new Set();
  let match;

  // Code file extensions to match
  const EXT = 'js|mjs|ts|tsx|jsx|sql|css|html|json|md|py|rs|go|java|rb|sh';

  // 1. Any relative path with at least one directory separator and a code extension
  //    Matches: src/foo.js, scripts/bar.mjs, .claude/skills/x/SKILL.md, lib/utils/helper.ts
  const genericPathRegex = new RegExp(`(?:^|\\s|\\\`|\\()((?:\\.?[\\w.-]+\\/)+[\\w.-]+\\.(?:${EXT}))`, 'gm');
  while ((match = genericPathRegex.exec(planContent)) !== null) {
    const p = match[1].replace(/^\.\//,''); // Normalize ./foo → foo
    if (!p.startsWith('http') && !p.startsWith('node_modules')) paths.add(p);
  }

  // 2. Backtick-quoted paths (highest confidence — explicitly referenced in plan)
  const btRegex = new RegExp(`\\\`((?:\\.?[\\w.-]+\\/)+[\\w.-]+\\.(?:${EXT}))\\\``, 'gm');
  while ((match = btRegex.exec(planContent)) !== null) {
    const p = match[1].replace(/^\.\//,'');
    if (!p.startsWith('http') && !p.startsWith('node_modules')) paths.add(p);
  }

  // 3. Filename-only headers (#### `foo.js`) — try to resolve in common dirs
  const fnRegex = /####\s+`([^/`]+\.(?:js|mjs|ts|md))`/gm;
  while ((match = fnRegex.exec(planContent)) !== null) {
    const filename = match[1];
    if ([...paths].some(p => p.endsWith('/' + filename) || p === filename)) continue;
    // Search common project directories
    const searchDirs = [
      'src/config', 'src/routes', 'src/services', 'src/schemas',
      'scripts', 'lib', 'utils', '.claude/skills', '.github/skills'
    ];
    for (const dir of searchDirs) {
      const candidate = `${dir}/${filename}`;
      if (fs.existsSync(path.resolve(candidate))) { paths.add(candidate); break; }
    }
  }

  // 4. Deduplicate paths that resolve to the same file
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

/**
 * Read file contents, truncated per file, capped total.
 * @param {string[]} filePaths - Relative paths to read
 * @param {object} opts
 * @param {number} [opts.maxPerFile=10000]
 * @param {number} [opts.maxTotal=120000]
 * @returns {string} Markdown block with file contents
 */
// Sensitive file patterns — never send to external API
const SENSITIVE_PATTERNS = [
  /\.env$/i, /\.env\./i, /secret/i, /credential/i, /\.pem$/i, /\.key$/i,
  /password/i, /token/i, /\.pfx$/i, /\.p12$/i, /id_rsa/i, /id_ed25519/i
];

function isSensitiveFile(relPath) {
  const basename = path.basename(relPath);
  return SENSITIVE_PATTERNS.some(p => p.test(basename));
}

function readFilesAsContext(filePaths, { maxPerFile = 10000, maxTotal = 120000 } = {}) {
  let total = '';
  let omitted = 0;
  let sensitive = 0;

  const cwdBoundary = path.resolve('.'); // Defence-in-depth: don't read outside project

  for (const relPath of filePaths) {
    if (isSensitiveFile(relPath)) { sensitive++; continue; }

    const absPath = path.resolve(relPath);
    if (!absPath.startsWith(cwdBoundary)) { omitted++; continue; } // Path traversal guard
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
function classifyFiles(filePaths) {
  const backend = [];
  const frontend = [];
  const shared = [];

  // Frontend indicators
  const fePatterns = [/^public\//, /\/css\//, /\/html\//, /\.css$/, /\.html$/, /\/components\//];
  // Shared indicators (config, schemas, types used by both)
  const sharedPatterns = [/\/config\//, /\/schemas\//, /\/types\//, /\/shared\//, /\.json$/];

  for (const p of filePaths) {
    if (fePatterns.some(rx => rx.test(p))) {
      frontend.push(p);
    } else if (sharedPatterns.some(rx => rx.test(p))) {
      shared.push(p);
    } else {
      backend.push(p); // Default: routes, services, scripts, lib, etc.
    }
  }

  return { backend, frontend, shared };
}

function formatFindings(findings) {
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

// ── GPT API Call Helper ────────────────────────────────────────────────────────

/**
 * Make a single GPT-5.4 call with structured output.
 * @param {OpenAI} openai
 * @param {object} opts
 * @param {string} opts.systemPrompt
 * @param {string} opts.userPrompt
 * @param {z.ZodType} opts.schema
 * @param {string} opts.schemaName
 * @param {string} [opts.reasoning='high']
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.passName] - For logging
 * @returns {Promise<{result: object, usage: object, latencyMs: number}>}
 */
async function callGPT(openai, { systemPrompt, userPrompt, schema, schemaName, reasoning, maxTokens, timeoutMs, passName }) {
  const effort = reasoning ?? REASONING_EFFORT;
  const tokens = maxTokens ?? MAX_OUTPUT_TOKENS_CAP;
  const timeout = timeoutMs ?? TIMEOUT_MS_CAP;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const startMs = Date.now();

  if (passName) {
    process.stderr.write(`  [${passName}] Starting (reasoning: ${effort}, timeout: ${(timeout / 1000).toFixed(0)}s)...\n`);
  }

  try {
    const requestParams = {
      model: MODEL,
      input: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      text: { format: zodTextFormat(schema, schemaName) },
      max_output_tokens: tokens
    };

    if (MODEL.startsWith('gpt-5')) {
      requestParams.reasoning = { effort };
    }

    const response = await openai.responses.parse(requestParams, { signal: controller.signal });
    clearTimeout(timer);
    const latencyMs = Date.now() - startMs;

    if (response.status === 'incomplete') {
      throw new Error(`Response incomplete: ${response.incomplete_details?.reason ?? 'unknown'}`);
    }

    const result = response.output_parsed;
    if (!result) throw new Error('No parsed output from model');

    const usage = {
      input_tokens: response.usage?.input_tokens ?? 0,
      output_tokens: response.usage?.output_tokens ?? 0,
      reasoning_tokens: response.usage?.output_tokens_details?.reasoning_tokens ?? 0,
      latency_ms: latencyMs
    };

    if (passName) {
      process.stderr.write(`  [${passName}] Done in ${(latencyMs / 1000).toFixed(1)}s (${usage.input_tokens} in / ${usage.output_tokens} out)\n`);
    }

    return { result, usage, latencyMs };

  } catch (err) {
    clearTimeout(timer);
    const latencyMs = Date.now() - startMs;
    const isAbort = err.name === 'AbortError' || err.message?.toLowerCase().includes('abort');
    const msg = isAbort
      ? `[${passName ?? 'call'}] Timeout after ${(timeout / 1000).toFixed(0)}s`
      : `[${passName ?? 'call'}] ${err.message} (${(latencyMs / 1000).toFixed(1)}s)`;
    process.stderr.write(`  [${passName ?? 'call'}] FAILED: ${msg}\n`);
    throw new Error(msg);
  }
}

/**
 * Wrapper that catches pass failures and returns empty results instead of crashing.
 * Allows the audit to continue even if one pass fails.
 */
async function safeCallGPT(openai, opts, emptyResult) {
  try {
    return await callGPT(openai, opts);
  } catch (err) {
    process.stderr.write(`  [${opts.passName}] Graceful degradation — using empty result\n`);
    return {
      result: emptyResult,
      usage: { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, latency_ms: 0 },
      latencyMs: 0,
      failed: true,
      error: err.message
    };
  }
}

// ── Multi-Pass Code Audit ──────────────────────────────────────────────────────

/**
 * Run multi-pass parallel code audit.
 * Large backend file sets are split into route+service sub-passes.
 * Each pass uses safeCallGPT for graceful degradation on timeout/error.
 */
async function runMultiPassCodeAudit(openai, planContent, projectContext, jsonMode, outFile, historyContext = '', { passFilter = null, fileFilter = null } = {}) {
  const totalStart = Date.now();
  const EMPTY_FINDINGS = { pass_name: 'empty', findings: [], quick_fix_warnings: [], summary: 'Pass skipped or failed.' };
  const EMPTY_STRUCTURE = { pass_name: 'structure', files_planned: 0, files_found: 0, files_missing: 0, missing_files: [], export_mismatches: [], findings: [], summary: 'Pass skipped.' };
  const EMPTY_WIRING = { pass_name: 'wiring', wiring_issues: [], findings: [], summary: 'Pass skipped.' };
  const EMPTY_SUSTAIN = { pass_name: 'sustainability', findings: [], dead_code: [], quick_fix_warnings: [], summary: 'Pass skipped.' };

  // 1. Gather and classify files
  const { found, missing, allPaths } = extractPlanPaths(planContent);
  const { backend, frontend, shared } = classifyFiles(found);

  // Split backend into routes vs services for manageable chunk sizes
  const backendRoutes = backend.filter(f => f.includes('/routes/'));
  const backendServices = backend.filter(f => !f.includes('/routes/'));
  const splitBackend = backend.length > BACKEND_SPLIT_THRESHOLD;

  process.stderr.write(`\nMulti-pass code audit: ${found.length} files found, ${missing.length} missing, ${allPaths.size} referenced\n`);
  process.stderr.write(`  Backend: ${backend.length} files (${backendRoutes.length} routes, ${backendServices.length} services) + ${shared.length} shared\n`);
  process.stderr.write(`  Frontend: ${frontend.length} files + ${shared.length} shared\n`);
  if (splitBackend) process.stderr.write(`  Backend split: YES (>${BACKEND_SPLIT_THRESHOLD} files → separate route + service passes)\n`);

  // History context for round 2+ (prevents re-raising resolved findings)
  const historyBlock = historyContext ? `\n${historyContext}\n` : '';

  const fileListContext = `## Files Referenced in Plan (${found.length} found, ${missing.length} missing)\n\n`
    + (missing.length ? `**Missing:** ${missing.join(', ')}\n\n` : '')
    + `**Found:** ${found.join(', ')}\n`;

  // When --files is specified, scope quality passes to those files + their shared deps
  // This enables delta-only auditing on Round 2+
  const scopedBackend = fileFilter ? backend.filter(f => fileFilter.some(ff => f.includes(ff) || ff.includes(f))) : backend;
  const scopedFrontend = fileFilter ? frontend.filter(f => fileFilter.some(ff => f.includes(ff) || ff.includes(f))) : frontend;
  const scopedBackendRoutes = fileFilter ? backendRoutes.filter(f => fileFilter.some(ff => f.includes(ff) || ff.includes(f))) : backendRoutes;
  const scopedBackendServices = fileFilter ? backendServices.filter(f => fileFilter.some(ff => f.includes(ff) || ff.includes(f))) : backendServices;

  if (fileFilter) {
    process.stderr.write(`  File scope: ${fileFilter.length} files → ${scopedBackend.length} BE + ${scopedFrontend.length} FE in scope\n`);
  }

  // Helper: should a pass run?
  const shouldRun = (name) => !passFilter || passFilter.includes(name);

  // Read shared files ONCE — reuse across passes that need them
  const sharedContext = shared.length > 0 ? readFilesAsContext(shared, { maxPerFile: 6000, maxTotal: 20000 }) : '';

  // Estimate base context size (targeted context per pass, not full CLAUDE.md)
  const baseContextChars = 2000 + fileListContext.length + historyBlock.length; // ~2000 for targeted CLAUDE.md

  // 2. Wave 1: Structure + Wiring (mechanical, reasoning: low)
  // Skippable on Round 2+ via --passes (structure rarely changes after R1)
  const wave1Promises = [];

  if (shouldRun('structure')) {
    const structureContextChars = baseContextChars + measureContextChars(found, 2000);
    const structureLimits = computePassLimits(structureContextChars, 'low');
    process.stderr.write(`\n── Wave 1: Structure + Wiring (parallel, reasoning: low) ──\n`);
    const structureFiles = readFilesAsContext(found, { maxPerFile: 2000, maxTotal: 30000 });
    wave1Promises.push(
      safeCallGPT(openai, {
        systemPrompt: PASS_STRUCTURE_SYSTEM,
        userPrompt: `## Project Context\n${readProjectContextForPass('structure')}\n${historyBlock}\n## Plan\n${extractPlanForPass(planContent, 'structure')}\n\n${fileListContext}\n\n## File Signatures\n${structureFiles}`,
        schema: StructurePassSchema,
        schemaName: 'structure_pass',
        reasoning: 'low',
        ...structureLimits,
        passName: 'structure'
      }, EMPTY_STRUCTURE)
    );
  } else {
    process.stderr.write(`\n── Wave 1: Structure SKIPPED (--passes) ──\n`);
    wave1Promises.push(Promise.resolve({ result: EMPTY_STRUCTURE, usage: { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, latency_ms: 0 }, latencyMs: 0 }));
  }

  if (shouldRun('wiring')) {
    const wiringFiles = found.filter(f => f.includes('/api/') || f.includes('/routes/'));
    const wiringContextChars = baseContextChars + measureContextChars(wiringFiles, 8000) + sharedContext.length;
    const wiringLimits = computePassLimits(wiringContextChars, 'low');
    wave1Promises.push(
      safeCallGPT(openai, {
        systemPrompt: PASS_WIRING_SYSTEM,
        userPrompt: `## Project Context\n${readProjectContextForPass('wiring')}\n${historyBlock}\n## Plan\n${extractPlanForPass(planContent, 'wiring')}\n\n${fileListContext}\n\n## API & Route Files\n${readFilesAsContext(wiringFiles, { maxPerFile: 8000, maxTotal: 60000 })}\n\n## Shared Files\n${sharedContext}`,
        schema: WiringPassSchema,
        schemaName: 'wiring_pass',
        reasoning: 'low',
        ...wiringLimits,
        passName: 'wiring'
      }, EMPTY_WIRING)
    );
  } else {
    process.stderr.write(`  Wiring SKIPPED (--passes)\n`);
    wave1Promises.push(Promise.resolve({ result: EMPTY_WIRING, usage: { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, latency_ms: 0 }, latencyMs: 0 }));
  }

  const [structureResult, wiringResult] = await Promise.all(wave1Promises);

  // 3. Wave 2: Backend + Frontend quality (deep, reasoning: high)
  process.stderr.write('\n── Wave 2: Quality passes (parallel, reasoning: high) ──\n');

  const wave2Promises = [];
  const backendPassNames = [];

  // Use scoped file lists when --files is specified (delta-only auditing)
  const beCtx = readProjectContextForPass('backend');
  const bePlan = extractPlanForPass(planContent, 'backend');
  const effectiveRoutes = fileFilter ? scopedBackendRoutes : backendRoutes;
  const effectiveServices = fileFilter ? scopedBackendServices : backendServices;
  const effectiveBackend = fileFilter ? scopedBackend : backend;
  const effectiveFrontend = fileFilter ? scopedFrontend : frontend;

  if (shouldRun('backend')) {
    if (splitBackend) {
      if (effectiveRoutes.length > 0) {
        const limits = computePassLimits(baseContextChars + measureContextChars(effectiveRoutes, 8000) + sharedContext.length, 'high');
        process.stderr.write(`  be-routes: ${effectiveRoutes.length} files → ${limits.maxTokens} tok / ${(limits.timeoutMs/1000).toFixed(0)}s\n`);
        backendPassNames.push('be-routes');
        wave2Promises.push(
          safeCallGPT(openai, {
            systemPrompt: PASS_BACKEND_SYSTEM,
            userPrompt: `## Project Context\n${beCtx}\n${historyBlock}\n## Plan\n${bePlan}\n\n## Backend ROUTES\n${readFilesAsContext(effectiveRoutes, { maxPerFile: 8000, maxTotal: 60000 })}\n\n## Shared Files\n${sharedContext}`,
            schema: PassFindingsSchema,
            schemaName: 'backend_routes_pass',
            reasoning: 'high',
            ...limits,
            passName: 'be-routes'
          }, EMPTY_FINDINGS)
        );
      }
      if (effectiveServices.length > 0) {
        const limits = computePassLimits(baseContextChars + measureContextChars(effectiveServices, 8000), 'high');
        process.stderr.write(`  be-services: ${effectiveServices.length} files → ${limits.maxTokens} tok / ${(limits.timeoutMs/1000).toFixed(0)}s\n`);
        backendPassNames.push('be-services');
        wave2Promises.push(
          safeCallGPT(openai, {
            systemPrompt: PASS_BACKEND_SYSTEM,
            userPrompt: `## Project Context\n${beCtx}\n${historyBlock}\n## Plan\n${bePlan}\n\n## Backend SERVICES\n${readFilesAsContext(effectiveServices, { maxPerFile: 8000, maxTotal: 80000 })}`,
            schema: PassFindingsSchema,
            schemaName: 'backend_services_pass',
            reasoning: 'high',
            ...limits,
            passName: 'be-services'
          }, EMPTY_FINDINGS)
        );
      }
    } else if (effectiveBackend.length > 0) {
      const limits = computePassLimits(baseContextChars + measureContextChars(effectiveBackend, 8000) + sharedContext.length, 'high');
      process.stderr.write(`  backend: ${effectiveBackend.length} files → ${limits.maxTokens} tok / ${(limits.timeoutMs/1000).toFixed(0)}s\n`);
      backendPassNames.push('backend');
      wave2Promises.push(
        safeCallGPT(openai, {
          systemPrompt: PASS_BACKEND_SYSTEM,
          userPrompt: `## Project Context\n${beCtx}\n${historyBlock}\n## Plan\n${bePlan}\n\n## Backend Implementation Files\n${readFilesAsContext(effectiveBackend, { maxPerFile: 8000, maxTotal: 80000 })}\n\n## Shared Files\n${sharedContext}`,
          schema: PassFindingsSchema,
          schemaName: 'backend_pass',
          reasoning: 'high',
          ...limits,
          passName: 'backend'
        }, EMPTY_FINDINGS)
      );
    }
  } else {
    process.stderr.write(`  backend SKIPPED (--passes)\n`);
  }

  if (shouldRun('frontend') && effectiveFrontend.length > 0) {
    const limits = computePassLimits(baseContextChars + measureContextChars(effectiveFrontend, 10000) + sharedContext.length, 'high');
    process.stderr.write(`  frontend: ${effectiveFrontend.length} files → ${limits.maxTokens} tok / ${(limits.timeoutMs/1000).toFixed(0)}s\n`);
    wave2Promises.push(
      safeCallGPT(openai, {
        systemPrompt: PASS_FRONTEND_SYSTEM,
        userPrompt: `## Project Context\n${readProjectContextForPass('frontend')}\n${historyBlock}\n## Plan\n${extractPlanForPass(planContent, 'frontend')}\n\n## Frontend Implementation Files\n${readFilesAsContext(effectiveFrontend, { maxPerFile: 10000, maxTotal: 80000 })}\n\n## Shared Files\n${sharedContext}`,
        schema: PassFindingsSchema,
        schemaName: 'frontend_pass',
        reasoning: 'high',
        ...limits,
        passName: 'frontend'
      }, EMPTY_FINDINGS)
    );
  } else if (!shouldRun('frontend')) {
    process.stderr.write(`  frontend SKIPPED (--passes)\n`);
  }

  if (wave2Promises.length === 0) {
    wave2Promises.push(Promise.resolve({ result: EMPTY_FINDINGS, usage: { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, latency_ms: 0 }, latencyMs: 0 }));
  }

  const wave2Results = await Promise.all(wave2Promises);
  const backendResults = wave2Results.slice(0, backendPassNames.length);
  const frontendResult = wave2Results[backendPassNames.length] ?? { result: EMPTY_FINDINGS, usage: { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, latency_ms: 0 }, latencyMs: 0 };

  // 4. Wave 3: Sustainability (reasoning: medium)
  let sustainResult;
  if (shouldRun('sustainability')) {
    const sustainFiles = fileFilter ? found.filter(f => fileFilter.some(ff => f.includes(ff) || ff.includes(f))) : found;
    const sustainContextChars = baseContextChars + measureContextChars(sustainFiles, 4000);
    const sustainLimits = computePassLimits(sustainContextChars, 'medium');

    process.stderr.write(`\n── Wave 3: Sustainability (reasoning: medium) ──\n`);
    process.stderr.write(`  ${sustainFiles.length} files → ${sustainLimits.maxTokens} tok / ${(sustainLimits.timeoutMs/1000).toFixed(0)}s\n`);

    sustainResult = await safeCallGPT(openai, {
      systemPrompt: PASS_SUSTAINABILITY_SYSTEM,
      userPrompt: `## Project Context\n${readProjectContextForPass('sustainability')}\n${historyBlock}\n## Plan\n${extractPlanForPass(planContent, 'sustainability')}\n\n## All Implementation Files\n${readFilesAsContext(sustainFiles, { maxPerFile: 4000, maxTotal: 60000 })}`,
      schema: SustainabilityPassSchema,
      schemaName: 'sustainability_pass',
      reasoning: 'medium',
      ...sustainLimits,
      passName: 'sustainability'
    }, EMPTY_SUSTAIN);
  } else {
    process.stderr.write(`\n── Sustainability SKIPPED (--passes) ──\n`);
    sustainResult = { result: EMPTY_SUSTAIN, usage: { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, latency_ms: 0 }, latencyMs: 0 };
  }

  // 5. Merge all pass results with semantic dedup
  const totalLatency = Date.now() - totalStart;
  const allResults = [structureResult, wiringResult, ...backendResults, frontendResult, sustainResult];
  const failedPasses = allResults.filter(r => r.failed).map(r => r.error);

  process.stderr.write(`\n── Merge (${allResults.length} passes, ${failedPasses.length} failed) ──\n`);
  if (failedPasses.length > 0) {
    process.stderr.write(`  Failed passes: ${failedPasses.join('; ')}\n`);
  }

  // Semantic finding ID: content-hash of category+section+detail (first 8 hex chars)
  // Same issue keeps the same ID across rounds, making history matching exact
  function semanticId(f) {
    const content = `${f.category}|${f.section}|${f.detail}`.toLowerCase().trim();
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 8);
  }

  // Cross-pass dedup: if two passes flag the same issue (>80% word overlap on
  // section+detail), keep the higher-severity one
  function tokenize(s) {
    return (s ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
  }
  function wordOverlap(a, b) {
    const ta = new Set(tokenize(a));
    const tb = new Set(tokenize(b));
    const intersection = [...ta].filter(t => tb.has(t)).length;
    const union = new Set([...ta, ...tb]).size;
    return union === 0 ? 0 : intersection / union;
  }

  const allFindings = [];
  const seenHashes = new Set();
  const findingCounter = { HIGH: 0, MEDIUM: 0, LOW: 0 };
  let dedupCount = 0;
  const sevOrder = { HIGH: 0, MEDIUM: 1, LOW: 2 };

  function addFindings(findings, prefix) {
    // Sort by severity (HIGH first) before adding
    const sorted = [...(findings ?? [])].sort((a, b) => (sevOrder[a.severity] ?? 2) - (sevOrder[b.severity] ?? 2));
    for (const f of sorted) {
      const hash = semanticId(f);

      // Exact dedup by content hash
      if (seenHashes.has(hash)) { dedupCount++; continue; }

      // Fuzzy dedup: check if a substantially similar finding already exists
      const sig = `${f.section} ${f.detail}`;
      const isDupe = allFindings.some(existing => {
        const existSig = `${existing.section} ${existing.detail}`;
        return wordOverlap(sig, existSig) > 0.8;
      });
      if (isDupe) { dedupCount++; continue; }

      seenHashes.add(hash);
      findingCounter[f.severity]++;
      const num = findingCounter[f.severity];
      const letter = f.severity === 'HIGH' ? 'H' : f.severity === 'MEDIUM' ? 'M' : 'L';
      allFindings.push({
        ...f,
        id: `${letter}${num}`,
        _hash: hash,
        _pass: prefix,
        category: `[${prefix}] ${f.category}`
      });
    }
  }

  addFindings(structureResult.result.findings, 'Structure');
  addFindings(wiringResult.result.findings, 'Wiring');
  for (let i = 0; i < backendResults.length; i++) {
    addFindings(backendResults[i].result.findings, backendPassNames[i] ?? 'Backend');
  }
  addFindings(frontendResult.result.findings, 'Frontend');
  addFindings(sustainResult.result.findings, 'Sustainability');

  if (dedupCount > 0) {
    process.stderr.write(`  Deduped ${dedupCount} cross-pass duplicate(s)\n`);
  }

  const high = allFindings.filter(f => f.severity === 'HIGH').length;
  const medium = allFindings.filter(f => f.severity === 'MEDIUM').length;
  const low = allFindings.filter(f => f.severity === 'LOW').length;

  let verdict = 'PASS';
  if (high > 0) verdict = 'SIGNIFICANT_ISSUES';
  else if (medium > 2) verdict = 'NEEDS_FIXES';

  const totalUsage = {
    input_tokens: allResults.reduce((s, r) => s + (r.usage?.input_tokens ?? 0), 0),
    output_tokens: allResults.reduce((s, r) => s + (r.usage?.output_tokens ?? 0), 0),
    reasoning_tokens: allResults.reduce((s, r) => s + (r.usage?.reasoning_tokens ?? 0), 0),
    latency_ms: totalLatency
  };

  // Build per-pass timing map
  const passTimings = {};
  passTimings.structure = `${(structureResult.latencyMs / 1000).toFixed(1)}s`;
  passTimings.wiring = `${(wiringResult.latencyMs / 1000).toFixed(1)}s`;
  for (let i = 0; i < backendResults.length; i++) {
    passTimings[backendPassNames[i] ?? `backend_${i}`] = `${(backendResults[i].latencyMs / 1000).toFixed(1)}s`;
  }
  passTimings.frontend = `${(frontendResult.latencyMs / 1000).toFixed(1)}s`;
  passTimings.sustainability = `${(sustainResult.latencyMs / 1000).toFixed(1)}s`;
  passTimings.total = `${(totalLatency / 1000).toFixed(1)}s`;

  // Build overall reasoning from pass summaries
  const summaryLines = [
    `**Structure**: ${structureResult.result.summary ?? 'N/A'}`,
    `**Wiring**: ${wiringResult.result.summary ?? 'N/A'}`
  ];
  for (let i = 0; i < backendResults.length; i++) {
    summaryLines.push(`**${backendPassNames[i] ?? 'Backend'}**: ${backendResults[i].result.summary ?? 'N/A'}`);
  }
  summaryLines.push(`**Frontend**: ${frontendResult.result.summary ?? 'N/A'}`);
  summaryLines.push(`**Sustainability**: ${sustainResult.result.summary ?? 'N/A'}`);
  if (failedPasses.length > 0) {
    summaryLines.push(`\n**WARNING**: ${failedPasses.length} pass(es) failed — findings may be incomplete.`);
  }

  const mergedResult = {
    verdict,
    files_planned: structureResult.result.files_planned ?? allPaths.size,
    files_found: structureResult.result.files_found ?? found.length,
    files_missing: structureResult.result.files_missing ?? missing.length,
    findings: allFindings,
    wiring_issues: wiringResult.result.wiring_issues ?? [],
    quick_fix_warnings: [
      ...backendResults.flatMap(r => r.result.quick_fix_warnings ?? []),
      ...(frontendResult.result.quick_fix_warnings ?? []),
      ...(sustainResult.result.quick_fix_warnings ?? [])
    ],
    dead_code: sustainResult.result.dead_code ?? [],
    overall_reasoning: summaryLines.join('\n'),
    _pass_timings: passTimings,
    _failed_passes: failedPasses.length > 0 ? failedPasses : undefined,
    _usage: totalUsage
  };

  // 6. Output
  if (outFile) {
    const summaryLine = `Verdict: ${verdict} | H:${high} M:${medium} L:${low} | ${(totalLatency / 1000).toFixed(0)}s`;
    writeOutput(mergedResult, outFile, summaryLine);
  } else if (jsonMode) {
    console.log(JSON.stringify(mergedResult, null, 2));
  } else {
    console.log('# GPT-5.4 Multi-Pass Code Audit Report');
    console.log(`- **Model**: ${MODEL}`);
    const timingStr = Object.entries(passTimings).map(([k, v]) => `${k}: ${v}`).join(', ');
    console.log(`- **Total time**: ${timingStr}`);
    console.log(`- **Tokens**: ${totalUsage.input_tokens} in / ${totalUsage.output_tokens} out (${totalUsage.reasoning_tokens} reasoning)`);
    console.log(`- **Files**: ${mergedResult.files_found} found, ${mergedResult.files_missing} missing`);
    if (failedPasses.length > 0) console.log(`- **WARNING**: ${failedPasses.length} pass(es) failed — findings may be incomplete`);
    console.log('');
    console.log(`## Verdict: **${verdict}**`);
    console.log(`- **HIGH**: ${high} | **MEDIUM**: ${medium} | **LOW**: ${low}`);
    const qf = mergedResult.quick_fix_warnings.length;
    if (qf > 0) console.log(`- **Quick Fix Warnings**: ${qf}`);
    console.log('');
    console.log('## Findings');
    console.log(formatFindings(allFindings));

    if (mergedResult.wiring_issues.length > 0) {
      console.log('\n## Wiring Issues\n');
      console.log('| Frontend Call | Backend Route | Status | Detail |');
      console.log('|-------------|--------------|--------|--------|');
      for (const w of mergedResult.wiring_issues) {
        console.log(`| ${w.frontend_call} | ${w.backend_route} | ${w.status} | ${w.detail} |`);
      }
    }

    if (mergedResult.dead_code.length > 0) {
      console.log('\n## Dead Code\n');
      for (const d of mergedResult.dead_code) console.log(`- ${d}`);
    }

    if (mergedResult.quick_fix_warnings.length > 0) {
      console.log('\n## Quick Fix Warnings\n');
      for (const w of mergedResult.quick_fix_warnings) console.log(`- ${w}`);
    }

    console.log('\n## Pass Summaries\n');
    console.log(mergedResult.overall_reasoning);
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0];
  const planFile = args[1];
  const rebuttalFile = mode === 'rebuttal' ? args[2] : null;
  const jsonMode = args.includes('--json');

  // --out <file>: write JSON results to file, keep terminal clean
  const outIdx = args.indexOf('--out');
  const outFile = outIdx !== -1 && args[outIdx + 1] ? args[outIdx + 1] : null;

  // --history <file>: inject prior round results to avoid re-raising resolved findings
  const histIdx = args.indexOf('--history');
  const historyFile = histIdx !== -1 && args[histIdx + 1] ? args[histIdx + 1] : null;

  // --passes <list>: comma-separated pass names to run (default: all)
  // e.g. --passes backend,frontend,sustainability (skip structure+wiring on R2+)
  const passIdx = args.indexOf('--passes');
  const passFilter = passIdx !== -1 && args[passIdx + 1] ? args[passIdx + 1].split(',').map(s => s.trim()) : null;

  // --files <list>: comma-separated file paths to scope quality passes to
  // e.g. --files src/routes/wines.js,src/services/wine/parser.js
  const filesIdx = args.indexOf('--files');
  const fileFilter = filesIdx !== -1 && args[filesIdx + 1] ? args[filesIdx + 1].split(',').map(s => s.trim()) : null;

  if (!mode || !planFile || !['plan', 'code', 'rebuttal'].includes(mode)) {
    console.error('Usage: node scripts/openai-audit.mjs <plan|code> <plan-file> [--json] [--out <file>] [--history <file>] [--passes <list>] [--files <list>]');
    console.error('       node scripts/openai-audit.mjs rebuttal <plan-file> <rebuttal-file> [--json] [--out <file>]');
    process.exit(1);
  }

  if (mode === 'rebuttal' && !rebuttalFile) {
    console.error('Error: rebuttal mode requires a rebuttal file path');
    process.exit(1);
  }

  if (!process.env.OPENAI_API_KEY) {
    console.error('Error: OPENAI_API_KEY environment variable required');
    console.error('Set it in .env or export OPENAI_API_KEY=sk-...');
    process.exit(1);
  }

  const planContent = readFileOrDie(planFile);
  const projectContext = readProjectContext();
  const historyContext = buildHistoryContext(historyFile);
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // Code mode → multi-pass parallel audit
  if (mode === 'code') {
    await runMultiPassCodeAudit(openai, planContent, projectContext, jsonMode, outFile, historyContext, { passFilter, fileFilter });
    return;
  }

  // Plan and rebuttal modes → single call
  let systemPrompt, schema, schemaName, userPrompt;

  if (mode === 'rebuttal') {
    const rebuttalContent = readFileOrDie(rebuttalFile);
    systemPrompt = REBUTTAL_SYSTEM;
    schema = RebuttalResolutionSchema;
    schemaName = 'rebuttal_resolution';
    userPrompt = `## Project Context\n${projectContext}\n\n---\n\n## Original Plan/Code\n${planContent}\n\n---\n\n## Claude's Deliberation\n${rebuttalContent}`;
  } else {
    systemPrompt = PLAN_AUDIT_SYSTEM;
    schema = PlanAuditResultSchema;
    schemaName = 'plan_audit_result';
    userPrompt = `## Project Context\n${projectContext}\n\n${historyContext ? `---\n\n${historyContext}\n` : ''}---\n\n## Plan to Audit\n${planContent}`;
  }

  try {
    const { result, usage, latencyMs } = await callGPT(openai, {
      systemPrompt, userPrompt, schema, schemaName,
      passName: mode
    });

    if (jsonMode || outFile) {
      const data = { ...result, _usage: usage };
      if (outFile) {
        const summaryLine = mode === 'rebuttal'
          ? `Deliberation complete: ${result.resolutions?.length ?? 0} resolutions`
          : `Verdict: ${result.verdict} | H:${result.findings?.filter(f => f.severity === 'HIGH').length ?? 0} M:${result.findings?.filter(f => f.severity === 'MEDIUM').length ?? 0} L:${result.findings?.filter(f => f.severity === 'LOW').length ?? 0}`;
        writeOutput(data, outFile, summaryLine);
      } else {
        console.log(JSON.stringify(data, null, 2));
      }
    } else if (mode === 'rebuttal') {
      const sustained = result.resolutions.filter(r => r.gpt_ruling === 'sustain').length;
      const overruled = result.resolutions.filter(r => r.gpt_ruling === 'overrule').length;
      const compromised = result.resolutions.filter(r => r.gpt_ruling === 'compromise').length;

      console.log('# GPT-5.4 Deliberation Resolution Report');
      console.log(`- **Model**: ${MODEL} | **Latency**: ${(latencyMs / 1000).toFixed(1)}s`);
      console.log(`- **Tokens**: ${usage.input_tokens} in / ${usage.output_tokens} out (${usage.reasoning_tokens} reasoning)`);
      console.log('');
      console.log(`| Outcome | Count |\n|---------|-------|\n| Sustained | ${sustained} |\n| Overruled | ${overruled} |\n| Compromise | ${compromised} |\n| Uncontested | ${result.uncontested_findings?.length ?? 0} |`);
      console.log('\n## Resolutions\n');
      for (const r of result.resolutions) {
        const icon = r.gpt_ruling === 'sustain' ? '🔴' : r.gpt_ruling === 'overrule' ? '🟢' : '🟡';
        console.log(`### ${icon} [${r.finding_id}] ${r.gpt_ruling.toUpperCase()} → ${r.final_severity}`);
        console.log(`- **Claude**: ${r.claude_position} | **GPT**: ${r.gpt_ruling}`);
        console.log(`- **Final**: ${r.final_recommendation}`);
        console.log(`- **Why**: ${r.reasoning}\n`);
      }
      if (result.uncontested_findings?.length) console.log(`\n**Uncontested**: ${result.uncontested_findings.join(', ')}`);
      console.log(`\n## Overall\n${result.deliberation_summary}`);
    } else {
      // Plan audit
      const high = result.findings.filter(f => f.severity === 'HIGH').length;
      const medium = result.findings.filter(f => f.severity === 'MEDIUM').length;
      const low = result.findings.filter(f => f.severity === 'LOW').length;

      console.log('# GPT-5.4 Plan Audit Report');
      console.log(`- **Model**: ${MODEL} | **Latency**: ${(latencyMs / 1000).toFixed(1)}s`);
      console.log(`- **Tokens**: ${usage.input_tokens} in / ${usage.output_tokens} out (${usage.reasoning_tokens} reasoning)`);
      console.log('');
      console.log(`## Verdict: **${result.verdict}**`);
      console.log(`- **Completeness**: ${result.structural_completeness} | **Principles**: ${result.principle_coverage_pct}%`);
      console.log(`- **Specificity**: ${result.specificity} | **Sustainability**: ${result.sustainability}`);
      console.log(`- **HIGH**: ${high} | **MEDIUM**: ${medium} | **LOW**: ${low}`);
      console.log('');
      console.log('## Findings');
      console.log(formatFindings(result.findings));

      if (result.ambiguities?.length > 0) {
        console.log('\n## Ambiguities\n');
        console.log('| Location | Vague Language | Clarification |\n|----------|---------------|---------------|');
        for (const a of result.ambiguities) console.log(`| ${a.location} | ${a.vague_language} | ${a.clarification_needed} |`);
      }

      if (result.quick_fix_warnings?.length > 0) {
        console.log('\n## Quick Fix Warnings\n');
        for (const w of result.quick_fix_warnings) console.log(`- ${w}`);
      }

      console.log(`\n## Overall\n${result.overall_reasoning}`);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
