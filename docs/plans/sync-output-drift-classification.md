# Sync output drift classification

**Status**: Complete — `/audit-code` converged 2026-09-10 (6 rounds, PASS at round 6; 3 real bugs found and fixed across ownership-vs-provenance verification and rename/copy commit safety), Gemini final review APPROVE (2 LOW findings, both fixed).

## Problem

`sync-to-repos.mjs` writes straight into a consumer's working tree
(`.claude/skills/**`, `.sync-receipt.json`, `scripts/.sync-owned.json`) and
deliberately never commits there (see `lib/sync-receipt.mjs`'s header: the
tree is the human's, and a commit would fire their hooks and bundle whatever
else they had staged). Left at that, the sync's own output sits as ordinary
uncommitted changes — byte-identical in `git status` to a person's own
unfinished edits. This caused real confusion in `louis-strydom_wartsila/storyline`:
a batch of `.claude/skills/**` + `.sync-receipt.json` drift sat uncommitted
until someone opened the gitignored `scripts/.sync-manifest.json` and diffed
each file by hand to decide what was safe to commit.

## Design

Two changes, chosen over auto-committing (rejected: see `lib/sync-receipt.mjs`'s
header — the sync must not assume commit authority over a consumer's tree):

1. **`scripts/sync-status.mjs`** (new consumer-side CLI) + **`scripts/lib/sync-status.mjs`**
   (pure logic) — reads `git status --porcelain=v1 -z --untracked-files=all`,
   classifies every dirty path as sync-owned vs. the repo's own edits using the
   already-committed `scripts/.sync-owned.json` sidecar + git-ignore state (the
   same ownership oracle `lib/upstream-ownership.mjs::createUpstreamOwnershipOracle`
   already provides for `debt-review.mjs`), and prints a ready-to-paste
   `git add … && git commit -m "…"` for the sync-owned group. `--format json`
   for scripting. Ships to every consumer via `CORE_ENTRY`.
2. **`sync-to-repos.mjs`** — every run now prints the same "safe to commit"
   line at the end of each consumer's block, naming exactly the paths that run
   wrote (`receiptCreated`/`receiptUpdated` + the receipt/sidecar when written),
   so the answer is available immediately without a separate step. The
   formatting logic lives in `lib/sync-status.mjs::describeSafeToCommit` rather
   than inline, to avoid growing `sync-to-repos.mjs` past
   `file-size-ratchet.mjs`'s governed-file tolerance (that file is already
   over the 1000-line limit and named in the ratchet's own header as a repeat
   offender for unmanaged growth).

Neither path stages or commits anything automatically. `docs/runbooks/consumer-adoption.md`
documents the new CLI under "Sync internals".

## /audit-code findings (6 rounds) — three real bugs, fixed and regression-tested

Ownership (sidecar/git-ignore membership) is not provenance (did the sync
write THESE bytes). `classifyDirtyEntries` only trusts a path once
`createProvenanceVerifier` confirms its on-disk content hash matches what
`scripts/.sync-manifest.json` recorded the last sync writing there
(`.sync-receipt.json` / `scripts/.sync-owned.json` get the same treatment —
`sync-to-repos.mjs` now patches their hashes into the manifest via
`patchManifestWithExtraHashes`, since their final bytes are only known after
the manifest's own write). Three git-state edge cases around renames/copies
that could still slip unverified or unrelated content into the suggested
commit were found and fixed, each with a passing regression test built from
an empirically-verified `git status` fixture:

1. A path with staged content that diverges from the working tree (`MM`) is
   demoted to `needsReview` — `hasUnambiguousIndexState` — since the scoped
   commit uses working-tree bytes and would silently discard the staged
   version.
2. A rename's origin is included in the commit's pathspecs (capturing its
   deletion) but never in `git add`'s (which fails outright on an
   already-resolved origin after `git mv`) — and a COPY's origin, being a
   live, separately-classified file, is never treated as a rename origin at
   all (`isRenameStatus`).
3. A rename whose origin path is REOCCUPIED — by a same-named file OR by a
   directory — in the same `git status` snapshot demotes the whole rename to
   `needsReview`, because `git add`/`commit` on that origin pathspec would
   otherwise recursively sweep the reoccupying content into the commit under
   a false "verified" claim (found via a GPT rebuttal deliberation that
   correctly refuted my initial claim the scenario was impossible).

Gemini's mandatory final review (APPROVE) added two LOW mechanical fixes:
normalising `patchManifestWithExtraHashes`'s manifest keys to forward slashes,
and replacing the POSIX-only `GIT_LITERAL_PATHSPECS=1` env-var prefix with
git's portable `--literal-pathspecs` flag (works unchanged in PowerShell/cmd.exe).

## Acceptance criteria

- [x] `node scripts/sync-status.mjs --selfcheck-relocation` prints `OK` and exits 0.
- [x] Against a consumer repo carrying a real `scripts/.sync-owned.json`, running
      `sync-status.mjs` after a sync partitions every dirty path into
      sync-owned vs. other, with no false claims of ownership (verified
      end-to-end against a throwaway git repo: a full sync classified 223
      sync-owned files against 2 genuine local edits — `.gitignore`,
      `.gitattributes`).
- [x] A rename/copy `git status` record is classified by either its old or new
      path — and only trusted when the origin isn't independently reoccupied
      (see the findings above).
- [x] `.sync-receipt.json` and `scripts/.sync-owned.json` are verified against
      real recorded hashes, not trusted unconditionally by path membership.
- [x] `sync-to-repos.mjs`'s own line-count did not grow past
      `file-size-ratchet.mjs`'s tolerance.
- [x] All existing sync-related gates stay green: `check-cli-flags`,
      `check-stdout-flush`, `sync-inventory-parity`, `relocation-guard`,
      `dashboard-cli`, `generate-bundle-deps --check`.
- [x] New CLI entry is registered everywhere a `CORE_ENTRY` addition requires:
      `sync-to-repos.mjs` CORE_ENTRY, `sync-inventory.mjs` mirror,
      `sync-isolation-verify.mjs` CLI_SMOKE_SET, `.cli-catalog.json`,
      `package.json` (`sync:status`).

## Files touched

- `scripts/sync-status.mjs` (new)
- `scripts/lib/sync-status.mjs` (new)
- `tests/sync-status.test.mjs` (new)
- `scripts/sync-to-repos.mjs`
- `scripts/lib/sync-manifest.mjs`
- `scripts/lib/sync-inventory.mjs`
- `scripts/lib/sync-isolation-verify.mjs`
- `scripts/.cli-catalog.json`
- `package.json`
- `docs/runbooks/consumer-adoption.md`
