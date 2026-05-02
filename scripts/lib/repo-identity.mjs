/**
 * @fileoverview Stable repository identity (R1 H6, R3 H6).
 *
 * Resolves a `repoUuid` that survives across clones, renames, and machines —
 * single source of truth used by every script, skill, workflow, and RPC.
 *
 * Algorithm:
 *   1. Read .audit-loop/repo-id (committed file) → use as repoUuid if present.
 *   2. Else compute UUIDv5 from canonicalised git origin URL ONLY (R3 H6 — top-level
 *      path excluded so two clones of the same remote get the same id).
 *   3. Bootstrap fallback (no remote): UUIDv5 from absolute repo path + stderr warning.
 *
 * The committed `.audit-loop/repo-id` lets forks (different origin) get a new id
 * by design.
 *
 * @module scripts/lib/repo-identity
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** Namespace UUID for architectural-memory. Constant; do not change. */
const ARCH_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'; // RFC4122 namespace UUID for URLs

const REPO_ID_FILE = '.audit-loop/repo-id';

/**
 * Compute UUIDv5 (SHA-1, name-based) from a namespace + name.
 * Implementation per RFC 4122 §4.3.
 *
 * @param {string} namespaceUuid - Hex UUID
 * @param {string} name
 * @returns {string} formatted UUID (lowercase, with hyphens)
 */
export function uuidv5(namespaceUuid, name) {
  const nsBytes = Buffer.from(namespaceUuid.replace(/-/g, ''), 'hex');
  const hash = crypto.createHash('sha1');
  hash.update(nsBytes);
  hash.update(name);
  const bytes = hash.digest();
  // Set version (5) and variant bits per RFC 4122
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Canonicalise a git remote URL so equivalent forms collapse to one string.
 *
 * Examples that all canonicalise to `github.com/owner/repo`:
 *   git@github.com:owner/repo.git
 *   https://github.com/owner/repo.git
 *   https://user@github.com/owner/repo
 *
 * @param {string} remoteUrl
 * @returns {string|null}
 */
export function canonicaliseRemoteUrl(remoteUrl) {
  if (!remoteUrl) return null;
  let s = String(remoteUrl).trim();
  // Strip trailing .git
  s = s.replace(/\.git\/?$/, '');
  // SSH form: git@host:owner/repo
  const sshMatch = s.match(/^[\w.-]+@([\w.-]+):(.+)$/);
  if (sshMatch) {
    return `${sshMatch[1].toLowerCase()}/${sshMatch[2]}`;
  }
  // HTTP(S) form
  try {
    const url = new URL(s);
    return `${url.host.toLowerCase()}${url.pathname}`.replace(/\/+$/, '');
  } catch {
    return s.toLowerCase();
  }
}

function gitOriginUrl(cwd) {
  try {
    return execSync('git config --get remote.origin.url', {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim() || null;
  } catch {
    return null;
  }
}

function gitTopLevel(cwd) {
  try {
    return execSync('git rev-parse --show-toplevel', {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim() || null;
  } catch {
    return null;
  }
}

/**
 * Derive `name` from a canonical remote (`owner/repo`) or the directory basename.
 * @param {string|null} canonicalRemote
 * @param {string} cwd
 * @returns {string}
 */
function deriveName(canonicalRemote, cwd) {
  if (canonicalRemote) {
    // Take last two path segments (e.g. "github.com/owner/repo" → "owner/repo")
    const parts = canonicalRemote.split('/').filter(Boolean);
    if (parts.length >= 2) return parts.slice(-2).join('/');
    if (parts.length === 1) return parts[0];
  }
  return path.basename(cwd);
}

/**
 * @param {string} [cwd] - Defaults to process.cwd()
 * @returns {{repoUuid: string, name: string, remoteUrl: string|null, source: 'committed-file'|'origin-url'|'path-fallback'}}
 */
export function resolveRepoIdentity(cwd = process.cwd()) {
  const repoRoot = gitTopLevel(cwd) || cwd;
  const repoIdPath = path.join(repoRoot, REPO_ID_FILE);

  // 1. Committed file
  if (fs.existsSync(repoIdPath)) {
    const repoUuid = fs.readFileSync(repoIdPath, 'utf-8').trim();
    if (repoUuid) {
      const remoteUrl = gitOriginUrl(repoRoot);
      const canon = canonicaliseRemoteUrl(remoteUrl);
      return {
        repoUuid,
        name: deriveName(canon, repoRoot),
        remoteUrl,
        source: 'committed-file',
      };
    }
  }

  // 2. Compute from canonical origin URL
  const remoteUrl = gitOriginUrl(repoRoot);
  const canon = canonicaliseRemoteUrl(remoteUrl);
  if (canon) {
    const repoUuid = uuidv5(ARCH_NAMESPACE, canon);
    const name = deriveName(canon, repoRoot);
    return { repoUuid, name, remoteUrl, source: 'origin-url' };
  }

  // 3. Fallback: absolute repo path + warning
  process.stderr.write(
    `  [repo-identity] WARNING: no git origin configured for ${repoRoot} — ` +
    `falling back to path-based id (will not survive moving the repo).\n`
  );
  const repoUuid = uuidv5(ARCH_NAMESPACE, path.resolve(repoRoot).toLowerCase());
  return {
    repoUuid,
    name: path.basename(repoRoot),
    remoteUrl: null,
    source: 'path-fallback',
  };
}

/**
 * Persist the resolved repoUuid to `.audit-loop/repo-id` so subsequent
 * resolutions are stable even if origin URL changes.
 *
 * @param {string} repoUuid
 * @param {string} [cwd]
 */
export function persistRepoIdentity(repoUuid, cwd = process.cwd()) {
  const repoRoot = gitTopLevel(cwd) || cwd;
  const dir = path.join(repoRoot, path.dirname(REPO_ID_FILE));
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(repoRoot, REPO_ID_FILE);
  if (!fs.existsSync(target)) {
    fs.writeFileSync(target, repoUuid + '\n');
  }
}
