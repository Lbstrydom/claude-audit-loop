import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { enumerateSkillFiles, listSkillNames } from '../scripts/lib/skill-packaging.mjs';

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function write(rel, body = '') {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}

describe('enumerateSkillFiles', () => {
  it('returns just SKILL.md for a minimal skill', () => {
    write('SKILL.md');
    assert.deepEqual(enumerateSkillFiles(tmp), ['SKILL.md']);
  });

  it('includes references/*.md and examples/*.md', () => {
    write('SKILL.md');
    write('references/a.md');
    write('references/b.md');
    write('examples/sample.md');
    assert.deepEqual(enumerateSkillFiles(tmp), [
      'SKILL.md', 'examples/sample.md', 'references/a.md', 'references/b.md',
    ]);
  });

  it('handles one level of nested dirs under references/', () => {
    write('SKILL.md');
    write('references/group/a.md');
    write('references/group/b.md');
    const files = enumerateSkillFiles(tmp);
    assert.ok(files.includes('references/group/a.md'));
    assert.ok(files.includes('references/group/b.md'));
  });

  it('excludes dotfiles and swap files', () => {
    write('SKILL.md');
    write('references/real.md');
    write('references/.DS_Store');
    write('references/.hidden.md');
    write('references/foo.md.swp');
    write('references/bak.md~');
    const files = enumerateSkillFiles(tmp);
    assert.deepEqual(files, ['SKILL.md', 'references/real.md']);
  });

  it('rejects non-markdown files by default', () => {
    write('SKILL.md');
    write('references/helper.js');
    assert.throws(() => enumerateSkillFiles(tmp), /outside the allowlist/);
  });

  it('rejects top-level non-SKILL.md files', () => {
    write('SKILL.md');
    write('README.md');
    assert.throws(() => enumerateSkillFiles(tmp), /outside the allowlist/);
  });

  it('rejects unknown directories', () => {
    write('SKILL.md');
    write('scripts/helper.mjs');
    assert.throws(() => enumerateSkillFiles(tmp), /outside the allowlist/);
  });

  it('strict:false returns allowlisted files even when unexpected files exist', () => {
    write('SKILL.md');
    write('references/good.md');
    write('references/bad.json');
    const files = enumerateSkillFiles(tmp, { strict: false });
    assert.deepEqual(files, ['SKILL.md', 'references/good.md']);
  });

  it('throws when skill directory does not exist', () => {
    assert.throws(() => enumerateSkillFiles(path.join(tmp, 'nonexistent')));
  });
});

describe('listSkillNames', () => {
  it('returns sorted skill directory names', () => {
    fs.mkdirSync(path.join(tmp, 'zeta'));
    fs.writeFileSync(path.join(tmp, 'zeta', 'SKILL.md'), '');
    fs.mkdirSync(path.join(tmp, 'alpha'));
    fs.writeFileSync(path.join(tmp, 'alpha', 'SKILL.md'), '');
    fs.mkdirSync(path.join(tmp, 'beta'));
    // beta has no SKILL.md — should be filtered out

    const names = listSkillNames(tmp);
    assert.deepEqual(names, ['alpha', 'zeta']);
  });

  it('returns empty array when root does not exist', () => {
    assert.deepEqual(listSkillNames(path.join(tmp, 'missing')), []);
  });
});
