/**
 * @fileoverview Pure-function dispatcher for /audit-loop input parsing.
 *
 * Mirrors the dispatch table documented in skills/audit-loop/SKILL.md.
 * Used by tests to verify the routing contract; can also be used by
 * programmatic callers that want to invoke the right sub-skill directly.
 *
 * Decision tree:
 *   "plan <path>"      → { skill: 'audit-plan', mode: 'PLAN_AUDIT', planFile: <path> }
 *   "code <path>"      → { skill: 'audit-code', mode: 'CODE_AUDIT', planFile: <path> }
 *   "<existing.md>"    → { skill: 'audit-code', mode: 'CODE_AUDIT', planFile: <path> }   (shorthand)
 *   "full <task>"      → { skill: 'orchestrate', mode: 'FULL_CYCLE', task: <task> }
 *   "<task text>"      → { skill: 'audit-plan', mode: 'PLAN_CYCLE', task: <task> }
 *   ""                 → { skill: null, error: 'empty input' }
 *
 * @module scripts/lib/audit-dispatch
 */
import fs from 'node:fs';

/**
 * Decide where to route an /audit-loop invocation.
 * @param {string} input - $ARGUMENTS verbatim
 * @param {{ existsSync?: (p: string) => boolean }} [opts] - Inject for tests
 * @returns {{ skill: string|null, mode: string, planFile?: string, task?: string, error?: string }}
 */
export function dispatch(input, opts = {}) {
  const exists = opts.existsSync || fs.existsSync;
  const trimmed = (input || '').trim();
  if (!trimmed) return { skill: null, mode: 'NONE', error: 'empty input' };

  // Mode keyword + remaining tokens
  const modeMatch = /^(plan|code|full)\s+(.+)$/i.exec(trimmed);
  if (modeMatch) {
    const mode = modeMatch[1].toLowerCase();
    const rest = modeMatch[2].trim();
    if (mode === 'plan') return { skill: 'audit-plan', mode: 'PLAN_AUDIT', planFile: rest };
    if (mode === 'code') return { skill: 'audit-code', mode: 'CODE_AUDIT', planFile: rest };
    return { skill: 'orchestrate', mode: 'FULL_CYCLE', task: rest };
  }

  // Shorthand: a single token that points to an existing .md file → code audit
  if (/\.md$/.test(trimmed) && exists(trimmed)) {
    return { skill: 'audit-code', mode: 'CODE_AUDIT', planFile: trimmed };
  }

  // Otherwise treat as a task description for PLAN_CYCLE
  return { skill: 'audit-plan', mode: 'PLAN_CYCLE', task: trimmed };
}
