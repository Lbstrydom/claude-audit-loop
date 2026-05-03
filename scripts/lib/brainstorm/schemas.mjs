import { z } from 'zod';

export const PROVIDER_STATES = [
  'success',
  'misconfigured',
  'timeout',
  'http_error',
  'empty',
  'malformed',
  'blocked',
];

export const ProviderResultSchema = z.object({
  provider: z.enum(['openai', 'gemini']),
  state: z.enum(PROVIDER_STATES),
  text: z.string().nullable(),
  errorMessage: z.string().nullable(),
  httpStatus: z.number().int().nullable(),
  usage: z
    .object({
      inputTokens: z.number().int().min(0),
      outputTokens: z.number().int().min(0),
    })
    .nullable(),
  latencyMs: z.number().int().min(0),
  estimatedCostUsd: z.number().nullable(),
});

export const BrainstormOutputSchema = z.object({
  topic: z.string(),
  redactionCount: z.number().int().min(0),
  resolvedModels: z.object({
    openai: z.string().optional(),
    gemini: z.string().optional(),
  }),
  providers: z.array(ProviderResultSchema),
  totalCostUsd: z.number(),
});
