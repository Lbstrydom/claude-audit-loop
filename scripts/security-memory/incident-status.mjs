/**
 * @fileoverview Status resolution for security incidents.
 * Plan: docs/plans/security-memory-v1.md §4.B (incident-status.mjs).
 *
 * Two functions:
 *   - classifyMitigation(): pure, given evidence picks the enum value.
 *   - runSemgrepIfNeeded(): impure, shells out to semgrep with caching.
 *
 * Semgrep ref formats supported:
 *   - "semgrep:my-rule-id"        → local rule at semgrep/my-rule-id.yml
 *   - "semgrep:p/owasp-top-ten"   → registry ruleset (no local file)
 *   - "semgrep:r/python.lang..."  → registry rule
 *
 * False-comfort guard (Gemini-r2-G2): file-ref mitigations NEVER auto-claim
 * mitigation-passing — only semgrep rules that exist AND last-passed do.
 *
 * @module scripts/security-memory/incident-status
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Pure function — given mitigation kind + evidence, pick status enum.
 * Testable without I/O.
 *
 * @param {object} args
 * @param {'semgrep'|'manual'|'file-ref'} args.mitigation_kind
 * @param {{passed: boolean, ranSemgrep: boolean, ruleFileFound: boolean}|null} args.semgrepRunResult
 * @returns {{status: string, status_evidence: string}}
 */
export function classifyMitigation({ mitigation_kind, semgrepRunResult }) {
  if (mitigation_kind === 'semgrep') {
    if (!semgrepRunResult) {
      return { status: 'manual-verification-required', status_evidence: 'semgrep-not-run' };
    }
    // R2-H8: rule-file check comes BEFORE binary-presence check.
    // Runner short-circuits to {ranSemgrep:false, ruleFileFound:false} when
    // the local rule is missing — without this ordering, the missing-rule
    // case (a real failing mitigation) gets misreported as "binary-not-found".
    if (!semgrepRunResult.ruleFileFound) {
      return { status: 'mitigation-failing', status_evidence: 'rule-not-found' };
    }
    if (!semgrepRunResult.ranSemgrep) {
      // R-Gemini-G8: distinguish tool-error (broken YAML, timeout) from
      // binary-not-found so operators triage env vs rule problems correctly.
      const evidence = semgrepRunResult.toolError ? 'semgrep-tool-error' : 'semgrep-binary-not-found';
      return { status: 'manual-verification-required', status_evidence: evidence };
    }
    return semgrepRunResult.passed
      ? { status: 'mitigation-passing', status_evidence: 'semgrep-passed' }
      : { status: 'mitigation-failing', status_evidence: 'semgrep-failed' };
  }
  // file-ref + manual: NEVER auto-claim mitigation-passing (false-comfort guard)
  return { status: 'manual-verification-required', status_evidence: `kind-${mitigation_kind}` };
}

/**
 * Impure: shells out to semgrep when needed, caches result by
 * sha256(rule + repo_HEAD).
 *
 * @param {object} args
 * @param {string} args.repoRoot
 * @param {string|null} args.mitigationRef
 * @param {string} args.mitigationKind
 * @param {Map<string, object>} args.fingerprintCache  in-memory cache, persistent across incidents in one refresh
 * @param {string} args.repoHeadSha                     git rev-parse HEAD output
 * @returns {{passed: boolean, ranSemgrep: boolean, ruleFileFound: boolean}|null}
 */
export function runSemgrepIfNeeded({ repoRoot, mitigationRef, mitigationKind, fingerprintCache, repoHeadSha }) {
  if (mitigationKind !== 'semgrep' || !mitigationRef) return null;

  const ref = mitigationRef.replace(/^semgrep:/, '');
  const isRegistry = ref.startsWith('p/') || ref.startsWith('r/');

  // R-Gemini-r2-G3: fs.existsSync BEFORE readFileSync
  let cacheKey;
  let ruleFileFound = false;
  if (isRegistry) {
    // Registry rule: no local file to hash; use the ref + repo HEAD
    cacheKey = sha256(ref + '\n' + repoHeadSha);
    ruleFileFound = true; // we trust semgrep to fetch; "not found" means semgrep tool error
  } else {
    // R-Gemini-G2: path-traversal guard. The parser's mitigation_ref regex
    // accepts dots and slashes (needed for namespaced rule IDs), so ref can
    // contain `..` segments. Resolve and verify the path stays inside the
    // intended `<repoRoot>/semgrep/` directory before any I/O.
    const semgrepDir = path.resolve(repoRoot, 'semgrep');
    const rulePath = path.resolve(semgrepDir, `${ref}.yml`);
    if (rulePath !== semgrepDir && !rulePath.startsWith(semgrepDir + path.sep)) {
      // ref escapes the semgrep/ boundary — refuse to read or run
      return { passed: false, ranSemgrep: false, ruleFileFound: false };
    }
    if (!existsSync(rulePath)) {
      // R-Gemini-r2-G3 + R-Gemini-G3: short-circuit, no readFileSync attempt
      return { passed: false, ranSemgrep: false, ruleFileFound: false };
    }
    ruleFileFound = true;
    const ruleContent = readFileSync(rulePath, 'utf-8');
    cacheKey = sha256(ruleContent + '\n' + repoHeadSha);
  }

  if (fingerprintCache.has(cacheKey)) {
    return fingerprintCache.get(cacheKey);
  }

  // Detect semgrep binary presence first (R1-H2 graceful degradation).
  // R-Gemini-G8: differentiate "binary missing" (probe.error or non-zero
  // status from --version) from "tool error during scan" (handled below)
  // so operators can distinguish env-misconfig from a broken rule file.
  const probe = spawnSync('semgrep', ['--version'], { stdio: 'ignore' });
  if (probe.error || probe.status !== 0) {
    const result = { passed: false, ranSemgrep: false, ruleFileFound, toolError: false };
    fingerprintCache.set(cacheKey, result);
    return result;
  }

  // Run semgrep on the repo. For local rules, reuse the validated rulePath
  // resolved above (cannot be reconstructed here without re-running the
  // traversal guard). For registry rules, pass ref as-is — semgrep will
  // 404 against the registry rather than touch the local FS.
  // R-Gemini-G6: stdio:'ignore' (not 'pipe') — we only care about exit
  // code. Piping forces Node to buffer stdout/stderr up to maxBuffer
  // (1MB default), which a broadly-matching rule against a large repo
  // will blow past, throwing ENOBUFS.
  const configArg = isRegistry ? ref : path.resolve(repoRoot, 'semgrep', `${ref}.yml`);
  let result;
  try {
    execFileSync('semgrep', ['--config', configArg, '--json', '--quiet', repoRoot], {
      stdio: 'ignore',
      timeout: 60000,
    });
    // Exit 0: no findings = passing
    result = { passed: true, ranSemgrep: true, ruleFileFound, toolError: false };
  } catch (err) {
    if (err.status === 1) {
      // Exit 1: findings = failing
      result = { passed: false, ranSemgrep: true, ruleFileFound, toolError: false };
    } else {
      // Exit 2+ or signal: tool error (broken YAML, timeout, perms) →
      // degrade to manual but PRESERVE toolError so the classifier can
      // emit a distinct evidence string vs binary-not-found (R-Gemini-G8).
      result = { passed: false, ranSemgrep: false, ruleFileFound, toolError: true };
    }
  }

  fingerprintCache.set(cacheKey, result);
  return result;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}
