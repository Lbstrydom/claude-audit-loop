import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright e2e harness — template from claude-engineering-skills.
 *
 * Bootstrap:
 *   npm install -D @playwright/test axe-core
 *   npx playwright install chromium
 *   cp scripts/templates/playwright-config.js playwright.config.js
 *   cp -r scripts/templates/e2e-helpers tests/e2e/helpers
 *
 * Set E2E_BASE_URL to your deployed app. Defaults to localhost:3000.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    ignoreHTTPSErrors: false,
  },
  projects: [
    { name: 'chromium-desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    { name: 'chromium-mobile', use: { ...devices['Pixel 5'] } },
  ],
});
