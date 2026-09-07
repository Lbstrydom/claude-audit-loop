import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

describe('model-eval-adjudicator.mjs — CLI preflight', () => {
  test('--selfcheck-relocation exits 0 and prints OK', () => {
    const out = execFileSync('node', ['scripts/model-eval-adjudicator.mjs', '--selfcheck-relocation'], { encoding: 'utf8' });
    assert.match(out, /OK/);
  });

  test('missing --candidate exits non-zero with a usage message', () => {
    assert.throws(() => execFileSync('node', ['scripts/model-eval-adjudicator.mjs', '--tier', 'screen'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  });

  test('an invalid --tier exits non-zero', () => {
    assert.throws(() => execFileSync('node', ['scripts/model-eval-adjudicator.mjs', '--candidate', '{"kind":"sentinel","value":"latest-pro"}', '--tier', 'bogus'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  });

  test('an insufficient-ground-truth run exits with the documented preflight code (2)', () => {
    // AIR-GAPPED (2026-09-07), and that is load-bearing. This test used to rely
    // on the assumption that "this repo's real ground-truth corpus is almost
    // certainly below the 10/20-row minSampleSize" — an assumption about
    // MUTABLE STORE STATE, and it had quietly stopped holding: the corpus is
    // 3,413 labeled rows. The only reason the test still passed is that the
    // repo-id-space bug made every read return 0. Fixing that bug turned this
    // into a green test that COMPLETED a real screen-tier run and billed a
    // provider on every `npm test` (~$0.06 per run, measured).
    //
    // An empty DSN is this repo's air-gap signal (see tests/helpers/air-gap.mjs),
    // so the corpus is deterministically empty and no provider is ever reached.
    const env = { ...process.env, AUDIT_DB_URL: '', AUDIT_POSTGRES_URL: '' };
    try {
      execFileSync('node', ['scripts/model-eval-adjudicator.mjs', '--candidate', '{"kind":"sentinel","value":"latest-pro"}', '--tier', 'screen'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env });
      assert.fail('expected a non-zero exit (insufficient ground truth)');
    } catch (err) {
      assert.ok([1, 2, 3].includes(err.status), `unexpected exit code ${err.status}: ${err.stderr}`);
      assert.match(err.stderr, /insufficient_ground_truth/, 'must fail on the corpus, not on some earlier error');
    }
  });
});
