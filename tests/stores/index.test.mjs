import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { pickAdapter } from '../../scripts/lib/stores/index.mjs';

describe('pickAdapter', () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    // Restore env
    delete process.env.AUDIT_STORE;
    delete process.env.SUPABASE_AUDIT_URL;
    delete process.env.SUPABASE_AUDIT_ANON_KEY;
  });

  it('returns noop when nothing set', () => {
    delete process.env.AUDIT_STORE;
    delete process.env.SUPABASE_AUDIT_URL;
    delete process.env.SUPABASE_AUDIT_ANON_KEY;
    assert.equal(pickAdapter(), 'noop');
  });

  it('returns supabase on backward-compat auto-detect', () => {
    delete process.env.AUDIT_STORE;
    process.env.SUPABASE_AUDIT_URL = 'https://example.supabase.co';
    process.env.SUPABASE_AUDIT_ANON_KEY = 'test-key';
    assert.equal(pickAdapter(), 'supabase');
  });

  it('returns explicit AUDIT_STORE value', () => {
    process.env.AUDIT_STORE = 'noop';
    process.env.SUPABASE_AUDIT_URL = 'https://example.supabase.co';
    process.env.SUPABASE_AUDIT_ANON_KEY = 'test-key';
    assert.equal(pickAdapter(), 'noop');
  });
});
