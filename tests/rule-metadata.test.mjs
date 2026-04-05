/**
 * @fileoverview Phase C — rule-metadata registry tests.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RULE_METADATA, getRuleMetadata } from '../scripts/lib/rule-metadata.mjs';

test('getRuleMetadata — returns specific eslint entry for known rule', () => {
  const meta = getRuleMetadata('eslint', 'no-undef');
  assert.equal(meta.severity, 'HIGH');
  assert.equal(meta.sonarType, 'BUG');
});

test('getRuleMetadata — fatal-parse-error maps to HIGH BUG', () => {
  const meta = getRuleMetadata('eslint', 'fatal-parse-error');
  assert.equal(meta.severity, 'HIGH');
  assert.equal(meta.sonarType, 'BUG');
});

test('getRuleMetadata — returns eslint _default for unknown eslint rule', () => {
  const meta = getRuleMetadata('eslint', 'totally-fake-rule');
  assert.equal(meta, RULE_METADATA.eslint._default);
});

test('getRuleMetadata — returns global _default for unknown tool', () => {
  const meta = getRuleMetadata('unknown-tool', 'anything');
  assert.equal(meta, RULE_METADATA._default);
});

test('getRuleMetadata — ruff S-rules map to VULNERABILITY', () => {
  assert.equal(getRuleMetadata('ruff', 'S307').sonarType, 'VULNERABILITY');
  assert.equal(getRuleMetadata('ruff', 'S608').severity, 'HIGH');
});

test('getRuleMetadata — ruff F401 unused import maps to LOW CODE_SMELL', () => {
  const meta = getRuleMetadata('ruff', 'F401');
  assert.equal(meta.severity, 'LOW');
  assert.equal(meta.sonarType, 'CODE_SMELL');
  assert.equal(meta.effort, 'TRIVIAL');
});

test('getRuleMetadata — tsc TS2304 (cannot find name) is HIGH BUG', () => {
  const meta = getRuleMetadata('tsc', 'TS2304');
  assert.equal(meta.severity, 'HIGH');
  assert.equal(meta.sonarType, 'BUG');
});

test('getRuleMetadata — tsc unknown code falls back to tsc _default (MEDIUM BUG)', () => {
  const meta = getRuleMetadata('tsc', 'TS99999');
  assert.equal(meta.severity, 'MEDIUM');
  assert.equal(meta.sonarType, 'BUG');
});

test('RULE_METADATA — every tool registry has a _default entry', () => {
  for (const [tool, registry] of Object.entries(RULE_METADATA)) {
    if (tool === '_default') continue;
    assert.ok(registry._default, `tool ${tool} must have _default`);
    assert.ok(registry._default.severity);
    assert.ok(registry._default.sonarType);
  }
});

test('RULE_METADATA — all severity values are valid enum members', () => {
  const valid = new Set(['HIGH', 'MEDIUM', 'LOW']);
  for (const [tool, registry] of Object.entries(RULE_METADATA)) {
    if (tool === '_default') {
      assert.ok(valid.has(registry.severity));
      continue;
    }
    for (const [rule, meta] of Object.entries(registry)) {
      assert.ok(valid.has(meta.severity), `${tool}.${rule}.severity invalid: ${meta.severity}`);
    }
  }
});

test('RULE_METADATA — all sonarType values are valid enum members', () => {
  const valid = new Set(['BUG', 'VULNERABILITY', 'CODE_SMELL', 'SECURITY_HOTSPOT']);
  for (const [tool, registry] of Object.entries(RULE_METADATA)) {
    if (tool === '_default') {
      assert.ok(valid.has(registry.sonarType));
      continue;
    }
    for (const [rule, meta] of Object.entries(registry)) {
      assert.ok(valid.has(meta.sonarType), `${tool}.${rule}.sonarType invalid: ${meta.sonarType}`);
    }
  }
});

test('RULE_METADATA — registry is frozen (immutable)', () => {
  assert.throws(() => { RULE_METADATA.eslint.newRule = { severity: 'LOW' }; }, TypeError);
});
