#!/usr/bin/env node
/**
 * @fileoverview Phase E — architecture-map.md renderer.
 *
 * Reads symbol_index for the active snapshot via cross-skill.mjs read APIs,
 * renders the architecture-map.md document via lib/arch-render.mjs, and
 * atomically writes to docs/architecture-map.md (or --out path).
 *
 * Cloud-off: writes a stub file noting the cloud is disabled.
 *
 * @module scripts/symbol-index/render-mermaid
 */

import 'dotenv/config';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { atomicWriteFileSync } from '../lib/file-io.mjs';
import {
  initLearningStore,
  isCloudEnabled,
  getRepoIdByUuid,
  getActiveSnapshot,
  listSymbolsForSnapshot,
  listLayeringViolationsForSnapshot,
  computeDriftScore,
} from '../learning-store.mjs';
import { resolveRepoIdentity } from '../lib/repo-identity.mjs';
import { renderArchitectureMap } from '../lib/arch-render.mjs';
import { symbolIndexConfig } from '../lib/config.mjs';

function parseArgs(argv) {
  const args = { out: 'docs/architecture-map.md' };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--out') args.out = argv[++i];
  }
  return args;
}

function commitSha() {
  try { return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().slice(0, 12); }
  catch { return null; }
}

function classify(score, threshold) {
  if (score <= threshold * 0.5) return 'GREEN';
  if (score <= threshold) return 'AMBER';
  return 'RED';
}

async function main() {
  const args = parseArgs(process.argv);
  const outPath = path.resolve(args.out);
  const repoRoot = process.cwd();
  await initLearningStore();

  const identity = resolveRepoIdentity(repoRoot);

  if (!isCloudEnabled()) {
    const stub = [
      '<!-- audit-loop:architectural-map -->',
      `# Architecture Map — ${identity.name}`,
      '',
      `- Generated: ${new Date().toISOString()}   commit: ${commitSha() || 'unknown'}   refresh_id: none`,
      `- Status: cloud-disabled — run \`npm run arch:refresh\` to populate`,
      '',
      'Architectural memory cloud store is not configured for this repo.',
      'Set `SUPABASE_AUDIT_URL`, `SUPABASE_AUDIT_ANON_KEY`, and ',
      '`SUPABASE_AUDIT_SERVICE_ROLE_KEY` then `npm run arch:refresh`.',
      '',
    ].join('\n');
    atomicWriteFileSync(outPath, stub);
    process.stderr.write(`arch:render: cloud disabled — wrote stub to ${outPath}\n`);
    process.exit(0);
  }

  const repo = await getRepoIdByUuid(identity.repoUuid);
  if (!repo) {
    process.stderr.write(`arch:render: repo not found in store — run \`npm run arch:refresh\` first\n`);
    process.exit(0);
  }
  const snap = await getActiveSnapshot(repo.id);
  if (!snap?.refreshId) {
    process.stderr.write(`arch:render: no active snapshot — run \`npm run arch:refresh\` first\n`);
    process.exit(0);
  }

  // Page through all symbols. Default cap raised from 5000 → 50000 (was
  // silently truncating wine-cellar at 5377). Configurable via env var
  // for huge monorepos; loud warning to stderr if the cap is hit so the
  // user knows the rendered map is incomplete.
  const cap = symbolIndexConfig.renderMaxSymbols;
  const allSymbols = [];
  let offset = 0;
  let truncatedAtCap = false;
  while (allSymbols.length < cap) {
    const remaining = cap - allSymbols.length;
    const pageLimit = Math.min(500, remaining);
    const page = await listSymbolsForSnapshot({ refreshId: snap.refreshId, limit: pageLimit, offset });
    if (!page || page.length === 0) break;
    allSymbols.push(...page);
    if (page.length < pageLimit) break;
    offset += pageLimit;
  }
  // Probe whether more rows exist beyond our cap so we can warn.
  if (allSymbols.length === cap) {
    const probe = await listSymbolsForSnapshot({ refreshId: snap.refreshId, limit: 1, offset: cap });
    if (probe && probe.length > 0) {
      truncatedAtCap = true;
      process.stderr.write(`arch:render: WARN — symbol cap of ${cap} hit; some symbols not rendered. Raise ARCH_RENDER_MAX_SYMBOLS env var to include more.\n`);
    }
  }

  const violations = await listLayeringViolationsForSnapshot(snap.refreshId);
  // R1 H8/M8: do NOT silently substitute score=0 on RPC failure — that gives
  // a false GREEN signal in a rendered surface humans trust. Surface the
  // failure as a distinct status so the document tells the truth.
  let drift = { score: 0 };
  let driftStatus;
  const threshold = symbolIndexConfig.driftThreshold;
  try {
    drift = await computeDriftScore({
      repoId: repo.id, refreshId: snap.refreshId,
      simDup: symbolIndexConfig.driftSimDup,
      simName: symbolIndexConfig.driftSimName,
    });
    driftStatus = classify(Number(drift.score) || 0, threshold);
  } catch (err) {
    process.stderr.write(`arch:render: drift_score RPC failed: ${err.message}\n`);
    driftStatus = 'INSUFFICIENT_DATA';
  }
  const status = driftStatus;

  const { markdown, bytesWritten } = renderArchitectureMap({
    repoName: identity.name,
    generatedAt: new Date().toISOString(),
    commitSha: commitSha(),
    refreshId: snap.refreshId,
    drift: drift.score,
    threshold,
    status,
    symbols: allSymbols,
    violations,
    dupSymbolIds: new Set(),
    renderedSymbolCap: truncatedAtCap ? cap : null,
  });

  atomicWriteFileSync(outPath, markdown);
  process.stderr.write(`arch:render: wrote ${outPath} (${bytesWritten} bytes, ${allSymbols.length} symbols, ${violations.length} violations)\n`);
}

main().catch(err => {
  process.stderr.write(`arch:render: fatal: ${err.stack || err.message}\n`);
  process.exit(1);
});
