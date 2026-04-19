import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  detectRepoStack, detectPythonFramework, detectPythonEnvironmentManager,
} from '../scripts/lib/repo-stack.mjs';

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-stack-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function write(rel, body) {
  fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
  fs.writeFileSync(path.join(tmp, rel), body);
}

describe('detectRepoStack', () => {
  it('identifies js-ts when package.json has deps', () => {
    write('package.json', JSON.stringify({ dependencies: { express: '^4' } }));
    const r = detectRepoStack(tmp);
    assert.equal(r.stack, 'js-ts');
    assert.deepEqual(r.detectedFrom, ['package.json']);
    assert.equal(r.pythonFramework, null);
  });

  it('identifies python when only python markers present', () => {
    write('pyproject.toml', '[project]\nname = "x"\n');
    const r = detectRepoStack(tmp);
    assert.equal(r.stack, 'python');
    assert.equal(r.pythonFramework, 'none');
  });

  it('identifies mixed when both present with deps', () => {
    write('package.json', JSON.stringify({ devDependencies: { typescript: '^5' } }));
    write('requirements.txt', 'fastapi\n');
    const r = detectRepoStack(tmp);
    assert.equal(r.stack, 'mixed');
    assert.equal(r.pythonFramework, 'fastapi');
  });

  it('returns unknown when no markers found', () => {
    const r = detectRepoStack(tmp);
    assert.equal(r.stack, 'unknown');
    assert.equal(r.pythonFramework, null);
    assert.deepEqual(r.detectedFrom, []);
  });

  it('empty package.json does not count as js-ts', () => {
    write('package.json', JSON.stringify({}));
    const r = detectRepoStack(tmp);
    assert.notEqual(r.stack, 'js-ts');
  });

  it('package.json with deps + requirements → mixed', () => {
    write('package.json', JSON.stringify({ dependencies: { x: '1' } }));
    write('requirements.txt', 'django>=5\n');
    const r = detectRepoStack(tmp);
    assert.equal(r.stack, 'mixed');
    assert.equal(r.pythonFramework, 'django');
  });

  it('invalid JSON in package.json treated as no js-ts', () => {
    write('package.json', '{invalid');
    write('pyproject.toml', '');
    const r = detectRepoStack(tmp);
    assert.equal(r.stack, 'python');
  });
});

describe('detectPythonFramework', () => {
  it('detects fastapi in requirements.txt', () => {
    write('requirements.txt', 'fastapi==0.110\nuvicorn\n');
    assert.equal(detectPythonFramework(tmp), 'fastapi');
  });

  it('detects django from manage.py even without deps file', () => {
    write('manage.py', '#!/usr/bin/env python\n');
    assert.equal(detectPythonFramework(tmp), 'django');
  });

  it('detects flask from pyproject.toml', () => {
    write('pyproject.toml', '[project]\ndependencies = ["flask>=3.0"]\n');
    assert.equal(detectPythonFramework(tmp), 'flask');
  });

  it('prefers fastapi when multiple present (ordering)', () => {
    write('requirements.txt', 'fastapi\nflask\n');
    assert.equal(detectPythonFramework(tmp), 'fastapi');
  });

  it('returns none when no framework detected', () => {
    write('requirements.txt', 'numpy\npandas\n');
    assert.equal(detectPythonFramework(tmp), 'none');
  });
});

describe('detectPythonEnvironmentManager', () => {
  it('detects poetry from lockfile', () => {
    write('poetry.lock', '');
    assert.equal(detectPythonEnvironmentManager(tmp), 'poetry');
  });

  it('detects uv from lockfile or toml', () => {
    write('uv.lock', '');
    assert.equal(detectPythonEnvironmentManager(tmp), 'uv');
  });

  it('detects pipenv from lockfile', () => {
    write('Pipfile.lock', '');
    assert.equal(detectPythonEnvironmentManager(tmp), 'pipenv');
  });

  it('detects plain venv', () => {
    fs.mkdirSync(path.join(tmp, '.venv'));
    assert.equal(detectPythonEnvironmentManager(tmp), 'venv');
  });

  it('returns none when no env manager detected', () => {
    assert.equal(detectPythonEnvironmentManager(tmp), 'none');
  });

  it('poetry takes priority when multiple markers present', () => {
    write('poetry.lock', '');
    write('uv.lock', '');
    assert.equal(detectPythonEnvironmentManager(tmp), 'poetry');
  });
});
