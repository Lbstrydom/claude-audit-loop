#!/usr/bin/env node
/**
 * @fileoverview Interactive setup script for claude-audit-loop.
 *
 * Checks prerequisites, installs dependencies, sets up .env,
 * and copies skills to the correct location for Claude Code or VS Code Copilot.
 *
 * Usage:
 *   npx claude-audit-loop          # Run from npm (future)
 *   node setup.mjs                 # Run locally
 *   node setup.mjs --target <dir>  # Install into a specific project
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import readline from 'readline';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(resolve => rl.question(q, resolve));

const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function log(msg) { console.log(msg); }
function ok(msg) { console.log(`${GREEN}✓${RESET} ${msg}`); }
function warn(msg) { console.log(`${YELLOW}⚠${RESET} ${msg}`); }
function fail(msg) { console.log(`${RED}✗${RESET} ${msg}`); }
function heading(msg) { console.log(`\n${BOLD}${msg}${RESET}\n`); }

// ── Detect project root ────────────────────────────────────────────────────────

function findProjectRoot(startDir) {
  let dir = startDir;
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

// ── Check prerequisites ────────────────────────────────────────────────────────

function checkNode() {
  const version = process.version;
  const major = parseInt(version.slice(1));
  if (major >= 18) {
    ok(`Node.js ${version}`);
    return true;
  }
  fail(`Node.js ${version} — need v18+ for ES modules and fetch`);
  return false;
}

function checkNpm() {
  try {
    const version = execSync('npm --version', { encoding: 'utf-8' }).trim();
    ok(`npm ${version}`);
    return true;
  } catch {
    fail('npm not found');
    return false;
  }
}

function checkGit() {
  try {
    const version = execSync('git --version', { encoding: 'utf-8' }).trim();
    ok(version);
    return true;
  } catch {
    warn('git not found — not required but recommended');
    return true;
  }
}

function checkOpenAIKey(targetDir) {
  // Check env var first
  if (process.env.OPENAI_API_KEY) {
    ok(`OPENAI_API_KEY set in environment (${process.env.OPENAI_API_KEY.slice(0, 7)}...)`);
    return true;
  }
  // Check .env file
  const envPath = path.join(targetDir, '.env');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8');
    if (content.includes('OPENAI_API_KEY=sk-')) {
      ok('OPENAI_API_KEY found in .env');
      return true;
    }
  }
  warn('OPENAI_API_KEY not found — you will need to set it before running audits');
  return false;
}

// ── Check/install npm dependencies ─────────────────────────────────────────────

function checkDependencies(targetDir) {
  const pkgPath = path.join(targetDir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    warn('No package.json found — creating one');
    execSync('npm init -y', { cwd: targetDir, stdio: 'pipe' });
  }

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const needed = [];

  for (const dep of ['openai', 'zod', 'dotenv']) {
    if (deps[dep]) {
      ok(`${dep} already in package.json`);
    } else {
      needed.push(dep);
    }
  }

  // Check package.json has type: "module" (needed for ESM)
  if (pkg.type !== 'module') {
    warn('package.json missing "type": "module" — the audit script uses ES modules');
    log(`  ${DIM}Add "type": "module" to package.json, or rename the script to .mjs${RESET}`);
  }

  return needed;
}

// ── Install skills ─────────────────────────────────────────────────────────────

function installSkills(targetDir, sourceDir) {
  const results = { claude: false, copilot: false };

  // Claude Code skill
  const claudeSkillDir = path.join(targetDir, '.claude', 'skills', 'audit-loop');
  const claudeSkillSrc = path.join(sourceDir, '.claude', 'skills', 'audit-loop', 'SKILL.md');
  if (fs.existsSync(claudeSkillSrc)) {
    fs.mkdirSync(claudeSkillDir, { recursive: true });
    fs.copyFileSync(claudeSkillSrc, path.join(claudeSkillDir, 'SKILL.md'));
    ok('Claude Code skill installed → .claude/skills/audit-loop/SKILL.md');
    results.claude = true;
  }

  // VS Code Copilot skill
  const copilotSkillDir = path.join(targetDir, '.github', 'skills', 'audit-loop');
  const copilotSkillSrc = path.join(sourceDir, '.github', 'skills', 'audit-loop', 'SKILL.md');
  if (fs.existsSync(copilotSkillSrc)) {
    fs.mkdirSync(copilotSkillDir, { recursive: true });
    fs.copyFileSync(copilotSkillSrc, path.join(copilotSkillDir, 'SKILL.md'));
    ok('VS Code Copilot skill installed → .github/skills/audit-loop/SKILL.md');
    results.copilot = true;
  }

  return results;
}

// ── Install audit script ───────────────────────────────────────────────────────

function installScript(targetDir, sourceDir) {
  const scriptsDir = path.join(targetDir, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });

  const src = path.join(sourceDir, 'scripts', 'openai-audit.mjs');
  const dest = path.join(scriptsDir, 'openai-audit.mjs');

  if (fs.existsSync(dest)) {
    const existing = fs.readFileSync(dest, 'utf-8');
    const incoming = fs.readFileSync(src, 'utf-8');
    if (existing === incoming) {
      ok('scripts/openai-audit.mjs already up to date');
      return;
    }
    warn('scripts/openai-audit.mjs exists but differs — overwriting with latest');
  }

  fs.copyFileSync(src, dest);
  ok('Audit script installed → scripts/openai-audit.mjs');
}

// ── Setup .env ─────────────────────────────────────────────────────────────────

async function setupEnv(targetDir) {
  const envPath = path.join(targetDir, '.env');
  const envExamplePath = path.join(targetDir, '.env.example');

  // Copy .env.example if target doesn't have one
  const sourceExample = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '.env.example');
  if (!fs.existsSync(envExamplePath) && fs.existsSync(sourceExample)) {
    fs.copyFileSync(sourceExample, envExamplePath);
    ok('Copied .env.example template');
  }

  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8');
    if (content.includes('OPENAI_API_KEY=sk-')) {
      ok('.env already has OPENAI_API_KEY');
      return;
    }
    // .env exists but no key — append
    const key = await ask(`\n  Enter your OpenAI API key (or press Enter to skip): `);
    if (key && key.startsWith('sk-')) {
      fs.appendFileSync(envPath, `\n# Added by claude-audit-loop setup\nOPENAI_API_KEY=${key}\n`);
      ok('OPENAI_API_KEY added to .env');
    } else {
      warn('Skipped — add OPENAI_API_KEY to .env before running audits');
    }
  } else {
    const key = await ask(`\n  Enter your OpenAI API key (or press Enter to skip): `);
    if (key && key.startsWith('sk-')) {
      fs.writeFileSync(envPath, `# claude-audit-loop\nOPENAI_API_KEY=${key}\n`);
      ok('.env created with OPENAI_API_KEY');
    } else {
      fs.writeFileSync(envPath, `# claude-audit-loop\n# OPENAI_API_KEY=sk-...\n`);
      warn('.env created — add your OPENAI_API_KEY before running audits');
    }
  }

  // Ensure .env is in .gitignore
  const gitignorePath = path.join(targetDir, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    const gi = fs.readFileSync(gitignorePath, 'utf-8');
    if (!gi.includes('.env')) {
      fs.appendFileSync(gitignorePath, '\n.env\n');
      ok('Added .env to .gitignore');
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  log(`\n${BOLD}╔════════════════════════════════════════════════════╗${RESET}`);
  log(`${BOLD}║       Claude Audit Loop — Setup                    ║${RESET}`);
  log(`${BOLD}║  Claude plans → GPT-5.4 audits → Peer deliberation ║${RESET}`);
  log(`${BOLD}╚════════════════════════════════════════════════════╝${RESET}\n`);

  const args = process.argv.slice(2);
  const targetIdx = args.indexOf('--target');
  const targetArg = targetIdx >= 0 ? args[targetIdx + 1] : null;

  const sourceDir = path.dirname(fileURLToPath(import.meta.url));
  let targetDir = targetArg ? path.resolve(targetArg) : findProjectRoot(process.cwd()) ?? process.cwd();

  // ── Step 1: Prerequisites
  heading('Step 1 — Checking prerequisites');
  const nodeOk = checkNode();
  const npmOk = checkNpm();
  checkGit();

  if (!nodeOk || !npmOk) {
    fail('Missing prerequisites. Please install Node.js 18+ and npm.');
    process.exit(1);
  }

  // ── Step 2: Target project
  heading('Step 2 — Target project');
  log(`  Installing into: ${BOLD}${targetDir}${RESET}`);

  if (!fs.existsSync(targetDir)) {
    fail(`Target directory does not exist: ${targetDir}`);
    process.exit(1);
  }

  const confirm = await ask(`  Is this correct? (Y/n) `);
  if (confirm.toLowerCase() === 'n') {
    const newTarget = await ask('  Enter target directory: ');
    targetDir = path.resolve(newTarget);
  }

  // ── Step 3: Dependencies
  heading('Step 3 — Dependencies');
  const needed = checkDependencies(targetDir);

  if (needed.length > 0) {
    log(`\n  Installing: ${needed.join(', ')}`);
    try {
      execSync(`npm install ${needed.join(' ')}`, { cwd: targetDir, stdio: 'inherit' });
      ok('Dependencies installed');
    } catch {
      fail('Failed to install dependencies. Run manually: npm install ' + needed.join(' '));
    }
  }

  // ── Step 4: Install script + skills
  heading('Step 4 — Installing audit script and skills');
  installScript(targetDir, sourceDir);
  const skills = installSkills(targetDir, sourceDir);

  // ── Step 5: Setup .env
  heading('Step 5 — API key setup');
  checkOpenAIKey(targetDir);
  await setupEnv(targetDir);

  // ── Summary
  heading('Setup complete!');
  log('  Files installed:');
  log(`    ${GREEN}✓${RESET} scripts/openai-audit.mjs`);
  if (skills.claude) log(`    ${GREEN}✓${RESET} .claude/skills/audit-loop/SKILL.md (Claude Code)`);
  if (skills.copilot) log(`    ${GREEN}✓${RESET} .github/skills/audit-loop/SKILL.md (VS Code Copilot)`);

  log('\n  Usage:');
  if (skills.claude) {
    log(`    ${DIM}Claude Code:${RESET}  /audit-loop plan docs/plans/my-feature.md`);
    log(`    ${DIM}Claude Code:${RESET}  /audit-loop code docs/plans/my-feature.md`);
  }
  if (skills.copilot) {
    log(`    ${DIM}VS Code:${RESET}      /audit-loop (in Copilot Chat)`);
  }
  log(`    ${DIM}Direct:${RESET}       node scripts/openai-audit.mjs plan <plan-file>`);
  log(`    ${DIM}Direct:${RESET}       node scripts/openai-audit.mjs code <plan-file>`);

  log('');
  rl.close();
}

main().catch(err => {
  console.error('Setup failed:', err.message);
  process.exit(1);
});
