/**
 * @fileoverview One oracle for "am I standing in the MAIN checkout or a linked
 * worktree?".
 *
 * **It does not derive the main root itself** — `resolveMainRoot`
 * (`lib/pinned-worktree/paths.mjs`) is the canonical answer to that question and
 * this imports it, which is what `tests/prepush-worktree-anchor.test.mjs`
 * enforces. What is added here is the COMPARISON: the main root against the
 * working tree's own top level. In the main checkout they are the same
 * directory; in a linked worktree they differ, and that difference is the whole
 * classification.
 *
 * **`unknown` is a third state, not a synonym for `main`.** Git may fail to
 * answer at all — not a repo, no git on PATH — and reporting that as a main
 * checkout would be a claim nothing established. Callers decide: the one that
 * refuses on `linked` deliberately does NOT refuse on `unknown`, because there
 * is no proof of a linked worktree to act on.
 *
 * **The probe's stderr is suppressed on purpose.** "Not a git repository" is an
 * EXPECTED input here, not an error to report; a probe that prints `fatal:` on
 * its normal negative path corrupts the stdout of any caller emitting JSON —
 * measured 2026-09-07, where it broke two gate-8 tests that parse the verifier's
 * output.
 *
 * @module scripts/lib/checkout-kind
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { resolveMainRoot } from './pinned-worktree/paths.mjs';

/**
 * PURE — both directories arrive as arguments.
 *
 * `path.resolve` normalises separators and drops any trailing one, so the two
 * answers are directly comparable on Windows and POSIX alike.
 *
 * @param {{worktreeRoot: string|null, mainRoot: string|null}} facts
 * @returns {{kind: 'main'|'linked'|'unknown', reason: string}}
 */
export function classifyCheckout({ worktreeRoot, mainRoot }) {
  if (!worktreeRoot || !mainRoot) {
    return { kind: 'unknown', reason: 'git could not resolve this working tree' };
  }
  const here = path.resolve(worktreeRoot);
  const main = path.resolve(mainRoot);
  return here === main
    ? { kind: 'main', reason: 'the working tree IS the main checkout' }
    : { kind: 'linked', reason: `working tree ${here} is not the main checkout ${main}` };
}

/** The working tree's own top level, or null. Never throws, never prints. */
function gitTopLevel(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--path-format=absolute', '--show-toplevel'], {
      cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch { return null; }
}

/**
 * Ask git the two facts `classifyCheckout` decides on. Never throws.
 *
 * The top-level probe runs FIRST so `resolveMainRoot` — which does not suppress
 * its own stderr — is only ever called somewhere it will succeed.
 *
 * @param {string} cwd
 * @returns {{kind: 'main'|'linked'|'unknown', reason: string}}
 */
export function detectCheckout(cwd) {
  const worktreeRoot = gitTopLevel(cwd);
  if (!worktreeRoot) return classifyCheckout({ worktreeRoot: null, mainRoot: null });
  try {
    return classifyCheckout({ worktreeRoot, mainRoot: resolveMainRoot(cwd) });
  } catch {
    return classifyCheckout({ worktreeRoot, mainRoot: null });
  }
}
