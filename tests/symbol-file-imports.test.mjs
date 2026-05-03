/**
 * Tests for the symbol_file_imports persistence pipeline.
 * Plan v6 §2.6 + §2.6.1.
 *
 * The full extract→refresh→persist→copy-forward pipeline requires Supabase,
 * so these tests cover the deterministic logic at the boundaries:
 *   - extract.mjs's isInternalEdge filter (covered in import-edge-filter.test.mjs)
 *   - The chain-of-trust rule for import_graph_populated (R2-H1)
 *   - The renderer's "0 importers + populated=false" handling
 *   - The renderer's "0 importers + populated=true" handling
 *   - importer_path-keyed copy-forward semantics (R1-H1)
 *
 * Live integration smoke (npm run arch:refresh:full → arch:render) is the
 * end-to-end gate.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderSymbolTable } from '../scripts/lib/arch-render.mjs';

// Mirror the chain-of-trust logic from refresh.mjs
function computeImportGraphPopulated(mode, priorPopulated) {
  return (mode === 'full') || (mode === 'incremental' && priorPopulated === true);
}

// Mirror the importer-keyed copy-forward filter from learning-store.mjs
function shouldCopyForward(row, touchedFileSet) {
  return !touchedFileSet.has(row.importer_path);
}

describe('chain-of-trust for import_graph_populated (Plan v6 §2.6.1, R2-H1)', () => {
  it('full refresh → always populated', () => {
    assert.equal(computeImportGraphPopulated('full', null), true);
    assert.equal(computeImportGraphPopulated('full', false), true);
    assert.equal(computeImportGraphPopulated('full', true), true);
  });

  it('incremental from populated → populated (carry-forward + new = full)', () => {
    assert.equal(computeImportGraphPopulated('incremental', true), true);
  });

  it('incremental from un-populated → NOT populated (would have gaps)', () => {
    assert.equal(computeImportGraphPopulated('incremental', false), false);
  });

  it('incremental from null prior → NOT populated', () => {
    assert.equal(computeImportGraphPopulated('incremental', null), false);
  });
});

describe('importer-keyed copy-forward (Plan v6 §2.6, R1-H1)', () => {
  // Edges in prior snapshot
  const priorEdges = [
    { importer_path: 'a.js', imported_path: 'b.js' },
    { importer_path: 'a.js', imported_path: 'c.js' },
    { importer_path: 'd.js', imported_path: 'b.js' },
    { importer_path: 'd.js', imported_path: 'c.js' },
  ];

  it('untouched importer files → all their edges carry forward', () => {
    const touched = new Set();  // nothing touched
    const carried = priorEdges.filter(e => shouldCopyForward(e, touched));
    assert.equal(carried.length, 4);
  });

  it('touched importer file → its edges DROPPED (importer re-emits current edges)', () => {
    // a.js was touched and modified — its current edges will be re-extracted.
    // The OLD edges (a→b, a→c) must NOT be carried forward, even though
    // b.js and c.js are untouched. (R1-H1: edges owned by importer side.)
    const touched = new Set(['a.js']);
    const carried = priorEdges.filter(e => shouldCopyForward(e, touched));
    assert.equal(carried.length, 2, 'only d.js edges carry');
    assert.deepEqual(
      carried.map(e => e.importer_path).sort(),
      ['d.js', 'd.js'],
    );
  });

  it('the bug scenario: a.js (touched) DROPS its import of b.js (untouched)', () => {
    // After this refresh: a.js no longer imports b.js. Its current edges
    // are just a→c. The dropped (a,b) edge must NOT linger.
    const touched = new Set(['a.js']);
    const carriedFromPrior = priorEdges.filter(e => shouldCopyForward(e, touched));
    const newlyExtracted = [{ importer_path: 'a.js', imported_path: 'c.js' }];  // a.js's new edges (b dropped)
    const finalSnapshot = [...carriedFromPrior, ...newlyExtracted];

    // (a, b) must be ABSENT
    assert.equal(
      finalSnapshot.some(e => e.importer_path === 'a.js' && e.imported_path === 'b.js'),
      false,
      'naive imported-keyed copy-forward would have kept this stale edge — must not',
    );
    // (a, c) is present from new extraction
    assert.equal(
      finalSnapshot.some(e => e.importer_path === 'a.js' && e.imported_path === 'c.js'),
      true,
    );
    // d.js's edges (untouched importer) carry forward
    assert.equal(finalSnapshot.filter(e => e.importer_path === 'd.js').length, 2);
  });
});

describe('renderer respects importGraphPopulated (Plan v6 §2.6.1, R1-H2)', () => {
  const sampleSymbols = [
    { id: 's1', symbolName: 'foo', kind: 'function', filePath: 'src/leaf.js',
      startLine: 10, endLine: 20, purposeSummary: 'A leaf function', domainTag: 'core' },
  ];

  it('populated=true + no importers → "(internal)" (true leaf)', () => {
    const out = renderSymbolTable(sampleSymbols, new Set(), {
      importerMap: new Map(), importGraphPopulated: true,
    });
    assert.match(out, /_\(internal\)_/);
    assert.doesNotMatch(out, /unknown/);
  });

  it('populated=false + no importers → "(unknown)" (pre-feature snapshot)', () => {
    const out = renderSymbolTable(sampleSymbols, new Set(), {
      importerMap: new Map(), importGraphPopulated: false,
    });
    assert.match(out, /_\(unknown — run `npm run arch:refresh:full`\)_/);
    assert.doesNotMatch(out, /\(internal\)/);
  });

  it('populated=true + 1 importer → renders importer path', () => {
    const out = renderSymbolTable(sampleSymbols, new Set(), {
      importerMap: new Map([['src/leaf.js', ['src/caller.js']]]),
      importGraphPopulated: true,
    });
    assert.match(out, /`src\/caller\.js`/);
  });
});
