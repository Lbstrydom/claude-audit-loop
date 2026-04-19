/**
 * @fileoverview Repo-root discovery and scope target path resolution.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Discover the repo root by walking up from cwd.
 * Looks for .git (directory or file, for worktrees).
 * @param {string} [startDir=process.cwd()]
 * @returns {string} Absolute path to repo root
 */
export function findRepoRoot(startDir = process.cwd()) {
  let current = path.resolve(startDir);
  const root = path.parse(current).root;
  let outermost = null;

  while (current !== root) {
    const gitPath = path.join(current, '.git');
    if (fs.existsSync(gitPath)) {
      outermost = current; // keep walking up for outermost
    }
    current = path.dirname(current);
  }

  if (outermost) return outermost;

  // Fallback: look for package.json
  current = path.resolve(startDir);
  while (current !== root) {
    if (fs.existsSync(path.join(current, 'package.json'))) return current;
    current = path.dirname(current);
  }

  return startDir;
}

/**
 * Resolve target paths for a skill based on surface selection.
 * @param {string} skillName
 * @param {string} surface - 'claude' | 'copilot' | 'agents' | 'both'
 * @param {string} repoRoot
 * @returns {Array<{ surface: string, dir: string, filePath: string, scope: 'global'|'repo' }>}
 */
export function resolveSkillTargets(skillName, surface, repoRoot) {
  const targets = [];
  const home = os.homedir();

  if (surface === 'claude' || surface === 'both') {
    const dir = path.join(home, '.claude', 'skills', skillName);
    targets.push({ surface: 'claude', dir, filePath: path.join(dir, 'SKILL.md'), scope: 'global' });
  }

  if (surface === 'copilot' || surface === 'both') {
    const dir = path.join(repoRoot, '.github', 'skills', skillName);
    targets.push({ surface: 'copilot', dir, filePath: path.join(dir, 'SKILL.md'), scope: 'repo' });
  }

  if (surface === 'agents' || surface === 'both') {
    const dir = path.join(repoRoot, '.agents', 'skills', skillName);
    targets.push({ surface: 'agents', dir, filePath: path.join(dir, 'SKILL.md'), scope: 'repo' });
  }

  return targets;
}

/**
 * Resolve target paths for ALL files of a multi-file skill (manifest v2).
 * Returns per-file entries so the installer can write references/ and examples/
 * content, not just SKILL.md.
 *
 * @param {string} skillName
 * @param {string} surface - 'claude' | 'copilot' | 'agents' | 'both'
 * @param {string} repoRoot
 * @param {Array<{ relPath: string, sha: string, size: number }>} files - from manifest v2 skill.files
 * @returns {Array<{ surface: string, dir: string, filePath: string, relPath: string, scope: 'global'|'repo' }>}
 */
export function resolveSkillFiles(skillName, surface, repoRoot, files) {
  const surfaceTargets = resolveSkillTargets(skillName, surface, repoRoot);
  const expanded = [];
  for (const t of surfaceTargets) {
    for (const f of files) {
      expanded.push({
        surface: t.surface,
        scope: t.scope,
        dir: t.dir,
        relPath: f.relPath,
        filePath: path.join(t.dir, f.relPath),
      });
    }
  }
  return expanded;
}

/**
 * Get the receipt file path for a given scope.
 * - `global` — `~/.audit-loop-install-receipt.json` — tracks files installed
 *   to the user's `~/.claude/skills/` directory (claude surface).
 * - `repo`   — `<repoRoot>/.audit-loop-install-receipt.json` — tracks files
 *   installed into the repo (copilot + agents surfaces).
 *
 * Splitting by scope fixes the G2 bug: claude-surface files live in
 * `~/.claude/skills/` but were previously recorded in the repo receipt using
 * machine-specific `../../../../Users/<name>/...` relative paths.
 * @param {'repo'|'global'} scope
 * @param {string} repoRoot
 * @returns {string}
 */
export function receiptPath(scope, repoRoot) {
  if (scope === 'global') {
    return path.join(os.homedir(), '.audit-loop-install-receipt.json');
  }
  return path.join(repoRoot, '.audit-loop-install-receipt.json');
}

/**
 * Partition managed-file entries by scope. Callers use this to split a single
 * install batch into two receipts (global for claude surface, repo for others).
 *
 * @param {Array<{ scope?: 'global'|'repo', path?: string, skill?: string, sha?: string, blockSha?: string, merged?: boolean }>} managedFiles
 * @returns {{ global: Array, repo: Array }}
 */
export function partitionManagedFilesByScope(managedFiles) {
  const global = [];
  const repo = [];
  for (const mf of managedFiles) {
    if (mf.scope === 'global') global.push(mf);
    else repo.push(mf);
  }
  return { global, repo };
}
