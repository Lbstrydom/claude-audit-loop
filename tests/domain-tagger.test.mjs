import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { matchGlob, tagDomain, loadDomainRules } from '../scripts/lib/symbol-index/domain-tagger.mjs';

describe('matchGlob', () => {
  it('matches exact path', () => {
    assert.equal(matchGlob('scripts/foo.mjs', 'scripts/foo.mjs'), true);
    assert.equal(matchGlob('scripts/bar.mjs', 'scripts/foo.mjs'), false);
  });

  it('normalises Windows backslashes', () => {
    assert.equal(matchGlob('scripts\\lib\\foo.mjs', 'scripts/lib/foo.mjs'), true);
  });

  it('strips leading ./', () => {
    assert.equal(matchGlob('./scripts/foo.mjs', 'scripts/foo.mjs'), true);
  });

  it('single * matches one segment, no slashes', () => {
    assert.equal(matchGlob('scripts/foo.mjs', 'scripts/*.mjs'), true);
    assert.equal(matchGlob('scripts/lib/foo.mjs', 'scripts/*.mjs'), false);
  });

  it('prefix/** matches any file in subtree (matches bash/gitignore semantics)', () => {
    assert.equal(matchGlob('scripts/lib/brainstorm/openai-adapter.mjs', 'scripts/lib/brainstorm/**'), true);
    assert.equal(matchGlob('scripts/lib/brainstorm/sub/x.mjs', 'scripts/lib/brainstorm/**'), true);
    assert.equal(matchGlob('scripts/lib/other.mjs', 'scripts/lib/brainstorm/**'), false);
    // Bare prefix dir does NOT match prefix/** — consistent with bash + gitignore.
    // Symbol-index never feeds bare dirs anyway (every input is a file path).
    assert.equal(matchGlob('scripts/lib/brainstorm', 'scripts/lib/brainstorm/**'), false);
  });

  it('** alone matches everything', () => {
    assert.equal(matchGlob('anything/at/all.txt', '**'), true);
  });

  it('mid-pattern ** allowed', () => {
    assert.equal(matchGlob('src/auth/oauth/token.mjs', 'src/**/token.mjs'), true);
    assert.equal(matchGlob('src/token.mjs', 'src/**/token.mjs'), true,
      'src/**/token.mjs should match src/token.mjs (zero segments between)');
    assert.equal(matchGlob('src/auth/other.mjs', 'src/**/token.mjs'), false);
  });

  it('extension wildcards', () => {
    assert.equal(matchGlob('scripts/foo.test.mjs', 'scripts/*.test.mjs'), true);
    assert.equal(matchGlob('scripts/foo.mjs', 'scripts/*.test.mjs'), false);
  });

  it('rejects non-string inputs without throwing', () => {
    assert.equal(matchGlob(null, 'foo'), false);
    assert.equal(matchGlob('foo', null), false);
    assert.equal(matchGlob(undefined, undefined), false);
  });

  it('regex special chars in literal segments are escaped', () => {
    // A path containing `.` in the pattern must match `.` literally, not "any char"
    assert.equal(matchGlob('docs/architecture-map.md', 'docs/architecture-map.md'), true);
    assert.equal(matchGlob('docsXarchitecture-mapXmd', 'docs/architecture-map.md'), false);
  });
});

describe('tagDomain', () => {
  const rules = [
    { pattern: 'scripts/lib/brainstorm/**', domain: 'brainstorm' },
    { pattern: 'scripts/symbol-index/**', domain: 'symbol-index' },
    { pattern: 'tests/**', domain: 'tests' },
    { pattern: 'scripts/lib/**', domain: 'shared-lib' }, // catch-all after specifics
    { pattern: 'scripts/**', domain: 'scripts' },        // broader catch-all
  ];

  it('first match wins (specific before catch-all)', () => {
    assert.equal(tagDomain('scripts/lib/brainstorm/openai-adapter.mjs', rules), 'brainstorm');
    assert.equal(tagDomain('scripts/lib/findings.mjs', rules), 'shared-lib');
    assert.equal(tagDomain('scripts/openai-audit.mjs', rules), 'scripts');
  });

  it('subdirectory still matches subtree rule', () => {
    assert.equal(tagDomain('scripts/symbol-index/render-mermaid.mjs', rules), 'symbol-index');
  });

  it('test files routed to tests domain', () => {
    assert.equal(tagDomain('tests/brainstorm-round.test.mjs', rules), 'tests');
  });

  it('returns null for unmatched paths', () => {
    assert.equal(tagDomain('docs/plans/something.md', rules), null);
    assert.equal(tagDomain('package.json', rules), null);
  });

  it('handles empty rules array', () => {
    assert.equal(tagDomain('scripts/foo.mjs', []), null);
  });

  it('handles non-array rules', () => {
    assert.equal(tagDomain('scripts/foo.mjs', null), null);
    assert.equal(tagDomain('scripts/foo.mjs', undefined), null);
  });

  it('skips malformed rule entries', () => {
    const mixed = [
      null,
      { pattern: 'scripts/lib/brainstorm/**' }, // missing domain
      { domain: 'orphan' },                      // missing pattern
      { pattern: 'scripts/foo.mjs', domain: 'foo' },
    ];
    assert.equal(tagDomain('scripts/foo.mjs', mixed), 'foo');
  });
});

describe('loadDomainRules', () => {
  it('returns [] when file is missing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dom-tag-'));
    try {
      assert.deepEqual(loadDomainRules(tmp), []);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns [] on invalid JSON', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dom-tag-'));
    try {
      fs.mkdirSync(path.join(tmp, '.audit-loop'), { recursive: true });
      fs.writeFileSync(path.join(tmp, '.audit-loop/domain-map.json'), '{ not json');
      assert.deepEqual(loadDomainRules(tmp), []);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns [] when "rules" key is missing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dom-tag-'));
    try {
      fs.mkdirSync(path.join(tmp, '.audit-loop'), { recursive: true });
      fs.writeFileSync(path.join(tmp, '.audit-loop/domain-map.json'), '{}');
      assert.deepEqual(loadDomainRules(tmp), []);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('loads valid rule list', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dom-tag-'));
    try {
      fs.mkdirSync(path.join(tmp, '.audit-loop'), { recursive: true });
      const config = { rules: [
        { pattern: 'src/**', domain: 'src' },
        { pattern: 'tests/**', domain: 'tests' },
      ] };
      fs.writeFileSync(path.join(tmp, '.audit-loop/domain-map.json'), JSON.stringify(config));
      const out = loadDomainRules(tmp);
      assert.equal(out.length, 2);
      assert.equal(out[0].domain, 'src');
      assert.equal(out[1].domain, 'tests');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('drops rules with invalid domain names', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dom-tag-'));
    try {
      fs.mkdirSync(path.join(tmp, '.audit-loop'), { recursive: true });
      const config = { rules: [
        { pattern: 'src/**', domain: 'GoodName_123' },   // invalid: uppercase
        { pattern: 'src/**', domain: 'spaces in name' },  // invalid: spaces
        { pattern: 'src/**', domain: '' },                // invalid: empty
        { pattern: 'src/**', domain: 'a'.repeat(60) },    // invalid: too long
        { pattern: 'src/**', domain: 'good-domain' },     // valid
      ] };
      fs.writeFileSync(path.join(tmp, '.audit-loop/domain-map.json'), JSON.stringify(config));
      const out = loadDomainRules(tmp);
      assert.equal(out.length, 1);
      assert.equal(out[0].domain, 'good-domain');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
