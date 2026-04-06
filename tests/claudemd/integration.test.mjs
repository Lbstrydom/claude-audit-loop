import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const CLI = path.resolve('scripts/claudemd-lint.mjs');
const FIXTURES = path.resolve('tests/claudemd/fixtures');

function runLint(fixtureDir, args = '') {
  try {
    const result = execSync(`node "${CLI}" ${args}`, {
      cwd: fixtureDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout: result, exitCode: 0 };
  } catch (err) {
    return { stdout: err.stdout || '', stderr: err.stderr || '', exitCode: err.status };
  }
}

describe('CLI integration', () => {
  it('exits 0 for clean fixture', () => {
    const r = runLint(path.join(FIXTURES, 'clean'));
    assert.equal(r.exitCode, 0, `expected exit 0, got ${r.exitCode}: ${r.stderr || ''}`);
  });

  it('exits non-zero for sprawl fixture (size violation)', () => {
    const r = runLint(path.join(FIXTURES, 'sprawl'));
    assert.ok(r.exitCode > 0, 'sprawl should produce non-zero exit');
  });

  it('exits 1 for stale fixture (error findings)', () => {
    const r = runLint(path.join(FIXTURES, 'stale'));
    assert.equal(r.exitCode, 1, 'stale refs should produce exit 1 (error)');
  });

  it('produces JSON output with --format json --out', () => {
    const outFile = path.join(FIXTURES, 'sprawl', '_test-output.json');
    runLint(path.join(FIXTURES, 'sprawl'), `--format json --out "${outFile}"`);
    try {
      const report = JSON.parse(fs.readFileSync(outFile, 'utf-8'));
      assert.ok(report.version, 'report must have version');
      assert.ok(Array.isArray(report.findings), 'report must have findings array');
      assert.ok(report.summary, 'report must have summary');
    } finally {
      try { fs.unlinkSync(outFile); } catch {}
    }
  });

  it('produces SARIF output with --format sarif --out', () => {
    const outFile = path.join(FIXTURES, 'sprawl', '_test-output.sarif');
    runLint(path.join(FIXTURES, 'sprawl'), `--format sarif --out "${outFile}"`);
    try {
      const sarif = JSON.parse(fs.readFileSync(outFile, 'utf-8'));
      assert.equal(sarif.version, '2.1.0');
      assert.ok(Array.isArray(sarif.runs), 'SARIF must have runs');
    } finally {
      try { fs.unlinkSync(outFile); } catch {}
    }
  });

  it('fails with exit 3 when --format json without --out', () => {
    const r = runLint(path.join(FIXTURES, 'clean'), '--format json');
    assert.equal(r.exitCode, 3, 'missing --out should exit 3');
  });
});
