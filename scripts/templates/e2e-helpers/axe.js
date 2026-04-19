import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const axeSrc = readFileSync(
  resolve(HERE, '../../../node_modules/axe-core/axe.min.js'),
  'utf8'
);

/**
 * Run axe-core on the page and fail on WCAG AA violations.
 * Template from claude-engineering-skills.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{ include?: string, ignore?: string[] }} [opts]
 */
export async function expectNoA11yViolations(page, opts = {}) {
  await page.evaluate(axeSrc);
  const results = await page.evaluate(async ({ include, ignore }) => {
    const context = include ? { include: [include], exclude: ignore || [] } : { exclude: ignore || [] };
    const r = await window.axe.run(context, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] },
      resultTypes: ['violations'],
    });
    return r.violations.map(v => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      nodes: v.nodes.map(n => ({ target: n.target, html: String(n.html || '').slice(0, 200) })),
    }));
  }, { include: opts.include, ignore: opts.ignore });

  if (results.length) {
    const msg = results.map(v =>
      `  [${v.impact}] ${v.id}: ${v.help}\n    targets: ${v.nodes.slice(0, 3).map(n => n.target.join(' ')).join(', ')}`
    ).join('\n');
    throw new Error(`axe-core violations:\n${msg}`);
  }
}
