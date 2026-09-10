/**
 * @fileoverview Pure helpers for `sync-status.mjs` — separating a consumer's
 * dirty working tree into "written by the claude-engineering-skills sync" vs
 * "this repo's own edits".
 *
 * ## The defect this closes
 *
 * A sync writes `.claude/skills/**`, `.sync-receipt.json` and
 * `scripts/.sync-owned.json` straight into a consumer's working tree and never
 * commits them (see `sync-receipt.mjs`'s header for why self-committing was
 * rejected: the tree is the human's, and a commit would fire their hooks and
 * bundle unrelated staged work). The result sat as ordinary uncommitted
 * changes in `storyline` — byte-identical in `git status` to a person's own
 * unfinished edits — and had to be triaged by hand: open
 * `scripts/.sync-manifest.json` (gitignored, easy to forget exists), diff each
 * file, decide what's safe to commit.
 *
 * `scripts/.sync-owned.json` already exists as a COMMITTED, deterministic
 * answer to "is this path upstream's?" (see `sync-owned-sidecar.mjs`), and
 * `lib/upstream-ownership.mjs`'s `createUpstreamOwnershipOracle` already unions
 * it with git-ignore state as the single ownership oracle (`debt-review.mjs`
 * uses it the same way). This module is the missing last step: point that
 * oracle at `git status`'s own output instead of a curated candidate list, so
 * the classification a human used to do by hand runs automatically.
 *
 * @module scripts/lib/sync-status
 */

import { RECEIPT_PATH } from './sync-receipt.mjs';
import { OWNED_SIDECAR_RELATIVE_PATH, comparisonKey } from './sync-owned-sidecar.mjs';
import { SYNC_BOOKKEEPING_DESTS } from './sync-divergence.mjs';

/**
 * Sync-produced paths that `createUpstreamOwnershipOracle` cannot see, because
 * neither of its two sources describes them: the receipt and the sidecar are
 * the RECORD of what a sync did, not payload the sync copied from upstream, so
 * they never appear in the sidecar's own `paths` list, and both are committed
 * (never gitignored) by design. Listed once here, from the modules that own
 * each path string, so this can never drift into a second hand-typed spelling.
 */
export const EXTRA_SYNC_ARTIFACTS = Object.freeze(new Set(
  [RECEIPT_PATH, OWNED_SIDECAR_RELATIVE_PATH, ...SYNC_BOOKKEEPING_DESTS]
    .map((p) => comparisonKey(p)),
));

/**
 * Parse `git status --porcelain=v1 -z` output into structured entries.
 *
 * `-z` is load-bearing, not a style choice: without it, a path containing a
 * space or a quote is unparseable from plain porcelain output with any
 * delimiter-based split. Each record is NUL-terminated; a rename/copy record
 * (X or Y is `R`/`C`) is followed by a SECOND NUL-terminated token carrying the
 * original path — both must be examined, because ownership is a question about
 * bytes on disk, and a rename's original path is often the one the sidecar
 * actually lists.
 *
 * PURE — accepts the raw stdout string, never shells out itself.
 *
 * @param {string} output
 * @returns {Array<{status: string, path: string, origPath: string|null}>}
 */
export function parsePorcelainZ(output) {
  const tokens = String(output ?? '').split('\0').filter((t) => t.length > 0);
  const entries = [];
  let i = 0;
  while (i < tokens.length) {
    const record = tokens[i++];
    // `XY<space>PATH` — the two status columns, a space, then the path.
    const status = record.slice(0, 2);
    const entryPath = record.slice(3);
    const isRenameOrCopy = status[0] === 'R' || status[0] === 'C'
      || status[1] === 'R' || status[1] === 'C';
    let origPath = null;
    if (isRenameOrCopy && i < tokens.length) {
      origPath = tokens[i++];
    }
    if (entryPath.length > 0) entries.push({ status, path: entryPath, origPath });
  }
  return entries;
}

/**
 * Split `git status` entries into sync-owned vs everything else.
 *
 * A rename is classified by EITHER of its two paths — if the file the sync
 * last wrote was renamed, the old path is still the evidence, and the new one
 * is what a commit needs to stage.
 *
 * PURE. `isUpstreamOwned` is injected (from `createUpstreamOwnershipOracle`)
 * so this stays testable without a git fixture or a real sidecar file.
 *
 * @param {{entries: Array<{path: string, origPath: string|null}>, isUpstreamOwned: (rel: string) => boolean}} input
 * @returns {{syncOwned: string[], other: string[]}}
 */
export function classifyDirtyEntries({ entries, isUpstreamOwned }) {
  const syncOwned = new Set();
  const other = new Set();
  for (const entry of entries ?? []) {
    const candidates = entry.origPath ? [entry.path, entry.origPath] : [entry.path];
    const owned = candidates.some(
      (p) => EXTRA_SYNC_ARTIFACTS.has(comparisonKey(p)) || isUpstreamOwned(p),
    );
    (owned ? syncOwned : other).add(entry.path);
  }
  return { syncOwned: [...syncOwned].sort(), other: [...other].sort() };
}

/**
 * A single POSIX-shell-safe token for a path — double-quoted whenever it
 * carries a space, a quote, or a shell metacharacter a bare path could not
 * survive unescaped. This is advisory copy-paste text, not something this CLI
 * executes, so the bar is "safe to paste into a shell", not exhaustive escaping.
 *
 * @param {string} p
 * @returns {string}
 */
function shellQuote(p) {
  return /[^A-Za-z0-9_./-]/.test(p) ? `"${p.replace(/(["\\$`])/g, '\\$1')}"` : p;
}

/**
 * Render the copy-paste `git add … && git commit -m '…'` suggestion for a set
 * of sync-owned paths. PURE.
 *
 * @param {string[]} paths
 * @param {{message?: string}} [opts]
 * @returns {string}
 */
export function buildCommitSuggestion(paths, { message = 'chore(sync): update audit-loop tooling' } = {}) {
  const files = [...paths].sort().map(shellQuote).join(' ');
  return `git add ${files} && git commit -m "${message}"`;
}

/**
 * Render sync-to-repos.mjs's end-of-run "safe to commit" line, or `null` when
 * there's nothing to report. Kept here rather than inline in the caller: that
 * file is already over file-size-ratchet.mjs's governed-file limit, and its
 * own header names `sync-to-repos.mjs` as a repeat offender for exactly this
 * kind of unmanaged growth.
 *
 * @param {{created: string[], updated: string[], sidecarWritten: boolean, statusCliRel: string}} input
 * @param {{G?: string, D?: string, X?: string}} [colors] — ANSI codes, caller's own
 * @returns {string|null}
 */
export function describeSafeToCommit(
  { created, updated, sidecarWritten, statusCliRel },
  { G = '', D = '', X = '' } = {},
) {
  const paths = [...new Set([
    ...created, ...updated,
    ...(sidecarWritten ? [OWNED_SIDECAR_RELATIVE_PATH, RECEIPT_PATH] : []),
  ])].sort();
  if (paths.length === 0) return null;
  return `  ${G}safe to commit${X} ${D}(written by this sync — \`node ${statusCliRel}\` re-derives this list any time):${X}\n    ${buildCommitSuggestion(paths)}`;
}
