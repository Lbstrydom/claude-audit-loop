#!/usr/bin/env node
/**
 * @fileoverview One-way generation: byte-copy skills from the authoritative
 * `skills/` tree to `.claude/skills/` (and optionally `.github/skills/`).
 *
 * - The top-level `skills/` directory is the ONLY place authors edit.
 * - `.claude/skills/` is always generated — never edited directly.
 * - `.github/skills/` is **deprecated** as of Phase 4 of ai-context-sync —
 *   no documented tool reads it. Pass `--keep-github-skills` to keep
 *   regenerating it during the deprecation window. Removed in next minor.
 * - Prunes files in the destination that are no longer in the source so
 *   destinations exactly mirror source.
 *
 * Uses `scripts/lib/skill-packaging.mjs` for the file allowlist — non-markdown
 * and dotfile files never propagate.
 *
 * Usage:
 *   node scripts/regenerate-skill-copies.mjs                     # default: only .claude/skills/
 *   node scripts/regenerate-skill-copies.mjs --keep-github-skills # also write .github/skills/
 *   node scripts/regenerate-skill-copies.mjs --dry-run           # report, no writes
 *   node scripts/regenerate-skill-copies.mjs --check             # exit 1 if out of sync
 *
 * Exit codes:
 *   0 = success (or --check: in sync)
 *   1 = --check: destinations differ from source
 *   2 = bad input / allowlist violation
 *
 * @module scripts/regenerate-skill-copies
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { enumerateSkillFiles, listSkillNames } from './lib/skill-packaging.mjs';
import { generateAllPromptFiles } from './lib/install/copilot-prompts.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC_ROOT = path.join(ROOT, 'skills');

const KEEP_GITHUB_SKILLS = process.argv.includes('--keep-github-skills');

const DEST_ROOTS = [
  path.join(ROOT, '.claude', 'skills'),
  ...(KEEP_GITHUB_SKILLS ? [path.join(ROOT, '.github', 'skills')] : []),
];

const G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', X = '\x1b[0m', D = '\x1b[2m', B = '\x1b[1m';

function sha(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
}

function main() {
  const DRY = process.argv.includes('--dry-run');
  const CHECK = process.argv.includes('--check');

  // Phase-4 deprecation: warn when stale .github/skills/ files are present
  // and the user has NOT opted into keeping them. The files are not deleted
  // here — operators remove them once they confirm nothing reads them.
  const ghSkillsDir = path.join(ROOT, '.github', 'skills');
  if (!KEEP_GITHUB_SKILLS && fs.existsSync(ghSkillsDir)) {
    process.stderr.write(
      `${Y}[regenerate] DEPRECATION: .github/skills/ is no longer maintained ` +
      `(no documented tool reads it).\n` +
      `  Existing files at ${path.relative(ROOT, ghSkillsDir)} are not deleted ` +
      `by this run. To preserve them and keep regenerating, pass --keep-github-skills.\n` +
      `  Once confirmed unused, delete the directory manually.${X}\n`
    );
  }

  if (!fs.existsSync(SRC_ROOT)) {
    process.stderr.write(`${R}skills/ does not exist at ${SRC_ROOT}${X}\n`);
    process.exit(2);
  }

  const skills = listSkillNames(SRC_ROOT);
  if (skills.length === 0) {
    process.stderr.write(`${R}No skills found under ${SRC_ROOT}${X}\n`);
    process.exit(2);
  }

  let writes = 0, deletes = 0, unchanged = 0;
  const violations = [];

  for (const name of skills) {
    const skillSrcDir = path.join(SRC_ROOT, name);
    let srcFiles;
    try {
      srcFiles = enumerateSkillFiles(skillSrcDir, { strict: true });
    } catch (err) {
      process.stderr.write(`${R}${name}: ${err.message}${X}\n`);
      violations.push(`${name}: ${err.message}`);
      continue;
    }

    for (const destRoot of DEST_ROOTS) {
      const destDir = path.join(destRoot, name);
      fs.mkdirSync(destDir, { recursive: true });

      // Write / update every file from source
      for (const rel of srcFiles) {
        const srcAbs = path.join(skillSrcDir, rel);
        const dstAbs = path.join(destDir, rel);
        fs.mkdirSync(path.dirname(dstAbs), { recursive: true });

        const srcBuf = fs.readFileSync(srcAbs);
        const dstExists = fs.existsSync(dstAbs);
        const dstBuf = dstExists ? fs.readFileSync(dstAbs) : null;

        if (dstBuf && sha(srcBuf) === sha(dstBuf)) {
          unchanged++;
          continue;
        }
        if (DRY || CHECK) {
          process.stdout.write(`${Y}~${X} ${path.relative(ROOT, dstAbs)} ${D}(${dstExists ? 'update' : 'create'})${X}\n`);
        } else {
          fs.writeFileSync(dstAbs, srcBuf);
        }
        writes++;
      }

      // Prune files in dest that are not in source
      if (fs.existsSync(destDir)) {
        const destFiles = enumerateSkillFiles(destDir, { strict: false });
        const srcSet = new Set(srcFiles);
        for (const rel of destFiles) {
          if (srcSet.has(rel)) continue;
          const dstAbs = path.join(destDir, rel);
          if (DRY || CHECK) {
            process.stdout.write(`${R}-${X} ${path.relative(ROOT, dstAbs)} ${D}(prune)${X}\n`);
          } else {
            fs.unlinkSync(dstAbs);
          }
          deletes++;
        }
      }
    }
  }

  // Also prune any orphan skill directories in dests that don't exist in source
  const srcNames = new Set(skills);
  for (const destRoot of DEST_ROOTS) {
    if (!fs.existsSync(destRoot)) continue;
    for (const ent of fs.readdirSync(destRoot, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      if (srcNames.has(ent.name)) continue;
      const dstDir = path.join(destRoot, ent.name);
      if (DRY || CHECK) {
        process.stdout.write(`${R}-${X} ${path.relative(ROOT, dstDir)}/ ${D}(prune orphan skill)${X}\n`);
      } else {
        fs.rmSync(dstDir, { recursive: true, force: true });
      }
      deletes++;
    }
  }

  // Generate Copilot prompt-file shims under .github/prompts/. Phase 3 of
  // ai-context-sync — gives VS Code Copilot teammates parity slash commands
  // backed by the same CLIs Claude skills orchestrate.
  const promptDir = path.join(ROOT, '.github', 'prompts');
  const promptEntries = generateAllPromptFiles(SRC_ROOT);
  const expectedPromptPaths = new Set();
  for (const entry of promptEntries) {
    const dstAbs = path.join(ROOT, entry.relPath);
    expectedPromptPaths.add(dstAbs);
    fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
    const dstExists = fs.existsSync(dstAbs);
    const dstContent = dstExists ? fs.readFileSync(dstAbs, 'utf-8') : null;
    if (dstContent === entry.content) {
      unchanged++;
      continue;
    }
    if (DRY || CHECK) {
      process.stdout.write(`${Y}~${X} ${path.relative(ROOT, dstAbs)} ${D}(${dstExists ? 'update' : 'create'} prompt)${X}\n`);
    } else {
      fs.writeFileSync(dstAbs, entry.content);
    }
    writes++;
  }
  // Prune stale prompt files (skill removed from registry or skill deleted)
  if (fs.existsSync(promptDir)) {
    for (const f of fs.readdirSync(promptDir)) {
      if (!f.endsWith('.prompt.md')) continue;
      const abs = path.join(promptDir, f);
      if (expectedPromptPaths.has(abs)) continue;
      // Only prune if managed (has our marker) — never delete operator-authored prompts.
      const content = fs.readFileSync(abs, 'utf-8');
      if (!content.includes('<!-- audit-loop-bundle:prompt:start -->')) continue;
      if (DRY || CHECK) {
        process.stdout.write(`${R}-${X} ${path.relative(ROOT, abs)} ${D}(prune managed prompt)${X}\n`);
      } else {
        fs.unlinkSync(abs);
      }
      deletes++;
    }
  }

  const verdict = violations.length > 0 ? 'VIOLATIONS' : (writes + deletes === 0 ? 'IN SYNC' : 'CHANGES');
  process.stdout.write(
    `\n${B}regenerate-skill-copies:${X} ${writes} write, ${deletes} prune, ${unchanged} unchanged` +
    (violations.length ? `, ${R}${violations.length} violations${X}` : '') +
    ` — ${verdict}\n`,
  );

  if (violations.length > 0) process.exit(2);
  if (CHECK && (writes + deletes) > 0) {
    process.stderr.write(`\n${R}Destinations differ from source. Run: node scripts/regenerate-skill-copies.mjs${X}\n`);
    process.exit(1);
  }
  process.exit(0);
}

main();
