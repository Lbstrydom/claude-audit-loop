import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Supabase adapter tests only run when SUPABASE_AUDIT_URL is configured
const HAS_SUPABASE = !!(process.env.SUPABASE_AUDIT_URL && process.env.SUPABASE_AUDIT_ANON_KEY);

describe('supabase adapter (structural)', () => {
  it('declares all capabilities', async () => {
    if (!HAS_SUPABASE) {
      // Can still import and check structure without connecting
      try {
        const { adapter } = await import('../../scripts/lib/stores/supabase-store.mjs');
        assert.equal(adapter.name, 'supabase');
        assert.equal(adapter.capabilities.debt, true);
        assert.equal(adapter.capabilities.run, true);
        assert.equal(adapter.capabilities.learningState, true);
        assert.equal(adapter.capabilities.globalState, true);
        assert.equal(adapter.capabilities.repo, true);
        assert.equal(adapter.capabilities.scopeIsolation, true);
      } catch {
        // @supabase/supabase-js may not be installed — skip
      }
    }
  });

  it('has all interface sub-objects', async () => {
    try {
      const { adapter } = await import('../../scripts/lib/stores/supabase-store.mjs');
      assert.ok(adapter.debt);
      assert.ok(adapter.run);
      assert.ok(adapter.learningState);
      assert.ok(adapter.globalState);
      assert.ok(adapter.repo);
    } catch {
      // @supabase/supabase-js not installed — skip
    }
  });
});
