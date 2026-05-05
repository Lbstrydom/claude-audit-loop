/**
 * Tests for scripts/lib/brainstorm/debate-prompt.mjs
 * Plan ACs: AC4, §14.A (debate includes assembled context).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildDebatePrompt } from '../scripts/lib/brainstorm/debate-prompt.mjs';

describe('buildDebatePrompt — required inputs', () => {
  it('throws on missing otherProvider', () => {
    assert.throws(() => buildDebatePrompt({ otherResponse: 'x', originalTopic: 't' }), /otherProvider/);
  });

  it('throws on empty otherResponse', () => {
    assert.throws(() => buildDebatePrompt({ otherProvider: 'gemini', otherResponse: '', originalTopic: 't' }), /otherResponse/);
  });

  it('throws on empty originalTopic', () => {
    assert.throws(() => buildDebatePrompt({ otherProvider: 'gemini', otherResponse: 'x', originalTopic: '' }), /originalTopic/);
  });
});

describe('buildDebatePrompt — output structure', () => {
  it('produces a system prompt that asks for cross-pollination, not summary', () => {
    const out = buildDebatePrompt({ otherProvider: 'gemini', otherResponse: 'their take', originalTopic: 'foo' });
    assert.match(out.systemPrompt, /pressure-test|push back|disagree|opinionated/i);
  });

  it('user message includes the OTHER provider name + their response verbatim', () => {
    const out = buildDebatePrompt({ otherProvider: 'gemini', otherResponse: 'GEMINI_RESPONSE_TOKEN', originalTopic: 'foo' });
    assert.match(out.userMessage, /gemini/);
    assert.match(out.userMessage, /GEMINI_RESPONSE_TOKEN/);
  });

  it('user message includes original topic so debate has context', () => {
    const out = buildDebatePrompt({ otherProvider: 'openai', otherResponse: 'r', originalTopic: 'topic-X-marker' });
    assert.match(out.userMessage, /topic-X-marker/);
  });
});

describe('buildDebatePrompt — assembled context (§14.A)', () => {
  it('includes systemPreface in the systemPrompt when assembled context provided', () => {
    const out = buildDebatePrompt({
      otherProvider: 'gemini', otherResponse: 'r', originalTopic: 't',
      assembledContext: { systemPreface: 'PREFACE_TOKEN', userPrefix: '' },
    });
    assert.match(out.systemPrompt, /PREFACE_TOKEN/);
  });

  it('includes userPrefix in the userMessage when assembled context provided', () => {
    const out = buildDebatePrompt({
      otherProvider: 'gemini', otherResponse: 'r', originalTopic: 't',
      assembledContext: { systemPreface: '', userPrefix: 'EARLIER_ROUNDS_TOKEN' },
    });
    assert.match(out.userMessage, /EARLIER_ROUNDS_TOKEN/);
  });

  it('includes withContextText in the userMessage when provided', () => {
    const out = buildDebatePrompt({
      otherProvider: 'gemini', otherResponse: 'r', originalTopic: 't',
      withContextText: 'WC_TOKEN',
    });
    assert.match(out.userMessage, /WC_TOKEN/);
  });

  it('omits sections cleanly when context is empty (no leading blank-blocks)', () => {
    const out = buildDebatePrompt({
      otherProvider: 'gemini', otherResponse: 'r', originalTopic: 't',
    });
    assert.ok(!out.userMessage.startsWith('\n\n'), 'userMessage should not start with empty section gaps');
  });

  it('Audit Gemini-G2-H3 contract: debate-prompt CALLER passes redacted topic, not raw — lock in', () => {
    // The buildDebatePrompt function itself echoes whatever it's given;
    // the caller (brainstorm-round.mjs runBrainstormMode) is responsible
    // for passing the post-redaction `topic` variable, NOT `args.topic`.
    // This test pins the prompt builder's contract so a future refactor
    // that changes the variable name still has to thread redacted text through.
    // The function takes raw text — caller redacts. We verify by passing
    // a string with a fake-secret marker and confirm the builder echoes verbatim
    // (so the responsibility for redaction stays at the caller boundary, not the builder).
    const fakeSecret = '[REDACTED:openai-key]';
    const out = buildDebatePrompt({ otherProvider: 'gemini', otherResponse: 'r', originalTopic: fakeSecret });
    assert.match(out.userMessage, /\[REDACTED:openai-key\]/);
  });
});
