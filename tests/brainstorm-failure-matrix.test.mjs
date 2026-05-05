/**
 * Failure-mode tests for brainstorm-round.mjs (helper boundary).
 * Plan §10.F failure matrix.
 *
 * The helper itself is a CLI; these tests spawn it as a subprocess and
 * feed targeted bad inputs to verify the documented exit code, stdout
 * contract, and stderr behaviour for each failure mode.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.resolve(TEST_DIR, '..', 'scripts', 'brainstorm-round.mjs');

function runHelper(argv, opts = {}) {
  return spawnSync('node', [HELPER, ...argv], {
    encoding: 'utf-8',
    timeout: 10_000,
    cwd: opts.cwd || process.cwd(),
    env: { ...process.env, ...(opts.env || {}) },
    input: opts.input,
  });
}

describe('helper boundary — argv errors (exit 1)', () => {
  it('missing both --topic and --topic-stdin → exit 1', () => {
    const r = runHelper(['--models', 'openai']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Missing --topic/);
  });

  it('--topic AND --topic-stdin → exit 1', () => {
    const r = runHelper(['--topic', 'x', '--topic-stdin']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /either --topic OR --topic-stdin/);
  });

  it('unknown --models value → exit 1', () => {
    const r = runHelper(['--topic', 'x', '--models', 'claude']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Unknown model provider/);
  });

  it('unknown flag → exit 1', () => {
    const r = runHelper(['--topic', 'x', '--no-such-flag']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Unknown flag/);
  });

  it('--max-tokens non-integer → exit 1', () => {
    const r = runHelper(['--topic', 'x', '--max-tokens', 'foo']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /must be a positive integer/);
  });

  it('--depth invalid → exit 1', () => {
    const r = runHelper(['--topic', 'x', '--depth', 'huge']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--depth must be one of/);
  });

  it('--with-context > 8000 chars per flag → exit 1', () => {
    const r = runHelper(['--topic', 'x', '--with-context', 'y'.repeat(9000)]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /per-flag max/);
  });
});

describe('helper boundary — save mode argv errors', () => {
  it('save without --sid → exit 1', () => {
    const r = runHelper(['save', '--round', '0', '--topic', 'x', '--insight', 'y']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /requires --sid/);
  });

  it('save without --round → exit 1', () => {
    const r = runHelper(['save', '--sid', 'aaa', '--topic', 'x', '--insight', 'y']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /requires --round/);
  });

  it('save with --topic AND --topic-stdin → exit 1', () => {
    const r = runHelper(['save', '--sid', 'aaa', '--round', '0', '--topic', 'x', '--topic-stdin', '--insight', 'y']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /either --topic OR --topic-stdin/);
  });

  it('save mode unknown flag → exit 1', () => {
    const r = runHelper(['save', '--sid', 'a', '--round', '0', '--no-such-flag']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Unknown save-mode flag/);
  });
});

describe('--help exits 0 with helpful text', () => {
  it('outputs help', () => {
    const r = runHelper(['--help']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /USAGE/);
    assert.match(r.stdout, /--debate/);
    assert.match(r.stdout, /--continue-from/);
    assert.match(r.stdout, /--depth/);
    assert.match(r.stdout, /save mode/);
  });
});
