---
name: ux-lock
description: |
  Generate Playwright e2e regression specs that lock in a fix's DOM contract.
  Use after shipping a bug fix or feature to ensure it doesn't regress.
  Triggers on: "ux lock", "lock ux", "lock in the fix", "write regression spec",
  "generate e2e test for", "regression test for commit", "lock this fix".
  Usage: /ux-lock <commit-or-description> [--url <base-url>]
  Examples:
    /ux-lock "modal closes before retry"
    /ux-lock abc1234
    /ux-lock "role=list on wine grid" --url https://myapp.railway.app
disable-model-invocation: true
---

# UX Lock — Playwright Spec Generator

Generate a Playwright e2e spec that locks in a bug fix or feature's public DOM contract.

**Input**: commit hash, PR description, or plain-text description of what was fixed.

---

## Step 0 — Understand the Fix

1. If a commit hash is provided, read the commit message and diff:
   ```bash
   git show <hash> --stat
   git show <hash>
   ```
2. Extract: what was broken, what was fixed, which files changed, which DOM elements are involved.
3. If a description is provided instead, ask clarifying questions only if the DOM contract is ambiguous.

## Step 1 — Identify the DOM Contract

The regression spec must assert on **public DOM contracts**, not implementation details:

| Good assertions (stable) | Bad assertions (brittle) |
|---|---|
| Element with `role="list"` exists | Element has class `wine-list-v3` |
| Modal closes when action button clicked | Internal state variable changes |
| Button is `aria-disabled` when form invalid | CSS opacity is 0.5 |
| Navigation to `/cellar` shows grid | `document.querySelector('.grid-abc')` |

**Rules**:
- Assert on semantic HTML (`role`, `aria-*`, `data-testid`) not CSS classes
- Assert on user-visible behavior (click → result) not internal state
- Assert on accessibility (axe-core) when the fix touched a11y

## Step 2 — Check Existing Harness

Before generating, check what already exists:

```bash
ls tests/e2e/helpers/        # auth, axe helpers
cat playwright.config.*       # base URL, projects, timeouts
ls tests/e2e/*.spec.*         # existing specs for naming convention
```

If no Playwright setup exists, offer to bootstrap from the template:
```bash
# Template from the engineering-skills repo
cp scripts/templates/playwright-config.js playwright.config.js
mkdir -p tests/e2e/helpers
cp scripts/templates/e2e-helpers/* tests/e2e/helpers/
npm install -D @playwright/test axe-core
npx playwright install chromium
```

## Step 3 — Generate the Spec

### Naming Convention
```
tests/e2e/<ticket-or-round>-<description>.spec.js
```
Examples: `r18-quality-gate.spec.js`, `fix-modal-close.spec.js`, `pr42-wine-grid-a11y.spec.js`

### Template Structure

```javascript
import { test, expect } from '@playwright/test';
import { loginAsTestUser } from './helpers/auth.js';
import { expectNoA11yViolations } from './helpers/axe.js';

/**
 * Regression lock for: <one-line description of fix>
 * Commit: <hash> — <commit message first line>
 * Covers:
 *   - <assertion 1>
 *   - <assertion 2>
 *   - <a11y assertion if applicable>
 */

test.describe('<fix description>', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsTestUser(page);
  });

  test('<primary assertion>', async ({ page }) => {
    await page.goto('/');

    // Drive the component/feature directly
    // ...

    // Assert on public DOM contract
    await expect(page.locator('...')).toBeVisible();
    // or: await expect(page.locator('...')).toHaveAttribute('role', 'list');
    // or: await expect(page.locator('...')).toHaveCount(n);
  });

  test('a11y — no WCAG violations', async ({ page }) => {
    await page.goto('/');
    // Set up the state that triggers the fix
    // ...
    await expectNoA11yViolations(page, { include: '#relevant-container' });
  });
});
```

### What to Assert

For each fix, generate assertions based on the fix type:

| Fix Type | Assertions |
|---|---|
| **Missing attribute** (role, aria-*) | `toHaveAttribute('role', 'list')` |
| **Modal behavior** | Element appears → action → element disappears |
| **Data rendering** | Container has expected child count or text |
| **Navigation** | Click → URL changes → content visible |
| **Form validation** | Invalid state → button disabled; valid → enabled |
| **Error handling** | Trigger error → error message visible → recovery works |

## Step 4 — Verify the Spec Runs

```bash
npx playwright test tests/e2e/<new-spec>.spec.js --project chromium-desktop
```

If the spec fails, debug and fix. Common issues:
- Base URL needs `E2E_BASE_URL` env var
- Auth needs `E2E_BEARER_TOKEN` for authenticated endpoints
- Timing: add `await page.waitForSelector(...)` before assertions

## Step 5 — Report

```
═══════════════════════════════════════
  REGRESSION SPEC — Created
  File: tests/e2e/<name>.spec.js
  Assertions: <n>
  Passes: ✓ chromium-desktop, ✓ chromium-mobile
═══════════════════════════════════════
```

---

## When to Use This Skill

- **After /audit-loop convergence**: lock in the fixes before moving on
- **After a P0 fix from /persona-test**: the fix should never regress
- **After any production bug fix**: before closing the issue
- **Before a major refactor**: baseline the current behavior

## Scope & Limitations

**Works for**: Web apps served via URL (Express, Railway, Vercel, Netlify, etc.)
Playwright navigates to `baseURL`, drives the DOM, asserts on elements.

**Limited for**: Obsidian plugins (Electron apps). Playwright can't attach to
Obsidian's Electron process. For Obsidian plugins:
- Unit test the plugin's logic with vitest (not e2e)
- Test extracted UI components in a mock HTML harness
- Use `/persona-test` with Playwright MCP against Obsidian's dev tools if available
- Full Electron e2e (`_electron.launch()`) is possible but heavy — use only for
  critical user flows

## Integration with Other Skills

- **/audit-loop** → converges → **/ux-lock** locks in fixes
- **/persona-test** → finds P0 → fix → **/ux-lock** prevents recurrence
- **/ship** → warns if recent fixes lack regression specs
