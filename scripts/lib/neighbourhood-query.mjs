/**
 * @fileoverview Plan-time consultation orchestrator.
 *
 * Owns the description→embedding→RPC path for /plan-* and /audit-code consumers
 * (per R1 H3). Loads the repo's persisted (model, dim) at read time so query
 * embeddings live in the same vector space as stored embeddings (per R2 H9 +
 * Gemini G2 — concrete model id, never sentinel).
 *
 * Caches intent embedding on disk at `.audit-loop/cache/intent-embeddings.json`
 * so the cache survives across ephemeral CLI invocations (per Gemini-R2 G3).
 *
 * @module scripts/lib/neighbourhood-query
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from './file-io.mjs';
import {
  NeighbourhoodQueryArgsSchema,
  NeighbourhoodResultSchema,
} from './symbol-index-contracts.mjs';
import { recommendationFromSimilarity } from './symbol-index.mjs';
import { symbolIndexConfig } from './config.mjs';

const CACHE_REL = '.audit-loop/cache/intent-embeddings.json';
const CACHE_TTL_MS_DEFAULT = 24 * 60 * 60 * 1000;

function cacheKey(intentDescription, model, dim) {
  return crypto
    .createHash('sha256')
    .update(`${intentDescription}|${model}|${dim}`)
    .digest('hex')
    .slice(0, 24);
}

function loadCache(repoRoot) {
  const file = path.join(repoRoot, CACHE_REL);
  if (!fs.existsSync(file)) return { entries: {} };
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return { entries: {} };
  }
}

function saveCache(repoRoot, cache) {
  const file = path.join(repoRoot, CACHE_REL);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  atomicWriteFileSync(file, JSON.stringify(cache, null, 2));
}

function getCached(repoRoot, key, ttlMs) {
  const cache = loadCache(repoRoot);
  const e = cache.entries[key];
  if (!e) return null;
  if (Date.now() - e.savedAt > ttlMs) return null;
  return e.embedding;
}

function putCached(repoRoot, key, embedding) {
  const cache = loadCache(repoRoot);
  cache.entries[key] = { embedding, savedAt: Date.now() };
  saveCache(repoRoot, cache);
}

// R1 audit M3/M5: singleton client (one per process, not per call).
let _geminiClient = null;
async function getGeminiClient() {
  if (_geminiClient) return _geminiClient;
  if (!process.env.GEMINI_API_KEY) return null;
  const { GoogleGenAI } = await import('@google/genai');
  _geminiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return _geminiClient;
}

/**
 * Generate an embedding for a single intent string, using the EXACT
 * `(activeModel, activeDim)` pair the repo's stored embeddings use.
 *
 * Implementation: thin wrapper around `@google/genai`. Returns
 * `{result: number[], usage: {totalTokens: number}, latencyMs: number}`
 * matching the `{result, usage, latencyMs}` contract used elsewhere.
 *
 * @param {string} intentDescription
 * @param {string} activeModel - concrete model id, NEVER a sentinel
 * @param {number} activeDim
 * @returns {Promise<{result: number[], usage: {totalTokens: number}, latencyMs: number}>}
 */
export async function generateIntentEmbedding(intentDescription, activeModel, activeDim) {
  const client = await getGeminiClient();
  if (!client) {
    const err = new Error('GEMINI_API_KEY not set — cannot generate intent embedding');
    err.code = 'EMBED_FAILED';
    throw err;
  }
  const start = Date.now();
  // Pin outputDimensionality so gemini-embedding-001 (and friends) return the
  // exact dim stored in audit_repos.active_embedding_dim — otherwise the
  // length check below will reject the response.
  const res = await client.models.embedContent({
    model: activeModel,
    contents: intentDescription,
    config: { outputDimensionality: activeDim },
  });
  const latencyMs = Date.now() - start;
  const embedding = res?.embeddings?.[0]?.values || [];
  if (!Array.isArray(embedding) || embedding.length === 0) {
    const err = new Error(`Embedding provider returned empty vector for model ${activeModel}`);
    err.code = 'EMBED_FAILED';
    throw err;
  }
  if (embedding.length !== activeDim) {
    const err = new Error(
      `Embedding dim mismatch: provider returned ${embedding.length}, repo active_embedding_dim=${activeDim}`
    );
    err.code = 'EMBEDDING_MISMATCH';
    err.expected = { model: activeModel, dim: activeDim };
    err.actualDim = embedding.length;
    throw err;
  }
  return {
    result: embedding,
    usage: { totalTokens: res?.usageMetadata?.totalTokenCount || intentDescription.length },
    latencyMs,
  };
}

/**
 * Top-level orchestrator for plan-time neighbourhood consultation.
 *
 * Inputs validated against `NeighbourhoodQueryArgsSchema`. Returns a result
 * matching `NeighbourhoodResultSchema`. Errors are typed for the failure-matrix
 * mapping in cross-skill.mjs.
 *
 * @param {{getActiveSnapshot: Function, getRepoIdByUuid: Function, callNeighbourhoodRpc: Function}} adapters - injected for testability
 * @param {object} args - matches NeighbourhoodQueryArgsSchema
 * @param {string} repoRoot - for disk cache location
 */
export async function getNeighbourhoodForIntent(adapters, args, repoRoot = process.cwd()) {
  const parsed = NeighbourhoodQueryArgsSchema.safeParse(args);
  if (!parsed.success) {
    const err = new Error('Invalid args');
    err.code = 'BAD_INPUT';
    err.issues = parsed.error.issues;
    throw err;
  }
  const v = parsed.data;

  // 1. Resolve repo + active snapshot
  const repoRow = await adapters.getRepoIdByUuid(v.repoUuid);
  if (!repoRow) {
    const out = {
      cloud: false,
      refreshId: null,
      records: [],
      totalCandidatesConsidered: 0,
      truncated: false,
      hint: `repo not found in cloud store; run \`npm run arch:refresh\` to populate`,
    };
    return NeighbourhoodResultSchema.parse(out);
  }

  const active = await adapters.getActiveSnapshot(repoRow.id);
  if (!active || !active.refreshId) {
    return NeighbourhoodResultSchema.parse({
      cloud: true,
      refreshId: null,
      records: [],
      totalCandidatesConsidered: 0,
      truncated: false,
      hint: `repo has no active snapshot; run \`npm run arch:refresh\` to populate`,
    });
  }
  if (!active.activeEmbeddingModel || !active.activeEmbeddingDim) {
    const err = new Error('repo has no active embedding model configured');
    err.code = 'EMBEDDING_MISMATCH';
    err.expected = { model: null, dim: null };
    err.available = [];
    throw err;
  }

  // 2. Cache lookup or generate
  const ttlMs = symbolIndexConfig?.intentEmbedCacheTtlMs ?? CACHE_TTL_MS_DEFAULT;
  const key = cacheKey(v.intentDescription, active.activeEmbeddingModel, active.activeEmbeddingDim);
  let intentEmbedding = getCached(repoRoot, key, ttlMs);
  if (!intentEmbedding) {
    const emb = await generateIntentEmbedding(
      v.intentDescription,
      active.activeEmbeddingModel,
      active.activeEmbeddingDim
    );
    intentEmbedding = emb.result;
    putCached(repoRoot, key, intentEmbedding);
  }

  // 3. Call RPC
  const rpcRows = await adapters.callNeighbourhoodRpc({
    repoId:           repoRow.id,
    refreshId:        active.refreshId,
    targetPaths:      v.targetPaths,
    intentEmbedding,
    kindFilter:       v.kind || null,
    k:                v.k,
  });

  const records = (rpcRows || []).map(r => ({
    id:              r.symbol_index_id || r.id,
    definitionId:    r.definition_id || r.definitionId,
    refreshId:       active.refreshId,
    repoId:          repoRow.id,
    filePath:        r.file_path || r.filePath,
    startLine:       r.start_line ?? r.startLine ?? null,
    endLine:         r.end_line ?? r.endLine ?? null,
    symbolName:      r.symbol_name || r.symbolName,
    kind:            r.kind,
    signatureHash:   r.signature_hash || r.signatureHash || '',
    purposeSummary:  r.purpose_summary ?? r.purposeSummary ?? null,
    domainTag:       r.domain_tag ?? r.domainTag ?? null,
    score:           Number(r.combined_score ?? r.score ?? 0),
    hopScore:        Number(r.hop_score ?? r.hopScore ?? 0),
    similarityScore: Number(r.similarity ?? r.similarityScore ?? 0),
    recommendation:  recommendationFromSimilarity(Number(r.similarity ?? 0)),
  }));

  return NeighbourhoodResultSchema.parse({
    cloud: true,
    refreshId: active.refreshId,
    records,
    totalCandidatesConsidered: records.length,
    truncated: false,
    hint: null,
  });
}
