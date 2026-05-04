import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { classifyMitigation, runSemgrepIfNeeded } from '../scripts/security-memory/incident-status.mjs';

describe('classifyMitigation — pure status enum picker', () => {
  it('semgrep + passed → mitigation-passing', () => {
    const r = classifyMitigation({
      mitigation_kind: 'semgrep',
      semgrepRunResult: { passed: true, ranSemgrep: true, ruleFileFound: true },
    });
    assert.equal(r.status, 'mitigation-passing');
    assert.equal(r.status_evidence, 'semgrep-passed');
  });

  it('semgrep + failed → mitigation-failing', () => {
    const r = classifyMitigation({
      mitigation_kind: 'semgrep',
      semgrepRunResult: { passed: false, ranSemgrep: true, ruleFileFound: true },
    });
    assert.equal(r.status, 'mitigation-failing');
    assert.equal(r.status_evidence, 'semgrep-failed');
  });

  it('semgrep + rule missing → mitigation-failing', () => {
    const r = classifyMitigation({
      mitigation_kind: 'semgrep',
      semgrepRunResult: { passed: false, ranSemgrep: true, ruleFileFound: false },
    });
    assert.equal(r.status, 'mitigation-failing');
    assert.equal(r.status_evidence, 'rule-not-found');
  });

  it('semgrep + rule missing (runner short-circuit shape: ranSemgrep=false too) → mitigation-failing (R2-H8)', () => {
    // This is the actual shape runSemgrepIfNeeded returns when the local
    // rule file is absent — we never spawn semgrep, so ranSemgrep=false.
    // Without R2-H8 fix, classifier saw !ranSemgrep first and reported
    // 'semgrep-binary-not-found' — masking a genuinely failing mitigation.
    const r = classifyMitigation({
      mitigation_kind: 'semgrep',
      semgrepRunResult: { passed: false, ranSemgrep: false, ruleFileFound: false },
    });
    assert.equal(r.status, 'mitigation-failing');
    assert.equal(r.status_evidence, 'rule-not-found');
  });

  it('semgrep + binary not on PATH → manual-verification-required (R1-H2)', () => {
    const r = classifyMitigation({
      mitigation_kind: 'semgrep',
      semgrepRunResult: { passed: false, ranSemgrep: false, ruleFileFound: true, toolError: false },
    });
    assert.equal(r.status, 'manual-verification-required');
    assert.equal(r.status_evidence, 'semgrep-binary-not-found');
  });

  it('R-Gemini-G8 — semgrep tool error (broken YAML/timeout) → distinct evidence', () => {
    const r = classifyMitigation({
      mitigation_kind: 'semgrep',
      semgrepRunResult: { passed: false, ranSemgrep: false, ruleFileFound: true, toolError: true },
    });
    assert.equal(r.status, 'manual-verification-required');
    assert.equal(r.status_evidence, 'semgrep-tool-error');
  });

  it('semgrep + null result → manual-verification-required (cache miss / not run)', () => {
    const r = classifyMitigation({
      mitigation_kind: 'semgrep',
      semgrepRunResult: null,
    });
    assert.equal(r.status, 'manual-verification-required');
  });

  it('FILE-REF — false-comfort guard: file-existence is NOT mitigation-passing', () => {
    // R-Gemini-G2 + brainstorm-r2 false-comfort trap
    const r = classifyMitigation({
      mitigation_kind: 'file-ref',
      semgrepRunResult: null,  // never runs semgrep for file-ref
    });
    assert.equal(r.status, 'manual-verification-required');
    assert.equal(r.status_evidence, 'kind-file-ref');
  });

  it('manual mitigation → manual-verification-required', () => {
    const r = classifyMitigation({
      mitigation_kind: 'manual',
      semgrepRunResult: null,
    });
    assert.equal(r.status, 'manual-verification-required');
  });

  it('classifyMitigation NEVER returns "active" (false-comfort trap)', () => {
    // Exhaustive: any non-semgrep input should never produce a "passing"-flavoured status
    for (const kind of ['file-ref', 'manual']) {
      const r = classifyMitigation({ mitigation_kind: kind, semgrepRunResult: null });
      assert.notEqual(r.status, 'mitigation-passing');
      assert.notEqual(r.status, 'active');
    }
  });
});

describe('runSemgrepIfNeeded — path-traversal guard (R-Gemini-G2)', () => {
  it('semgrep:../../../etc/passwd → refuses (returns failing without I/O)', () => {
    const repoRoot = path.join(os.tmpdir(), 'guard-test');
    const r = runSemgrepIfNeeded({
      repoRoot,
      mitigationRef: 'semgrep:../../../etc/passwd',
      mitigationKind: 'semgrep',
      fingerprintCache: new Map(),
      repoHeadSha: 'deadbeef',
    });
    // Must short-circuit to mitigation-failing semantics (passed:false,
    // ranSemgrep:false) without touching the filesystem outside semgrep/.
    assert.equal(r.passed, false);
    assert.equal(r.ranSemgrep, false);
    assert.equal(r.ruleFileFound, false);
  });

  it('semgrep:..\\..\\windows\\system32 → refuses on win-style separators too', () => {
    const repoRoot = path.join(os.tmpdir(), 'guard-test');
    const r = runSemgrepIfNeeded({
      repoRoot,
      mitigationRef: 'semgrep:..\\..\\windows\\system32',
      mitigationKind: 'semgrep',
      fingerprintCache: new Map(),
      repoHeadSha: 'deadbeef',
    });
    // path.resolve normalises backslashes on win32; on posix the segment
    // stays literal but still doesn't exist under semgrep/. Either way:
    // refuse without spawning.
    assert.equal(r.passed, false);
    assert.equal(r.ranSemgrep, false);
  });

  it('semgrep:p/owasp-top-ten → registry refs bypass the guard (no FS lookup)', () => {
    const repoRoot = path.join(os.tmpdir(), 'guard-test');
    const r = runSemgrepIfNeeded({
      repoRoot,
      mitigationRef: 'semgrep:p/owasp-top-ten',
      mitigationKind: 'semgrep',
      fingerprintCache: new Map(),
      repoHeadSha: 'deadbeef',
    });
    // Registry refs go through to spawn semgrep. If semgrep binary is
    // absent in this env, ranSemgrep=false. ruleFileFound=true because
    // we trust the registry.
    assert.equal(r.ruleFileFound, true);
  });
});
