import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveReferencedPath,
  extractFileRefs,
  extractFunctionRefs,
  extractEnvVarRefs,
} from '../../scripts/lib/claudemd/ref-checker.mjs';

describe('resolveReferencedPath', () => {
  it('skips external URLs', () => {
    const r = resolveReferencedPath('CLAUDE.md', 'https://example.com', '/repo');
    assert.equal(r.skip, true);
  });

  it('skips anchor-only links', () => {
    const r = resolveReferencedPath('CLAUDE.md', '#section', '/repo');
    assert.equal(r.skip, true);
  });

  it('strips trailing anchors', () => {
    const r = resolveReferencedPath('CLAUDE.md', 'docs/arch.md#details', '/repo');
    assert.equal(r.resolved, 'docs/arch.md');
  });

  it('resolves relative to source directory', () => {
    const r = resolveReferencedPath('docs/guides/setup.md', '../arch.md', '/repo');
    assert.equal(r.resolved, 'docs/arch.md');
  });
});

describe('extractFileRefs', () => {
  it('extracts markdown links', () => {
    const refs = extractFileRefs('[Guide](docs/guide.md)\n[API](docs/api.md)');
    assert.equal(refs.length, 2);
    assert.equal(refs[0].ref, 'docs/guide.md');
    assert.equal(refs[1].ref, 'docs/api.md');
  });

  it('extracts backtick paths', () => {
    const refs = extractFileRefs('See `scripts/build.mjs` for details');
    assert.equal(refs.length, 1);
    assert.equal(refs[0].ref, 'scripts/build.mjs');
  });

  it('skips refs inside code blocks', () => {
    const content = '```\n[link](foo.md)\n```\n[real](bar.md)';
    const refs = extractFileRefs(content);
    assert.equal(refs.length, 1);
    assert.equal(refs[0].ref, 'bar.md');
  });
});

describe('extractFunctionRefs', () => {
  it('extracts backtick function calls', () => {
    const refs = extractFunctionRefs('Use `buildSchema()` to create');
    assert.equal(refs.length, 1);
    assert.equal(refs[0].name, 'buildSchema');
  });

  it('extracts backtick class names', () => {
    const refs = extractFunctionRefs('The `AppException` class handles errors');
    assert.equal(refs.length, 1);
    assert.equal(refs[0].name, 'AppException');
  });

  it('skips refs inside code blocks', () => {
    const refs = extractFunctionRefs('```\n`myFunc()`\n```\n`realFunc()`');
    assert.equal(refs.length, 1);
    assert.equal(refs[0].name, 'realFunc');
  });
});

describe('extractEnvVarRefs', () => {
  it('extracts ALL_CAPS_WITH_UNDERSCORES', () => {
    const refs = extractEnvVarRefs('Set `OPENAI_API_KEY` and `DATABASE_URL`');
    assert.equal(refs.length, 2);
    assert.equal(refs[0].name, 'OPENAI_API_KEY');
    assert.equal(refs[1].name, 'DATABASE_URL');
  });

  it('requires at least one underscore', () => {
    const refs = extractEnvVarRefs('Not a var: `SINGLE`');
    assert.equal(refs.length, 0);
  });

  it('skips refs inside code blocks', () => {
    const refs = extractEnvVarRefs('```\n`FAKE_VAR`\n```\n`REAL_VAR`');
    assert.equal(refs.length, 1);
    assert.equal(refs[0].name, 'REAL_VAR');
  });
});
