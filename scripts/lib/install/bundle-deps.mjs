/**
 * @fileoverview Read the bundle's own npm-dependency declaration, and report on it.
 *
 * The WRITE half lives in `scripts/generate-bundle-deps.mjs`, which is
 * source-repo-only because it walks the consumer registry. This half syncs: it
 * is what lets `check-setup.mjs` answer "is every package this bundle imports
 * actually installed here?" in a consumer, where the derived set
 * (`bundleDeps()` in `./deps.mjs`) is unreachable by construction.
 *
 * Deliberately imports NOTHING source-only — no `./deps.mjs`, no
 * `../sync-inventory.mjs`. The curated optional set and the generated-spec
 * allowlist are INJECTED by the generator rather than imported here, because
 * importing either would drag the consumer registry into every consumer's
 * bundle through the closure walk.
 *
 * @module scripts/lib/install/bundle-deps
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import { detectPackageManager, displayAddDev } from '../package-manager.mjs';

/** Bundle-relative location. Lives beside the other `lib/` assets in both layouts. */
export const BUNDLE_DEPS_FILENAME = 'bundle-deps.json';
export const BUNDLE_DEPS_RELATIVE_PATH = `scripts/lib/${BUNDLE_DEPS_FILENAME}`;

/**
 * Read the declaration from a bundle, in EITHER layout.
 *
 * Callers resolve it relative to their OWN location, so one call works at
 * `scripts/` (source) and `scripts/.claude-skills/` (consumer).
 *
 * Returns null when absent or malformed — an older bundle predates this file,
 * and that must degrade to "cannot check" rather than "nothing to check".
 *
 * @param {string} scriptsDir directory holding the CLI doing the reading
 * @returns {{packages: Array<{name: string, required: boolean, importers: string[]}>,
 *   generatedSpecPackages?: {packages: string[]}}|null}
 */
export function readBundleDeps(scriptsDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(scriptsDir, 'lib', BUNDLE_DEPS_FILENAME), 'utf-8'));
    return Array.isArray(raw?.packages) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Is `pkg` resolvable from `repoRoot`?
 *
 * **Probe by RESOLUTION, never by `<repoRoot>/node_modules/<pkg>`.** That path
 * test is right for `ensureAuditDeps`, which is deciding what to install into a
 * main checkout. It is wrong for a health check: a linked worktree has no
 * `node_modules` of its own and inherits the main checkout's by node's own
 * walk-up, so the path test reported 13 of 16 packages missing on an install
 * where every one of them imports fine (measured 2026-09-07 — check-setup's
 * Browser section resolved `playwright` in the same run this called it absent).
 * `createRequire` asks the question node itself asks. pnpm needs no adjustment:
 * every dep here is direct, and pnpm resolves direct dependencies normally.
 *
 * A resolution error that is NOT `MODULE_NOT_FOUND` means the package was found
 * and only a subpath was refused (an `exports` map without `./package.json`),
 * which is presence, not absence.
 */
export function makeInstalledProbe(repoRoot) {
  const requireFrom = createRequire(path.join(repoRoot, 'bundle-deps-probe.cjs'));
  return (pkg) => {
    try { requireFrom.resolve(pkg); return true; }
    catch (err) { return err?.code !== 'MODULE_NOT_FOUND'; }
  };
}

/**
 * Report the install state of every declared package into a check-setup report.
 *
 * **Why this exists at all.** Until 2026-09-07 that health check special-cased
 * exactly ONE dependency — playwright — and the comment justifying that makes
 * the general argument itself: leaving it to the runners made the check
 * "structurally unable to report the one dependency four skills cannot run
 * without". The reasoning covers the other fifteen, and it did not cover them:
 * check-setup exited 0 on an install missing `ts-morph` (upstream ea23dfda).
 *
 * @param {{section: Function, pass: Function, warn: Function, fail: Function}} report
 * @param {string} repoRoot the repo being checked
 * @param {string} scriptsDir where the calling CLI lives
 * @param {{installed?: (pkg: string) => boolean}} [io] injected for tests
 */
export function checkBundleDependencies(report, repoRoot, scriptsDir, io = {}) {
  report.section('Bundle dependencies');
  const declared = readBundleDeps(scriptsDir);
  if (!declared) {
    report.warn(
      'bundle-deps.json not found',
      'this bundle predates the dependency declaration — the install cannot be verified',
      'Re-sync from claude-engineering-skills to pick it up.');
    return;
  }
  const installed = io.installed ?? makeInstalledProbe(repoRoot);
  const missingRequired = declared.packages.filter((p) => p.required && !installed(p.name));
  const missingOptional = declared.packages.filter((p) => !p.required && !installed(p.name));
  const pm = detectPackageManager(repoRoot).name;

  if (missingRequired.length) {
    report.fail(
      `${missingRequired.length} required package(s) missing`,
      // Name an importer, so the report answers "why does this bundle need it?"
      // rather than asserting a need the reader has to take on faith.
      missingRequired.map((p) => `${p.name} (imported by ${p.importers[0]}${p.importers.length > 1 ? ` +${p.importers.length - 1} more` : ''})`).join(', '),
      displayAddDev(pm, missingRequired.map((p) => p.name), repoRoot));
  } else {
    report.pass('Required packages', `${declared.packages.filter((p) => p.required).length} present`);
  }

  if (missingOptional.length) {
    report.warn(
      `${missingOptional.length} optional package(s) missing`,
      `${missingOptional.map((p) => p.name).join(', ')} — features degrade, imports still resolve`,
      displayAddDev(pm, missingOptional.map((p) => p.name), repoRoot));
  }

  // A DIFFERENT claim, reported separately: nothing in the bundle imports these,
  // the specs /ux-lock GENERATES do. Absent is only a problem for a consumer
  // that runs those specs, so this informs rather than warns.
  const spec = declared.generatedSpecPackages?.packages ?? [];
  if (spec.length) {
    const specMissing = spec.filter((p) => !installed(p));
    report.pass(
      'Generated-spec packages',
      specMissing.length
        ? `${spec.length - specMissing.length}/${spec.length} present — ${specMissing.join(', ')} needed only to RUN the specs /ux-lock generates (${displayAddDev(pm, specMissing, repoRoot)})`
        : `${spec.length}/${spec.length} present`);
  }
}
