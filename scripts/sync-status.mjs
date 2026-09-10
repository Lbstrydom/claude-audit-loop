#!/usr/bin/env node
/**
 * @fileoverview `sync-status` — separates a consumer's dirty working tree into
 * "written by the claude-engineering-skills sync" vs "this repo's own edits".
 *
 * A sync writes straight into the consumer's working tree and never commits
 * (see `lib/sync-receipt.mjs`'s header for why self-committing was rejected).
 * That output — `.claude/skills/**`, `.sync-receipt.json`,
 * `scripts/.sync-owned.json` — then sits as ordinary uncommitted changes,
 * indistinguishable in plain `git status` from a person's own unfinished
 * edits. This CLI runs the same cross-reference a human had to do by hand
 * (open `scripts/.sync-manifest.json`, diff each file) using the ALREADY
 * shipped `scripts/.sync-owned.json` sidecar + git-ignore state, via the one
 * ownership oracle `debt-review.mjs` already trusts
 * (`lib/upstream-ownership.mjs`'s `createUpstreamOwnershipOracle`).
 *
 * REPORT-ONLY. Never stages or commits anything itself — see the "self-commit
 * rejected" rationale above; this tool exists so a human (or a pre-commit
 * hook) doesn't have to reverse-engineer the same answer by hand.
 *
 * Usage:
 *   node scripts/sync-status.mjs                  # human-readable report
 *   node scripts/sync-status.mjs --format json
 *   node scripts/sync-status.mjs --repo-root <dir>
 *
 * Exit codes:
 *   0  ran (report-only; a dirty tree, even an entirely unowned one, is not a failure)
 *   1  `git status` could not be read
 *   2  bad CLI input
 *
 * @module scripts/sync-status
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertKnownFlags, ArgvError, finishAndExit } from './lib/cli-io.mjs';
import { createUpstreamOwnershipOracle } from './lib/upstream-ownership.mjs';
import {
  parsePorcelainZ, classifyDirtyEntries, buildCommitSuggestion,
} from './lib/sync-status.mjs';

const KNOWN_FLAGS = ['--format', '--repo-root', '--selfcheck-relocation'];
const G = '\x1b[32m', Y = '\x1b[33m', D = '\x1b[2m', X = '\x1b[0m', B = '\x1b[1m';

// Relocation smoke: proves this file's imports survive being synced into a
// consumer's `scripts/.claude-skills/`. Answered before anything else, and
// before `assertKnownFlags` — a probe that itself required valid flags could
// never prove the file loads at all.
if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }

/**
 * @param {string[]} argv
 * @param {NodeJS.WriteStream} out
 * @param {NodeJS.WriteStream} err
 * @returns {number} exit code
 */
export function main(argv = process.argv, out = process.stdout, err = process.stderr) {
  assertKnownFlags(argv, KNOWN_FLAGS, { cli: 'sync-status' });

  const rest = argv.slice(2);
  const flagValue = (name) => {
    const i = rest.indexOf(name);
    return i === -1 ? null : rest[i + 1];
  };
  const asJson = flagValue('--format') === 'json';
  const repoRoot = path.resolve(flagValue('--repo-root') ?? process.cwd());

  // `--untracked-files=all`, not the default `normal`: an entirely-untracked
  // directory collapses to one `dirname/` record under `normal`, which cannot
  // be classified against the sidecar's per-FILE path list — every file inside
  // reads as "not attributed" on a first sync, which is exactly the run where
  // the most sync-owned content exists. `all` lists each file individually.
  const status = spawnSync(
    'git',
    ['-C', repoRoot, 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
    { encoding: 'utf-8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
  );
  if (status.error || typeof status.status !== 'number' || status.status !== 0) {
    err.write(
      `sync-status: \`git status\` failed in ${repoRoot}: `
      + `${status.error?.message || status.stderr || `exit ${status.status}`}\n`,
    );
    return 1;
  }

  const entries = parsePorcelainZ(status.stdout);
  if (entries.length === 0) {
    if (asJson) {
      out.write(`${JSON.stringify({ repoRoot, syncOwned: [], other: [], clean: true }, null, 2)}\n`);
    } else {
      out.write(`${G}Working tree is clean${X} — nothing to classify.\n`);
    }
    return 0;
  }

  const candidates = entries.flatMap((e) => (e.origPath ? [e.path, e.origPath] : [e.path]));
  const oracle = createUpstreamOwnershipOracle(repoRoot, candidates);
  const { syncOwned, other } = classifyDirtyEntries({ entries, isUpstreamOwned: oracle.isUpstreamOwned });

  if (asJson) {
    out.write(`${JSON.stringify({
      repoRoot, syncOwned, other,
      degraded: oracle.degraded, partial: oracle.partial, blindTo: oracle.blindTo,
    }, null, 2)}\n`);
    return 0;
  }

  out.write(`${B}Sync status${X}  ${D}${repoRoot}${X}\n\n`);

  if (oracle.degraded) {
    out.write(
      `  ${Y}⚠ no scripts/.sync-owned.json and no readable git-ignore state${X} — cannot tell `
      + `sync output from this repo's own edits. Run a sync from the upstream repo first.\n\n`,
    );
  } else if (oracle.partial) {
    out.write(`  ${Y}⚠ partial classification${X} ${D}(not examined: ${oracle.blindTo.join(', ')})${X}\n\n`);
  }

  if (syncOwned.length > 0) {
    out.write(`  ${G}Sync-owned${X} (${syncOwned.length}) — written by the last sync, safe to commit as-is:\n`);
    for (const p of syncOwned) out.write(`    ${D}${p}${X}\n`);
    out.write(`\n  ${buildCommitSuggestion(syncOwned)}\n\n`);
  }

  if (other.length > 0) {
    out.write(`  ${B}Not attributed to the sync${X} (${other.length}):\n`);
    for (const p of other) out.write(`    ${p}\n`);
    out.write('\n');
  }

  if (syncOwned.length === 0 && other.length === 0) {
    out.write(`  ${D}nothing to report${X}\n`);
  }

  return 0;
}

// Compare the RESOLVED file, not a path suffix — a suffix match is true in
// this repo and false at the consumer path `scripts/.claude-skills/sync-status.mjs`
// (the exact class workflow-cadence-doctor.mjs's own guard comment records).
const isDirectRun = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  try {
    await finishAndExit(main());
  } catch (e) {
    if (e instanceof ArgvError || e?.code === 'ARGV_ERROR') {
      process.stderr.write(`${e.message}\n`);
      await finishAndExit(2);
    } else {
      throw e;
    }
  }
}
