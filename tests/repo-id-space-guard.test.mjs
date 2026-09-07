/**
 * @fileoverview `assertRepoRowId` — the guard for the two-repo-id-space hazard.
 * Integration test on a disposable DB; skips cleanly without AUDIT_DB_TEST_URL.
 *
 * THE DEFECT (measured 2026-09-07 on the live store). This repo carries two
 * uuid-shaped repo identities: `audit_repos.repo_uuid` (the logical identity
 * `resolveRepoIdentity()` returns, and the FK-less scoping convention of
 * `model_eval_runs`) and `audit_repos.id` (the storage row id every FK'd child
 * table's `repo_id` references). Nothing about their SHAPE distinguishes them,
 * so a reader handed the wrong one matches no rows and returns an empty
 * result — indistinguishable from "this repo genuinely has none".
 *
 * `model-eval-adjudicator.mjs` passed `repoUuid` into `getAdjudicatorGroundTruth`,
 * whose SQL filters `audit_runs.repo_id`. It reported
 * `insufficient_ground_truth: only 0 labeled rows` against 3,413 real ones,
 * which is why the adjudicator eval had never run since it was built.
 *
 * The fix is a guard at the READ SEAM, not at the three call sites — hence the
 * third case below, which is the one that makes it structural: the store
 * function must refuse the wrong id space itself, so a fourth caller cannot
 * quietly reintroduce the false zero.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { getPool, closePool, _resetForTest, assertDisposableDbUrl } from '../scripts/lib/db/client.mjs';
import { upsertRepoByUuid, assertRepoRowId, RepoIdSpaceError } from '../scripts/lib/store/repo.mjs';
import { getAdjudicatorGroundTruth } from '../scripts/lib/store/model-ab.mjs';

const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const skip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set';

let savedUrl, repoRowId, textRepoRowId, seededFindingId;
// resolveRepoIdentity() emits a v5 uuid, so this is the real-world shape...
const repoUuid = crypto.randomUUID();
// ...but the column is TEXT and other callers store free-form values, which
// make the uuid-typed `id` lookup throw 22P02 before any logic runs.
const textRepoUuid = `test-id-space-${crypto.randomUUID()}`;

describe('assertRepoRowId — a repo_uuid must never read as an empty corpus', { skip }, () => {
  before(async () => {
    savedUrl = process.env.AUDIT_DB_URL;
    assertDisposableDbUrl(TEST_URL, { productionUrl: savedUrl });
    await _resetForTest();
    process.env.AUDIT_DB_URL = TEST_URL;

    repoRowId = (await upsertRepoByUuid({ repoUuid, name: 'id-space-test-repo', fingerprint: null })).id;
    textRepoRowId = (await upsertRepoByUuid({ repoUuid: textRepoUuid, name: 'id-space-text-repo', fingerprint: null })).id;

    // One labeled finding, so "0 rows" can only mean the scoping went wrong —
    // without this the empty result would be honest and the test vacuous.
    const pool = await getPool();
    const { rows } = await pool.query(
      `INSERT INTO audit_runs (repo_id, plan_file, mode) VALUES ($1, 'docs/plans/id-space.md', 'code') RETURNING id`,
      [repoRowId],
    );
    const { rows: seeded } = await pool.query(
      `INSERT INTO audit_findings (run_id, finding_fingerprint, pass_name, severity, category,
         primary_file, detail_snapshot, adjudication_outcome, decided_at)
       VALUES ($1, $2, 'structure', 'HIGH', 'crash', 'src/a.ts', 'boom', 'accepted', now()) RETURNING id`,
      [rows[0].id, crypto.randomUUID().slice(0, 8)],
    );
    seededFindingId = seeded[0].id;
  });

  after(async () => {
    await closePool();
    if (savedUrl === undefined) delete process.env.AUDIT_DB_URL;
    else process.env.AUDIT_DB_URL = savedUrl;
    await _resetForTest();
  });

  it('accepts a real audit_repos.id', async () => {
    await assert.doesNotReject(() => assertRepoRowId(repoRowId, { caller: 'test' }));
  });

  it('rejects a repo_uuid, and names the correct id in the error', async () => {
    // Structural assertions, not prose matching: `kind` and `expected` are the
    // contract a caller can act on.
    await assert.rejects(
      () => assertRepoRowId(repoUuid, { caller: 'test' }),
      (err) => {
        assert.ok(err instanceof RepoIdSpaceError, `expected RepoIdSpaceError, got ${err?.name}`);
        assert.equal(err.kind, 'repo-uuid-passed-as-row-id');
        assert.equal(err.expected, repoRowId, 'the error must carry the id the caller should have used');
        return true;
      },
    );
  });

  it('rejects a NON-UUID repo_uuid too, without leaking a raw SQLSTATE', async () => {
    // `audit_repos.id` is uuid and `repo_uuid` is text: a free-form value makes
    // the id lookup throw 22P02 before the uuid branch is reached. That must
    // still land on the actionable error, not a Postgres parse failure.
    await assert.rejects(
      () => assertRepoRowId(textRepoUuid, { caller: 'test' }),
      (err) => {
        assert.ok(err instanceof RepoIdSpaceError, `expected RepoIdSpaceError, got ${err?.name}: ${err?.message}`);
        assert.equal(err.kind, 'repo-uuid-passed-as-row-id');
        assert.equal(err.expected, textRepoRowId);
        return true;
      },
    );
  });

  it('rejects an id belonging to neither space', async () => {
    await assert.rejects(
      () => assertRepoRowId(crypto.randomUUID(), { caller: 'test' }),
      (err) => err instanceof RepoIdSpaceError && err.kind === 'unknown-repo-id',
    );
  });

  it('getAdjudicatorGroundTruth refuses a repo_uuid instead of returning []', async () => {
    // The seam-level assertion — this is what makes the fix structural. Before
    // the guard this resolved to `{cloud:true, rows:[]}` and every caller read
    // it as "no ground truth".
    await assert.rejects(
      () => getAdjudicatorGroundTruth({ repoId: repoUuid }),
      (err) => err instanceof RepoIdSpaceError && err.kind === 'repo-uuid-passed-as-row-id',
    );
  });

  it('excludes a dismissal the store itself contradicts, and counts what it removed', async () => {
    // `adjudication_outcome` is TRIAGE, not a verdict on truth: 86% of this
    // repo's dismissals were written by the deliberation ledger, not a person.
    // A dismissed finding someone then FIXED is not a false positive, and
    // scoring a model against it penalises the model for being right.
    const pool = await getPool();
    const mk = async (outcome, extra = {}) => {
      const { rows: r } = await pool.query(
        `INSERT INTO audit_runs (repo_id, plan_file, mode) VALUES ($1, 'docs/plans/contam.md', 'code') RETURNING id`,
        [repoRowId],
      );
      const { rows: f } = await pool.query(
        `INSERT INTO audit_findings (run_id, finding_fingerprint, pass_name, severity, category,
           primary_file, detail_snapshot, adjudication_outcome, decided_at, remediation_state, user_action)
         VALUES ($1, $2, 'structure', 'HIGH', 'crash', 'src/c.ts', 'boom', $3, now(), $4, $5) RETURNING id`,
        [r[0].id, crypto.randomUUID().slice(0, 8), outcome, extra.remediation ?? null, extra.userAction ?? null],
      );
      return f[0].id;
    };

    const cleanDismissal = await mk('dismissed');            // user_action NULL — the 86% case
    const fixedDismissal = await mk('dismissed', { remediation: 'fixed' });
    const deferredDismissal = await mk('dismissed', { userAction: 'auto_dismissed' });

    const { rows, excludedContaminated } = await getAdjudicatorGroundTruth({ repoId: repoRowId, limit: 500 });
    const ids = new Set(rows.map((r) => r.findingId));

    // The direction the exclusion must NOT fire. A dismissal with no
    // contradicting signal is the overwhelmingly common shape, and `x IN (...)`
    // is NULL (not false) when x is NULL — un-coalesced, three-valued logic
    // drops exactly these rows and leaves a 100%-true_positive corpus. That is
    // what the first draft of this exclusion actually did.
    assert.ok(ids.has(cleanDismissal), 'an uncontradicted dismissal must survive');
    assert.equal(rows.find((r) => r.findingId === cleanDismissal).triageLabel, 'false_positive');

    assert.ok(!ids.has(fixedDismissal), 'a dismissal someone FIXED is not a false positive');
    assert.ok(!ids.has(deferredDismissal), 'auto-deferral is out-of-scope, not disproved');
    assert.ok(excludedContaminated >= 2, `expected the removals to be counted, got ${excludedContaminated}`);
  });

  it('the correct id still returns the seeded row (negative control)', async () => {
    // Without this, the suite would pass just as well against a function that
    // rejects EVERYTHING.
    // Asserted BY ID, not by row count: a sibling case in this suite seeds its
    // own rows, and node's test order is not a contract to hang an assertion on.
    const { rows } = await getAdjudicatorGroundTruth({ repoId: repoRowId, limit: 500 });
    const mine = rows.find((r) => r.findingId === seededFindingId);
    assert.ok(mine, 'the seeded accepted finding must come back');
    assert.equal(mine.triageLabel, 'true_positive');
  });
});
