/**
 * @fileoverview Pattern matrix + matcher for the prospective quickfix hook.
 * Plan: docs/plans/brainstorm-quickfix-v1.md §B1, §11.D, §12.D, §12.F, §13.A, §15.A.
 *
 * Pure module — no I/O. The hook runner (.claude/hooks/quickfix-scan.mjs)
 * reads stdin, extracts diff text, calls matchPatterns(), composes the
 * system message, and writes telemetry. All redaction happens BEFORE
 * truncation (§15.A) so partial-secret characters cannot leak.
 *
 * @module scripts/lib/quickfix-patterns
 */
import path from 'node:path';
import { redactSecrets } from './secret-patterns.mjs';

const MAX_INPUT_CHARS = 80_000;            // §B1 — bail at >2000 lines
const SNIPPET_MAX_CHARS = 80;              // §10.G — display cap

/**
 * Pattern matrix. Each entry has:
 *   - name: stable id used in telemetry + system message
 *   - severity: 'low' | 'medium' | 'high'
 *   - regex: matcher applied per line by default
 *   - multiline: if true, regex is evaluated against the WHOLE diff text
 *     instead of line-by-line — used for patterns that span newlines
 *     like `catch (e) {\n  return null;\n}` (Audit Gemini-G3-M1)
 *   - suggestion: shown to the user
 *   - langGuard: optional regex on the file extension; if set, pattern
 *                only fires for matching extensions
 */
export const PATTERNS = Object.freeze([
  {
    name: 'empty-catch',
    severity: 'medium',
    // Multiline-aware: matches `catch (e) {}` AND `catch (e) {\n}` AND `catch (e) {\n  \n}`.
    regex: /catch\s*(?:\([^)]*\))?\s*\{\s*\}/m,
    multiline: true,
    suggestion: 'Empty catch swallows errors silently. Either log + rethrow, fix the underlying cause, or annotate why ignoring is safe.',
  },
  {
    name: 'todo-fixme-hack',
    severity: 'low',
    regex: /(?:^|[^a-zA-Z0-9_])(TODO|FIXME|HACK|XXX)(?:\b|:)/,
    suggestion: 'Marker comment indicates incomplete work. Track in an issue or remove before merge.',
  },
  {
    name: 'ts-ignore-no-justification',
    severity: 'medium',
    regex: /@ts-ignore\s*$|@ts-ignore[^\S\n]*$/m,
    suggestion: '@ts-ignore without a trailing explanation hides type errors. Add a comment explaining why, or fix the underlying type.',
    langGuard: /\.(ts|tsx|mts|cts)$/,
  },
  {
    name: 'ts-expect-error-no-justification',
    severity: 'medium',
    regex: /@ts-expect-error\s*$|@ts-expect-error[^\S\n]*$/m,
    suggestion: '@ts-expect-error without a trailing explanation. Add a comment explaining the expected error.',
    langGuard: /\.(ts|tsx|mts|cts)$/,
  },
  {
    name: 'eslint-disable-no-rule',
    severity: 'medium',
    regex: /eslint-disable-next-line\s*$|eslint-disable-line\s*$/m,
    suggestion: 'eslint-disable without a rule name disables ALL rules. Specify the rule(s) being disabled and why.',
  },
  {
    name: 'py-noqa-no-code',
    severity: 'low',
    regex: /#\s*noqa\s*$/m,
    suggestion: '`# noqa` without an error code suppresses everything. Specify codes (e.g. `# noqa: E501`).',
    langGuard: /\.py$/,
  },
  {
    name: 'py-pylint-disable-no-reason',
    severity: 'low',
    regex: /#\s*pylint:\s*disable=[\w,-]+\s*$/m,
    suggestion: 'pylint disable without a trailing reason comment. Add `  # reason: ...` so reviewers know why.',
    langGuard: /\.py$/,
  },
  {
    name: 'magic-number-conditional',
    severity: 'low',
    // Captures `if/while/for (...) X` where X is a digit literal NOT 0/1/-1
    regex: /\b(if|while|for)\s*\([^)]*?\b(?!(?:0|1|-1)\b)\d{2,}\b/,
    suggestion: 'Magic number in a condition. Extract to a named constant so the threshold is documented.',
  },
  {
    name: 'masked-error',
    severity: 'high',
    // Multiline-aware: `catch (e) {\n  return null;\n}` should match.
    regex: /catch\s*\(\s*\w+\s*\)\s*\{\s*return\s*(?:null|undefined|\[\]|\{\})\s*;?\s*\}/m,
    multiline: true,
    suggestion: 'Catch-and-return-empty masks the real failure. Surface the error or fix root cause.',
  },
  {
    name: 'disabled-assertion',
    severity: 'medium',
    regex: /(?:\/\/\s*expect\s*\(|\/\/\s*assert\s*\(|\bxit\s*\(|\bxdescribe\s*\(|\.skip\s*\()/,
    suggestion: 'Disabled or skipped test assertion. If intentional, document why. If temporary, track in an issue.',
  },
  {
    name: 'hardcoded-localhost',
    severity: 'medium',
    regex: /\|\|\s*['"]localhost(?::\d+)?['"]/,
    suggestion: 'Hardcoded localhost fallback. Move to config (env var) so non-local environments work.',
  },
  {
    name: 'hardcoded-http-url',
    severity: 'medium',
    regex: /\|\|\s*['"]http:\/\/[^'"]+['"]/,
    suggestion: 'Hardcoded HTTP URL fallback. Move to config; prefer HTTPS.',
  },
]);

/**
 * Sensitive-path patterns — files matching these are NEVER scanned.
 * Plan §11.D + §13.A — patterns use `(^|/)` so absolute paths match too.
 */
export const SENSITIVE_PATH_PATTERNS = Object.freeze([
  /(^|\/)\.env(\..+)?$/,
  /(^|\/)\.env\.local$/,
  /(^|\/)secrets?\.(json|yaml|yml|txt|env)$/,
  /(^|\/)credentials?\..+$/,
  /\.(pem|key|crt|p12|pfx)$/,
  /(^|\/)(secrets|credentials|\.aws|\.ssh)\//,
]);

/**
 * Per-file-ext suppression syntax. Default fallback accepts either
 * `// quickfix-hook:ignore` or `# quickfix-hook:ignore`.
 */
export const SUPPRESS_BY_EXT = Object.freeze({
  '.js': /\/\/\s*quickfix-hook:ignore/,
  '.mjs': /\/\/\s*quickfix-hook:ignore/,
  '.cjs': /\/\/\s*quickfix-hook:ignore/,
  '.ts': /\/\/\s*quickfix-hook:ignore/,
  '.tsx': /\/\/\s*quickfix-hook:ignore/,
  '.jsx': /\/\/\s*quickfix-hook:ignore/,
  '.py': /#\s*quickfix-hook:ignore/,
  '.sh': /#\s*quickfix-hook:ignore/,
  '.rb': /#\s*quickfix-hook:ignore/,
  '.html': /<!--\s*quickfix-hook:ignore\s*-->/,
  '.css': /\/\*\s*quickfix-hook:ignore\s*\*\//,
  '.scss': /\/\/\s*quickfix-hook:ignore/,
  __default__: /(?:\/\/|#)\s*quickfix-hook:ignore/,
});

/**
 * Normalise a path to a canonical comparable form: forward slashes,
 * drive letter stripped, lower-cased, leading `./` removed.
 *
 * @param {string} pathInput
 * @returns {string}
 */
export function normalisePath(pathInput) {
  return String(pathInput || '')
    .replace(/\\/g, '/')
    .replace(/^[a-zA-Z]:\//, '')
    .toLowerCase()
    .replace(/^\.\//, '');
}

/**
 * True iff the path matches a sensitive-path pattern (env files, keys,
 * credential dirs, etc.). Path is normalised before matching.
 *
 * @param {string} pathInput
 * @returns {boolean}
 */
export function isSensitivePath(pathInput) {
  const p = normalisePath(pathInput);
  return SENSITIVE_PATH_PATTERNS.some(re => re.test(p));
}

/**
 * True iff the line contains a per-line suppression marker for the
 * file's language.
 *
 * @param {string} line
 * @param {string} filePath
 * @returns {boolean}
 */
export function hasSuppression(line, filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  const re = SUPPRESS_BY_EXT[ext] || SUPPRESS_BY_EXT.__default__;
  return re.test(line);
}

/**
 * Run pattern matcher on diff text. Returns array of matches (possibly
 * empty). REDACTS each matched line BEFORE truncation (§15.A) so partial
 * secrets cannot leak into the output.
 *
 * @param {string} diffText - new lines from the edit (Edit.new_string or Write.content)
 * @param {{filePath?: string}} [opts]
 * @returns {Array<{name: string, severity: string, snippet: string, suggestion: string}>}
 */
export function matchPatterns(diffText, opts = {}) {
  if (typeof diffText !== 'string' || diffText.length === 0) return [];
  // Audit R1-M8: surface bypass on huge inputs (was silent before)
  if (diffText.length > MAX_INPUT_CHARS) {
    process.stderr.write(`  [quickfix-patterns] WARN: input ${diffText.length} chars > ${MAX_INPUT_CHARS} cap — coverage skipped for this edit\n`);
    return [];
  }
  const filePath = opts.filePath || '';
  // Audit R1-M12 + R4-M6: enforce sensitive-path exclusion inside the
  // public API. NO escape hatch — sensitive-file scanning is a project
  // policy, not a per-call option. Callers that genuinely need to test
  // pattern matching against synthetic content can pass an empty
  // filePath (which falls through this guard).
  if (filePath && isSensitivePath(filePath)) {
    return [];
  }
  const lines = diffText.split('\n');
  const matches = [];

  // Audit Gemini-G3-M1: multiline patterns evaluate against the WHOLE
  // diff so `catch (e) {\n  return null;\n}` style code (which spans
  // newlines after formatting) is detected. We still scan line-by-line
  // for non-multiline patterns to keep snippets focused.
  for (const pattern of PATTERNS) {
    if (!pattern.multiline) continue;
    if (pattern.langGuard && !pattern.langGuard.test(filePath)) continue;
    const m = pattern.regex.exec(diffText);
    if (!m) continue;
    // Find the line containing the match (for snippet + suppression check)
    const matchStart = m.index;
    const lineStart = diffText.lastIndexOf('\n', matchStart - 1) + 1;
    const lineEnd = diffText.indexOf('\n', matchStart);
    const matchLine = diffText.slice(lineStart, lineEnd === -1 ? diffText.length : lineEnd);
    // Audit Gemini-G4-L1: also check the preceding line for the
    // suppression marker — a multi-line `catch (e) {…}` block can't have
    // the marker on the brace line, so users naturally place it on the
    // line above.
    const prevLineEnd = lineStart > 0 ? lineStart - 1 : 0;
    const prevLineStart = diffText.lastIndexOf('\n', prevLineEnd - 1) + 1;
    const prevLine = prevLineEnd > 0 ? diffText.slice(prevLineStart, prevLineEnd) : '';
    if (hasSuppression(matchLine, filePath) || (prevLine && hasSuppression(prevLine, filePath))) continue;
    // For multiline matches, snippet shows the matched range itself
    // (truncated) rather than the single line — gives the reviewer the full
    // pattern that fired.
    const matched = m[0];
    const redacted = redactSecrets(matched).text;
    const snippet = redacted.length > SNIPPET_MAX_CHARS
      ? redacted.slice(0, SNIPPET_MAX_CHARS - 3) + '...'
      : redacted;
    matches.push({
      name: pattern.name,
      severity: pattern.severity,
      snippet,
      suggestion: pattern.suggestion,
    });
  }

  // Per-line patterns (the default)
  for (const line of lines) {
    if (hasSuppression(line, filePath)) continue;
    for (const pattern of PATTERNS) {
      if (pattern.multiline) continue;  // already handled above
      if (pattern.langGuard && !pattern.langGuard.test(filePath)) continue;
      if (!pattern.regex.test(line)) continue;
      // §15.A — redact full line FIRST, then truncate
      const redacted = redactSecrets(line).text;
      const snippet = redacted.length > SNIPPET_MAX_CHARS
        ? redacted.slice(0, SNIPPET_MAX_CHARS - 3) + '...'
        : redacted;
      matches.push({
        name: pattern.name,
        severity: pattern.severity,
        snippet,
        suggestion: pattern.suggestion,
      });
    }
  }
  return matches;
}
