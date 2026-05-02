import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  isPathSensitive,
  isExtensionAllowlisted,
  containsSecrets,
  redactSecrets,
  gateSymbolForEgress,
  SECRET_REDACTED,
} from '../scripts/lib/sensitive-egress-gate.mjs';

describe('isPathSensitive', () => {
  it('blocks .env and variants', () => {
    assert.ok(isPathSensitive('.env'));
    assert.ok(isPathSensitive('.env.local'));
    assert.ok(isPathSensitive('.env.production'));
    assert.ok(isPathSensitive('packages/app/.env'));
  });
  it('blocks key files', () => {
    assert.ok(isPathSensitive('keys/server.pem'));
    assert.ok(isPathSensitive('id_rsa'));
    assert.ok(isPathSensitive('id_rsa.pub'));
    assert.ok(isPathSensitive('certs/cert.crt'));
  });
  it('blocks secrets/ and credentials*', () => {
    assert.ok(isPathSensitive('secrets/api.key'));
    assert.ok(isPathSensitive('config/credentials.json'));
  });
  it('blocks lockfiles (low signal, large noise)', () => {
    assert.ok(isPathSensitive('package-lock.json'));
    assert.ok(isPathSensitive('yarn.lock'));
  });
  it('lets normal source through', () => {
    assert.equal(isPathSensitive('scripts/openai-audit.mjs'), false);
    assert.equal(isPathSensitive('src/components/Modal.tsx'), false);
  });
  it('handles Windows-style paths', () => {
    assert.ok(isPathSensitive('packages\\app\\.env'));
  });
});

describe('isExtensionAllowlisted', () => {
  it('allows JS/TS/component extensions', () => {
    for (const p of ['x.js', 'y.mjs', 'z.ts', 'a.tsx', 'b.vue', 'c.svelte']) {
      assert.ok(isExtensionAllowlisted(p), `expected ${p} allowed`);
    }
  });
  it('rejects non-source extensions', () => {
    for (const p of ['x.json', 'y.md', 'z.yaml', 'a.lock']) {
      assert.equal(isExtensionAllowlisted(p), false, `expected ${p} rejected`);
    }
  });
});

describe('containsSecrets', () => {
  it('detects an AWS-style key', () => {
    assert.ok(containsSecrets('const k = "AKIAIOSFODNN7EXAMPLE";'));
  });
  it('returns false for clean code', () => {
    assert.equal(containsSecrets('function add(a, b) { return a + b; }'), false);
  });
  it('returns false for empty', () => {
    assert.equal(containsSecrets(''), false);
    assert.equal(containsSecrets(null), false);
  });
});

describe('redactSecrets', () => {
  it('strips a real-looking key from a payload', () => {
    const payload = '{"hint": "use AKIAIOSFODNN7EXAMPLE here"}';
    const out = redactSecrets(payload);
    assert.equal(out.includes('AKIAIOSFODNN7EXAMPLE'), false);
  });
});

describe('gateSymbolForEgress', () => {
  it('skips by path for sensitive files', () => {
    const r = gateSymbolForEgress({ filePath: '.env', bodyText: 'foo' });
    assert.equal(r.action, 'skip-path');
  });
  it('skips by extension for non-allowlisted', () => {
    const r = gateSymbolForEgress({ filePath: 'README.md', bodyText: 'foo' });
    assert.equal(r.action, 'skip-extension');
  });
  it('redacts content with secret-pattern body', () => {
    const r = gateSymbolForEgress({
      filePath: 'src/x.mjs',
      bodyText: 'const k = "AKIAIOSFODNN7EXAMPLE";',
    });
    assert.equal(r.action, 'redact-content');
  });
  it('sends clean code from allowlisted path', () => {
    const r = gateSymbolForEgress({
      filePath: 'src/x.mjs',
      bodyText: 'function add(a,b){return a+b;}',
    });
    assert.equal(r.action, 'send');
  });
});

describe('SECRET_REDACTED constant', () => {
  it('is a non-empty marker', () => {
    assert.ok(SECRET_REDACTED && SECRET_REDACTED.length > 0);
  });
});
