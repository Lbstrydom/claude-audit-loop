import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  escapeMarkdown,
  escapeMermaidLabel,
  groupByDomain,
  renderArchitectureMap,
  renderNeighbourhoodCallout,
  renderDriftIssue,
} from '../scripts/lib/arch-render.mjs';

describe('escapeMarkdown', () => {
  it('escapes pipes', () => assert.equal(escapeMarkdown('a|b'), 'a\\|b'));
  it('strips newlines', () => assert.equal(escapeMarkdown('a\nb'), 'a b'));
  it('handles null/undefined', () => assert.equal(escapeMarkdown(null), ''));
});

describe('escapeMermaidLabel', () => {
  it('strips angle brackets and pipes', () => {
    assert.equal(escapeMermaidLabel('foo<bar|baz>'), 'foo bar baz ');
  });
  it('caps length', () => {
    assert.ok(escapeMermaidLabel('x'.repeat(120)).length <= 60);
  });
});

describe('groupByDomain', () => {
  it('groups by domainTag with stable ordering', () => {
    const symbols = [
      { domainTag: 'b', filePath: 'b.mjs', symbolName: 'y' },
      { domainTag: 'a', filePath: 'a.mjs', symbolName: 'x' },
      { domainTag: 'a', filePath: 'a.mjs', symbolName: 'w' },
    ];
    const g = groupByDomain(symbols);
    assert.deepEqual([...g.keys()], ['a', 'b']);
    assert.equal(g.get('a').length, 2);
    assert.equal(g.get('a')[0].symbolName, 'w');
  });
  it('sends untagged to _other', () => {
    const g = groupByDomain([{ filePath: 'x.mjs', symbolName: 'a' }]);
    assert.ok(g.has('_other'));
  });
});

describe('renderArchitectureMap', () => {
  it('starts with the sticky marker', () => {
    const { markdown } = renderArchitectureMap({
      repoName: 'r', generatedAt: '2026-05-01T00:00:00Z', commitSha: 'abc1234',
      refreshId: '00000000-0000-4000-8000-000000000001',
      drift: 0, threshold: 20, status: 'GREEN',
      symbols: [], violations: [],
    });
    assert.ok(markdown.startsWith('<!-- audit-loop:architectural-map -->'));
  });
  it('includes timestamp + commit + refresh_id in header', () => {
    const { markdown } = renderArchitectureMap({
      repoName: 'r', generatedAt: '2026-05-01T00:00:00Z', commitSha: 'abc1234',
      refreshId: '00000000-0000-4000-8000-000000000001',
      drift: 0, threshold: 20, status: 'GREEN',
      symbols: [], violations: [],
    });
    assert.match(markdown, /Generated: \d{4}-\d{2}-\d{2}T.*commit: [0-9a-f]{7,}.*refresh_id: [0-9a-f-]{36}/);
  });
  it('includes drift score line', () => {
    const { markdown } = renderArchitectureMap({
      repoName: 'r', generatedAt: '2026-05-01T00:00:00Z', commitSha: 'abc',
      refreshId: 'rid', drift: 5, threshold: 20, status: 'GREEN',
      symbols: [], violations: [],
    });
    assert.match(markdown, /Drift score: \d+ \/ threshold \d+/);
  });
  it('includes "How to regenerate" + "How to interpret" footers', () => {
    const { markdown } = renderArchitectureMap({
      repoName: 'r', generatedAt: 't', commitSha: 'c', refreshId: 'r',
      drift: 0, threshold: 20, status: 'GREEN',
      symbols: [], violations: [],
    });
    assert.ok(markdown.includes('## How to regenerate'));
    assert.ok(markdown.includes('## How to interpret'));
  });
  it('marks duplicates with [DUP] in table and dup class in mermaid', () => {
    const symbols = [
      { id: 'a', symbolName: 'foo', kind: 'function', filePath: 'a.mjs', startLine: 1, endLine: 2, purposeSummary: '' },
      { id: 'b', symbolName: 'bar', kind: 'function', filePath: 'b.mjs', startLine: 1, endLine: 2, purposeSummary: '' },
    ];
    const dups = new Set(['a', 'b']);
    const { markdown } = renderArchitectureMap({
      repoName: 'r', generatedAt: 't', commitSha: 'c', refreshId: 'rid',
      drift: 5, threshold: 20, status: 'AMBER',
      symbols, violations: [], dupSymbolIds: dups,
    });
    assert.ok(markdown.includes('[DUP]'));
    assert.ok(markdown.includes(':::dup'));
  });
  it('every classDef has both fill: and color:', () => {
    const { markdown } = renderArchitectureMap({
      repoName: 'r', generatedAt: 't', commitSha: 'c', refreshId: 'rid',
      drift: 0, threshold: 20, status: 'GREEN',
      symbols: [{ id: 'x', symbolName: 'x', kind: 'function', filePath: 'a.mjs', startLine: 1, endLine: 2 }],
      violations: [],
    });
    const classDefs = (markdown.match(/^classDef [^\n]+$/gm) || []);
    assert.ok(classDefs.length > 0);
    for (const c of classDefs) {
      assert.ok(c.includes('fill:'), `classDef missing fill: ${c}`);
      assert.ok(c.includes('color:'), `classDef missing color: ${c}`);
    }
  });
  it('is byte-deterministic for identical input', () => {
    const args = {
      repoName: 'r', generatedAt: '2026-05-01T00:00:00Z', commitSha: 'abc',
      refreshId: 'rid', drift: 0, threshold: 20, status: 'GREEN',
      symbols: [
        { id: 'b', symbolName: 'b', kind: 'function', filePath: 'b.mjs', startLine: 1, endLine: 2 },
        { id: 'a', symbolName: 'a', kind: 'function', filePath: 'a.mjs', startLine: 1, endLine: 2 },
      ],
      violations: [],
    };
    const r1 = renderArchitectureMap(args).markdown;
    const r2 = renderArchitectureMap(args).markdown;
    assert.equal(r1, r2);
  });
});

describe('renderNeighbourhoodCallout', () => {
  it('cloud-off state includes refresh hint', () => {
    const { markdown } = renderNeighbourhoodCallout({ records: [], cloudStatus: 'cloud-off' });
    assert.ok(markdown.includes('npm run arch:refresh'));
  });
  it('error state includes "consultation failed"', () => {
    const { markdown } = renderNeighbourhoodCallout({ records: [], cloudStatus: 'error', hint: 'RPC_ERROR' });
    assert.match(markdown, /consultation failed/);
  });
  it('empty records emits "No near-duplicates found"', () => {
    const { markdown } = renderNeighbourhoodCallout({
      records: [], cloudStatus: 'ok', targetPaths: ['x.mjs'],
    });
    assert.match(markdown, /No near-duplicates found/);
  });
  it('non-empty emits a blockquote callout starting with "Neighbourhood considered"', () => {
    const { markdown } = renderNeighbourhoodCallout({
      cloudStatus: 'ok',
      targetPaths: ['x.mjs'],
      totalCandidatesConsidered: 1,
      records: [{
        symbolName: 'foo', filePath: 'lib/x.mjs', startLine: 10,
        kind: 'function', purposeSummary: 'does foo',
        similarityScore: 0.91, hopScore: 1.0, score: 0.95, recommendation: 'reuse',
      }],
    });
    assert.match(markdown, /^> \*\*Neighbourhood considered\*\*/);
  });
});

describe('renderDriftIssue', () => {
  it('starts with sticky marker', () => {
    const { markdown } = renderDriftIssue({
      drift: { score: 25 }, threshold: 20, status: 'RED',
      generatedAt: '2026-05-01T00:00:00Z', commitSha: 'abc', refreshId: 'rid',
      repoName: 'r',
    });
    assert.ok(markdown.startsWith('<!-- audit-loop:architectural-drift -->'));
  });
  it('collapses long tail under <details>', () => {
    const clusters = Array.from({ length: 8 }, (_, i) => ({
      label: `cluster ${i}`, similarity: 0.9, members: [{ symbolName: `s${i}`, filePath: 'a.mjs' }],
    }));
    const { markdown, longTailHidden } = renderDriftIssue({
      drift: { score: 30 }, threshold: 20, status: 'RED',
      generatedAt: 't', commitSha: 'c', refreshId: 'r',
      repoName: 'x', clusters,
    });
    assert.ok(markdown.includes('<details>'));
    assert.ok(markdown.match(/<summary>Long tail/));
    assert.equal(longTailHidden, 3);
  });
});
