import { GoogleGenAI } from '@google/genai';
import { BRAINSTORM_SYSTEM_PROMPT } from './prompt.mjs';
import { estimateCostUsd } from './pricing.mjs';

let _client = null;
function client() {
  if (!_client) _client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return _client;
}

/**
 * Call Gemini with the brainstorm system prompt + user topic.
 * Always returns a ProviderResult — never throws to the caller (Plan v6
 * §2.1 / R2-H4 total output contract).
 */
export async function callGemini({ topic, model, maxTokens, timeoutMs = 60000 }) {
  const startMs = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await client().models.generateContent(
      {
        model,
        contents: topic,
        config: {
          systemInstruction: BRAINSTORM_SYSTEM_PROMPT,
          maxOutputTokens: maxTokens,
        },
      },
      { signal: controller.signal },
    );
    clearTimeout(timer);
    const latencyMs = Date.now() - startMs;

    const text = response?.text ?? null;
    const usage = {
      inputTokens: response?.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: response?.usageMetadata?.candidatesTokenCount ?? 0,
    };
    const estimatedCostUsd = estimateCostUsd({
      modelId: model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    });

    const finishReason = response?.candidates?.[0]?.finishReason ?? null;
    const blockedReasons = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'IMAGE_SAFETY']);
    if (finishReason && blockedReasons.has(finishReason)) {
      return {
        provider: 'gemini',
        state: 'blocked',
        text: null,
        errorMessage: `Blocked by safety filter: ${finishReason}`,
        httpStatus: null,
        usage,
        latencyMs,
        estimatedCostUsd,
      };
    }

    if (!text || text.trim().length === 0) {
      return {
        provider: 'gemini',
        state: 'empty',
        text: null,
        errorMessage: `Empty response (finish_reason: ${finishReason ?? 'unknown'})`,
        httpStatus: null,
        usage,
        latencyMs,
        estimatedCostUsd,
      };
    }

    return {
      provider: 'gemini',
      state: 'success',
      text,
      errorMessage: null,
      httpStatus: null,
      usage,
      latencyMs,
      estimatedCostUsd,
    };
  } catch (err) {
    clearTimeout(timer);
    const latencyMs = Date.now() - startMs;
    return classifyError({ err, latencyMs });
  }
}

function classifyError({ err, latencyMs }) {
  const base = {
    provider: 'gemini',
    text: null,
    usage: null,
    latencyMs,
    estimatedCostUsd: null,
  };

  if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') {
    return { ...base, state: 'timeout', errorMessage: 'Aborted after timeout', httpStatus: null };
  }

  // Google SDK surfaces HTTP errors via err.status or in the message
  const statusMatch = (err?.message ?? '').match(/\[(\d{3})\b/);
  const status = err?.status ?? (statusMatch ? Number(statusMatch[1]) : null);
  if (status) {
    return {
      ...base,
      state: 'http_error',
      errorMessage: err?.message ?? `HTTP ${status}`,
      httpStatus: status,
    };
  }

  return {
    ...base,
    state: 'malformed',
    errorMessage: err?.message ?? 'Unknown adapter error',
    httpStatus: null,
  };
}
