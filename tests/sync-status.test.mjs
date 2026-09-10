/**
 * @fileoverview `sync-status` — classifies a consumer's dirty `git status`
 * paths into "written by the sync" vs "this repo's own edits", so a person
 * doesn't have to cross-reference scripts/.sync-manifest.json by hand (the
 * failure mode observed in `storyline`: a batch of `.claude/skills/**` +
 * `.sync-receipt.json` drift sat unexplained as ordinary uncommitted changes).
 *
 * The classifier does NOT stop at "is this path sync-managed" — `/audit-code`
 * found across two rounds (docs/plans/sync-output-drift-classification.md)
 * that ownership alone lets a hand-edit, a rename, or a staged-vs-working-tree
 * mismatch inherit "safe to commit" it never earned, and that a suggested git
 * command needs real safety guarantees (repo pinning, pathspec scoping,
 * literal pathspecs, escaped messages) beyond shell quoting alone.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parsePorcelainZ, classifyDirtyEntries, createProvenanceVerifier, pathspecsForCommit,
  buildCommitSuggestion, EXTRA_SYNC_ARTIFACTS,
} from '../scripts/lib/sync-status.mjs';
import { RECEIPT_PATH } from '../scripts/lib/sync-receipt.mjs';
import { OWNED_SIDECAR_RELATIVE_PATH } from '../scripts/lib/sync-owned-sidecar.mjs';

// Every classifyDirtyEntries call below needs SOME isVerifiedSyncOutput —
// these two make the intent of each test obvious at the call site.
const ALWAYS_VERIFIED = () => true;
const NEVER_VERIFIED = () => false;

/** Build a plain (unambiguous-index-state) entry — the common case. */
const plain = (path, origPath = null) => ({ status: ' M', path, origPath });
/** Build an untracked entry. */
const untracked = (path) => ({ status: '??', path, origPath: null });

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

  it('consumes the second token for a COPY too (stream stays aligned), but does NOT expose it as origPath (/audit-code round 3 H1)', () => {
    // A copy's "origin" is a live, separately-classified file — not evidence
    // about the new path's own provenance, and not something that should be
    // pulled into a commit under this entry's authority.
    const raw = [
      'C  copied-file.mjs',
      'source-of-copy.mjs',
      ' M .sync-receipt.json',
      '',
    ].join('\0');
    assert.deepEqual(parsePorcelainZ(raw), [
      { status: 'C ', path: 'copied-file.mjs', origPath: null },
      { status: ' M', path: '.sync-receipt.json', origPath: null },
    ]);
  });

  it('empty input yields no entries (a clean tree, not a parse failure)', () => {
    assert.deepEqual(parsePorcelainZ(''), []);
    assert.deepEqual(parsePorcelainZ(null), []);
  });
});

describe('classifyDirtyEntries', () => {
  it('routes EXTRA_SYNC_ARTIFACTS to needsReview when unverified — ownership is not a provenance bypass (/audit-code round 2 M1)', () => {
    const entries = [plain(RECEIPT_PATH), plain(OWNED_SIDECAR_RELATIVE_PATH), plain('src/my-feature.ts')];
    const { syncOwned, needsReview, other } = classifyDirtyEntries({
      entries, isUpstreamOwned: () => false, isVerifiedSyncOutput: NEVER_VERIFIED,
    });
    assert.deepEqual(syncOwned, []);
    assert.deepEqual(needsReview.map((e) => e.path), [OWNED_SIDECAR_RELATIVE_PATH, RECEIPT_PATH].sort());
    assert.deepEqual(other.map((e) => e.path), ['src/my-feature.ts']);
  });

  it('EXTRA_SYNC_ARTIFACTS reach syncOwned once provenance verifies (they are owned by pathname, verified like anything else)', () => {
    const entries = [plain(RECEIPT_PATH)];
    const { syncOwned } = classifyDirtyEntries({
      entries, isUpstreamOwned: () => false, isVerifiedSyncOutput: ALWAYS_VERIFIED,
    });
    assert.deepEqual(syncOwned.map((e) => e.path), [RECEIPT_PATH]);
  });

  it('an owned path with VERIFIED provenance and unambiguous index state is syncOwned', () => {
    const owned = new Set(['.claude/skills/plan/SKILL.md']);
    const entries = [plain('.claude/skills/plan/SKILL.md')];
    const { syncOwned, needsReview } = classifyDirtyEntries({
      entries, isUpstreamOwned: (p) => owned.has(p), isVerifiedSyncOutput: ALWAYS_VERIFIED,
    });
    assert.deepEqual(syncOwned.map((e) => e.path), ['.claude/skills/plan/SKILL.md']);
    assert.deepEqual(needsReview, []);
  });

  it('an owned path with UNVERIFIED provenance is needsReview, never syncOwned', () => {
    // A file the sidecar lists as sync-managed, hand-edited after the last
    // sync wrote it — ownership says the PATH is sync's, not that these BYTES
    // are.
    const owned = new Set(['.claude/skills/plan/SKILL.md']);
    const entries = [plain('.claude/skills/plan/SKILL.md')];
    const { syncOwned, needsReview } = classifyDirtyEntries({
      entries, isUpstreamOwned: (p) => owned.has(p), isVerifiedSyncOutput: NEVER_VERIFIED,
    });
    assert.deepEqual(syncOwned, []);
    assert.deepEqual(needsReview.map((e) => e.path), ['.claude/skills/plan/SKILL.md']);
  });

  it('an owned path with VERIFIED content but a STAGED change (MM) is needsReview, never syncOwned (/audit-code round 2 H1)', () => {
    // Working-tree bytes match the manifest (hashOf would say "verified"),
    // but the INDEX holds something our check never examined — the commit
    // this tool suggests would silently discard whatever is staged.
    const entries = [{ status: 'MM', path: '.claude/skills/plan/SKILL.md', origPath: null }];
    const { syncOwned, needsReview } = classifyDirtyEntries({
      entries, isUpstreamOwned: () => true, isVerifiedSyncOutput: ALWAYS_VERIFIED,
    });
    assert.deepEqual(syncOwned, []);
    assert.deepEqual(needsReview.map((e) => e.path), ['.claude/skills/plan/SKILL.md']);
  });

  it('a staged-clean untracked entry (??) is still eligible for syncOwned', () => {
    const entries = [untracked('.claude/skills/plan/SKILL.md')];
    const { syncOwned } = classifyDirtyEntries({
      entries, isUpstreamOwned: () => true, isVerifiedSyncOutput: ALWAYS_VERIFIED,
    });
    assert.deepEqual(syncOwned.map((e) => e.path), ['.claude/skills/plan/SKILL.md']);
  });

  it('a rename is sync-owned if EITHER its old or new path is owned AND provenance verifies, and origPath survives on the entry', () => {
    const entries = [
      { status: 'R ', path: 'scripts/.claude-skills/new.mjs', origPath: 'scripts/.claude-skills/old.mjs' },
    ];
    const { syncOwned, other } = classifyDirtyEntries({
      entries,
      isUpstreamOwned: (p) => p === 'scripts/.claude-skills/old.mjs',
      isVerifiedSyncOutput: ALWAYS_VERIFIED,
    });
    assert.deepEqual(syncOwned, [{ status: 'R ', path: 'scripts/.claude-skills/new.mjs', origPath: 'scripts/.claude-skills/old.mjs' }]);
    assert.deepEqual(other, []);
  });

  it('a rename whose ORIGIN PATH IS REOCCUPIED by a separate, unrelated entry demotes the WHOLE rename to needsReview (/audit-code round 4 H1, GPT rebuttal)', () => {
    // Real, reproducible git state (confirmed empirically): `git mv A B` then
    // recreating a brand-new, unrelated file at `A` reports BOTH `R  B`
    // (origin A) AND a separate `?? A` in one `git status` snapshot —
    //   git -c status.renames=true status --porcelain=v1 -z --untracked-files=all
    // Blindly trusting the rename's origPath would sweep A's fresh, unrelated
    // content into the rename's commit under a false "verified" claim.
    const raw = [
      'R  .claude/skills/plan/renamed.md',
      '.claude/skills/plan/SKILL.md',
      '?? .claude/skills/plan/SKILL.md',
      '',
    ].join('\0');
    const entries = parsePorcelainZ(raw);
    assert.equal(entries.length, 2, 'both the rename and the recreated file must parse as separate entries');

    const { syncOwned, needsReview } = classifyDirtyEntries({
      entries,
      isUpstreamOwned: () => true, // both paths are legitimate sync destinations by name
      // The rename's own content genuinely verifies (it's the untouched
      // original, unchanged by the rename) — the fix must refuse it because
      // the origin is REOCCUPIED, not because provenance fails on its own
      // merits. The recreated file's fresh content correctly does NOT verify
      // (it was never sync's output) — that must not be the only thing
      // keeping this test green.
      isVerifiedSyncOutput: (e) => e.path === '.claude/skills/plan/renamed.md',
    });
    assert.deepEqual(syncOwned, [], 'the rename must NOT be trusted while its origin is a live, separate entry');
    assert.deepEqual(needsReview.map((e) => e.path).sort(), [
      '.claude/skills/plan/SKILL.md', '.claude/skills/plan/renamed.md',
    ]);
  });

  it('a rename whose origin is reoccupied by a DIRECTORY (not a same-named file) is also demoted (/audit-code round 5 H1)', () => {
    // Real, reproducible git state (confirmed empirically): `git mv fileA
    // fileB` then `mkdir fileA && echo x > fileA/inner.txt` reports `R  fileB`
    // (origin `fileA`) alongside a SEPARATE `?? fileA/inner.txt` — no entry's
    // path is the exact string `fileA`, so a same-string livePaths check
    // alone misses this. Confirmed separately: `GIT_LITERAL_PATHSPECS=1 git
    // add -- './fileA'` recursively staged `fileA/inner.txt` regardless.
    const raw = ['R  fileB', 'fileA', '?? fileA/inner.txt', ''].join('\0');
    const entries = parsePorcelainZ(raw);
    assert.equal(entries.length, 2);

    const { syncOwned, needsReview } = classifyDirtyEntries({
      entries,
      isUpstreamOwned: () => true,
      isVerifiedSyncOutput: (e) => e.path === 'fileB',
    });
    assert.deepEqual(syncOwned, [], 'a directory-reoccupied origin must not be trusted either');
    assert.deepEqual(needsReview.map((e) => e.path).sort(), ['fileA/inner.txt', 'fileB']);
  });

  it('a COPY entry is classified purely on its own path — its origPath is already null from parsePorcelainZ, so a copy of a needsReview-worthy file never inherits that verdict or pulls the source into a commit (/audit-code round 3 H1)', () => {
    // Constructed as parsePorcelainZ would emit it: a COPY's origPath is
    // always null. If ownership/provenance ever looked at a copy's source
    // path, this test's isUpstreamOwned/isVerifiedSyncOutput would see it and
    // fail the assertions below.
    const entries = [{ status: 'C ', path: 'copied.mjs', origPath: null }];
    const seenPaths = new Set();
    const { syncOwned } = classifyDirtyEntries({
      entries,
      isUpstreamOwned: (p) => { seenPaths.add(p); return p === 'copied.mjs'; },
      isVerifiedSyncOutput: (e) => { seenPaths.add(e.path); return e.path === 'copied.mjs'; },
    });
    assert.deepEqual(syncOwned.map((e) => e.path), ['copied.mjs']);
    assert.deepEqual([...seenPaths], ['copied.mjs']);
  });

  it('an entry matching neither source is "other" — never guessed as owned, and provenance is never even asked', () => {
    const entries = [plain('README.md')];
    const { syncOwned, needsReview, other } = classifyDirtyEntries({
      entries, isUpstreamOwned: () => false,
      isVerifiedSyncOutput: () => { throw new Error('must not be called for an unowned path'); },
    });
    assert.deepEqual(syncOwned, []);
    assert.deepEqual(needsReview, []);
    assert.deepEqual(other.map((e) => e.path), ['README.md']);
  });
});

describe('createProvenanceVerifier', () => {
  it('no manifest at all → unverified (absence must never read as "must be fine")', () => {
    const verify = createProvenanceVerifier({ manifestFiles: null, hashOf: () => 'sha256:x' });
    assert.equal(verify({ path: 'a.mjs', origPath: null }), false);
  });

  it('manifest entry present and hash matches → verified', () => {
    const verify = createProvenanceVerifier({
      manifestFiles: { 'a.mjs': 'sha256:abc' },
      hashOf: () => 'sha256:abc',
    });
    assert.equal(verify({ path: 'a.mjs', origPath: null }), true);
  });

  it('manifest entry present but hash differs → unverified (content changed since the sync wrote it)', () => {
    const verify = createProvenanceVerifier({
      manifestFiles: { 'a.mjs': 'sha256:abc' },
      hashOf: () => 'sha256:different',
    });
    assert.equal(verify({ path: 'a.mjs', origPath: null }), false);
  });

  it('no manifest entry for this path → unverified, not "assume fine"', () => {
    const verify = createProvenanceVerifier({
      manifestFiles: { 'other.mjs': 'sha256:abc' },
      hashOf: () => 'sha256:abc',
    });
    assert.equal(verify({ path: 'a.mjs', origPath: null }), false);
  });

  it('a rename checks the ORIGIN path\'s recorded hash against the CURRENT path\'s content', () => {
    const verify = createProvenanceVerifier({
      manifestFiles: { 'old.mjs': 'sha256:abc' },
      hashOf: (p) => (p === 'new.mjs' ? 'sha256:abc' : 'sha256:wrong'),
    });
    assert.equal(verify({ path: 'new.mjs', origPath: 'old.mjs' }), true);
  });

  it('hashOf failing (deleted/unreadable file) is unverified, not a throw', () => {
    const verify = createProvenanceVerifier({
      manifestFiles: { 'a.mjs': 'sha256:abc' },
      hashOf: () => null,
    });
    assert.equal(verify({ path: 'a.mjs', origPath: null }), false);
  });
});

describe('pathspecsForCommit', () => {
  it('includes BOTH sides of a rename (/audit-code round 2 H2)', () => {
    const entries = [{ path: 'new.mjs', origPath: 'old.mjs' }];
    assert.deepEqual(new Set(pathspecsForCommit(entries)), new Set(['new.mjs', 'old.mjs']));
  });

  it('a plain entry contributes only its own path', () => {
    const entries = [{ path: 'a.mjs', origPath: null }];
    assert.deepEqual(pathspecsForCommit(entries), ['a.mjs']);
  });

  it('de-duplicates across entries', () => {
    const entries = [{ path: 'a.mjs', origPath: null }, { path: 'b.mjs', origPath: 'a.mjs' }];
    assert.deepEqual(new Set(pathspecsForCommit(entries)), new Set(['a.mjs', 'b.mjs']));
  });
});

/** Plain (non-rename) entries — most buildCommitSuggestion tests need only this. */
const entriesOf = (paths) => paths.map((path) => ({ path, origPath: null }));

describe('buildCommitSuggestion', () => {
  it('requires repoRoot — a suggested git command must be pinned to a repo', () => {
    assert.throws(() => buildCommitSuggestion(entriesOf(['a.mjs']), {}), /repoRoot/);
  });

  it('is deterministic regardless of input order', () => {
    const a = buildCommitSuggestion(entriesOf(['b.mjs', 'a.mjs']), { repoRoot: '/repo' });
    const b = buildCommitSuggestion(entriesOf(['a.mjs', 'b.mjs']), { repoRoot: '/repo' });
    assert.equal(a, b);
  });

  it('pins both commands to repoRoot via `git -C` (/audit-code H4/M4)', () => {
    const cmd = buildCommitSuggestion(entriesOf(['a.mjs']), { repoRoot: '/some/repo' });
    const gitDashC = /-C '\/some\/repo'/g;
    assert.equal((cmd.match(gitDashC) || []).length, 2, 'both add and commit must carry git -C');
  });

  it('disables pathspec magic (including glob wildcards) with --literal-pathspecs on both commands (/audit-code round 2 H3, refined by Gemini G2 to a portable CLI flag)', () => {
    const cmd = buildCommitSuggestion(entriesOf(['a.mjs']), { repoRoot: '/repo' });
    assert.equal((cmd.match(/--literal-pathspecs/g) || []).length, 2);
    // The env-var form is POSIX-only syntax — a syntax error pasted into
    // PowerShell or cmd.exe. Must not reappear.
    assert.doesNotMatch(cmd, /GIT_LITERAL_PATHSPECS/);
  });

  it('scopes the commit to the given paths, not a bare `git commit` (/audit-code H2/H5)', () => {
    const cmd = buildCommitSuggestion(entriesOf(['a.mjs', 'b.mjs']), { repoRoot: '/repo' });
    assert.match(cmd, /commit -m '[^']*' -- /);
  });

  it('terminates options with `--` and neutralises pathspec magic with `./` (/audit-code H3/M5)', () => {
    const cmd = buildCommitSuggestion(entriesOf(['-A']), { repoRoot: '/repo' });
    assert.match(cmd, /add -- '\.\/-A'/);
    assert.match(cmd, /commit -m '[^']*' -- '\.\/-A'/);
    // Never a bare, unprefixed `-A` reaching git as an operand.
    assert.doesNotMatch(cmd, /(?<!\/)'-A'/);
  });

  it('single-quotes a path carrying a space', () => {
    const cmd = buildCommitSuggestion(entriesOf(['docs/plan notes.md']), { repoRoot: '/repo' });
    assert.match(cmd, /'\.\/docs\/plan notes\.md'/);
  });

  it('escapes a message containing shell metacharacters instead of allowing command substitution (/audit-code M2)', () => {
    const cmd = buildCommitSuggestion(entriesOf(['a.mjs']), {
      repoRoot: '/repo', message: '$(touch pwned); `also pwned`; "quoted"',
    });
    // Single-quoted throughout: the whole message sits inside '...', so a
    // shell reading it verbatim never opens command substitution.
    assert.match(cmd, /-m '\$\(touch pwned\); `also pwned`; "quoted"'/);
  });

  it('escapes an embedded single quote in the message using the standard POSIX technique', () => {
    const cmd = buildCommitSuggestion(entriesOf(['a.mjs']), { repoRoot: '/repo', message: "it's fine" });
    assert.match(cmd, /-m 'it'"'"'s fine'/);
  });

  it('carries the git add + commit shape a human can paste verbatim', () => {
    const cmd = buildCommitSuggestion(entriesOf(['.sync-receipt.json']), { repoRoot: '/repo' });
    assert.match(cmd, /^git --literal-pathspecs -C '\/repo' add -- .*&& git --literal-pathspecs -C '\/repo' commit -m '[^']*' -- /);
  });

  it('a rename: `git add` targets ONLY the current path, never the origin (/audit-code round 2 H2 follow-up)', () => {
    // Found empirically: after `git mv`, the origin path is already fully
    // resolved in the index — `git add -- <origin>` fails outright with
    // "pathspec did not match any files", aborting the whole command before
    // the commit ever runs.
    const cmd = buildCommitSuggestion([{ path: 'new.mjs', origPath: 'old.mjs' }], { repoRoot: '/repo' });
    const [addPart, commitPart] = cmd.split('&&');
    assert.match(addPart, /add -- '\.\/new\.mjs'/);
    assert.doesNotMatch(addPart, /old\.mjs/);
    assert.match(commitPart, /'\.\/new\.mjs'/);
    assert.match(commitPart, /'\.\/old\.mjs'/);
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
