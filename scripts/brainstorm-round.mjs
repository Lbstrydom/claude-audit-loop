#!/usr/bin/env node
/**
 * brainstorm-round — call OpenAI and/or Gemini concurrently with the
 * concept-level brainstorm prompt; emit one schema-valid JSON document.
 *
 * Plan: docs/plans/brainstorm-and-arch-discoverability.md (v6).
 *
 * Total output contract (R2-H4): always emit schema-valid JSON. Exit code
 * is secondary — caller reads per-provider state to know what worked.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { resolveModel, refreshModelCatalog } from './lib/model-resolver.mjs';
import { redactSecrets } from './lib/secret-patterns.mjs';
import { atomicWriteFileSync } from './lib/file-io.mjs';
import { BrainstormOutputSchema } from './lib/brainstorm/schemas.mjs';
import { callOpenAI } from './lib/brainstorm/openai-adapter.mjs';
import { callGemini } from './lib/brainstorm/gemini-adapter.mjs';
import { preflightEstimateUsd } from './lib/brainstorm/pricing.mjs';

// Repo-local debug dir for malformed-payload artefacts (Plan v6 Gemini-G3).
// Lives inside the repo so file ACLs are governed by repo ownership, not
// the world-readable /tmp umask. Synced to consumer-repo .gitignore via
// scripts/sync-to-repos.mjs.
const DEBUG_DIR_RELATIVE = '.claude/tmp';

const HELP_TEXT = `brainstorm-round — call multiple LLMs concurrently for concept-level brainstorming

USAGE
  node scripts/brainstorm-round.mjs --topic "<text>" [flags]
  echo "<text>" | node scripts/brainstorm-round.mjs --topic-stdin [flags]
  node scripts/brainstorm-round.mjs --topic-stdin [flags] < topic.txt

FLAGS
  --topic <text>         User topic (provide either this OR --topic-stdin, not both)
  --topic-stdin          Read topic from stdin
  --models <csv>         Providers to call (default: openai). Options: openai, gemini
  --openai-model <id>    OpenAI model sentinel or concrete ID (default: latest-gpt)
  --gemini-model <id>    Gemini model sentinel or concrete ID (default: latest-pro)
  --max-tokens <n>       Per-provider output cap (default: 1500)
  --out <path>           Write JSON output to file (default: stdout)
  --timeout-ms <n>       Per-provider timeout (default: 60000)
  --help                 Show this message

OUTPUT
  Schema-valid JSON document (per scripts/lib/brainstorm/schemas.mjs).
  Exit 0 = helper ran. Exit 1 = argv error or schema-validation bug.
`;

function parseArgs(argv) {
  const args = {
    topic: null,
    topicStdin: false,
    models: ['openai'],
    openaiModel: 'latest-gpt',
    geminiModel: 'latest-pro',
    maxTokens: 1500,
    out: null,
    timeoutMs: 60000,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const requireValue = () => {
      const v = argv[++i];
      if (v === undefined) throw new ArgvError(`Flag ${a} requires a value`);
      return v;
    };
    switch (a) {
      case '--topic': args.topic = requireValue(); break;
      case '--topic-stdin': args.topicStdin = true; break;
      case '--models': args.models = requireValue().split(',').map(s => s.trim()).filter(Boolean); break;
      case '--openai-model': args.openaiModel = requireValue(); break;
      case '--gemini-model': args.geminiModel = requireValue(); break;
      case '--max-tokens': args.maxTokens = Number(requireValue()); break;
      case '--out': args.out = requireValue(); break;
      case '--timeout-ms': args.timeoutMs = Number(requireValue()); break;
      case '--help':
      case '-h': args.help = true; break;
      default:
        throw new ArgvError(`Unknown flag: ${a}`);
    }
  }
  if (args.help) return args;
  if (args.topic !== null && args.topicStdin) {
    throw new ArgvError('Provide either --topic OR --topic-stdin, not both');
  }
  if (args.topic === null && !args.topicStdin) {
    throw new ArgvError('Missing --topic or --topic-stdin');
  }
  for (const m of args.models) {
    if (!['openai', 'gemini'].includes(m)) {
      throw new ArgvError(`Unknown model provider: ${m} (allowed: openai, gemini)`);
    }
  }
  if (!Number.isFinite(args.maxTokens) || args.maxTokens <= 0 || !Number.isInteger(args.maxTokens)) {
    throw new ArgvError(`--max-tokens must be a positive integer`);
  }
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0 || !Number.isInteger(args.timeoutMs)) {
    throw new ArgvError(`--timeout-ms must be a positive integer`);
  }
  return args;
}

class ArgvError extends Error {
  constructor(msg) { super(msg); this.code = 'ARGV_ERROR'; }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err.code === 'ARGV_ERROR') {
      process.stderr.write(`Error: ${err.message}\n\n${HELP_TEXT}`);
      process.exit(1);
    }
    throw err;
  }

  if (args.help) {
    process.stdout.write(HELP_TEXT);
    process.exit(0);
  }

  // Load topic
  let rawTopic = args.topic;
  if (args.topicStdin) {
    rawTopic = await readStdin();
  }
  if (!rawTopic || rawTopic.trim().length === 0) {
    process.stderr.write(`Error: empty topic\n`);
    process.exit(1);
  }

  // Redact secrets — mandatory (R2-H3); no opt-out flag exists.
  const redaction = redactSecrets(rawTopic);
  const topic = redaction.text;
  const redactionCount = redaction.redacted.length;
  if (redactionCount > 0) {
    process.stderr.write(`  [brainstorm] ⚠ Redacted ${redactionCount} secret pattern(s) before sending: ${redaction.redacted.join(', ')}\n`);
  }

  // Resolve model sentinels — best-effort live catalog refresh; surface
  // failure to stderr so operators see stale-catalog conditions (audit-code R1-L1).
  await refreshModelCatalog().catch(err => {
    process.stderr.write(`  [brainstorm] WARN: model catalog refresh failed (${err?.message ?? 'unknown'}); using static pool\n`);
  });
  const resolvedModels = {};
  if (args.models.includes('openai')) resolvedModels.openai = resolveModel(args.openaiModel);
  if (args.models.includes('gemini')) resolvedModels.gemini = resolveModel(args.geminiModel);

  // Pre-call cost estimate (Gemini-G2 v2 — includes input cost)
  const inputChars = topic.length;
  const preflightTotal = args.models.reduce((sum, p) => {
    return sum + preflightEstimateUsd({
      modelId: resolvedModels[p],
      inputChars,
      maxOutputTokens: args.maxTokens,
    });
  }, 0);
  process.stderr.write(`  [brainstorm] Calling: ${args.models.join(', ')} | Resolved: ${JSON.stringify(resolvedModels)}\n`);
  process.stderr.write(`  [brainstorm] Pre-call cost ceiling: ~$${preflightTotal.toFixed(4)} (input=${inputChars} chars, max-out=${args.maxTokens})\n`);

  // Dispatch — preserve --models argv order in output (R3-M2)
  const tasks = args.models.map(p => ({
    provider: p,
    promise: dispatchProvider({ provider: p, topic, args, resolvedModels }),
  }));
  const settled = await Promise.all(tasks.map(t => t.promise));

  // Build output document
  const totalCostUsd = settled.reduce((s, p) => s + (p.estimatedCostUsd ?? 0), 0);
  const output = {
    topic,
    redactionCount,
    resolvedModels,
    providers: settled,
    totalCostUsd: Number(totalCostUsd.toFixed(6)),
  };

  // Validate our own output before emitting (catches helper bugs)
  const parsed = BrainstormOutputSchema.safeParse(output);
  if (!parsed.success) {
    process.stderr.write(`  [brainstorm] code: SCHEMA_INVALID — helper produced an invalid document\n`);
    process.stderr.write(`  ${JSON.stringify(parsed.error.issues, null, 2)}\n`);
    process.exit(1);
  }

  const json = JSON.stringify(parsed.data, null, 2);
  if (args.out) {
    // Atomic write — temp-file + rename, crash-safe per repo standard
    // (audit-code R1-M4).
    atomicWriteFileSync(args.out, json);
    process.stderr.write(`  [brainstorm] Output: ${args.out}\n`);
  } else {
    process.stdout.write(json + '\n');
  }
  process.exit(0);
}

async function dispatchProvider({ provider, topic, args, resolvedModels }) {
  const requiredEnv = provider === 'openai' ? 'OPENAI_API_KEY' : 'GEMINI_API_KEY';
  if (!process.env[requiredEnv]) {
    return {
      provider,
      state: 'misconfigured',
      text: null,
      errorMessage: `${requiredEnv} not set`,
      httpStatus: null,
      usage: null,
      latencyMs: 0,
      estimatedCostUsd: null,
    };
  }

  const model = resolvedModels[provider];
  const fn = provider === 'openai' ? callOpenAI : callGemini;
  const result = await fn({
    topic,
    model,
    maxTokens: args.maxTokens,
    timeoutMs: args.timeoutMs,
  });

  // For malformed responses, save raw payload to repo-local debug dir
  // with restricted permissions (Gemini-G3, R2-M3).
  if (result.state === 'malformed' && result.errorMessage) {
    try {
      const repoRoot = process.cwd();
      const debugDir = path.join(repoRoot, DEBUG_DIR_RELATIVE);
      fs.mkdirSync(debugDir, { recursive: true });
      const sid = Date.now().toString(36);
      const debugPath = path.join(debugDir, `brainstorm-${sid}-${provider}.json`);
      const payload = redactSecrets(result.errorMessage).text;
      fs.writeFileSync(debugPath, payload, { mode: 0o600 });
      result.errorMessage = `${result.errorMessage} (raw payload: ${path.relative(repoRoot, debugPath)})`;
    } catch {
      // Best-effort; don't fail the whole call
    }
  }

  return result;
}

main().catch(err => {
  process.stderr.write(`  [brainstorm] FATAL: ${err.message}\n`);
  process.stderr.write(`${err.stack ?? ''}\n`);
  process.exit(1);
});
