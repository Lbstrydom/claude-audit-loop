/**
 * Tests for the new flags + envelope shape introduced by brainstorm-quickfix-v1.
 * Plan ACs: AC1, AC8, AC51, §11.B grammar, §11.A debate array shape.
 *
 * Loads parseArgs by spawning the helper with --help to verify documented
 * flags appear (contract test — keeps CLI advertised vs implemented in sync).
 * For deeper logic we exercise the lib modules directly (provider-limits,
 * depth-config, schemas) which the helper composes.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ProviderResultSchema,
  DebateRoundSchema,
  BrainstormEnvelopeV1Schema,
  BrainstormEnvelopeV2Schema,
  BrainstormOutputSchema,
  BrainstormEnvelopeWriteSchema,
} from '../scripts/lib/brainstorm/schemas.mjs';
import { resolveDepth } from '../scripts/lib/brainstorm/depth-config.mjs';
import {
  PROVIDER_INPUT_CEILING_TOKENS,
  estimateTokens,
  getCeilingTokens,
  smallestCeilingTokens,
} from '../scripts/lib/brainstorm/provider-limits.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.resolve(TEST_DIR, '..', 'scripts', 'brainstorm-round.mjs');

function helpText() {
  const r = spawnSync('node', [HELPER, '--help'], { encoding: 'utf-8', timeout: 5000 });
  return r.stdout || '';
}

describe('AC1 — --help advertises the canonical flag set per mode', () => {
  const help = helpText();
  for (const flag of ['--debate', '--depth', '--continue-from', '--with-context', '--with-gemini', '--sid']) {
    it(`brainstorm-mode help mentions ${flag}`, () => {
      assert.match(help, new RegExp(flag.replace(/[-]/g, '\\-')));
    });
  }

  it('save mode subcommand documented', () => {
    assert.match(help, /save\b/);
  });

  it('save mode requires --sid + --round in help', () => {
    assert.match(help, /save mode/i);
    // The save flags table mentions REQUIRED for --sid/--round
    assert.match(help, /--sid <sid>\s+REQUIRED/);
    assert.match(help, /--round <n>\s+REQUIRED/);
  });
});

describe('AC51 — --continue-from carries sid as own value (no separate --sid in brainstorm mode)', () => {
  const help = helpText();
  it('brainstorm-mode help shows --continue-from <sid> not --sid + --continue-from', () => {
    // continue-from takes a sid value
    assert.match(help, /--continue-from <sid>/);
  });
});

describe('Schema layering — V1 / V2 / debate / envelope (§11.A + §12.C)', () => {
  it('ProviderResultSchema accepts a normal success entry', () => {
    const ok = {
      provider: 'openai', state: 'success',
      text: 'response', errorMessage: null, httpStatus: null,
      usage: { inputTokens: 10, outputTokens: 20 }, latencyMs: 100, estimatedCostUsd: 0.001,
    };
    assert.equal(ProviderResultSchema.safeParse(ok).success, true);
  });

  it('DebateRoundSchema requires both provider AND reactingTo', () => {
    const ok = {
      provider: 'openai', reactingTo: 'gemini',
      state: 'success', text: 'reply', errorMessage: null, httpStatus: null,
      usage: null, latencyMs: 50, estimatedCostUsd: 0.001,
    };
    assert.equal(DebateRoundSchema.safeParse(ok).success, true);
    const missingReact = { ...ok };
    delete missingReact.reactingTo;
    assert.equal(DebateRoundSchema.safeParse(missingReact).success, false);
  });

  it('V2 envelope requires sid/round/capturedAt/schemaVersion', () => {
    const minimal = {
      topic: 't', redactionCount: 0, resolvedModels: { openai: 'g' },
      providers: [], totalCostUsd: 0,
      sid: 'test-id', round: 0, capturedAt: new Date().toISOString(),
      schemaVersion: 2,
    };
    assert.equal(BrainstormEnvelopeV2Schema.safeParse(minimal).success, true);
    const noSid = { ...minimal };
    delete noSid.sid;
    assert.equal(BrainstormEnvelopeV2Schema.safeParse(noSid).success, false);
  });

  it('R1 §12.C — V1 envelope still parseable via union BrainstormOutputSchema', () => {
    const v1 = {
      topic: 't', redactionCount: 0, resolvedModels: { openai: 'g' },
      providers: [], totalCostUsd: 0,
    };
    assert.equal(BrainstormEnvelopeV1Schema.safeParse(v1).success, true);
    assert.equal(BrainstormOutputSchema.safeParse(v1).success, true);
  });

  it('Writers must emit V2 strict (BrainstormEnvelopeWriteSchema)', () => {
    const v1 = {
      topic: 't', redactionCount: 0, resolvedModels: { openai: 'g' },
      providers: [], totalCostUsd: 0,
    };
    assert.equal(BrainstormEnvelopeWriteSchema.safeParse(v1).success, false, 'V1 must NOT pass strict write schema');
  });
});

describe('§11.F provider-limits — token-based budgeting end-to-end', () => {
  it('PROVIDER_INPUT_CEILING_TOKENS uses tokens, not chars', () => {
    assert.equal(typeof PROVIDER_INPUT_CEILING_TOKENS.openai['latest-gpt'], 'number');
    assert.ok(PROVIDER_INPUT_CEILING_TOKENS.openai['latest-gpt'] >= 100_000);
  });

  it('estimateTokens returns chars/4 ceiling', () => {
    assert.equal(estimateTokens('aaaa'), 1);
    assert.equal(estimateTokens('aaaaa'), 2);  // ceiling
  });

  it('getCeilingTokens falls back to default for unknown sentinel', () => {
    const c = getCeilingTokens('openai', 'nonexistent');
    assert.equal(c, PROVIDER_INPUT_CEILING_TOKENS.openai.default);
  });

  it('smallestCeilingTokens picks the most restrictive provider', () => {
    const r = smallestCeilingTokens([
      { provider: 'openai', model: 'latest-gpt' },
      { provider: 'gemini', model: 'latest-pro' },
    ]);
    // openai 128k < gemini 1M → openai wins
    assert.equal(r.drivenBy.provider, 'openai');
    assert.equal(r.ceilingTokens, PROVIDER_INPUT_CEILING_TOKENS.openai['latest-gpt']);
  });
});

describe('§13.D depth — auto-promote correctness (R1 H2 null-safety)', () => {
  it('resolveDepth handles undefined args gracefully', () => {
    const r = resolveDepth();
    assert.equal(r.depth, 'standard');
  });

  it('resolveDepth handles null explicitDepth gracefully', () => {
    const r = resolveDepth({ explicitDepth: null, topic: 'x' });
    assert.equal(r.depth, 'standard');
  });

  it('resolveDepth handles null args object gracefully', () => {
    const r = resolveDepth(null);
    assert.equal(r.depth, 'standard');
  });

  it('explicit deep wins over auto-promote', () => {
    const r = resolveDepth({ explicitDepth: 'deep', topic: 'fix typo' });
    assert.equal(r.depth, 'deep');
    assert.equal(r.autoPromoted, false);
  });
});
