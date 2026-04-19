/**
 * @fileoverview Ensure audit-loop artifacts are gitignored in consumer repos.
 *
 * Called on install and update-check so that newly-added patterns
 * (e.g. .audit/local/) land in the target repo's .gitignore automatically.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Patterns that MUST be in .gitignore for any repo using the audit loop.
 *
 * Two categories:
 *
 * OPERATIONAL — output state produced by running the audit loop locally.
 * Never shared between repos; always gitignored.
 *
 * BUNDLE — files synced into the consumer from claude-engineering-skills.
 * These are NOT the consumer's code — they're versioned in the source repo
 * and replayed on each sync. Committing them in the consumer would cause
 * history pollution + drift. Shared state is the Supabase DB only.
 *
 * Kept in sync with scripts/sync-to-repos.mjs CORE_SCRIPTS / SKILL_FILES
 * / EDITOR_FILES — source of truth for what ships to consumers.
 */
const OPERATIONAL_PATTERNS = [
  '.env',
  '.audit/local/',
  '.audit/staging/',
  '.audit/quarantine/',
  '.audit/**/*.lock',
  '.audit/outcomes.jsonl',
  '.audit/experiments.jsonl',
  '.audit/experiment-manifests/',
  '.audit/prompt-revisions/',
  '.audit/bandit-state.json',
  '.audit/fp-tracker.json',
  '.audit/remediation-tasks.jsonl',
  '.audit/pipeline-state.json',
  '.audit/session-ledger.json',
  '.audit/meta-assessments.jsonl',
  '.audit-loop-install-receipt.json',
  '.audit-loop-install-txn.json',
];

const BUNDLE_PATTERNS = [
  // Skill surfaces — all three; consumers read but never author these
  '.claude/skills/',
  '.github/skills/',
  '.agents/skills/',
  // MCP wiring shipped alongside skills
  '.vscode/mcp.json',
  // Top-level audit-loop scripts (CORE_SCRIPTS in sync-to-repos.mjs)
  'scripts/openai-audit.mjs',
  'scripts/gemini-review.mjs',
  'scripts/bandit.mjs',
  'scripts/learning-store.mjs',
  'scripts/cross-skill.mjs',
  'scripts/phase7-check.mjs',
  'scripts/shared.mjs',
  'scripts/check-sync.mjs',
  'scripts/check-setup.mjs',
  'scripts/install-skills.mjs',
  'scripts/build-manifest.mjs',
  'scripts/regenerate-skill-copies.mjs',
  'scripts/check-skill-refs.mjs',
  'scripts/refine-prompts.mjs',
  'scripts/evolve-prompts.mjs',
  'scripts/meta-assess.mjs',
  'scripts/audit-loop.mjs',
  'scripts/debt-auto-capture.mjs',
  'scripts/debt-backfill.mjs',
  'scripts/debt-budget-check.mjs',
  'scripts/debt-pr-comment.mjs',
  'scripts/debt-resolve.mjs',
  'scripts/debt-review.mjs',
  'scripts/write-ledger-r1.mjs',
  'scripts/write-plan-outcomes.mjs',
  'scripts/setup-permissions.mjs',
  // Shared lib — entire directory; consumers read it, never edit
  'scripts/lib/',
  // Generated manifest
  'skills.manifest.json',
];

const REQUIRED_PATTERNS = [...OPERATIONAL_PATTERNS, ...BUNDLE_PATTERNS];

/**
 * Header comment prepended when adding the audit-loop block.
 */
const BLOCK_HEADER = '\n# Audit-loop — operational state + synced bundle (auto-managed, do not edit by hand)\n';

/**
 * Ensure all required audit-loop patterns are in the target repo's .gitignore.
 *
 * @param {string} repoRoot - Absolute path to the repo root
 * @param {{ dryRun?: boolean, quiet?: boolean }} [opts]
 * @returns {{ added: string[], alreadyPresent: string[], created: boolean }}
 */
export function ensureAuditGitignore(repoRoot, { dryRun = false, quiet = false } = {}) {
  const giPath = path.join(repoRoot, '.gitignore');
  let gi = '';
  let created = false;

  if (fs.existsSync(giPath)) {
    gi = fs.readFileSync(giPath, 'utf-8');
  } else {
    created = true;
  }

  const added = [];
  const alreadyPresent = [];

  for (const pattern of REQUIRED_PATTERNS) {
    if (gi.includes(pattern)) {
      alreadyPresent.push(pattern);
    } else {
      added.push(pattern);
    }
  }

  // Also handle legacy broad pattern — if .audit/ is already present,
  // the fine-grained patterns are redundant but we still add them
  // for clarity when .audit/ gets removed in favour of selective ignores.

  if (added.length > 0 && !dryRun) {
    const block = BLOCK_HEADER + added.join('\n') + '\n';
    fs.appendFileSync(giPath, block);
  }

  if (!quiet && added.length > 0) {
    const verb = created ? 'Created' : 'Updated';
    process.stderr.write(`  ${verb} .gitignore: +${added.length} audit-loop patterns\n`);
  }

  return { added, alreadyPresent, created };
}

/**
 * Check whether the target repo's .gitignore has all required patterns.
 * Does NOT modify the file — use ensureAuditGitignore() for that.
 *
 * @param {string} repoRoot - Absolute path to the repo root
 * @returns {{ missing: string[], present: string[], exists: boolean }}
 */
export function checkAuditGitignore(repoRoot) {
  const giPath = path.join(repoRoot, '.gitignore');
  if (!fs.existsSync(giPath)) {
    return { missing: [...REQUIRED_PATTERNS], present: [], exists: false };
  }

  const gi = fs.readFileSync(giPath, 'utf-8');
  const missing = [];
  const present = [];

  for (const pattern of REQUIRED_PATTERNS) {
    if (gi.includes(pattern)) {
      present.push(pattern);
    } else {
      missing.push(pattern);
    }
  }

  return { missing, present, exists: true };
}
