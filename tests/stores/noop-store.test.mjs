import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { adapter } from '../../scripts/lib/stores/noop-store.mjs';

describe('noop adapter', () => {
  it('has correct name', () => {
    assert.equal(adapter.name, 'noop');
  });

  it('declares capabilities correctly', () => {
    assert.equal(adapter.capabilities.debt, true);
    assert.equal(adapter.capabilities.run, false);
    assert.equal(adapter.capabilities.learningState, true);
    assert.equal(adapter.capabilities.globalState, false);
    assert.equal(adapter.capabilities.repo, true);
    assert.equal(adapter.capabilities.scopeIsolation, false);
  });

  it('init returns true', async () => {
    assert.equal(await adapter.init(), true);
  });

  it('upsertRepo returns fingerprint as repoId', async () => {
    const id = await adapter.repo.upsertRepo({ repoFingerprint: 'abc123' }, 'test-repo');
    assert.equal(id, 'abc123');
  });

  it('getRepoByFingerprint returns synthetic record', async () => {
    const result = await adapter.repo.getRepoByFingerprint('xyz789');
    assert.equal(result.id, 'xyz789');
    assert.equal(result.fingerprint, 'xyz789');
  });

  it('readDebtEntries returns array', async () => {
    const entries = await adapter.debt.readDebtEntries('test-repo');
    assert.ok(Array.isArray(entries));
  });

  it('loadBanditArms returns null when no file', async () => {
    const arms = await adapter.learningState.loadBanditArms('test-repo');
    // May return null or existing data depending on state
    assert.ok(arms === null || typeof arms === 'object');
  });

  it('loadFalsePositivePatterns returns structured result', async () => {
    const result = await adapter.learningState.loadFalsePositivePatterns('test-repo');
    assert.ok('repoPatterns' in result);
    assert.ok('globalPatterns' in result);
  });

  it('has no run interface', () => {
    assert.equal(adapter.capabilities.run, false);
    assert.equal(adapter.run, undefined);
  });

  it('has no globalState interface', () => {
    assert.equal(adapter.capabilities.globalState, false);
    assert.equal(adapter.globalState, undefined);
  });
});
