/**
 * @fileoverview `sync-status` — classifies a consumer's dirty `git status`
 * paths into "written by the sync" vs "this repo's own edits", so a person
 * doesn't have to cross-reference scripts/.sync-manifest.json by hand (the
 * failure mode observed in `storyline`: a batch of `.claude/skills/**` +
 * `.sync-receipt.json` drift sat unexplained as ordinary uncommitted changes).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parsePorcelainZ, classifyDirtyEntries, buildCommitSuggestion, EXTRA_SYNC_ARTIFACTS,
} from '../scripts/lib/sync-status.mjs';
import { RECEIPT_PATH } from '../scripts/lib/sync-receipt.mjs';
import { OWNED_SIDECAR_RELATIVE_PATH } from '../scripts/lib/sync-owned-sidecar.mjs';

describe('parsePorcelainZ', () => {
  it('parses ordinary modified/untracked entries', () => {
    const raw = [' M .claude/skills/plan/SKILL.md', '?? .sync-receipt.json', ''].join('\0');
    assert.deepEqual(parsePorcelainZ(raw), [
      { status: ' M', path: '.claude/skills/plan/SKILL.md', origPath: null },
      { status: '??', path: '.sync-receipt.json', origPath: null },
    ]);
  });

  it('consumes the SECOND token for a rename/copy record, not the next entry', () => {
    // `R  ` (renamed, index-clean) is followed by the ORIGINAL path as its own
    // NUL-terminated token. Getting this wrong reads the next real entry as the
    // rename's origin and drops it from the output entirely.
    const raw = [
      'R  scripts/.claude-skills/new-name.mjs',
      'scripts/.claude-skills/old-name.mjs',
      ' M .sync-receipt.json',
      '',
    ].join('\0');
    assert.deepEqual(parsePorcelainZ(raw), [
      { status: 'R ', path: 'scripts/.claude-skills/new-name.mjs', origPath: 'scripts/.claude-skills/old-name.mjs' },
      { status: ' M', path: '.sync-receipt.json', origPath: null },
    ]);
  });

  it('empty input yields no entries (a clean tree, not a parse failure)', () => {
    assert.deepEqual(parsePorcelainZ(''), []);
    assert.deepEqual(parsePorcelainZ(null), []);
  });
});

describe('classifyDirtyEntries', () => {
  it('routes EXTRA_SYNC_ARTIFACTS (.sync-receipt.json, scripts/.sync-owned.json) to syncOwned even with no oracle match', () => {
    const entries = [
      { path: RECEIPT_PATH, origPath: null },
      { path: OWNED_SIDECAR_RELATIVE_PATH, origPath: null },
      { path: 'src/my-feature.ts', origPath: null },
    ];
    const { syncOwned, other } = classifyDirtyEntries({ entries, isUpstreamOwned: () => false });
    assert.deepEqual(syncOwned, [OWNED_SIDECAR_RELATIVE_PATH, RECEIPT_PATH].sort());
    assert.deepEqual(other, ['src/my-feature.ts']);
  });

  it('defers to the injected oracle for everything else', () => {
    const owned = new Set(['.claude/skills/plan/SKILL.md']);
    const entries = [
      { path: '.claude/skills/plan/SKILL.md', origPath: null },
      { path: 'app/routes/checkout.tsx', origPath: null },
    ];
    const { syncOwned, other } = classifyDirtyEntries({
      entries, isUpstreamOwned: (p) => owned.has(p),
    });
    assert.deepEqual(syncOwned, ['.claude/skills/plan/SKILL.md']);
    assert.deepEqual(other, ['app/routes/checkout.tsx']);
  });

  it('a rename is sync-owned if EITHER its old or new path is', () => {
    const entries = [
      { path: 'scripts/.claude-skills/new.mjs', origPath: 'scripts/.claude-skills/old.mjs' },
    ];
    const { syncOwned, other } = classifyDirtyEntries({
      entries, isUpstreamOwned: (p) => p === 'scripts/.claude-skills/old.mjs',
    });
    assert.deepEqual(syncOwned, ['scripts/.claude-skills/new.mjs']);
    assert.deepEqual(other, []);
  });

  it('an entry matching neither source is "other" — never guessed as owned', () => {
    const entries = [{ path: 'README.md', origPath: null }];
    const { syncOwned, other } = classifyDirtyEntries({ entries, isUpstreamOwned: () => false });
    assert.deepEqual(syncOwned, []);
    assert.deepEqual(other, ['README.md']);
  });
});

describe('buildCommitSuggestion', () => {
  it('is deterministic regardless of input order', () => {
    const a = buildCommitSuggestion(['b.mjs', 'a.mjs']);
    const b = buildCommitSuggestion(['a.mjs', 'b.mjs']);
    assert.equal(a, b);
  });

  it('quotes a path carrying a space', () => {
    const cmd = buildCommitSuggestion(['docs/plan notes.md']);
    assert.match(cmd, /"docs\/plan notes\.md"/);
  });

  it('carries the git add + commit shape a human can paste verbatim', () => {
    const cmd = buildCommitSuggestion(['.sync-receipt.json']);
    assert.match(cmd, /^git add .*&& git commit -m "/);
  });
});

describe('EXTRA_SYNC_ARTIFACTS', () => {
  it('is case-insensitively comparable, matching the sidecar\'s own comparison contract', () => {
    // sync-owned-sidecar.mjs's `comparisonKey` folds case for Windows/macOS
    // filesystems; this set is built through the same reduction, so a stray
    // case difference in a caller's path must not create a false "other".
    assert.ok(EXTRA_SYNC_ARTIFACTS.has(RECEIPT_PATH.toLowerCase()));
  });
});
