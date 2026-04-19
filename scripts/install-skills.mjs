#!/usr/bin/env node
/**
 * @fileoverview Install engineering skills to consumer repos.
 *
 * **Version-gated entrypoint** (Phase B.1): reads `schemaVersion` BEFORE
 * parsing the manifest. v1 and v2 manifests are supported; anything else
 * exits with `UNSUPPORTED_MANIFEST_VERSION` and the minimum installer
 * version required.
 *
 * **Multi-file skills** (v2): when a skill entry has a `files[]` array,
 * every file (SKILL.md + references, examples) is installed into the
 * skill's target directory. Files previously managed
 * that are no longer in the manifest are deleted as part of the same
 * transaction (with orphan-protection for user-modified files).
 *
 * **Receipt scoping** (G2 fix): claude-surface files live in
 * `~/.claude/skills/` and are tracked in a global receipt at
 * `~/.audit-loop-install-receipt.json`. Repo-surface files (copilot,
 * agents) stay in the repo receipt. No more cross-home-directory
 * relative paths.
 *
 * **Copilot merge idempotency** (G3 fix): `managedFiles.sha` for the
 * merged `copilot-instructions.md` is the SHA of the final merged
 * content, not the inserted block alone. `blockSha` is kept as a separate
 * metadata field for block-update detection.
 *
 * Usage:
 *   node scripts/install-skills.mjs --local --target /path/to/consumer-repo
 *   node scripts/install-skills.mjs --local --target /path/to/repo --surface copilot
 *   node scripts/install-skills.mjs --local --target /path/to/repo --dry-run
 *
 * The --target flag is REQUIRED for cross-repo installs. Without it, the
 * installer targets the current repo (useful for self-install/testing only).
 *
 * @module scripts/install-skills
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ManifestSchema, MANIFEST_SUPPORTED_VERSIONS } from './lib/schemas-install.mjs';
import {
  findRepoRoot, resolveSkillFiles,
  receiptPath, partitionManagedFilesByScope,
} from './lib/install/surface-paths.mjs';
import { readReceipt, writeReceipt, buildReceipt } from './lib/install/receipt.mjs';
import { detectConflicts } from './lib/install/conflict-detector.mjs';
import { mergeBlock, COPILOT_BLOCK } from './lib/install/merge.mjs';
import { executeTransaction, recoverFromJournal } from './lib/install/transaction.mjs';
import { ensureAuditGitignore } from './lib/install/gitignore.mjs';

const G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', D = '\x1b[2m', B = '\x1b[1m', X = '\x1b[0m';

const MIN_INSTALLER_FOR_V2 = 'v2 (multi-file skills — Phase B.1)';

function parseArgs(argv) {
  const args = {
    local: false, remote: false, surface: 'both', skills: null,
    force: false, dryRun: false, target: null,
  };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--local': args.local = true; break;
      case '--remote': args.remote = true; break;
      case '--surface': args.surface = argv[++i]; break;
      case '--skills': args.skills = argv[++i]?.split(','); break;
      case '--force': args.force = true; break;
      case '--dry-run': args.dryRun = true; break;
      case '--target': case '--repo-root': args.target = path.resolve(argv[++i]); break;
    }
  }
  if (!args.local && !args.remote) {
    args.local = fs.existsSync(path.resolve('skills'));
  }
  return args;
}

/**
 * Load + validate a manifest file with version gating.
 * Rejects unsupported versions with a clear error before Zod parses the body.
 */
function loadManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) {
    console.error(`${R}Error${X}: skills.manifest.json not found. Run: node scripts/build-manifest.mjs`);
    process.exit(1);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch (err) {
    console.error(`${R}Error${X}: manifest is not valid JSON: ${err.message}`);
    process.exit(1);
  }

  const v = raw?.schemaVersion;
  if (typeof v !== 'number' || !MANIFEST_SUPPORTED_VERSIONS.includes(v)) {
    console.error(`${R}UNSUPPORTED_MANIFEST_VERSION${X}: manifest declares schemaVersion=${v}`);
    console.error(`  This installer supports: ${MANIFEST_SUPPORTED_VERSIONS.join(', ')}`);
    console.error(`  Minimum installer for this manifest: ${MIN_INSTALLER_FOR_V2}`);
    console.error(`  Update the installer: git pull in the engineering-skills repo`);
    process.exit(1);
  }

  return ManifestSchema.parse(raw);
}

/**
 * Compute the expanded file list for a skill:
 * - v2 manifest + `files[]` present → use it as-is.
 * - v1 manifest or v2 without `files[]` → treat as single-file skill (SKILL.md only).
 */
function expandSkillFiles(skillName, meta) {
  if (Array.isArray(meta.files) && meta.files.length > 0) {
    return meta.files.map(f => ({ ...f }));
  }
  // Back-compat: legacy v1 manifest or v2 entry without files array
  return [{ relPath: 'SKILL.md', sha: meta.sha, size: meta.size }];
}

function fileShaShort(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
}

function main() {
  const args = parseArgs(process.argv);
  const repoRoot = args.target || findRepoRoot();

  if (args.target) {
    if (!fs.existsSync(args.target)) {
      console.error(`${R}Error${X}: target directory does not exist: ${args.target}`);
      process.exit(1);
    }
    const hasGit = fs.existsSync(path.join(args.target, '.git'));
    const hasPkg = fs.existsSync(path.join(args.target, 'package.json'));
    if (!hasGit && !hasPkg) {
      console.error(`${Y}Warning${X}: target has no .git or package.json — are you sure this is a repo?`);
    }
  }

  console.log(`${B}Engineering Skills Installer${X}`);
  console.log(`  Mode: ${args.local ? 'local' : 'remote'}`);
  console.log(`  Surface: ${args.surface}`);
  console.log(`  Target repo: ${repoRoot}`);
  if (args.target) console.log(`  ${D}(cross-repo install from ${process.cwd()})${X}`);
  if (args.dryRun) console.log(`  ${Y}DRY RUN — no files will be written${X}`);
  console.log('');

  // Crash recovery — reconcile any leftover journal before starting
  const globalReceiptPath = receiptPath('global', repoRoot);
  const repoReceiptPath = receiptPath('repo', repoRoot);
  for (const journalBase of [repoRoot, path.dirname(globalReceiptPath)]) {
    const jp = path.join(journalBase, '.audit-loop-install-txn.json');
    const rec = recoverFromJournal(jp);
    if (rec.recovered) {
      console.log(`  ${Y}Journal recovered${X} (${jp}): rolled-forward=${rec.rolledForward} rolled-back=${rec.rolledBack}`);
    }
  }

  if (!args.local) {
    console.error(`${R}Error${X}: --remote mode not implemented yet (Phase F follow-up)`);
    process.exit(1);
  }

  const manifest = loadManifest(path.resolve('skills.manifest.json'));
  console.log(`  Manifest: schemaVersion ${manifest.schemaVersion} · bundleVersion ${manifest.bundleVersion}`);

  const skillNames = args.skills || Object.keys(manifest.skills);
  const availableSkills = skillNames.filter(s => manifest.skills[s]);
  if (availableSkills.length === 0) {
    console.error(`${R}Error${X}: no matching skills in manifest`);
    process.exit(1);
  }
  console.log(`  Skills: ${availableSkills.join(', ')}`);

  // ── Build write list (per-file, per-surface) ─────────────────────────────
  const writes = [];
  const managedFiles = [];

  for (const skillName of availableSkills) {
    const meta = manifest.skills[skillName];
    const skillSrcDir = path.resolve('skills', skillName);
    const files = expandSkillFiles(skillName, meta);
    const surfaces = resolveSkillFiles(skillName, args.surface, repoRoot, files);

    for (const t of surfaces) {
      const srcPath = path.join(skillSrcDir, t.relPath);
      if (!fs.existsSync(srcPath)) {
        console.error(`${R}Error${X}: source file missing for ${skillName}: ${t.relPath}`);
        process.exit(1);
      }
      const content = fs.readFileSync(srcPath);
      const sha = fileShaShort(content);

      // Verify SHA matches manifest (per-file validation)
      const manifestFile = files.find(f => f.relPath === t.relPath);
      if (manifestFile && sha !== manifestFile.sha) {
        console.error(
          `${R}Error${X}: SHA mismatch for ${skillName}/${t.relPath} ` +
          `(manifest: ${manifestFile.sha}, actual: ${sha}). Run: node scripts/build-manifest.mjs`,
        );
        process.exit(1);
      }

      const recordPath = t.scope === 'global'
        ? t.filePath            // absolute path for global receipt (G2 fix)
        : path.relative(repoRoot, t.filePath).replace(/\\/g, '/');
      writes.push({ path: recordPath, absPath: t.filePath, content, sha, scope: t.scope });
      managedFiles.push({ path: recordPath, sha, skill: skillName, scope: t.scope });
    }
  }

  // ── Copilot-instructions merge (G3 fix: final-merged SHA, not blockSha) ──
  if (args.surface === 'copilot' || args.surface === 'both') {
    const copilotPath = path.join(repoRoot, '.github', 'copilot-instructions.md');
    const existing = fs.existsSync(copilotPath) ? fs.readFileSync(copilotPath, 'utf-8') : null;
    const merged = mergeBlock(existing);
    const mergedBuf = Buffer.from(merged, 'utf-8');
    const mergedSha = fileShaShort(mergedBuf);
    const blockSha = crypto.createHash('sha256').update(COPILOT_BLOCK).digest('hex').slice(0, 12);

    const recordPath = path.relative(repoRoot, copilotPath).replace(/\\/g, '/');
    writes.push({ path: recordPath, absPath: copilotPath, content: mergedBuf, sha: mergedSha, scope: 'repo' });
    managedFiles.push({
      path: recordPath,
      sha: mergedSha,        // G3 fix: SHA of final merged file, matches on-disk SHA
      blockSha,              // separate metadata for block-update detection
      skill: null,
      merged: true,
      scope: 'repo',
    });
  }

  // ── Lifecycle: compute deletes from previous receipts vs new manifest ────
  const { receipt: prevGlobalReceipt } = readReceipt(globalReceiptPath);
  const { receipt: prevRepoReceipt } = readReceipt(repoReceiptPath);
  const newAbsPaths = new Set(writes.map(w => w.absPath));
  const deletes = [];
  for (const prev of [prevGlobalReceipt, prevRepoReceipt]) {
    if (!prev?.managedFiles) continue;
    for (const mf of prev.managedFiles) {
      // scope check: global-receipt entries store absolute paths; repo store relative
      const prevAbsPath = mf.scope === 'global'
        ? mf.path
        : path.join(repoRoot, mf.path);
      if (!newAbsPaths.has(prevAbsPath)) {
        deletes.push({ absPath: prevAbsPath, expectedSha: mf.sha });
      }
    }
  }

  // ── Conflict detection ──────────────────────────────────────────────────
  const { safe, conflicts } = detectConflicts(writes, prevRepoReceipt, { force: args.force });
  const { safe: safeGlobal, conflicts: conflictsGlobal } = detectConflicts(
    writes.filter(w => w.scope === 'global'),
    prevGlobalReceipt, { force: args.force },
  );
  const allConflicts = [...conflicts.filter(c => writes.find(w => w.path === c.path)?.scope !== 'global'), ...conflictsGlobal];
  const allSafe = [...safe.filter(s => s.scope !== 'global'), ...safeGlobal];

  if (allConflicts.length > 0) {
    console.log(`\n${R}Conflicts detected:${X}`);
    for (const c of allConflicts) console.log(`  ${R}x${X} ${c.path}: ${c.reason}`);
    if (!args.force) {
      console.log(`\nUse --force to overwrite, or resolve conflicts first.`);
      process.exit(1);
    }
  }

  if (args.dryRun) {
    console.log(`\n${Y}Would write ${allSafe.length} files, delete ${deletes.length}:${X}`);
    for (const w of allSafe) console.log(`  ${G}+${X} ${w.path} ${D}(${w.scope})${X}`);
    for (const d of deletes) console.log(`  ${R}-${X} ${d.absPath}`);
    process.exit(0);
  }

  // ── Execute transaction (crash-safe WAL) ────────────────────────────────
  const result = executeTransaction({
    writes: allSafe.map(w => ({ absPath: w.absPath, content: w.content })),
    deletes,
    journalPath: path.join(repoRoot, '.audit-loop-install-txn.json'),
  });

  if (!result.success) {
    console.error(`${R}Install failed${X}: ${result.error}`);
    console.error('All changes have been rolled back.');
    process.exit(1);
  }

  for (const skip of result.skippedDeletes) {
    console.log(`  ${Y}○${X} ${skip.absPath}: ${skip.reason}`);
  }

  // ── Write receipts (split by scope — G2 fix) ────────────────────────────
  const { global: globalManaged, repo: repoManaged } = partitionManagedFilesByScope(managedFiles);

  if (repoManaged.length > 0) {
    const receipt = buildReceipt({
      bundleVersion: manifest.bundleVersion,
      sourceUrl: manifest.rawUrlBase,
      surface: args.surface,
      managedFiles: repoManaged,
    });
    writeReceipt(repoReceiptPath, receipt);
  }
  if (globalManaged.length > 0) {
    const receipt = buildReceipt({
      bundleVersion: manifest.bundleVersion,
      sourceUrl: manifest.rawUrlBase,
      surface: args.surface,
      managedFiles: globalManaged,
    });
    writeReceipt(globalReceiptPath, receipt);
  }

  ensureAuditGitignore(repoRoot, { dryRun: args.dryRun });

  // ── npm deps (unchanged) ─────────────────────────────────────────────────
  const hasPkg = fs.existsSync(path.join(repoRoot, 'package.json'));
  if (hasPkg) {
    const REQUIRED_DEPS = ['openai', 'zod', 'dotenv', 'micromatch', '@google/genai', '@anthropic-ai/sdk'];
    const OPTIONAL_DEPS = ['proper-lockfile'];
    const nodeModules = path.join(repoRoot, 'node_modules');
    const missing = REQUIRED_DEPS.filter(d => !fs.existsSync(path.join(nodeModules, d)));
    const missingOptional = OPTIONAL_DEPS.filter(d => !fs.existsSync(path.join(nodeModules, d)));

    if (missing.length > 0 || missingOptional.length > 0) {
      console.log(`\n${D}Installing audit-loop dependencies in target repo...${X}`);
      try {
        if (missing.length > 0) {
          console.log(`  Required: ${missing.join(', ')}`);
          execFileSync('npm', ['install', '--save-dev', ...missing], {
            cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'], timeout: 120000,
          });
          console.log(`  ${G}✓${X} Required deps installed`);
        }
        if (missingOptional.length > 0) {
          console.log(`  Optional: ${missingOptional.join(', ')}`);
          try {
            execFileSync('npm', ['install', '--save-dev', '--legacy-peer-deps', ...missingOptional], {
              cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'], timeout: 120000,
            });
            console.log(`  ${G}✓${X} Optional deps installed`);
          } catch {
            console.log(`  ${Y}○${X} Some optional deps failed — audit will degrade gracefully`);
          }
        }
      } catch (err) {
        console.error(`  ${Y}⚠${X} npm install failed: ${err.message?.slice(0, 150)}`);
        console.error(`  Run manually: cd ${repoRoot} && npm install --save-dev ${missing.join(' ')}`);
      }
    } else {
      console.log(`\n  ${G}✓${X} All audit-loop dependencies already installed`);
    }
    if (process.env.SUPABASE_AUDIT_URL && !fs.existsSync(path.join(nodeModules, '@supabase', 'supabase-js'))) {
      console.log(`  ${Y}○${X} SUPABASE_AUDIT_URL is set but @supabase/supabase-js is not installed`);
      console.log(`    Run: cd ${repoRoot} && npm install --save-dev @supabase/supabase-js`);
    }
  } else {
    console.log(`\n  ${Y}○${X} No package.json in target — skipping dependency install`);
    console.log(`  To install manually: npm install openai zod dotenv micromatch @google/genai @anthropic-ai/sdk`);
  }

  console.log(`\n${G}Installed ${result.written} files${X}${result.deleted ? `, deleted ${result.deleted}` : ''}`);
  console.log(`  Bundle version: ${manifest.bundleVersion}`);
  if (repoManaged.length > 0) {
    console.log(`  Repo receipt: ${path.relative(repoRoot, repoReceiptPath)}`);
  }
  if (globalManaged.length > 0) {
    console.log(`  Global receipt: ${globalReceiptPath}`);
  }
  for (const w of allSafe) console.log(`  ${G}+${X} ${w.path} ${D}(${w.scope})${X}`);
}

try {
  main();
} catch (err) {
  console.error(`${R}Install error${X}: ${err.message}`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
}
