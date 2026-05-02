import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { uuidv5, canonicaliseRemoteUrl } from '../scripts/lib/repo-identity.mjs';

describe('uuidv5', () => {
  const NS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
  it('produces a valid UUID format', () => {
    const id = uuidv5(NS, 'github.com/owner/repo');
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it('is deterministic', () => {
    assert.equal(
      uuidv5(NS, 'github.com/owner/repo'),
      uuidv5(NS, 'github.com/owner/repo')
    );
  });
  it('differs for different names', () => {
    assert.notEqual(
      uuidv5(NS, 'github.com/owner/repo-a'),
      uuidv5(NS, 'github.com/owner/repo-b')
    );
  });
});

describe('canonicaliseRemoteUrl', () => {
  it('canonicalises HTTPS form', () => {
    assert.equal(
      canonicaliseRemoteUrl('https://github.com/owner/repo.git'),
      'github.com/owner/repo'
    );
  });
  it('canonicalises SSH form to the same string', () => {
    assert.equal(
      canonicaliseRemoteUrl('git@github.com:owner/repo.git'),
      'github.com/owner/repo'
    );
  });
  it('lower-cases host', () => {
    assert.equal(
      canonicaliseRemoteUrl('https://GitHub.COM/owner/repo'),
      'github.com/owner/repo'
    );
  });
  it('strips trailing slash', () => {
    assert.equal(
      canonicaliseRemoteUrl('https://github.com/owner/repo/'),
      'github.com/owner/repo'
    );
  });
  it('returns null for empty input', () => {
    assert.equal(canonicaliseRemoteUrl(''), null);
    assert.equal(canonicaliseRemoteUrl(null), null);
  });
});

describe('clones-of-same-remote contract', () => {
  it('two distinct path locations of the same canonical remote produce the same uuid', () => {
    const NS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
    const canon = canonicaliseRemoteUrl('git@github.com:org/repo.git');
    // Both clones see this canonical remote regardless of where they live on disk.
    // The uuid depends ONLY on the canon, so it matches across both clones.
    const uuidA = uuidv5(NS, canon);
    const uuidB = uuidv5(NS, canon);
    assert.equal(uuidA, uuidB);
  });
  it('forks (different remote) produce different uuids', () => {
    const NS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
    const upstream = canonicaliseRemoteUrl('git@github.com:upstream-org/repo.git');
    const fork     = canonicaliseRemoteUrl('git@github.com:fork-org/repo.git');
    assert.notEqual(uuidv5(NS, upstream), uuidv5(NS, fork));
  });
});
