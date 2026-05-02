import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';

import { dispatch } from '../scripts/lib/audit-dispatch.mjs';

// In-memory fs.existsSync stub for path-resolution tests
function fakeExists(presentPaths) {
  const set = new Set(presentPaths);
  return p => set.has(p);
}

describe('audit-loop orchestrator dispatch', () => {
  describe('explicit mode keyword', () => {
    it('"plan <path>" routes to /audit-plan', () => {
      const r = dispatch('plan docs/plans/X.md', { existsSync: () => true });
      assert.equal(r.skill, 'audit-plan');
      assert.equal(r.mode, 'PLAN_AUDIT');
      assert.equal(r.planFile, 'docs/plans/X.md');
    });

    it('"code <path>" routes to /audit-code', () => {
      const r = dispatch('code docs/plans/X.md', { existsSync: () => true });
      assert.equal(r.skill, 'audit-code');
      assert.equal(r.mode, 'CODE_AUDIT');
      assert.equal(r.planFile, 'docs/plans/X.md');
    });

    it('"full <task>" returns FULL_CYCLE for orchestration', () => {
      const r = dispatch('full add a wine recommendation engine', {});
      assert.equal(r.skill, 'orchestrate');
      assert.equal(r.mode, 'FULL_CYCLE');
      assert.equal(r.task, 'add a wine recommendation engine');
    });

    it('mode keyword is case-insensitive', () => {
      const r = dispatch('PLAN docs/plans/X.md', { existsSync: () => true });
      assert.equal(r.skill, 'audit-plan');
    });
  });

  describe('shorthand path detection', () => {
    it('a path to an existing .md file → /audit-code', () => {
      const r = dispatch('docs/plans/X.md', { existsSync: fakeExists(['docs/plans/X.md']) });
      assert.equal(r.skill, 'audit-code');
      assert.equal(r.mode, 'CODE_AUDIT');
    });

    it('a string ending .md but not existing falls through to PLAN_CYCLE', () => {
      const r = dispatch('not-a-real-file.md', { existsSync: () => false });
      assert.equal(r.skill, 'audit-plan');
      assert.equal(r.mode, 'PLAN_CYCLE');
    });
  });

  describe('plan_cycle (no path)', () => {
    it('plain task description → /audit-plan PLAN_CYCLE', () => {
      const r = dispatch('design a wine recommendation engine', {});
      assert.equal(r.skill, 'audit-plan');
      assert.equal(r.mode, 'PLAN_CYCLE');
      assert.equal(r.task, 'design a wine recommendation engine');
    });

    it('multi-word tasks parse as a single task string', () => {
      const r = dispatch('add observability to the cellar service', {});
      assert.equal(r.task, 'add observability to the cellar service');
    });
  });

  describe('error handling', () => {
    it('empty input returns error', () => {
      const r = dispatch('', {});
      assert.equal(r.skill, null);
      assert.match(r.error, /empty/);
    });

    it('whitespace-only input returns error', () => {
      const r = dispatch('   \t\n', {});
      assert.equal(r.skill, null);
    });

    it('null input returns error', () => {
      const r = dispatch(null, {});
      assert.equal(r.skill, null);
    });
  });

  describe('SKILL.md structural integrity (deprecated shim)', () => {
    // audit-loop was deprecated to a thin alias shim on 2026-05-02 — its
    // chained mode moved to /cycle, atomic modes to /audit-plan + /audit-code.
    // The shim's only job now is discoverability for muscle memory + routing
    // users to the active skills.
    const SKILL_DIR = path.resolve('skills/audit-loop');
    const SKILL_MD = path.join(SKILL_DIR, 'SKILL.md');

    it('SKILL.md exists and stays slim (deprecation shim)', () => {
      const content = fs.readFileSync(SKILL_MD, 'utf-8');
      const lines = content.split('\n').length;
      assert.ok(lines <= 100, `deprecation shim should be ≤100 lines, got ${lines}`);
    });

    it('SKILL.md is marked DEPRECATED and routes to active skills', () => {
      const content = fs.readFileSync(SKILL_MD, 'utf-8');
      assert.match(content, /DEPRECATED/i, 'must be marked DEPRECATED');
      // Must point at the three active skills that replace this:
      assert.match(content, /\/audit-plan/, 'must reference /audit-plan');
      assert.match(content, /\/audit-code/, 'must reference /audit-code');
      assert.match(content, /\/cycle/, 'must reference /cycle (replaces "full" mode)');
    });

    it('shim has no reference files', () => {
      const refsDir = path.join(SKILL_DIR, 'references');
      assert.ok(!fs.existsSync(refsDir), 'shim should not have references/');
    });
  });
});
