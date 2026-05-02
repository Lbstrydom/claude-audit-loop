/**
 * @fileoverview Pure renderers for the architectural-memory human surfaces.
 * No I/O. Imported by render-mermaid.mjs (architecture-map.md), drift.mjs
 * (sticky issue body), and the neighbourhood callout formatter.
 *
 * Per frontend plan §4 — these implement the data → presentation conversion
 * (RenderedNeighbourhoodCalloutSchema, RenderedArchitectureMapSchema,
 * RenderedDriftIssueSchema).
 *
 * @module scripts/lib/arch-render
 */

const MERMAID_DEFS = `
classDef container fill:#f5f5f5,stroke:#333,stroke-width:2px,color:#000
classDef component fill:#e8f0ff,stroke:#3178c6,color:#000
classDef symbol fill:#fff,stroke:#999,color:#444
classDef dup fill:#ffe8d8,stroke:#c0392b,stroke-width:2px,color:#000
classDef violation fill:#ffd6d6,stroke:#c0392b,stroke-width:2px,color:#000
`.trim();

/** Escape pipes/newlines for Markdown table cells. */
export function escapeMarkdown(s) {
  if (s == null) return '';
  return String(s)
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ')
    .replace(/\r/g, '');
}

/** Escape characters Mermaid balks at inside node labels. */
export function escapeMermaidLabel(s) {
  if (s == null) return '';
  return String(s)
    .replace(/"/g, "'")
    .replace(/[<>|]/g, ' ')
    .slice(0, 60);
}

/** Stable safe ID for Mermaid nodes. */
export function mermaidId(prefix, key) {
  return `${prefix}_` + String(key).replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 40);
}

/** Group symbol records by domain_tag (or '_other' if unset). */
export function groupByDomain(symbols) {
  const map = new Map();
  for (const s of symbols) {
    const d = s.domainTag || '_other';
    if (!map.has(d)) map.set(d, []);
    map.get(d).push(s);
  }
  // Sort domains alphabetically; sort symbols within each domain by file then name
  const out = new Map();
  const keys = [...map.keys()].sort();
  for (const k of keys) {
    const arr = [...map.get(k)].sort((a, b) => {
      if (a.filePath !== b.filePath) return String(a.filePath).localeCompare(String(b.filePath));
      return String(a.symbolName).localeCompare(String(b.symbolName));
    });
    out.set(k, arr);
  }
  return out;
}

/**
 * Render one domain's Mermaid block.
 * Falls back to a summary diagram when symbols.length > 50.
 */
export function renderMermaidContainer(domain, symbols, dupSymbolIds = new Set()) {
  const lines = ['```mermaid', 'flowchart TB', `subgraph ${mermaidId('dom', domain)} ["${escapeMermaidLabel(domain)}"]`];
  let nodes = symbols;
  let truncated = false;
  if (symbols.length > 50) {
    truncated = true;
    nodes = symbols.slice(0, 15);
  }
  // Group by file
  const byFile = new Map();
  for (const s of nodes) {
    const f = s.filePath;
    if (!byFile.has(f)) byFile.set(f, []);
    byFile.get(f).push(s);
  }
  for (const [file, syms] of byFile) {
    const fileNode = mermaidId('file', file);
    lines.push(`  ${fileNode}["${escapeMermaidLabel(file)}"]:::component`);
    for (const s of syms) {
      const cls = dupSymbolIds.has(s.id) ? 'dup' : 'symbol';
      const label = escapeMermaidLabel(s.symbolName);
      const sNode = mermaidId('sym', `${file}_${s.symbolName}`);
      lines.push(`  ${sNode}["${label}"]:::${cls}`);
      lines.push(`  ${fileNode} --> ${sNode}`);
    }
  }
  lines.push('end');
  lines.push(MERMAID_DEFS);
  lines.push('```');
  if (truncated) {
    lines.push('');
    lines.push(`_Domain has ${symbols.length} symbols (>50). Diagram shows top-15 by file order; see flat table below for the full list._`);
  }
  return lines.join('\n');
}

/** Render a flat symbols table for a domain. */
export function renderSymbolTable(symbols, dupSymbolIds = new Set()) {
  const lines = ['| Symbol | Kind | Path | Lines | Purpose |', '|---|---|---|---|---|'];
  for (const s of symbols) {
    const dupTag = dupSymbolIds.has(s.id) ? ' [DUP]' : '';
    const link = s.startLine
      ? `[\`${escapeMarkdown(s.symbolName)}\`](../${s.filePath}#L${s.startLine})`
      : `\`${escapeMarkdown(s.symbolName)}\``;
    lines.push(
      `| ${link}${dupTag} | ${escapeMarkdown(s.kind)} | \`${escapeMarkdown(s.filePath)}\` | ${s.startLine ?? ''}-${s.endLine ?? ''} | ${escapeMarkdown(s.purposeSummary || '')} |`
    );
  }
  return lines.join('\n');
}

/** Top-of-file header. */
export function renderHeader({ repoName, generatedAt, commitSha, refreshId, drift, threshold, status, domainCount, symbolCount, violationCount }) {
  const lines = [
    '<!-- audit-loop:architectural-map -->',
    `# Architecture Map — ${escapeMarkdown(repoName)}`,
    '',
    `- Generated: ${generatedAt}   commit: ${commitSha || 'unknown'}   refresh_id: ${refreshId || 'none'}`,
    `- Drift score: ${drift ?? 0} / threshold ${threshold}   status: \`${status || 'INSUFFICIENT_DATA'}\``,
    `- Domains: ${domainCount}   Symbols: ${symbolCount}   Layering violations: ${violationCount}`,
    '',
  ];
  return lines.join('\n');
}

/** Renders the full architecture-map.md document. */
export function renderArchitectureMap({
  repoName, generatedAt, commitSha, refreshId,
  drift, threshold, status,
  symbols, violations,
  dupSymbolIds = new Set(),
}) {
  const grouped = groupByDomain(symbols);
  const domainCount = grouped.size;
  const violationCount = violations?.length || 0;

  const out = [renderHeader({
    repoName, generatedAt, commitSha, refreshId,
    drift, threshold, status,
    domainCount, symbolCount: symbols.length, violationCount,
  })];

  // Table of contents
  out.push('## Contents');
  for (const [domain, syms] of grouped) {
    const anchor = String(domain).toLowerCase().replace(/[^a-z0-9]+/g, '-');
    out.push(`- [${domain}](#${anchor}) — ${syms.length} symbols`);
  }
  out.push('');

  // Per-domain sections
  for (const [domain, syms] of grouped) {
    out.push(`---`);
    out.push('');
    out.push(`## ${domain}`);
    out.push('');
    out.push(renderMermaidContainer(domain, syms, dupSymbolIds));
    out.push('');
    out.push('### Symbols in this domain');
    out.push('');
    out.push(renderSymbolTable(syms, dupSymbolIds));
    out.push('');
  }

  // Layering violations
  out.push('---');
  out.push('');
  out.push('## Layering violations');
  out.push('');
  if (violationCount === 0) {
    out.push('_No violations detected on this snapshot._');
  } else {
    out.push('| Rule | From | To | Severity | Comment |');
    out.push('|---|---|---|---|---|');
    for (const v of violations) {
      out.push(`| ${escapeMarkdown(v.ruleName)} | \`${escapeMarkdown(v.fromPath)}\` | \`${escapeMarkdown(v.toPath)}\` | ${escapeMarkdown(v.severity)} | ${escapeMarkdown(v.comment || '')} |`);
    }
  }
  out.push('');

  // Footer
  out.push('---');
  out.push('');
  out.push('## How to regenerate');
  out.push('');
  out.push('```bash');
  out.push('npm run arch:refresh   # update the index');
  out.push('npm run arch:render    # regenerate this file');
  out.push('```');
  out.push('');
  out.push('## How to interpret');
  out.push('');
  out.push('- Each domain has a Mermaid diagram (containers → components → symbols) and a flat table.');
  out.push('- **Duplication clusters** appear with `[DUP]` in the table and the `dup` class in Mermaid.');
  out.push('- Layering violations appear in the dedicated section above.');
  out.push('- Anchor links remain stable across regenerations as long as symbol names don\'t change.');
  out.push('');

  const markdown = out.join('\n');
  return { markdown, bytesWritten: Buffer.byteLength(markdown, 'utf-8') };
}

/** Render the /plan-* "Neighbourhood considered" callout. */
export function renderNeighbourhoodCallout({ records, targetPaths, totalCandidatesConsidered, cloudStatus, hint }) {
  if (cloudStatus === 'cloud-off') {
    const md = [
      '> **Neighbourhood considered** — _skipped_',
      '>',
      '> Architectural-memory store is offline (Supabase env unset).',
      `> Run \`npm run arch:refresh\` to enable consultation. Plan proceeds`,
      `> without architectural context.`,
    ].join('\n');
    return { markdown: md, appendixMarkdown: '', truncatedAt: 0 };
  }
  if (cloudStatus === 'error') {
    const md = [
      '> **Neighbourhood considered** — _consultation failed_',
      '>',
      `> _consultation failed: ${escapeMarkdown(hint || 'unknown error')}; plan proceeds without architectural context_`,
    ].join('\n');
    return { markdown: md, appendixMarkdown: '', truncatedAt: 0 };
  }
  if (!records || records.length === 0) {
    const md = [
      '> **Neighbourhood considered**',
      '>',
      `> _No near-duplicates found in the symbol-index for this neighbourhood`,
      `> (target paths: ${(targetPaths || []).map(p => `\`${p}\``).join(', ') || '(none)'}).`,
      `> Proceeding as a greenfield addition._`,
    ].join('\n');
    return { markdown: md, appendixMarkdown: '', truncatedAt: 0 };
  }
  const TOP_N = 5;
  const top = records.slice(0, TOP_N);
  const rows = [
    '> **Neighbourhood considered** (' + top.length + ' of ' + totalCandidatesConsidered + ' candidates from symbol-index)',
    '>',
    '> | Symbol | Path | Sim | Recommendation | Purpose |',
    '> |---|---|---|---|---|',
  ];
  for (const r of top) {
    const path = r.startLine ? `${r.filePath}:${r.startLine}` : r.filePath;
    rows.push(
      `> | \`${escapeMarkdown(r.symbolName)}\` | \`${escapeMarkdown(path)}\` | ${(r.similarityScore || 0).toFixed(2)} | **${r.recommendation}** | ${escapeMarkdown(r.purposeSummary || '')} |`
    );
  }
  if (records.length > TOP_N) {
    rows.push('>');
    rows.push(`> _Top-${TOP_N} of ${records.length}. Full neighbourhood at end of this plan._`);
  }
  // Appendix (full list as flat table, not in callout)
  const appendix = [
    '## Full neighbourhood considered',
    '',
    '| Symbol | Path | Sim | Hop | Score | Recommendation | Purpose |',
    '|---|---|---|---|---|---|---|',
    ...records.map(r => {
      const path = r.startLine ? `${r.filePath}:${r.startLine}` : r.filePath;
      return `| \`${escapeMarkdown(r.symbolName)}\` | \`${escapeMarkdown(path)}\` | ${(r.similarityScore || 0).toFixed(2)} | ${(r.hopScore || 0).toFixed(2)} | ${(r.score || 0).toFixed(2)} | **${r.recommendation}** | ${escapeMarkdown(r.purposeSummary || '')} |`;
    }),
  ].join('\n');
  return {
    markdown: rows.join('\n'),
    appendixMarkdown: appendix,
    truncatedAt: TOP_N,
  };
}

/** Render the drift-sweep sticky-issue body. */
export function renderDriftIssue({ drift, threshold, status, clusters = [], violations = [], generatedAt, commitSha, refreshId, repoName }) {
  const TOP_CLUSTERS = 5;
  const top = clusters.slice(0, TOP_CLUSTERS);
  const tail = clusters.slice(TOP_CLUSTERS);
  const lines = [
    '<!-- audit-loop:architectural-drift -->',
    '# Architectural drift report',
    '',
    `- **Repo:** ${escapeMarkdown(repoName || 'unknown')}`,
    `- **Status:** \`${status}\``,
    `- **Generated:** ${generatedAt}`,
    `- **Commit:** ${commitSha || 'unknown'}   refresh_id: ${refreshId || 'unknown'}`,
    `- **Drift score:** ${drift?.score ?? 0} / threshold ${threshold}`,
    `- **Duplication pairs:** ${drift?.duplication_pairs ?? drift?.duplicationPairs ?? 0}`,
    `- **Layering violations:** ${drift?.layering_violations ?? drift?.layeringViolations ?? 0}`,
    '',
  ];
  if (top.length > 0) {
    lines.push('## Top duplication clusters');
    lines.push('');
    for (let i = 0; i < top.length; i++) {
      const c = top[i];
      lines.push(`### ${i + 1}. ${escapeMarkdown(c.label || 'cluster')} (cosine ${(c.similarity || 0).toFixed(2)})${c.firstSeen ? ` — first seen ${c.firstSeen}` : ''}`);
      lines.push('');
      lines.push('| Symbol | Path | Purpose |');
      lines.push('|---|---|---|');
      for (const m of (c.members || [])) {
        lines.push(`| \`${escapeMarkdown(m.symbolName)}\` | \`${escapeMarkdown(m.filePath)}${m.startLine ? ':' + m.startLine : ''}\` | ${escapeMarkdown(m.purposeSummary || '')} |`);
      }
      lines.push('');
    }
  }
  if (tail.length > 0) {
    lines.push('<details>');
    lines.push(`<summary>Long tail — ${tail.length} lower-priority items</summary>`);
    lines.push('');
    lines.push('| # | Symbols |');
    lines.push('|---|---|');
    tail.forEach((c, i) => {
      const names = (c.members || []).map(m => `\`${escapeMarkdown(m.symbolName)}\``).join(', ');
      lines.push(`| ${TOP_CLUSTERS + i + 1} | ${names} |`);
    });
    lines.push('</details>');
    lines.push('');
  }
  if (violations.length > 0) {
    lines.push('## Layering violations');
    lines.push('');
    lines.push('| Rule | From | To | Severity |');
    lines.push('|---|---|---|---|');
    for (const v of violations) {
      lines.push(`| ${escapeMarkdown(v.ruleName)} | \`${escapeMarkdown(v.fromPath)}\` | \`${escapeMarkdown(v.toPath)}\` | ${escapeMarkdown(v.severity)} |`);
    }
    lines.push('');
  }
  lines.push('## Decision rule');
  lines.push('');
  lines.push('- 0 metrics fired for 4 weeks → consider raising threshold.');
  lines.push('- 1 metric for 2 weeks → triage top cluster.');
  lines.push('- 2+ metrics → schedule a refactor pass.');
  const markdown = lines.join('\n');
  return { markdown, topClustersShown: top.length, longTailHidden: tail.length };
}
