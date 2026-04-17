#!/usr/bin/env node
/**
 * @fileoverview CLI for recording plan-audit triage outcomes into PlanFpTracker.
 * Called after human triage of a plan audit result to persist which findings
 * were dismissed (for future suppression) vs accepted (for reset).
 *
 * Usage:
 *   node scripts/write-plan-outcomes.mjs \
 *     --result /tmp/audit-xxx-r1-result.json \
 *     --outcomes '[{"id":"H1","action":"fix-now"},{"id":"M3","action":"dismiss"}]'
 *
 * @module scripts/write-plan-outcomes
 */

import fs from 'node:fs';
import path from 'node:path';
import { PlanFpTracker } from './lib/plan-fp-tracker.mjs';

function parseArgs(argv) {
  const args = { result: null, outcomes: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--result') args.result = argv[++i];
    if (argv[i] === '--outcomes') args.outcomes = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.result || !args.outcomes) {
    console.error('Usage: node scripts/write-plan-outcomes.mjs --result <path> --outcomes \'[{...}]\'');
    process.exit(1);
  }

  let result;
  try {
    const raw = JSON.parse(fs.readFileSync(path.resolve(args.result), 'utf-8'));
    // Validate minimum required shape before trusting findings[]
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.findings)) {
      throw new Error('result file must be an object with a "findings" array');
    }
    result = raw;
  } catch (err) {
    console.error(`Failed to read result file: ${err.message}`);
    process.exit(1);
  }

  let outcomes;
  try {
    outcomes = JSON.parse(args.outcomes);
    if (!Array.isArray(outcomes)) throw new Error('outcomes must be an array');
  } catch (err) {
    console.error(`Failed to parse outcomes JSON: ${err.message}`);
    process.exit(1);
  }

  const tracker = new PlanFpTracker().load();
  const outcomeMap = new Map(outcomes.map(o => [o.id, o.action]));
  let recorded = 0;

  const VALID_ACTIONS = new Set(['dismiss', 'fix-now', 'defer', 'rebut']);

  for (const finding of result.findings || []) {
    const action = outcomeMap.get(finding.id);
    if (!action) continue;
    if (!VALID_ACTIONS.has(action)) {
      process.stderr.write(`  [write-plan-outcomes] Unknown action "${action}" for finding ${finding.id} — skipping\n`);
      continue;
    }
    const text = `${finding.category} ${finding.detail || ''}`.trim();
    const outcome = action === 'dismiss' ? 'dismissed' : 'accepted';
    tracker.recordOutcome(text, outcome);
    recorded++;
  }

  tracker.save();
  process.stderr.write(`Recorded ${recorded} outcomes → .audit/plan-fp-patterns.json\n`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
