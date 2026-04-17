/**
 * @fileoverview Remediation task CRUD — creation, editing, verification, persistence.
 * Split from findings.mjs (Wave 2, Phase 3) for Single Responsibility.
 * @module scripts/lib/findings-tasks
 */

import { AppendOnlyStore } from './file-store.mjs';

// ── Module-level state ─────────────────────────────────────────────────────

/**
 * @WARNING Module-global state — safe in CLI-per-invocation model.
 * Lazy-initialized on first use. Would need DI if used as a library.
 */
let _taskStore = null;

function getTaskStore() {
  if (!_taskStore) {
    _taskStore = new AppendOnlyStore('.audit/remediation-tasks.jsonl');
  }
  return _taskStore;
}

// ── Task Lifecycle ────────────────────────────────────────────────────────

/**
 * Create a RemediationTask at adjudication time.
 * @param {string} runId
 * @param {string} passName
 * @param {object} finding - Must have semanticHash, findingId (id), severity
 * @param {function} semanticIdFn - The semanticId function (injected to avoid circular dep)
 * @returns {object} RemediationTask
 */
export function createRemediationTask(runId, passName, finding, semanticIdFn) {
  const hash = finding.semanticHash || (semanticIdFn ? semanticIdFn(finding) : 'unknown');
  return {
    taskId: `${runId}-${passName}-${hash}`,
    runId,
    passName,
    semanticHash: hash,
    findingId: finding.id || finding.findingId,
    severity: finding.severity,
    remediationState: 'pending',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    edits: []
  };
}

/**
 * Append an edit to a task (called during fix generation).
 */
export function trackEdit(task, edit) {
  task.edits.push({ ...edit, timestamp: Date.now() });
  task.remediationState = 'fixed';
  task.updatedAt = Date.now();
}

/**
 * Update task after verification step.
 */
export function verifyTask(task, verifiedBy, passed) {
  task.remediationState = passed ? 'verified' : 'regressed';
  task.verifiedBy = verifiedBy;
  task.verifiedAt = Date.now();
  task.updatedAt = Date.now();
}

// ── Task Persistence ──────────────────────────────────────────────────────

/** Create and persist a new task. */
export function persistTask(task) { getTaskStore().append(task); }

/** Load all tasks, optionally filtered by runId. */
export function loadTasks(runId = null) {
  const all = getTaskStore().loadAll();
  const byId = new Map();
  for (const t of all) byId.set(t.taskId, t);
  const tasks = [...byId.values()];
  return runId ? tasks.filter(t => t.runId === runId) : tasks;
}

/** Update a task (append new version). */
export function updateTask(task) {
  task.updatedAt = Date.now();
  getTaskStore().append(task);
}
