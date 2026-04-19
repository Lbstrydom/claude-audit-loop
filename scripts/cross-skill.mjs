#!/usr/bin/env node
/**
 * @fileoverview CLI facade for the cross-skill data loop.
 *
 * Skills (/ux-lock, /persona-test, /ship) invoke this script instead of raw curl.
 * It handles Supabase auth, repo resolution, JSON I/O, and graceful no-op
 * when cloud store is unavailable — giving every skill a single, testable
 * persistence entrypoint.
 *
 * Usage:
 *   node scripts/cross-skill.mjs <subcommand> [--json <payload>]
 *
 * Subcommands:
 *   upsert-plan                 — register a plan artefact, print plan UUID
 *   record-regression-spec      — /ux-lock writes a new Playwright spec
 *   record-regression-spec-run  — append a pass/fail run to a spec
 *   record-correlation          — /persona-test links a finding to an audit row
 *   record-ship-event           — /ship writes its outcome
 *   list-unlocked-fixes         — /ship reads fixes that need a regression spec
 *   list-recent-p0s             — /ship reads persona-test open P0s (existing query, promoted here)
 *   audit-effectiveness         — dashboard rollup (user-visible precision/recall)
 *   whoami                      — print repo_id + cloud-mode status, for diagnostics
 *
 * All commands read their payload from `--json <inline>` or stdin.
 * All output is single-line JSON for downstream skill-markdown parsing.
 * @module scripts/cross-skill
 */

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

import {
  initLearningStore,
  isCloudEnabled,
  upsertRepo,
  upsertPlan,
  updatePlanStatus,
  recordRegressionSpec,
  recordRegressionSpecRun,
  recordPersonaAuditCorrelation,
  recordShipEvent,
  recordPlanVerificationRun,
  recordPlanVerificationItems,
  readPlanSatisfaction,
  readPersistentPlanFailures,
  getUnlockedFixes,
  readAuditEffectiveness,
} from './learning-store.mjs';

// ── Arg parsing ─────────────────────────────────────────────────────────────

const [subcommand, ...rest] = process.argv.slice(2);

function parsePayload() {
  const jsonIdx = rest.indexOf('--json');
  if (jsonIdx >= 0) {
    return JSON.parse(rest[jsonIdx + 1] || '{}');
  }
  const stdinIdx = rest.indexOf('--stdin');
  if (stdinIdx >= 0) {
    const raw = readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  }
  // Also accept bare JSON as the last arg (common when skills interpolate)
  if (rest.length > 0 && rest[rest.length - 1].startsWith('{')) {
    return JSON.parse(rest[rest.length - 1]);
  }
  return {};
}

function argOption(name) {
  const idx = rest.indexOf(`--${name}`);
  if (idx < 0) return null;
  return rest[idx + 1] || null;
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function emitError(code, message, extra = {}) {
  emit({ ok: false, error: { code, message, ...extra } });
}

// ── Repo + commit resolution ────────────────────────────────────────────────

function currentCommitSha() {
  try {
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch { return null; }
}

function currentBranch() {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch { return null; }
}

/**
 * Best-effort repo lookup — we already have a fingerprint-based upsert in
 * learning-store, but the skills don't always have a profile built. For now,
 * caller passes repoId explicitly OR we skip (cross-skill tables all allow
 * repo_id NULL). The more robust path is to let the audit-loop orchestrator
 * be the sole producer of audit_repos rows, and have the skills reference
 * by name via a side query.
 */
async function resolveRepoId(payload) {
  if (payload.repoId) return payload.repoId;
  // Leave null — the schema accepts it. When audit-loop has run, it will have
  // produced an audit_repos row whose id the skills can query by name, but for
  // MVP we rely on explicit passing from /audit-loop and let the others use null.
  return null;
}

// ── Subcommands ─────────────────────────────────────────────────────────────

async function cmdUpsertPlan() {
  const p = parsePayload();
  if (!p.path || !p.skill) return emitError('BAD_INPUT', 'path and skill are required');
  await initLearningStore();
  if (!isCloudEnabled()) return emit({ ok: true, cloud: false, planId: null });
  const repoId = await resolveRepoId(p);
  const planId = await upsertPlan(repoId, {
    path: p.path,
    skill: p.skill,
    status: p.status,
    principlesCited: p.principlesCited,
    focusAreas: p.focusAreas,
    commitSha: p.commitSha || currentCommitSha(),
    checksum: p.checksum,
  });
  emit({ ok: !!planId, cloud: true, planId });
}

async function cmdUpdatePlanStatus() {
  const p = parsePayload();
  if (!p.planId || !p.status) return emitError('BAD_INPUT', 'planId and status are required');
  await initLearningStore();
  if (!isCloudEnabled()) return emit({ ok: true, cloud: false });
  await updatePlanStatus(p.planId, p.status);
  emit({ ok: true, cloud: true });
}

async function cmdRecordRegressionSpec() {
  const p = parsePayload();
  if (!p.specPath || !p.description || !p.sourceKind) {
    return emitError('BAD_INPUT', 'specPath, description, sourceKind are required');
  }
  await initLearningStore();
  if (!isCloudEnabled()) return emit({ ok: true, cloud: false, specId: null });
  const repoId = await resolveRepoId(p);
  const specId = await recordRegressionSpec(repoId, {
    specPath: p.specPath,
    description: p.description,
    commitSha: p.commitSha || currentCommitSha(),
    assertionCount: p.assertionCount,
    domContractTypes: p.domContractTypes,
    sourceKind: p.sourceKind,
    sourceFindingId: p.sourceFindingId,
    sourceFindingType: p.sourceFindingType,
  });
  emit({ ok: !!specId, cloud: true, specId });
}

async function cmdRecordRegressionSpecRun() {
  const p = parsePayload();
  if (!p.specId || typeof p.passed !== 'boolean') {
    return emitError('BAD_INPUT', 'specId and passed (bool) are required');
  }
  await initLearningStore();
  if (!isCloudEnabled()) return emit({ ok: true, cloud: false });
  await recordRegressionSpecRun(p.specId, {
    passed: p.passed,
    commitSha: p.commitSha || currentCommitSha(),
    capturedRegression: p.capturedRegression,
    durationMs: p.durationMs,
    errorMessage: p.errorMessage,
    runContext: p.runContext,
  });
  emit({ ok: true, cloud: true });
}

async function cmdRecordCorrelation() {
  const p = parsePayload();
  if (!p.personaSessionId || !p.personaFindingHash || !p.personaSeverity || !p.correlationType) {
    return emitError('BAD_INPUT', 'personaSessionId, personaFindingHash, personaSeverity, correlationType required');
  }
  await initLearningStore();
  if (!isCloudEnabled()) return emit({ ok: true, cloud: false });
  await recordPersonaAuditCorrelation(p.personaSessionId, {
    personaFindingHash: p.personaFindingHash,
    personaSeverity: p.personaSeverity,
    auditFindingId: p.auditFindingId,
    auditRunId: p.auditRunId,
    correlationType: p.correlationType,
    matchScore: p.matchScore,
    matchRationale: p.matchRationale,
  });
  emit({ ok: true, cloud: true });
}

async function cmdRecordPlanVerifyRun() {
  const p = parsePayload();
  if (!p.planId || typeof p.totalCriteria !== 'number') {
    return emitError('BAD_INPUT', 'planId and totalCriteria (number) are required');
  }
  await initLearningStore();
  if (!isCloudEnabled()) return emit({ ok: true, cloud: false, runId: null });
  const runId = await recordPlanVerificationRun({
    planId: p.planId,
    specId: p.specId,
    commitSha: p.commitSha || currentCommitSha(),
    url: p.url,
    totalCriteria: p.totalCriteria,
    passedCount: p.passedCount || 0,
    failedCount: p.failedCount || 0,
    skippedCount: p.skippedCount || 0,
    durationMs: p.durationMs,
    runContext: p.runContext || 'ux-lock-verify',
  });
  emit({ ok: !!runId, cloud: true, runId });
}

async function cmdRecordPlanVerifyItems() {
  const p = parsePayload();
  if (!p.runId || !p.planId || !Array.isArray(p.items) || p.items.length === 0) {
    return emitError('BAD_INPUT', 'runId, planId, and non-empty items array are required');
  }
  await initLearningStore();
  if (!isCloudEnabled()) return emit({ ok: true, cloud: false, inserted: 0 });
  await recordPlanVerificationItems(p.runId, p.planId, p.items);
  emit({ ok: true, cloud: true, inserted: p.items.length });
}

async function cmdPlanSatisfaction() {
  await initLearningStore();
  if (!isCloudEnabled()) return emit({ ok: true, cloud: false, row: null, persistentFailures: [] });
  const planId = argOption('plan-id');
  if (!planId) return emitError('BAD_INPUT', '--plan-id is required');
  const [row, persistent] = await Promise.all([
    readPlanSatisfaction(planId),
    readPersistentPlanFailures(planId),
  ]);
  emit({ ok: true, cloud: true, row, persistentFailures: persistent });
}

async function cmdRecordShipEvent() {
  const p = parsePayload();
  if (!p.outcome) return emitError('BAD_INPUT', 'outcome is required');
  await initLearningStore();
  if (!isCloudEnabled()) return emit({ ok: true, cloud: false });
  const repoId = await resolveRepoId(p);
  await recordShipEvent(repoId, {
    commitSha: p.commitSha || currentCommitSha(),
    branch: p.branch || currentBranch(),
    outcome: p.outcome,
    blockReasons: p.blockReasons,
    openP0Count: p.openP0Count,
    openP1Count: p.openP1Count,
    missingSpecCount: p.missingSpecCount,
    overriddenByUser: p.overriddenByUser,
    overrideFlag: p.overrideFlag,
    stackDetected: p.stackDetected,
    framework: p.framework,
    durationMs: p.durationMs,
  });
  emit({ ok: true, cloud: true });
}

async function cmdListUnlockedFixes() {
  await initLearningStore();
  if (!isCloudEnabled()) return emit({ ok: true, cloud: false, rows: [] });
  const repoId = argOption('repo-id');
  const rows = await getUnlockedFixes(repoId);
  emit({ ok: true, cloud: true, rows });
}

async function cmdAuditEffectiveness() {
  await initLearningStore();
  if (!isCloudEnabled()) return emit({ ok: true, cloud: false, row: null });
  const repoId = argOption('repo-id');
  if (!repoId) return emitError('BAD_INPUT', '--repo-id is required');
  const row = await readAuditEffectiveness(repoId);
  emit({ ok: true, cloud: true, row });
}

async function cmdWhoami() {
  await initLearningStore();
  emit({
    ok: true,
    cloud: isCloudEnabled(),
    commitSha: currentCommitSha(),
    branch: currentBranch(),
    supabaseConfigured: !!process.env.SUPABASE_AUDIT_URL,
  });
}

// ── Dispatcher ──────────────────────────────────────────────────────────────

const commands = {
  'upsert-plan': cmdUpsertPlan,
  'update-plan-status': cmdUpdatePlanStatus,
  'record-regression-spec': cmdRecordRegressionSpec,
  'record-regression-spec-run': cmdRecordRegressionSpecRun,
  'record-correlation': cmdRecordCorrelation,
  'record-ship-event': cmdRecordShipEvent,
  'record-plan-verify-run': cmdRecordPlanVerifyRun,
  'record-plan-verify-items': cmdRecordPlanVerifyItems,
  'plan-satisfaction': cmdPlanSatisfaction,
  'list-unlocked-fixes': cmdListUnlockedFixes,
  'audit-effectiveness': cmdAuditEffectiveness,
  'whoami': cmdWhoami,
};

async function main() {
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    process.stdout.write(
      'Usage: node scripts/cross-skill.mjs <subcommand> [--json <payload>|--stdin]\n\n' +
      'Subcommands:\n' +
      Object.keys(commands).map(k => `  ${k}`).join('\n') + '\n'
    );
    process.exit(0);
  }
  const handler = commands[subcommand];
  if (!handler) {
    emitError('UNKNOWN_SUBCOMMAND', `Unknown subcommand: ${subcommand}`, {
      validSubcommands: Object.keys(commands),
    });
    process.exit(2);
  }
  try {
    await handler();
  } catch (err) {
    emitError('EXCEPTION', err.message, { stack: err.stack });
    process.exit(1);
  }
}

main();
