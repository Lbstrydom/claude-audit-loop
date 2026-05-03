/**
 * Tests for the planning-anchor renderer extensions:
 *   - renderNeighbourhoodCallout adds Domain column (Plan v6 §2.1)
 *   - renderArchitectureMap embeds per-domain summaries (§2.5)
 *   - renderArchitectureMap embeds "File imported by" + footer (§2.6, §2.7)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderNeighbourhoodCallout,
  renderArchitectureMap,
  renderSymbolTable,
} from '../scripts/lib/arch-render.mjs';

const sampleSymbols = [
  { id: 's1', symbolName: 'foo', kind: 'function', filePath: 'src/foo.js', startLine: 10, endLine: 20, purposeSummary: 'Does foo', domainTag: 'wine-shop' },
  { id: 's2', symbolName: 'bar', kind: 'function', filePath: 'src/bar.js', startLine: 5,  endLine: 15, purposeSummary: 'Does bar', domainTag: 'wine-shop' },
];

describe('renderNeighbourhoodCallout — Domain column (Plan v6 §2.1)', () => {
  it('callout table has Domain column header', () => {
    const records = [{
      symbolName: 'getCellar', filePath: 'src/cellar/get.js', startLine: 12,
      similarityScore: 0.91, recommendation: 'reuse',
      purposeSummary: 'Read cellar', domainTag: 'cellar-backend',
    }];
    const { markdown } = renderNeighbourhoodCallout({
      records, targetPaths: ['src/foo.js'], totalCandidatesConsidered: 1,
    });
    assert.match(markdown, /\| Symbol \| Path \| Domain \| Sim \| Recommendation \| Purpose \|/);
    assert.match(markdown, /`cellar-backend`/);
  });

  it('renders em-dash for null domainTag', () => {
    const records = [{
      symbolName: 'leaf', filePath: 'src/leaf.js',
      similarityScore: 0.5, recommendation: 'review',
      purposeSummary: 'A leaf', domainTag: null,
    }];
    const { markdown } = renderNeighbourhoodCallout({
      records, targetPaths: ['x'], totalCandidatesConsidered: 1,
    });
    assert.match(markdown, /\| — \|/);
  });

  it('appendix also has Domain column', () => {
    const records = Array.from({ length: 8 }, (_, i) => ({
      symbolName: `sym${i}`, filePath: `src/x${i}.js`,
      similarityScore: 0.5, recommendation: 'review',
      purposeSummary: `purpose ${i}`, domainTag: i % 2 === 0 ? 'A' : 'B',
    }));
    const { appendixMarkdown } = renderNeighbourhoodCallout({
      records, targetPaths: ['x'], totalCandidatesConsidered: 8,
    });
    assert.match(appendixMarkdown, /\| Symbol \| Path \| Domain \| Sim \| Hop \| Score/);
    assert.match(appendixMarkdown, /`A`/);
    assert.match(appendixMarkdown, /`B`/);
  });
});

describe('renderArchitectureMap — domain summaries (Plan v6 §2.5)', () => {
  it('embeds summary blockquote below `## <domain>` heading', () => {
    const summaries = new Map([['wine-shop', 'Catalog browsing UI for the cellar.']]);
    const { markdown } = renderArchitectureMap({
      repoName: 'test', generatedAt: '2026-05-03T00:00:00Z', commitSha: 'abc',
      refreshId: 'r1', drift: 0, threshold: 20, status: 'GREEN',
      symbols: sampleSymbols, violations: [],
      domainSummaries: summaries,
    });
    assert.match(markdown, /## wine-shop\n\n> Catalog browsing UI for the cellar\./);
  });

  it('omits summary when not provided', () => {
    const { markdown } = renderArchitectureMap({
      repoName: 'test', generatedAt: '2026-05-03T00:00:00Z', commitSha: 'abc',
      refreshId: 'r1', drift: 0, threshold: 20, status: 'GREEN',
      symbols: sampleSymbols, violations: [],
    });
    // No blockquote between heading and Mermaid
    assert.doesNotMatch(markdown, /## wine-shop\n\n>/);
  });
});

describe('renderArchitectureMap — File imported by column (Plan v6 §2.6)', () => {
  it('omits column entirely when importerMap is null', () => {
    const { markdown } = renderArchitectureMap({
      repoName: 'test', generatedAt: '2026-05-03T00:00:00Z', commitSha: 'abc',
      refreshId: 'r1', drift: 0, threshold: 20, status: 'GREEN',
      symbols: sampleSymbols, violations: [],
      importerMap: null,
    });
    assert.doesNotMatch(markdown, /File imported by/);
  });

  it('renders alphabetical top-3 with +N more (R1-L1)', () => {
    const importerMap = new Map([
      ['src/foo.js', ['src/zzz.js', 'src/aaa.js', 'src/mmm.js', 'src/bbb.js']],
    ]);
    const out = renderSymbolTable(sampleSymbols, new Set(), {
      importerMap, importGraphPopulated: true,
    });
    // Should appear sorted: aaa, bbb, mmm + ", +1 more"
    assert.match(out, /`src\/aaa\.js`, `src\/bbb\.js`, `src\/mmm\.js`, \+1 more/);
  });

  it('renders (internal) when populated and 0 importers', () => {
    const importerMap = new Map();
    const out = renderSymbolTable(sampleSymbols, new Set(), {
      importerMap, importGraphPopulated: true,
    });
    assert.match(out, /_\(internal\)_/);
  });

  it('renders (unknown — run arch:refresh:full) when not populated', () => {
    const importerMap = new Map();
    const out = renderSymbolTable(sampleSymbols, new Set(), {
      importerMap, importGraphPopulated: false,
    });
    assert.match(out, /_\(unknown — run `npm run arch:refresh:full`\)_/);
  });
});

describe('renderArchitectureMap — footer (Plan v6 §2.7)', () => {
  it('always emits "Plan a change in this area" footer', () => {
    const { markdown } = renderArchitectureMap({
      repoName: 'test', generatedAt: '2026-05-03T00:00:00Z', commitSha: 'abc',
      refreshId: 'r1', drift: 0, threshold: 20, status: 'GREEN',
      symbols: sampleSymbols, violations: [],
    });
    assert.match(markdown, /## Plan a change in this area/);
    assert.match(markdown, /\/plan <task description>/);
    assert.match(markdown, /\/explain <file:line>/);
    assert.match(markdown, /npm run arch:duplicates/);
    assert.match(markdown, /\/cycle <task>/);
  });
});
