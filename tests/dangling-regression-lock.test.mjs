/**
 * @fileoverview A regression lock citing a file that does not exist reads as coverage
 * forever — upstream report `b2c9a63f` (Lbstrydom/wine-cellar-app, 2026-09-06).
 *
 * `unlocked_fixes`'s only lock predicate is `EXISTS (SELECT 1 FROM regression_specs …)`,
 * so recording a spec REMOVES the finding from the view whose entire job is surfacing
 * fixes that lack regression coverage. A dangling citation therefore discharges the
 * obligation permanently, and nothing re-raises it: the queue reports a clean backlog
 * that is not clean.
 *
 * **The read side is the primary instrument, and the upstream evidence is why.** Measured
 * here the day of the fix: 3 of 235 rows cite a path that no longer resolves — all three
 * `source_kind: 'unit-test'`, i.e. written by `lock-with-test`, which ALREADY validates
 * existence, and all three deleted by one commit (`e833b2aa`, "retire the consistency
 * candidate promotion path"). They were TRUE when recorded and were invalidated later by
 * a legitimate refactor, so a write-time check would have caught zero of them. The
 * reporter's three were the opposite case (tests on unmerged branches). A citation's
 * truth is not a property of the moment it was written.
 *
 * @module tests/dangling-regression-lock
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  listUnlockedFixesCmd, recordRegressionSpecCmd, repointRegressionSpecCmd,
} from '../scripts/lib/cross-skill/commands/ship.mjs';
import { CommandError } from '../scripts/lib/cross-skill/dispatch.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
/** A file that genuinely exists in this repo — this test file itself. */
const REAL_SPEC = 'tests/dangling-regression-lock.test.mjs';
const GONE_SPEC = 'tests/retired-by-a-refactor.test.mjs';

function makeCtx({ recorded = [], repoId = 'repo-1', cloud = true, payload = {} } = {}) {
  return {
    verb: 'list-unlocked-fixes',
    cloud: { enabled: cloud },
    flag: () => null,
    hasFlag: () => false,
    payload: () => payload,
    git: { commitSha: () => 'abc1234', branch: () => 'main' },
    degrade: () => ({ ok: true, cloud: false }),
    resolveScope: async () => (repoId ? { kind: 'scoped', repoId, slug: 'owner/repo' } : { kind: 'unresolved', reason: 'repo-identity-unresolvable' }),
    deps: {
      getUnlockedFixes: async () => [],
      countUnlockedFixes: async () => ({ total: 0, code: 0, plan: 0 }),
      countAgedUnlockedFixes: async () => ({ agedOut: 0, byMode: { code: 0, plan: 0 }, prePractice: 0, practiceStart: null }),
      resolveNudgePage: () => ({ limit: 20, offset: 0 }),
      getRecordedSpecPaths: async () => recorded,
      recordRegressionSpec: async () => ({ ok: true, specId: 'spec-1' }),
    },
  };
}

describe('the /ship lock nudge reports locks whose spec_path no longer resolves', () => {
  it('counts a citation naming a missing file, and leaves a real one alone', async () => {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, REAL_SPEC)), 'the control file must really exist');
    assert.ok(!fs.existsSync(path.join(REPO_ROOT, GONE_SPEC)), 'the subject file must really be absent');

    const out = await listUnlockedFixesCmd(makeCtx({
      recorded: [
        { specPath: REAL_SPEC, sourceKind: 'unit-test', sourceFindingId: 'f1', createdAt: null },
        { specPath: GONE_SPEC, sourceKind: 'unit-test', sourceFindingId: 'f2', createdAt: null },
      ],
    }));
    assert.equal(out.danglingLocks.count, 1);
    assert.equal(out.danglingLocks.checked, 2);
    assert.equal(out.danglingLocks.rows[0].specPath, GONE_SPEC);
  });

  it('a clean repo reports 0 — a real measured zero, distinct from unmeasured', async () => {
    const out = await listUnlockedFixesCmd(makeCtx({
      recorded: [{ specPath: REAL_SPEC, sourceKind: 'unit-test', sourceFindingId: 'f1', createdAt: null }],
    }));
    assert.equal(out.danglingLocks.count, 0);
    assert.equal(out.danglingLocks.reason, null);
  });

  // ── The direction that must NOT read as clean ────────────────────────────
  it('cloud off is UNMEASURED (count null), never a clean zero', async () => {
    const out = await listUnlockedFixesCmd(makeCtx({ cloud: false }));
    assert.equal(out.danglingLocks.count, null, 'an unasked question must not render as a clean result');
    assert.equal(out.danglingLocks.reason, 'cloud-off');
  });

  it('an unresolved repo is UNMEASURED, and a failing read degrades to unmeasured too', async () => {
    const ctx = makeCtx({});
    ctx.deps.getRecordedSpecPaths = async () => { throw new Error('store unreachable'); };
    const out = await listUnlockedFixesCmd(ctx);
    assert.equal(out.danglingLocks.count, null);
    assert.match(out.danglingLocks.reason, /unreadable/);
    // and it must not have broken the nudge it rides on
    assert.equal(out.ok, true);
    assert.equal(out.measured, true);
  });

  it('a spec_path naming a DIRECTORY is dangling — existsSync alone would accept it', async () => {
    // The INC-001 class the shared oracle already handles: `classifyTestPath` requires a
    // regular file, so a lock naming `tests/` cannot read as evidence.
    const out = await listUnlockedFixesCmd(makeCtx({
      recorded: [{ specPath: 'tests', sourceKind: 'unit-test', sourceFindingId: 'f1', createdAt: null }],
    }));
    assert.equal(out.danglingLocks.count, 1, 'a directory is not a test file');
  });
});

describe('record-regression-spec does NOT probe the filesystem — and that is the decision', () => {
  // A REVERSAL of this change's own first attempt, pinned so it is not silently redone.
  // I added a write-time existence check as a "cheap second line". It broke two existing
  // contracts — the golden-envelope capture (a cloud-off call started REFUSING on a
  // filesystem probe where it used to degrade) and the write-outcome fixture (a synthetic
  // `tests/x.spec.ts`, testing exit codes rather than paths). Repairing those two guards
  // to fit the new check would have been fitting the tests to the change.
  //
  // And it earns little: upstream b2c9a63f measured 3 of 3 dangling citations that were
  // TRUE when written and were invalidated later by a refactor, so a write-time probe
  // catches none of the real population — only a typo, which the read-side report above
  // surfaces one ship later anyway.

  it('accepts a path that does not resolve — the programmatic recorder stays permissive', async () => {
    const ctx = makeCtx({ payload: { sourceKind: 'unit-test', description: 'pins a thing', specPath: GONE_SPEC } });
    const out = await recordRegressionSpecCmd(ctx);
    assert.equal(out.ok, true, 'tooling may legitimately record the intent before the file is saved');
  });

  it('still refuses an ABSENT specPath — presence was always the contract here', async () => {
    const ctx = makeCtx({ payload: { sourceKind: 'unit-test', description: 'pins a thing' } });
    await assert.rejects(() => recordRegressionSpecCmd(ctx), /specPath is required/);
  });

  it('cloud-off degrades rather than probing anything — the regression that was caught', async () => {
    // The specific break: a check placed before this early return turned a supported mode
    // into a refusal. Cloud-off writes nothing, so there is nothing for a probe to protect.
    const ctx = makeCtx({ cloud: false, payload: { sourceKind: 'unit-test', description: 'x', specPath: GONE_SPEC } });
    const out = await recordRegressionSpecCmd(ctx);
    assert.equal(out.ok, true);
    assert.equal(out.cloud, false);
  });

  it('lock-with-test KEEPS its own existence check — the two verbs differ on purpose', async () => {
    // The interactive verb a human aims at one finding, where refusing a typo immediately
    // is worth the friction. Asserted on the source so the asymmetry is deliberate rather
    // than an accident nobody noticed.
    const src = fs.readFileSync(
      path.join(REPO_ROOT, 'scripts/lib/cross-skill/commands/ship.mjs'), 'utf-8');
    const lockFn = src.slice(src.indexOf('export async function lockWithTestCmd'));
    assert.match(lockFn.slice(0, 4000), /classifyTestPath/,
      'lock-with-test must keep refusing a citation it cannot resolve');
  });
});


// ── The WRITE half — upstream 429683ac ─────────────────────────────────────
//
// The read half above reports dangling locks. For its whole life nothing could
// act on that report: `lock-with-test` refuses an already-locked finding (correctly
// — its job is discharging an OPEN obligation), and `record-regression-spec`
// cannot re-point a unit-test row either, because its arbiter is
// (repo_id, spec_path, source_finding_id) — a call naming a NEW path does not
// conflict, so it INSERTS a second row and leaves the stale citation standing.
//
// Every case below is a REFUSAL or an outcome that must not be guessed, because
// the failure mode being closed is a lock that reads as coverage while claiming
// something false. A repair that quietly picked a row would reproduce it.

function makeRepointCtx({
  flags = {}, boolFlags = {}, repoId = 'repo-1', cloud = true,
  found = { ok: true, cloud: true, rows: [] },
  repoint = { ok: true, cloud: true, specId: 'spec-1', specPath: 'tests/new.test.mjs' },
  del = { ok: true, cloud: true, specId: 'spec-1', specPath: 'tests/old.test.mjs' },
  calls = {},
} = {}) {
  return {
    verb: 'repoint-regression-spec',
    cloud: { enabled: cloud },
    flag: (n) => flags[n] ?? null,
    hasFlag: (n) => Boolean(boolFlags[n]),
    payload: () => ({}),
    git: { commitSha: () => 'abc1234', branch: () => 'main' },
    degrade: () => ({ ok: true, cloud: false }),
    resolveScope: async () => (repoId
      ? { kind: 'scoped', repoId, slug: 'owner/repo' }
      : { kind: 'unresolved', reason: 'repo-identity-unresolvable' }),
    deps: {
      getRegressionSpecsForFinding: async (...a) => { calls.found = a; return found; },
      repointRegressionSpec: async (...a) => { calls.repoint = a; return repoint; },
      deleteRegressionSpec: async (...a) => { calls.delete = a; return del; },
    },
  };
}

const FINDING = 'a4969127-d5d0-47bb-8b2e-0acb0ed71546';

describe('repoint-regression-spec — the write half the dangling report had no verb for', () => {
  it('re-points a single lock, and names where it came FROM', async () => {
    const calls = {};
    const out = await repointRegressionSpecCmd(makeRepointCtx({
      flags: { finding: FINDING, test: REAL_SPEC, description: 'the old spec was deleted by a refactor' },
      found: { ok: true, cloud: true, rows: [{ id: 'spec-1', specPath: GONE_SPEC }] },
      repoint: { ok: true, cloud: true, specId: 'spec-1', specPath: REAL_SPEC },
      calls,
    }));
    assert.equal(out.ok, true);
    assert.equal(out.repointed, true);
    assert.equal(out.previousPath, GONE_SPEC, 'the operator must be able to see what was replaced');
    // The repo id comes from the resolved identity, never from the row — the
    // cross-tenant fence lock-with-test grew after adopting a foreign repo_id.
    assert.equal(calls.repoint[0], 'repo-1');
    assert.equal(calls.repoint[1].specId, 'spec-1');
  });

  it('THE DIRECTION THAT MUST FIRE: an AMBIGUOUS (repo, finding) is refused and its candidates named', async () => {
    // Not unique by construction — the unit-test arbiter includes spec_path, so
    // one finding may legitimately carry two citations. Picking the newest would
    // repair one and silently leave the other.
    const calls = {};
    const out = await repointRegressionSpecCmd(makeRepointCtx({
      flags: { finding: FINDING, test: REAL_SPEC, description: 'why' },
      found: { ok: true, cloud: true, rows: [
        { id: 'spec-1', specPath: GONE_SPEC },
        { id: 'spec-2', specPath: 'tests/other.test.mjs' },
      ] },
      calls,
    }));
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'ambiguous-lock');
    assert.match(out.error, /spec-1/);
    assert.match(out.error, /spec-2/);
    assert.equal(calls.repoint, undefined, 'nothing may be written while the target is ambiguous');
  });

  it('a READ that failed is not reported as "no lock"', async () => {
    // "could not look" and "nothing there" must not be the same answer: the
    // second reads as "nothing to fix" over a store outage.
    const calls = {};
    const out = await repointRegressionSpecCmd(makeRepointCtx({
      flags: { finding: FINDING, test: REAL_SPEC, description: 'why' },
      found: { ok: false, cloud: true, reason: 'read-failed', message: 'connection reset' },
      calls,
    }));
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'read-failed');
    assert.equal(calls.repoint, undefined);
  });

  it('refuses a new path that does not exist — moving a dangling lock is not fixing it', async () => {
    const out = await repointRegressionSpecCmd(makeRepointCtx({
      flags: { finding: FINDING, test: GONE_SPEC, description: 'why' },
    }));
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'test-file-not-found');
  });

  it('refuses an unresolvable repo rather than guessing one', async () => {
    const out = await repointRegressionSpecCmd(makeRepointCtx({
      flags: { finding: FINDING, test: REAL_SPEC, description: 'why' }, repoId: null,
    }));
    assert.equal(out.ok, false);
    assert.match(out.error, /repo identity unresolvable/);
  });

  it('requires a description, exactly as lock-with-test does', async () => {
    for (const description of [null, '   ']) {
      const out = await repointRegressionSpecCmd(makeRepointCtx({
        flags: { finding: FINDING, test: REAL_SPEC, description },
      }));
      assert.equal(out.ok, false, `description ${JSON.stringify(description)} must be refused`);
    }
  });

  it('--delete removes the lock, and says the finding is an open obligation again', async () => {
    const calls = {};
    const out = await repointRegressionSpecCmd(makeRepointCtx({
      flags: { finding: FINDING }, boolFlags: { delete: true },
      found: { ok: true, cloud: true, rows: [{ id: 'spec-9', specPath: GONE_SPEC }] },
      del: { ok: true, cloud: true, specId: 'spec-9', specPath: GONE_SPEC },
      calls,
    }));
    assert.equal(out.ok, true);
    assert.equal(out.deleted, true);
    assert.equal(out.repointed, false);
    assert.deepEqual(calls.delete, ['repo-1', 'spec-9']);
    assert.match(out.note, /unlocked_fixes/);
  });

  it('--delete alongside --test is refused — two different outcomes for the finding', async () => {
    const calls = {};
    const out = await repointRegressionSpecCmd(makeRepointCtx({
      flags: { finding: FINDING, test: REAL_SPEC }, boolFlags: { delete: true }, calls,
    }));
    assert.equal(out.ok, false);
    assert.equal(calls.delete, undefined);
    assert.equal(calls.repoint, undefined);
  });

  it('a write that matched no row is a FAILURE, never a success', async () => {
    // Postgres reports success for an UPDATE that affected nothing.
    const out = await repointRegressionSpecCmd(makeRepointCtx({
      flags: { finding: FINDING, test: REAL_SPEC, description: 'why' },
      found: { ok: true, cloud: true, rows: [{ id: 'spec-1', specPath: GONE_SPEC }] },
      repoint: { ok: false, cloud: true, reason: 'write-failed', message: 'the UPDATE matched nothing' },
    }));
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'write-failed');
  });

  it('cloud-off degrades without claiming anything happened', async () => {
    const out = await repointRegressionSpecCmd(makeRepointCtx({ cloud: false, flags: { finding: FINDING } }));
    assert.equal(out.repointed, false);
    assert.equal(out.deleted, false);
  });
});
