import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  jaccardSimilarity,
  tokenize,
  extractParagraphs,
  findSimilarParagraphs,
} from '../../scripts/lib/claudemd/doc-similarity.mjs';

describe('jaccardSimilarity', () => {
  it('returns 1.0 for identical sets', () => {
    const a = new Set(['hello', 'world', 'test']);
    assert.equal(jaccardSimilarity(a, a), 1.0);
  });

  it('returns 0 for disjoint sets', () => {
    const a = new Set(['hello', 'world']);
    const b = new Set(['foo', 'bar']);
    assert.equal(jaccardSimilarity(a, b), 0);
  });

  it('returns 0 for two empty sets', () => {
    assert.equal(jaccardSimilarity(new Set(), new Set()), 0);
  });

  it('computes correct partial overlap', () => {
    const a = new Set(['hello', 'world', 'test']);
    const b = new Set(['hello', 'world', 'other']);
    // intersection=2, union=4 → 0.5
    assert.equal(jaccardSimilarity(a, b), 0.5);
  });
});

describe('tokenize', () => {
  it('lowercases and filters stopwords', () => {
    const tokens = tokenize('The Quick Brown Fox');
    assert.ok(!tokens.has('the'));
    assert.ok(tokens.has('quick'));
    assert.ok(tokens.has('brown'));
    assert.ok(tokens.has('fox'));
  });

  it('strips markdown formatting', () => {
    const tokens = tokenize('**bold** and [link](url)');
    assert.ok(tokens.has('bold'));
    assert.ok(tokens.has('link'));
    assert.ok(!tokens.has('url'));
  });
});

describe('extractParagraphs', () => {
  it('splits on blank lines', () => {
    const paras = extractParagraphs('First paragraph.\n\nSecond paragraph.');
    assert.equal(paras.length, 2);
    assert.equal(paras[0].text, 'First paragraph.');
    assert.equal(paras[1].text, 'Second paragraph.');
  });

  it('skips code blocks', () => {
    const content = 'Before\n\n```\ncode\n```\n\nAfter';
    const paras = extractParagraphs(content);
    assert.equal(paras.length, 2);
    assert.equal(paras[0].text, 'Before');
    assert.equal(paras[1].text, 'After');
  });

  it('tracks line numbers', () => {
    const paras = extractParagraphs('Line 1\n\nLine 3');
    assert.equal(paras[0].startLine, 1);
    assert.equal(paras[1].startLine, 3);
  });
});

describe('findSimilarParagraphs', () => {
  it('detects identical paragraphs', () => {
    // Create a paragraph with enough tokens (>50 after stopword removal)
    const para = Array(60).fill('unique').map((w, i) => `${w}${i}`).join(' ');
    const matches = findSimilarParagraphs(para, para, { threshold: 0.8, minTokens: 10 });
    assert.ok(matches.length > 0, 'identical paragraphs should match');
    assert.equal(matches[0].score, 1.0);
  });

  it('does not match short paragraphs', () => {
    const matches = findSimilarParagraphs('Short text.', 'Short text.', { minTokens: 50 });
    assert.equal(matches.length, 0, 'short paragraphs should be ignored');
  });

  it('does not match dissimilar content', () => {
    const a = Array(60).fill(0).map((_, i) => `alpha${i}`).join(' ');
    const b = Array(60).fill(0).map((_, i) => `beta${i}`).join(' ');
    const matches = findSimilarParagraphs(a, b, { threshold: 0.8, minTokens: 10 });
    assert.equal(matches.length, 0, 'dissimilar content should not match');
  });
});
