import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SKILLS_DIR = path.resolve('skills');
// plan-backend + plan-frontend were merged into the unified `plan` skill on
// 2026-05-02 (one consolidated plan output for cross-stack work). Both
// originals remain as thin alias shims for muscle memory but no longer
// hold the planning content — that's all in `skills/plan/`.
const ALL_SKILLS = ['audit-loop', 'plan', 'plan-backend', 'plan-frontend', 'ship'];
// Skills that must hold the full Phase 0 stack-detection + Python profile
// content. Shims (plan-backend, plan-frontend, audit-loop) deliberately don't anymore.
const PYTHON_SKILLS = ['plan', 'ship'];
// Shims allow no-`##`-heading content (just deprecation notice + delegate).
const HEADING_EXEMPT_SKILLS = new Set(['plan-backend', 'plan-frontend', 'audit-loop']);

describe('skills content', () => {
  for (const skill of ALL_SKILLS) {
    const skillPath = path.join(SKILLS_DIR, skill, 'SKILL.md');

    it(`${skill} exists in skills/`, () => {
      assert.ok(fs.existsSync(skillPath), `${skillPath} must exist`);
    });

    it(`${skill} has valid YAML frontmatter with name + description`, () => {
      const content = fs.readFileSync(skillPath, 'utf-8');
      assert.ok(content.startsWith('---'), 'must start with ---');
      const endIdx = content.indexOf('---', 3);
      assert.ok(endIdx > 3, 'must have closing ---');
      const frontmatter = content.slice(3, endIdx);
      assert.ok(/\bname:/.test(frontmatter), 'frontmatter must have name:');
      assert.ok(/\bdescription:/.test(frontmatter), 'frontmatter must have description:');
    });

    it(`${skill} has at least one ## heading`, { skip: HEADING_EXEMPT_SKILLS.has(skill) }, () => {
      const content = fs.readFileSync(skillPath, 'utf-8');
      assert.ok(/^## /m.test(content), 'must have at least one ## heading');
    });
  }

  for (const skill of PYTHON_SKILLS) {
    const skillPath = path.join(SKILLS_DIR, skill, 'SKILL.md');

    it(`${skill} has Phase 0 — Repo Stack Detection`, () => {
      const content = fs.readFileSync(skillPath, 'utf-8');
      assert.ok(
        content.includes('Phase 0') && content.includes('Repo Stack Detection'),
        'must contain Phase 0 — Repo Stack Detection heading'
      );
    });

    it(`${skill} has Python-specific content`, () => {
      // Progressive-disclosure refactor: Python content moved from SKILL.md
      // to references/*.md for plan-backend, plan-frontend, ship. Still part
      // of the skill — just loaded on demand. Check SKILL.md + references/.
      let content = fs.readFileSync(skillPath, 'utf-8');
      const refsDir = path.join(path.dirname(skillPath), 'references');
      if (fs.existsSync(refsDir)) {
        for (const f of fs.readdirSync(refsDir)) {
          if (f.endsWith('.md')) content += '\n' + fs.readFileSync(path.join(refsDir, f), 'utf-8');
        }
      }
      const hasTags = (content.match(/\[(generic|fastapi|django|flask)[,\]]/g) || []).length >= 5;
      const hasPythonSection = content.includes('Python') && content.includes('pytest');
      assert.ok(
        hasTags || hasPythonSection,
        `must have >= 5 framework tags OR Python-specific sections (checked SKILL.md + references/)`,
      );
    });
  }
});
