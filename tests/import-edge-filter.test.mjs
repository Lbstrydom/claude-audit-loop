import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isInternalEdge } from '../scripts/symbol-index/extract.mjs';

describe('isInternalEdge (Gemini-R2-G1: metadata-driven, not just string)', () => {
  it('returns false for falsy input', () => {
    assert.equal(isInternalEdge(null), false);
    assert.equal(isInternalEdge(undefined), false);
    assert.equal(isInternalEdge({}), false);
    assert.equal(isInternalEdge({ resolved: null }), false);
  });

  it('respects dep-cruiser coreModule flag (catches fs/promises etc — Gemini-R2-G1)', () => {
    assert.equal(
      isInternalEdge({ resolved: 'fs/promises', coreModule: true, dependencyTypes: ['core'] }),
      false,
      'core module with slash must be filtered (string-only filter would miss this)',
    );
    assert.equal(
      isInternalEdge({ resolved: 'util/types', coreModule: true, dependencyTypes: ['core'] }),
      false,
    );
    assert.equal(
      isInternalEdge({ resolved: 'stream/web', coreModule: true, dependencyTypes: ['core'] }),
      false,
    );
  });

  it('respects dependencyTypes "core" without coreModule flag', () => {
    assert.equal(
      isInternalEdge({ resolved: 'path', dependencyTypes: ['core'] }),
      false,
    );
  });

  it('respects npm dependency types', () => {
    for (const type of ['npm', 'npm-dev', 'npm-optional', 'npm-peer', 'npm-bundled']) {
      assert.equal(
        isInternalEdge({ resolved: 'node_modules/express/index.js', dependencyTypes: [type] }),
        false,
        `${type} should be filtered`,
      );
    }
  });

  it('node_modules path filter (defence-in-depth, both POSIX and Windows)', () => {
    assert.equal(
      isInternalEdge({ resolved: 'node_modules/express/index.js' }),
      false,
    );
    assert.equal(
      isInternalEdge({ resolved: 'foo/node_modules/express/index.js' }),
      false,
    );
    assert.equal(
      isInternalEdge({ resolved: 'node_modules\\express\\index.js' }),
      false,
      'Windows backslash path',
    );
  });

  it('node: scheme prefix filter', () => {
    assert.equal(isInternalEdge({ resolved: 'node:fs' }), false);
    assert.equal(isInternalEdge({ resolved: 'node:fs/promises' }), false);
  });

  it('returns true for internal repo paths', () => {
    assert.equal(
      isInternalEdge({ resolved: 'scripts/lib/findings.mjs', dependencyTypes: ['local'] }),
      true,
    );
    assert.equal(
      isInternalEdge({ resolved: 'src/wine-shop/index.js' }),
      true,
    );
    assert.equal(
      isInternalEdge({ resolved: 'tests/foo.test.mjs', dependencyTypes: ['local'] }),
      true,
    );
  });

  it('returns true even with no dependencyTypes when path is internal', () => {
    assert.equal(
      isInternalEdge({ resolved: 'scripts/lib/foo.mjs' }),
      true,
    );
  });
});
