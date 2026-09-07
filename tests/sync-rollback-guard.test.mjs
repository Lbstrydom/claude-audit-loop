/**
 * @fileoverview Guards `lib/sync-rollback-guard.mjs` — the refusal that stops a
 * sync from moving a consumer BACKWARDS.
 *
 * The incident (2026-09-07): a fix delivered to three consumers at 08:45 was
 * overwritten at 10:48 by a session pushing from a tree that predated it. The
 * push never landed; the sync side-effect did, because git fires pre-push BEFORE
 * the remote accepts. Each consumer logged the rollback as an ordinary success.
 *
 * The pure predicate lives in `sync-receipt.mjs` and is tested there. This suite
 * covers the two halves that live here: the three-valued git oracle (whose
 * `no`-vs-`unknown` distinction is the whole reason it is not a boolean) and the
 * abort/allow decision.
 */
import test, { describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';

import { createGitAncestry, planRollbackResponse } from '../scripts/lib/sync-rollback-guard.mjs';

const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

/** A throwaway repo with two commits on a line, plus a divergent branch tip. */
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rollback-guard-'));
  tmpDirs.push(dir);
  const run = (...args) => cp.execFileSync('git', args, { cwd: dir, stdio: 'pipe', encoding: 'utf-8' });
  run('init', '-q');
  run('config', 'user.email', 'test@example.invalid');
  run('config', 'user.name', 'Test');
  run('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  run('add', '-A'); run('commit', '-q', '-m', 'first');
  const first = run('rev-parse', 'HEAD').trim();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
  run('add', '-A'); run('commit', '-q', '-m', 'second');
  const second = run('rev-parse', 'HEAD').trim();
  // A sibling off `first` — neither an ancestor nor a descendant of `second`.
  run('checkout', '-q', '-b', 'side', first);
  fs.writeFileSync(path.join(dir, 'b.txt'), 'side\n');
  run('add', '-A'); run('commit', '-q', '-m', 'side');
  const side = run('rev-parse', 'HEAD').trim();
  return { dir, first, second, side };
}

describe('createGitAncestry', () => {
  test('answers yes / no across a real commit line', () => {
    const { dir, first, second } = makeRepo();
    const ancestry = createGitAncestry(dir);
    assert.equal(ancestry(first, second), 'yes', 'first IS an ancestor of second');
    assert.equal(ancestry(second, first), 'no', 'and the reverse must be a clean no, not unknown');
  });

  test('a DIVERGENT pair is `no` in both directions — the case that must stay allowed', () => {
    const { dir, second, side } = makeRepo();
    const ancestry = createGitAncestry(dir);
    assert.equal(ancestry(side, second), 'no');
    assert.equal(ancestry(second, side), 'no');
  });

  test('a sha absent from this checkout is `unknown`, never `no`', () => {
    // The real case: a consumer recorded its last sync on another machine. A
    // fabricated `no` there would be indistinguishable from a real answer, and
    // detectSourceRollback would silently stop guarding.
    const { dir, second } = makeRepo();
    const ancestry = createGitAncestry(dir);
    const absent = '0123456789012345678901234567890123456789';
    assert.equal(ancestry(absent, second), 'unknown');
    assert.equal(ancestry(second, absent), 'unknown');
  });

  test('a non-repo directory is `unknown`, not a crash and not a `no`', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rollback-guard-bare-'));
    tmpDirs.push(dir);
    const ancestry = createGitAncestry(dir);
    assert.equal(ancestry('a'.repeat(40), 'b'.repeat(40)), 'unknown');
  });
});

describe('planRollbackResponse', () => {
  const hit = { recordedSha: 'b'.repeat(40), incomingSha: 'a'.repeat(40), recordedAt: '2026-09-07T08:45:00.000Z' };

  test('no rollback says nothing at all', () => {
    const r = planRollbackResponse(null, { repoName: 'x', allowRollback: false });
    assert.equal(r.abort, false);
    assert.deepEqual(r.lines, [], 'a caller must never print a blank advisory');
  });

  test('a rollback ABORTS and names both shas, the relation and the remedy', () => {
    const r = planRollbackResponse(hit, { repoName: 'wine-cellar-app', allowRollback: false });
    assert.equal(r.abort, true);
    const text = r.lines.join('\n');
    assert.match(text, /ABORT/);
    assert.match(text, /wine-cellar-app/);
    assert.match(text, /ANCESTOR/, 'the operator must be told WHY, not just that it refused');
    assert.match(text, /aaaaaaaaaaaa/); assert.match(text, /bbbbbbbbbbbb/);
    assert.match(text, /--allow-rollback/, 'a refusal without its consent flag is a dead end');
    assert.match(text, /2026-09-07T08:45/, 'when the consumer got the newer bundle');
  });

  test('--allow-rollback proceeds but still SAYS so', () => {
    const r = planRollbackResponse(hit, { repoName: 'wine-cellar-app', allowRollback: true });
    assert.equal(r.abort, false, 'consent means proceed');
    assert.equal(r.lines.length, 1, 'and a deliberate rollback is still worth one line');
    assert.match(r.lines[0], /rollback ALLOWED/);
  });

  test('a missing recordedAt drops the clause instead of printing undefined', () => {
    const r = planRollbackResponse({ ...hit, recordedAt: null }, { repoName: 'x', allowRollback: false });
    assert.ok(!/undefined|null/.test(r.lines.join('\n')));
  });
});
