/**
 * @fileoverview Centralized, validated runtime configuration.
 * All environment variable reads and defaults live here — no scattered process.env
 * reads across modules. Import the config object you need.
 * @module scripts/lib/config
 */

import { safeInt } from './file-io.mjs';

// ── Validation helpers ──────────────────────────────────────────────────────

const VALID_REASONING = new Set(['low', 'medium', 'high']);

function validatedEnum(envVar, validSet, fallback) {
  const val = process.env[envVar];
  if (val && !validSet.has(val)) {
    process.stderr.write(`  [config] WARNING: Invalid ${envVar}="${val}" — using "${fallback}"\n`);
    return fallback;
  }
  return val || fallback;
}

// ── OpenAI / GPT-5.4 Audit Config ──────────────────────────────────────────

export const openaiConfig = Object.freeze({
  model: process.env.OPENAI_AUDIT_MODEL || 'gpt-5.4',
  reasoning: validatedEnum('OPENAI_AUDIT_REASONING', VALID_REASONING, 'high'),
  maxOutputTokensCap: safeInt(process.env.OPENAI_AUDIT_MAX_TOKENS, 32000),
  timeoutMsCap: safeInt(process.env.OPENAI_AUDIT_TIMEOUT_MS, 300000),
  backendSplitThreshold: safeInt(process.env.OPENAI_AUDIT_SPLIT_THRESHOLD, 12),
  mapReduceThreshold: safeInt(process.env.OPENAI_AUDIT_MAP_REDUCE_THRESHOLD, 15),
  mapReduceTokenThreshold: safeInt(process.env.OPENAI_AUDIT_MAP_REDUCE_TOKEN_THRESHOLD, 50000),
});

// ── Gemini / Final Review Config ────────────────────────────────────────────

export const geminiConfig = Object.freeze({
  model: process.env.GEMINI_REVIEW_MODEL || 'gemini-3.1-pro-preview',
  timeoutMs: safeInt(process.env.GEMINI_REVIEW_TIMEOUT_MS, 120000),
  maxOutputTokens: safeInt(process.env.GEMINI_REVIEW_MAX_TOKENS, 16000),
});

// ── Claude Opus Fallback Config ─────────────────────────────────────────────

export const claudeConfig = Object.freeze({
  finalReviewModel: process.env.CLAUDE_FINAL_REVIEW_MODEL || 'claude-opus-4-1',
});

// ── Brief Generation Config ─────────────────────────────────────────────────

export const briefConfig = Object.freeze({
  geminiModel: process.env.BRIEF_MODEL_GEMINI || 'gemini-2.5-flash',
  claudeModel: process.env.BRIEF_MODEL_CLAUDE || 'claude-haiku-4-5-20251001',
});

// ── Suppression Config ──────────────────────────────────────────────────────

export const suppressionConfig = Object.freeze({
  similarityThreshold: parseFloat(process.env.SUPPRESS_SIMILARITY_THRESHOLD || '0.35'),
});
