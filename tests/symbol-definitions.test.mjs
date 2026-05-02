import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Stable-symbol-identity rules (per docs/plans/architectural-memory.md §2 R2 H7).
 *
 * The full identity contract requires a real Postgres + RLS + the
 * `symbol_definitions` UNIQUE constraint to enforce. These tests are gated
 * behind `RUN_INTEGRATION=1` so unit `npm test` stays hermetic. When the
 * gate is unset, each test is skipped explicitly so the file still
 * exists per the §5 file plan and an integration runner sees it.
 */

const integration = process.env.RUN_INTEGRATION === '1';

describe('symbol_definitions stable identity', () => {
  it('same (repo,path,name,kind) across refreshes returns same definition_id', { skip: !integration }, async () => {
    // Integration test placeholder — implementer wires this against a real
    // Supabase test project. Asserts:
    //   1. recordSymbolDefinitions(repoId, [{canonicalPath:'a.mjs', symbolName:'foo', kind:'function'}])
    //      returns map containing key 'a.mjs|foo|function'
    //   2. Calling again returns the SAME definition_id for that key.
    assert.ok(false, 'integration-only');
  });

  it('git mv preserves definition_id when name+kind match', { skip: !integration }, async () => {
    // After a rename refresh:
    //   prior: { canonicalPath:'old.mjs', symbolName:'foo', kind:'function' }
    //   new:   { canonicalPath:'new.mjs', symbolName:'foo', kind:'function' }
    // The plan specifies preserving identity for `R` git diff status.
    // Current v1 implementation: the new row gets a new definition_id and
    // the old one is archived; preservation requires either composite-key
    // restoration or upsert-on-rename. Marked as a known gap to wire.
    assert.ok(false, 'integration-only');
  });

  it('symbol rename within same file produces a new definition_id', { skip: !integration }, async () => {
    // Different symbol_name → different unique-constraint key → new row.
    assert.ok(false, 'integration-only');
  });

  it('definition_id is stable for unchanged symbols across multiple refreshes', { skip: !integration }, async () => {
    // 3 successive full refreshes of the same fixture → same definition_id
    // for each unchanged symbol.
    assert.ok(false, 'integration-only');
  });
});

// Pure-helper unit test that can run without DB: identity key composition
import { signatureHash } from '../scripts/lib/symbol-index.mjs';

describe('definition key composition (pure)', () => {
  it('signature_hash binds name + signature + body', () => {
    const a = signatureHash({ symbolName: 'foo', signature: 'foo()', bodyText: 'x' });
    const b = signatureHash({ symbolName: 'foo', signature: 'foo()', bodyText: 'x' });
    const c = signatureHash({ symbolName: 'bar', signature: 'foo()', bodyText: 'x' });
    assert.equal(a, b);
    assert.notEqual(a, c);
  });
});
