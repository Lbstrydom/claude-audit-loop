/**
 * @fileoverview One reader for "this setting has a canonical env var and a
 * deprecated alias".
 *
 * Extracted from `db/client.mjs`'s private `warnAliasOnce` when the final-review
 * role acquired the same need, rather than writing a second copy — a duplicate
 * "does this look like an alias" helper is the shape this repo has been bitten
 * by before (two spellings, and nothing that can compare them).
 *
 * The contract that matters is the PRECEDENCE, not the warning: the canonical
 * name always wins when both are set, and the alias warns only when it actually
 * contributed a value. A warning that fires when the alias was set but unused
 * trains people to ignore it.
 *
 * @module scripts/lib/env-alias
 */

// At most one warning per alias per process — an alias read in a loop must not
// produce a wall of identical stderr that buries the one line above it.
const _aliasWarned = new Set();

/** For tests — reset the alias-warning latch. */
export function _resetAliasWarnings() {
  _aliasWarned.clear();
}

/**
 * Emit the deprecation notice for `alias` at most once per process.
 * @param {string} alias
 * @param {string} canonical
 * @param {string} subsystem - short tag for the log prefix, e.g. 'db'
 * @param {(msg: string) => void} [write] - injectable for tests
 */
export function warnAliasOnce(alias, canonical, subsystem, write = (m) => process.stderr.write(m)) {
  if (_aliasWarned.has(alias)) return;
  _aliasWarned.add(alias);
  write(
    `  [${subsystem}] ${alias} is a deprecated alias for ${canonical} — using it. `
    + `Rename to ${canonical} to silence this notice.\n`,
  );
}

/**
 * Read a setting that accepts a canonical name and one deprecated alias.
 *
 * Empty-string is treated as ABSENT for both, matching `resolveDbUrl`: a
 * GitHub Actions `env:` entry for a missing secret expands to empty-but-set, so
 * an empty canonical must fall through to the alias rather than winning as ''.
 *
 * @param {{canonical: string, alias: string, subsystem: string,
 *   env?: object, write?: (msg: string) => void}} args
 * @returns {string|undefined} the trimmed value, or undefined when neither is set
 */
export function readEnvWithAlias({ canonical, alias, subsystem, env = process.env, write }) {
  const canonicalValue = (env[canonical] || '').trim();
  const aliasValue = (env[alias] || '').trim();
  if (canonicalValue) return canonicalValue;
  if (aliasValue) {
    warnAliasOnce(alias, canonical, subsystem, write);
    return aliasValue;
  }
  return undefined;
}
