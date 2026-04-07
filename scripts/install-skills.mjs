#!/usr/bin/env node
/**
 * @fileoverview Install engineering skills to consumer repos.
 * Thin CLI wrapper composing lib/install/ modules.
 *
 * Usage (from engineering-skills repo):
 *   node scripts/install-skills.mjs --local --target /path/to/consumer-repo
 *   node scripts/install-skills.mjs --local --target /path/to/repo --surface copilot
 *   node scripts/install-skills.mjs --local --target /path/to/repo --dry-run
 *
 * The --target flag is REQUIRED for cross-repo installs. Without it, the installer
 * targets the current repo (useful for self-install/testing only).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ManifestSchema } from './lib/schemas-install.mjs';
import { findRepoRoot, resolveSkillTargets, receiptPath } from './lib/install/surface-paths.mjs';
import { readReceipt, writeReceipt, buildReceipt } from './lib/install/receipt.mjs';
import { detectConflicts, computeFileSha } from './lib/install/conflict-detector.mjs';
import { mergeBlock, COPILOT_BLOCK } from './lib/install/merge.mjs';
import { executeTransaction } from './lib/install/transaction.mjs';
import { ensureAuditGitignore } from './lib/install/gitignore.mjs';

const G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', D = '\x1b[2m', B = '\x1b[1m', X = '\x1b[0m';

function parseArgs(argv) {
  const args = {
    local: false,
    remote: false,
    surface: 'both',
    skills: null,
    force: false,
    dryRun: false,
    target: null,
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
  // Default: local if skills/ exists, remote otherwise
  if (!args.local && !args.remote) {
    args.local = fs.existsSync(path.resolve('skills'));
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);

  // --target is the consumer repo; without it, we use CWD (self-install)
  const repoRoot = args.target || findRepoRoot();

  // Validate target repo exists and looks like a repo
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

  // Load manifest
  let manifest;
  if (args.local) {
    const manifestPath = path.resolve('skills.manifest.json');
    if (!fs.existsSync(manifestPath)) {
      console.error(`${R}Error${X}: skills.manifest.json not found. Run: node scripts/build-manifest.mjs`);
      process.exit(1);
    }
    manifest = ManifestSchema.parse(JSON.parse(fs.readFileSync(manifestPath, 'utf-8')));
  } else {
    console.error(`${R}Error${X}: --remote mode not implemented yet (Phase F follow-up)`);
    process.exit(1);
  }

  // Filter skills
  const skillNames = args.skills || Object.keys(manifest.skills);
  const availableSkills = skillNames.filter(s => manifest.skills[s]);
  if (availableSkills.length === 0) {
    console.error(`${R}Error${X}: no matching skills in manifest`);
    process.exit(1);
  }

  console.log(`  Skills: ${availableSkills.join(', ')}`);

  // Prepare writes
  const writes = [];
  const managedFiles = [];

  for (const skillName of availableSkills) {
    const meta = manifest.skills[skillName];
    const sourcePath = path.resolve(meta.path);
    if (!fs.existsSync(sourcePath)) {
      console.error(`${R}Error${X}: source file missing: ${meta.path}`);
      process.exit(1);
    }
    const content = fs.readFileSync(sourcePath);
    const sha = crypto.createHash('sha256').update(content).digest('hex').slice(0, 12);

    // Verify SHA matches manifest
    if (sha !== meta.sha) {
      console.error(`${R}Error${X}: SHA mismatch for ${skillName} (manifest: ${meta.sha}, actual: ${sha}). Run: node scripts/build-manifest.mjs`);
      process.exit(1);
    }

    const targets = resolveSkillTargets(skillName, args.surface, repoRoot);
    for (const target of targets) {
      writes.push({
        path: path.relative(repoRoot, target.filePath).replace(/\\/g, '/'),
        absPath: target.filePath,
        content,
        sha,
      });
      managedFiles.push({
        path: path.relative(repoRoot, target.filePath).replace(/\\/g, '/'),
        sha,
        skill: skillName,
      });
    }
  }

  // Add copilot-instructions merge (for copilot or both surface)
  if (args.surface === 'copilot' || args.surface === 'both') {
    const copilotPath = path.join(repoRoot, '.github', 'copilot-instructions.md');
    const existing = fs.existsSync(copilotPath)
      ? fs.readFileSync(copilotPath, 'utf-8')
      : null;
    const merged = mergeBlock(existing);
    const blockSha = crypto.createHash('sha256')
      .update(COPILOT_BLOCK).digest('hex').slice(0, 12);

    writes.push({
      path: '.github/copilot-instructions.md',
      absPath: copilotPath,
      content: Buffer.from(merged, 'utf-8'),
      sha: blockSha,
    });
    managedFiles.push({
      path: '.github/copilot-instructions.md',
      sha: blockSha, // Actually blockSha but keep consistent
      blockSha,
      merged: true,
    });
  }

  // Read existing receipt
  const repoReceiptPath = receiptPath('repo', repoRoot);
  const { receipt: existingReceipt } = readReceipt(repoReceiptPath);

  // Detect conflicts
  const { safe, conflicts } = detectConflicts(writes, existingReceipt, { force: args.force });

  if (conflicts.length > 0) {
    console.log(`\n${R}Conflicts detected:${X}`);
    for (const c of conflicts) {
      console.log(`  ${R}x${X} ${c.path}: ${c.reason}`);
    }
    if (!args.force) {
      console.log(`\nUse --force to overwrite, or resolve conflicts first.`);
      process.exit(1);
    }
  }

  if (args.dryRun) {
    console.log(`\n${Y}Would write ${safe.length} files:${X}`);
    for (const w of safe) {
      console.log(`  ${w.path}`);
    }
    process.exit(0);
  }

  // Execute transaction
  const result = executeTransaction(safe.map(w => ({ absPath: w.absPath, content: w.content })));

  if (!result.success) {
    console.error(`${R}Install failed${X}: ${result.error}`);
    console.error('All changes have been rolled back.');
    process.exit(1);
  }

  // Write receipt
  const receipt = buildReceipt({
    bundleVersion: manifest.bundleVersion,
    sourceUrl: manifest.rawUrlBase,
    surface: args.surface,
    managedFiles,
  });
  writeReceipt(repoReceiptPath, receipt);

  // Ensure audit-loop artifacts are gitignored in target repo
  ensureAuditGitignore(repoRoot, { dryRun: args.dryRun });

  // Install npm dependencies in target repo
  const hasPkg = fs.existsSync(path.join(repoRoot, 'package.json'));
  if (hasPkg) {
    const REQUIRED_DEPS = ['openai', 'zod', 'dotenv', 'micromatch'];
    // Optional: enhance audit quality but core loop works without them
    const OPTIONAL_DEPS = ['@google/genai', 'proper-lockfile', '@anthropic-ai/sdk'];
    // Supabase is only needed if user configures cloud learning store
    // (SUPABASE_AUDIT_URL + SUPABASE_AUDIT_ANON_KEY in .env)

    // Check which deps are already installed
    const nodeModules = path.join(repoRoot, 'node_modules');
    const missing = REQUIRED_DEPS.filter(d => !fs.existsSync(path.join(nodeModules, d)));
    const missingOptional = OPTIONAL_DEPS.filter(d => !fs.existsSync(path.join(nodeModules, d)));

    if (missing.length > 0 || missingOptional.length > 0) {
      console.log(`\n${D}Installing audit-loop dependencies in target repo...${X}`);
      try {
        if (missing.length > 0) {
          console.log(`  Required: ${missing.join(', ')}`);
          execFileSync('npm', ['install', '--save-dev', ...missing], {
            cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'], timeout: 120000
          });
          console.log(`  ${G}✓${X} Required deps installed`);
        }
        if (missingOptional.length > 0) {
          console.log(`  Optional: ${missingOptional.join(', ')}`);
          try {
            execFileSync('npm', ['install', '--save-dev', '--legacy-peer-deps', ...missingOptional], {
              cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'], timeout: 120000
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
    // Supabase hint — only if env vars are set but package is missing
    if (process.env.SUPABASE_AUDIT_URL && !fs.existsSync(path.join(nodeModules, '@supabase', 'supabase-js'))) {
      console.log(`  ${Y}○${X} SUPABASE_AUDIT_URL is set but @supabase/supabase-js is not installed`);
      console.log(`    Run: cd ${repoRoot} && npm install --save-dev @supabase/supabase-js`);
    }
  } else {
    console.log(`\n  ${Y}○${X} No package.json in target — skipping dependency install`);
    console.log(`  To install manually: npm install openai zod dotenv micromatch`);
  }

  console.log(`\n${G}Installed ${result.written} files${X}`);
  console.log(`  Bundle version: ${manifest.bundleVersion}`);
  console.log(`  Receipt: ${path.relative(repoRoot, repoReceiptPath)}`);
  for (const w of safe) {
    console.log(`  ${G}+${X} ${w.path}`);
  }
}

try {
  main();
} catch (err) {
  console.error(`${R}Install error${X}: ${err.message}`);
  process.exit(1);
}
