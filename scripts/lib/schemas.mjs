/**
 * @fileoverview Canonical Zod schemas and derived JSON Schemas for the audit loop.
 * Single source of truth for finding shapes used by all reviewers (GPT + Gemini).
 * Zod schemas are the primary definition; JSON Schemas are derived explicitly.
 * @module scripts/lib/schemas
 */

import { z } from 'zod';

// ── Finding Schema ───────────────────────────────────────────────────────────

export const FindingSchema = z.object({
  id: z.string().max(10).describe('Finding ID, e.g. H1, M3, L2, G1'),
  severity: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  category: z.string().max(80).describe('Category: e.g. "DRY Violation", "Missing Error Handling"'),
  section: z.string().max(120).describe('Which plan/code section or file this relates to'),
  detail: z.string().max(600).describe('What is wrong and why it matters'),
  risk: z.string().max(300).describe('What could go wrong if not fixed'),
  recommendation: z.string().max(600).describe('Specific, actionable fix — NOT a quick fix, must be sustainable'),
  is_quick_fix: z.boolean().describe('TRUE if the recommendation is a band-aid rather than a proper fix.'),
  is_mechanical: z.boolean().describe('TRUE if fix is deterministic with exactly one correct answer.'),
  principle: z.string().max(80).describe('Which engineering/UX principle this violates')
});

// ── Zod-to-Gemini Schema Conversion ─────────────────────────────────────────

/**
 * Strip $schema and additionalProperties keys recursively.
 * These are unsupported by Gemini responseSchema.
 * @param {*} obj - JSON Schema node
 * @returns {*} Cleaned node
 */
function stripJsonSchemaExtras(obj) {
  if (typeof obj !== 'object' || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map(stripJsonSchemaExtras);
  const cleaned = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === '$schema' || k === 'additionalProperties') continue;
    cleaned[k] = stripJsonSchemaExtras(v);
  }
  return cleaned;
}

/**
 * Convert a Zod schema to Gemini-compatible JSON Schema.
 * Strips $schema and additionalProperties (unsupported by Gemini responseSchema).
 * Single source of truth: Zod schema → derived JSON Schema.
 * @param {import('zod').ZodType} zodSchema - Any Zod schema
 * @returns {object} Gemini-compatible JSON Schema
 */
export function zodToGeminiSchema(zodSchema) {
  const raw = z.toJSONSchema(zodSchema);
  return stripJsonSchemaExtras(raw);
}

// ── Derived JSON Schema ──────────────────────────────────────────────────────
// Generated from FindingSchema — single source of truth

export const FindingJsonSchema = zodToGeminiSchema(FindingSchema);

// ── Wiring Issue Schema ──────────────────────────────────────────────────────

export const WiringIssueSchema = z.object({
  frontend_call: z.string().max(120),
  backend_route: z.string().max(120),
  status: z.enum(['wired', 'broken', 'missing']),
  detail: z.string().max(300)
});

// ── Adjudication Ledger Schemas ──────────────────────────────────────────────

/** Zod 4 schema for a single adjudication ledger entry. */
export const LedgerEntrySchema = z.object({
  topicId: z.string(),
  semanticHash: z.string(),
  adjudicationOutcome: z.enum(['dismissed', 'accepted', 'severity_adjusted']),
  remediationState: z.enum(['pending', 'planned', 'fixed', 'verified', 'regressed']),
  severity: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  originalSeverity: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  category: z.string(),
  section: z.string(),
  detailSnapshot: z.string(),
  affectedFiles: z.array(z.string()),
  affectedPrinciples: z.array(z.string()),
  ruling: z.enum(['sustain', 'overrule', 'compromise']),
  rulingRationale: z.string(),
  resolvedRound: z.number(),
  pass: z.string()
});

/** Zod 4 schema for the full adjudication ledger. */
export const AdjudicationLedgerSchema = z.object({
  version: z.literal(1),
  entries: z.array(LedgerEntrySchema)
});
