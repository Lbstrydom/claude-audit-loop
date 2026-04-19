/**
 * e2e auth helper — template from claude-engineering-skills.
 *
 * Two modes:
 *   1. Shell mode (default): no token — spec drives modules via page.evaluate
 *   2. Authenticated mode: set E2E_BEARER_TOKEN + E2E_CELLAR_ID env vars
 */

/**
 * Seed localStorage so the app boots. Token is optional.
 * Uses addInitScript so it persists across navigations.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{ token?: string, cellarId?: string }} [overrides]
 */
export async function loginAsTestUser(page, overrides = {}) {
  const token = overrides.token || process.env.E2E_BEARER_TOKEN || '';
  const cellarId = overrides.cellarId || process.env.E2E_CELLAR_ID || '';

  await page.addInitScript(
    ({ token, cellarId }) => {
      if (token) localStorage.setItem('access_token', token);
      if (cellarId) localStorage.setItem('active_cellar_id', cellarId);
    },
    { token, cellarId }
  );
  return { token, cellarId };
}
