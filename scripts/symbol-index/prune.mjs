#!/usr/bin/env node
/**
 * @fileoverview Phase D — snapshot retention prune (per R2 M5).
 *
 * Policy (from plan §2 Snapshot retention):
 *   - active: forever
 *   - rollback: last 4 published per repo, forever
 *   - weekly_checkpoint: one per ISO week, retained 90 days
 *   - transient: pruned after 30 days
 *   - aborted: pruned after 7 days
 *
 * Prune is transactional per snapshot — snapshot-scoped rows
 * (symbol_index, symbol_layering_violations) cascade-delete via the
 * refresh_runs FK CASCADE.
 *
 * @module scripts/symbol-index/prune
 */

import 'dotenv/config';
import {
  initLearningStore,
  isCloudEnabled,
  getWriteClient,
} from '../learning-store.mjs';

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--dry-run') args.dryRun = true;
  }
  return args;
}

const ROLLBACK_KEEP = 4;
const CHECKPOINT_RETAIN_DAYS = 90;
const TRANSIENT_RETAIN_DAYS = 30;
const ABORTED_RETAIN_DAYS = 7;

async function main() {
  const args = parseArgs(process.argv);
  await initLearningStore();
  if (!isCloudEnabled()) {
    process.stderr.write('arch:prune: cloud disabled — skipping\n');
    process.exit(0);
  }
  let w;
  try { w = await getWriteClient(); }
  catch (err) {
    process.stderr.write(`arch:prune: ${err.message}\n`);
    process.exit(err.code === 'SERVICE_ROLE_REQUIRED' ? 2 : 1);
  }

  const now = Date.now();
  const cutoff = (days) => new Date(now - days * 86400_000).toISOString();

  // R1 audit Gemini-G3: crashed/killed refreshes may never have set
  // completed_at (NULL). A pure `completed_at < cutoff` filter would leak
  // those forever. The fix: use coalesce(completed_at, started_at) by
  // querying both columns and OR-filtering in Node, or use Supabase's `.or()`
  // operator. Either way, NULL completed_at must NOT survive pruning when
  // started_at is also old enough.

  async function pruneClass({ filterCol, filterVal, retainDays }) {
    const cutoffISO = cutoff(retainDays);
    // Two queries: completed_at < cutoff (normal path), then started_at < cutoff
    // AND completed_at IS NULL (crashed/killed path). Union the ids, dedupe.
    const baseQ = w.from('refresh_runs').select('id, completed_at, started_at');
    const q1 = baseQ.eq(filterCol, filterVal).lt('completed_at', cutoffISO);
    const q2 = w.from('refresh_runs').select('id, started_at')
      .eq(filterCol, filterVal).is('completed_at', null).lt('started_at', cutoffISO);
    const [r1, r2] = await Promise.all([q1, q2]);
    const ids = new Set();
    for (const row of (r1.data || [])) ids.add(row.id);
    for (const row of (r2.data || [])) ids.add(row.id);
    if (ids.size === 0) return 0;
    if (args.dryRun) return ids.size;
    const { error } = await w.from('refresh_runs').delete().in('id', [...ids]);
    return error ? 0 : ids.size;
  }

  // 1. Aborted runs older than 7d (incl. those that never set completed_at)
  const prunedAborted    = await pruneClass({ filterCol: 'status',          filterVal: 'aborted',           retainDays: ABORTED_RETAIN_DAYS });
  // 2. Transient older than 30d
  const prunedTransient  = await pruneClass({ filterCol: 'retention_class', filterVal: 'transient',         retainDays: TRANSIENT_RETAIN_DAYS });
  // 3. Weekly checkpoints older than 90d
  const prunedCheckpoints = await pruneClass({ filterCol: 'retention_class', filterVal: 'weekly_checkpoint', retainDays: CHECKPOINT_RETAIN_DAYS });

  // 4. Rollback retention: keep last 4 per repo. Demote older to 'transient' so
  //    next prune cycle catches them via the transient retention rule.
  let demotedRollback = 0;
  const { data: repoIds } = await w.from('audit_repos').select('id');
  for (const r of (repoIds || [])) {
    const { data: rollbacks } = await w
      .from('refresh_runs')
      .select('id, completed_at')
      .eq('repo_id', r.id)
      .eq('retention_class', 'rollback')
      .order('completed_at', { ascending: false });
    if (!rollbacks || rollbacks.length <= ROLLBACK_KEEP) continue;
    const demote = rollbacks.slice(ROLLBACK_KEEP).map(x => x.id);
    if (demote.length === 0) continue;
    if (!args.dryRun) {
      const { error } = await w.from('refresh_runs')
        .update({ retention_class: 'transient' })
        .in('id', demote);
      if (!error) demotedRollback += demote.length;
    } else {
      demotedRollback += demote.length;
    }
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    dryRun: args.dryRun,
    pruned: { aborted: prunedAborted, transient: prunedTransient, checkpoints: prunedCheckpoints },
    demoted: { rollback: demotedRollback },
  }) + '\n');
  process.stderr.write(`arch:prune: aborted=${prunedAborted} transient=${prunedTransient} checkpoints=${prunedCheckpoints} demoted=${demotedRollback}\n`);
  process.exit(0);
}

main().catch(err => {
  process.stderr.write(`arch:prune: fatal: ${err.stack || err.message}\n`);
  process.exit(1);
});
