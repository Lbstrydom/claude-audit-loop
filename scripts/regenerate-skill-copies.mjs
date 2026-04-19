#!/usr/bin/env node
/**
 * @fileoverview One-way generation: byte-copy skills from the authoritative
 * `skills/` tree to `.claude/skills/` and `.github/skills/`.
 *
 * - The top-level `skills/` directory is the ONLY place authors edit.
 * - `.claude/skills/` and `.github/skills/` are always generated — never edited directly.
 * - Prunes files in the destination that are no longer in the source (skill
 *   deleted, ref file renamed) so destinations exactly mirror source.
 *
 * Uses `scripts/lib/skill-packaging.mjs` for the file allowlist — non-markdown
 * and dotfile files never propagate.
 *
 * Usage:
 *   node scripts/regenerate-skill-copies.mjs              # do it
 *   node scripts/regenerate-skill-copies.mjs --dry-run    # report, no writes
 *   node scripts/regenerate-skill-copies.mjs --check      # exit 1 if out of sync
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

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC_ROOT = path.join(ROOT, 'skills');
const DEST_ROOTS = [
  path.join(ROOT, '.claude', 'skills'),
  path.join(ROOT, '.github', 'skills'),
];

const G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', X = '\x1b[0m', D = '\x1b[2m', B = '\x1b[1m';

function sha(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
}

function main() {
  const DRY = process.argv.includes('--dry-run');
  const CHECK = process.argv.includes('--check');

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
