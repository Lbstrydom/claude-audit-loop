/**
 * @fileoverview Strict identifier validation for session/lock/quarantine paths.
 * Plan: docs/plans/brainstorm-quickfix-v1.md (audit-code R1 H2 + H3).
 *
 * Session IDs are interpolated into filesystem paths. Allowing arbitrary
 * strings would let `../`, `/`, `\`, or null bytes traverse out of the
 * intended `.brainstorm/sessions/` directory. The allowlist below is
 * intentionally narrow — alphanumerics, hyphen, dot, underscore — so the
 * generator's `crypto.randomBytes` hex output and `Date.now().toString(36)`
 * patterns both validate cleanly while no traversal sequence can pass.
 *
 * @module scripts/lib/brainstorm/id-validator
 */

const SID_RE = /^[a-zA-Z0-9._-]{1,64}$/;

/**
 * Throws if the given sid contains anything other than [a-zA-Z0-9._-]
 * or is outside 1..64 chars. Returns the sid on success for fluent use.
 *
 * @param {string} sid
 * @param {string} [label='sid'] - field name for the error message
 * @returns {string}
 */
export function validateSid(sid, label = 'sid') {
  if (typeof sid !== 'string' || sid.length === 0) {
    const err = new Error(`${label} required (non-empty string)`);
    err.code = 'INVALID_SID';
    throw err;
  }
  if (!SID_RE.test(sid)) {
    const err = new Error(`${label} must match ${SID_RE} — got ${JSON.stringify(sid).slice(0, 80)}`);
    err.code = 'INVALID_SID';
    throw err;
  }
  return sid;
}

/**
 * Returns true if the sid passes validation (does not throw).
 * Useful for callers that want to branch rather than catch.
 */
export function isValidSid(sid) {
  return typeof sid === 'string' && SID_RE.test(sid);
}

export const SID_PATTERN = SID_RE;
