---
summary: LOCK mode — full Playwright spec template + fix-type assertion map + persistence recipe.
---

# LOCK Mode — Spec Generation

LOCK mode pins a fix's public DOM contract so the fix doesn't silently
regress. The generated spec asserts on semantic contracts (roles, aria-*,
data-testid, axe violations), never on CSS classes or internal state.

## Generated spec template

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

## Fix-type → assertion map

| Fix type | Assertions |
|---|---|
| **Missing attribute** (role, aria-*) | `toHaveAttribute('role', 'list')` |
| **Modal behaviour** | Element appears → action → element disappears |
| **Data rendering** | Container has expected child count or text |
| **Navigation** | Click → URL changes → content visible |
| **Form validation** | Invalid state → button disabled; valid → enabled |
| **Error handling** | Trigger error → error message visible → recovery works |
| **Accessibility** | `expectNoA11yViolations` on the relevant container |

## Naming convention

```
tests/e2e/<ticket-or-round>-<description>.spec.js
```

Examples: `r18-quality-gate.spec.js`, `fix-modal-close.spec.js`,
`pr42-wine-grid-a11y.spec.js`.

## Persistence — register the spec

After the spec runs and passes (Step 4), register it in the cross-skill
store:

```bash
node scripts/cross-skill.mjs record-regression-spec --json '{
  "specPath": "tests/e2e/<name>.spec.js",
  "description": "<one-line summary of the fix being locked>",
  "assertionCount": <N>,
  "domContractTypes": ["role", "axe", ...],
  "sourceKind": "audit-loop-fix" | "persona-test-p0" | "persona-test-p1" | "manual",
  "sourceFindingId": "<audit_findings.id OR persona finding hash if known, else null>",
  "sourceFindingType": "audit" | "persona" | null
}'
```

Response `{"ok": true, "cloud": ..., "specId": "<uuid>"}`. **Capture
specId** for the run record. If cloud mode is off (`cloud: false`), the
CLI still succeeds with `specId: null` — proceed without recording a run.

Then record the spec-run outcome:

```bash
node scripts/cross-skill.mjs record-regression-spec-run --json '{
  "specId": "<uuid from above>",
  "passed": true,
  "durationMs": <ms>,
  "runContext": "ux-lock-verify"
}'
```

If the spec fails unexpectedly on code that was supposed to satisfy the
contract (the fix didn't actually work), pass `"capturedRegression": true`
and the full `"errorMessage"`. That flags the row as a "save" and
surfaces in the `regression_saves` view.

## Choosing `source_kind`

| Trigger | source_kind |
|---|---|
| Commit from `/audit-loop` converged fix | `audit-loop-fix` |
| Commit or description tied to a `/persona-test` P0 | `persona-test-p0` |
| Same for P1 | `persona-test-p1` |
| Plain-text description / manual use | `manual` |
