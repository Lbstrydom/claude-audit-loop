---
name: ux-lock
description: |
  Generate Playwright e2e specs. Two modes:
    1. LOCK mode — pin a fix's DOM contract so it doesn't regress (default).
    2. VERIFY mode — check that a /plan-frontend plan was actually implemented
       by parsing its Acceptance Criteria (Section 9) and driving the live URL.
  Triggers on: "ux lock", "lock ux", "lock in the fix", "write regression spec",
  "generate e2e test for", "regression test for commit", "lock this fix",
  "verify the plan", "verify plan implementation", "check the plan was built",
  "audit frontend implementation", "did we ship the plan".
  Usage:
    /ux-lock <commit-or-description> [--url <base-url>]                     — lock mode
    /ux-lock verify <plan.md> [--url <base-url>]                            — verify mode
  Examples:
    /ux-lock "modal closes before retry"
    /ux-lock abc1234
    /ux-lock "role=list on wine grid" --url https://myapp.railway.app
    /ux-lock verify docs/plans/cellar-grid-redesign.md --url https://myapp.railway.app
disable-model-invocation: true
---

# UX Lock — Playwright Spec Generator & Plan Verifier

Two modes, one skill — both drive Playwright against semantic DOM contracts.

- **LOCK mode** (default): generate an e2e spec that pins a fix's DOM contract.
- **VERIFY mode** (`verify <plan.md>`): parse the plan's Acceptance Criteria
  (Section 9 of a `/plan-frontend` plan) and run one assertion per criterion
  against the live URL — producing a pass/fail grade for the plan.

---

## Phase 0 — Route the Command

Read the first word of `$ARGUMENTS`:

- If it is `verify` → go to **Mode: VERIFY** at the bottom of this file.
- Otherwise → proceed to **Mode: LOCK** below.

---

## Mode: LOCK

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

## Step 5 — Persist the Spec Record

Before reporting success, register the spec in the cross-skill store so `/ship`
can warn on missing regression specs and meta-assess can track what was locked.

Determine the `source_kind` from context:

| Trigger | source_kind |
|---|---|
| Commit from an `/audit-loop` converged fix | `audit-loop-fix` |
| Commit or description tied to a `/persona-test` P0 | `persona-test-p0` |
| Same for P1 | `persona-test-p1` |
| Plain-text description / manual use | `manual` |

Also tally which DOM contract types the spec actually asserts on — inspect the
generated code and collect any of: `role`, `aria-*`, `data-testid`, `navigation`,
`visibility`, `count`, `axe`, `text`, `attribute`.

Record the spec:

```bash
node scripts/cross-skill.mjs record-regression-spec --json '{
  "specPath": "tests/e2e/<name>.spec.js",
  "description": "<one-line summary of the fix being locked>",
  "assertionCount": <N>,
  "domContractTypes": ["role", "axe", ...],
  "sourceKind": "<audit-loop-fix | persona-test-p0 | persona-test-p1 | manual>",
  "sourceFindingId": "<audit_findings.id OR persona finding hash if known, else null>",
  "sourceFindingType": "<audit | persona | null>"
}'
```

The command prints `{"ok":true,"cloud":true,"specId":"<uuid>"}`. **Capture the
specId** — you need it in Step 6. If cloud mode is off (`cloud:false`), the
command still succeeds with `specId:null`; proceed to Step 6 without recording
a run (the local spec file is still created).

After running the spec in Step 4, record the outcome too:

```bash
node scripts/cross-skill.mjs record-regression-spec-run --json '{
  "specId": "<uuid from above>",
  "passed": true,
  "durationMs": <ms>,
  "runContext": "ux-lock-verify"
}'
```

If the spec fails unexpectedly on code that was supposed to satisfy the
contract (e.g. the fix didn't actually work), pass `"capturedRegression": true`
and the full `"errorMessage"`. That flags the row as a "save" and surfaces
in the `regression_saves` view.

## Step 6 — Report

```
═══════════════════════════════════════
  REGRESSION SPEC — Created
  File: tests/e2e/<name>.spec.js
  Assertions: <n>
  Passes: ✓ chromium-desktop, ✓ chromium-mobile
  Recorded: spec-id <uuid> (source: <sourceKind>)
═══════════════════════════════════════
```

If cloud mode is off, omit the `Recorded:` line.

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
- **/plan-frontend** → produces Section 9 Acceptance Criteria → **/ux-lock verify** grades the implementation

---

## Mode: VERIFY

Grade a `/plan-frontend` plan against its live implementation. Each
criterion in Section 9 becomes one Playwright `test()`; the pass/fail
rollup tells you whether the plan actually got shipped.

### Step V0 — Parse the Plan

1. Read the plan file at the path in `$ARGUMENTS` (first positional after `verify`).
2. Parse its Acceptance Criteria section using the shared parser:

   ```bash
   node -e "
     import('./scripts/lib/plan-criteria-parser.mjs').then(m => {
       const fs = require('node:fs');
       const md = fs.readFileSync('$PLAN_PATH', 'utf8');
       console.log(JSON.stringify(m.parseAcceptanceCriteria(md), null, 2));
     });
   "
   ```

   Or inline via a small Node snippet. The parser returns
   `{ criteria: [...], errors: [...], found: boolean }`.

3. If `found=false`, tell the user the plan has no Acceptance Criteria
   section and offer to run `/plan-frontend` in "add criteria to existing
   plan" mode, or have them add Section 9 manually using the format
   documented in `plan-frontend` SKILL.

4. If `errors.length > 0`, print the errors and stop — malformed criteria
   need fixing before verification can be meaningful.

5. Register the plan in the cross-skill store (no-op if cloud off):

   ```bash
   node scripts/cross-skill.mjs upsert-plan --json '{
     "path": "<plan-path>",
     "skill": "plan-frontend",
     "status": "in_progress"
   }'
   ```

   Capture `planId` from the response — you need it in Step V4.

### Step V1 — Detect Base URL

Resolve `--url` in this priority order:
1. `--url` flag on the command line
2. `E2E_BASE_URL` env var
3. `PERSONA_TEST_APP_URL` env var (shared with persona-test)
4. Ask the user

Record it as `baseUrl` — it goes into both `playwright.config` and the DB row.

### Step V2 — Generate One Spec, N Tests

Create ONE file: `tests/e2e/verify-<plan-slug>.spec.js` (slug = lowercased
plan filename without extension, hyphens only).

One `test()` per criterion. Use the criterion's `setup` and `assertion` text
to shape the test. Severity goes into a test tag for filtering.

Template:

```javascript
import { test, expect } from '@playwright/test';
import { loginAsTestUser } from './helpers/auth.js';
import { expectNoA11yViolations } from './helpers/axe.js';

/**
 * Plan verification — generated from <plan-path>
 * Plan ID: <planId>
 * Criteria: <N> total (<p0> P0, <p1> P1, <p2> P2, <p3> P3)
 * DO NOT HAND-EDIT — regenerated each time /ux-lock verify runs.
 */

test.describe('Plan verify: <plan-slug>', () => {
  <for each criterion c, emit>
  test(`[${c.severity}] [${c.category}] ${c.description}`, {
    tag: [`@${c.severity}`, `@${c.category}`, '@plan-verify']
  }, async ({ page }) => {
    // Setup: <c.setup ?? 'direct navigation'>
    await page.goto('/');
    <translate c.setup text into Playwright actions>

    // Assert: <c.assertion ?? c.description>
    <translate c.assertion text into expect(...) calls>
  });
  <endfor>
});
```

**Translation rules** (critical — the quality of verification depends on this):

| Assertion hint contains | Emit |
|---|---|
| `getByRole(...)` literal | Keep as-is in the spec |
| `axe-core` / `WCAG` / `violations == 0` | `await expectNoA11yViolations(page, { include: '<selector>' })` |
| `viewport` / `<N>px` / `mobile`/`desktop` | `await page.setViewportSize({ width: <N>, height: ... })` before other actions |
| `visible` / `shown` | `await expect(locator).toBeVisible()` |
| `hidden` / `not visible` | `await expect(locator).toBeHidden()` |
| `click` / `press` / `submit` | `await locator.click()` |
| `count == N` / `has N items` | `await expect(locator).toHaveCount(N)` |
| `role=` / `aria-*=` | `toHaveAttribute(<name>, <value>)` |
| `text matches` / `contains` | `toHaveText(/.../i)` or `toContainText(/.../i)` |

**Never** fall back to CSS class selectors. If a criterion can only be
expressed via a class selector, flag it as un-verifiable in Step V5 and
skip it rather than emitting a brittle assertion.

### Step V3 — Register the Spec

```bash
node scripts/cross-skill.mjs record-regression-spec --json '{
  "specPath": "tests/e2e/verify-<plan-slug>.spec.js",
  "description": "Plan verification for <plan-path>",
  "assertionCount": <total criteria>,
  "domContractTypes": [<unique set of categories across the plan>],
  "sourceKind": "plan-frontend-verify",
  "sourceFindingId": "<planId from Step V0>",
  "sourceFindingType": "plan"
}'
```

Capture `specId` from the response.

### Step V4 — Run the Spec

```bash
export E2E_BASE_URL="<baseUrl>"
START=$(date +%s%3N)
npx playwright test tests/e2e/verify-<plan-slug>.spec.js \
  --reporter=json \
  --output=.audit/plan-verify-results.json \
  > .audit/plan-verify-output.txt 2>&1
TOTAL_MS=$(( $(date +%s%3N) - START ))
```

Parse the JSON report. For each criterion, you get `status ∈ {passed, failed, skipped}`
plus `duration` and (on fail) `errors[].message`.

### Step V5 — Record the Run + Per-Criterion Outcomes

Record the overall run:

```bash
node scripts/cross-skill.mjs record-plan-verify-run --json '{
  "planId": "<planId>",
  "specId": "<specId>",
  "url": "<baseUrl>",
  "totalCriteria": <N>,
  "passedCount": <n>,
  "failedCount": <n>,
  "skippedCount": <n>,
  "durationMs": <totalMs>,
  "runContext": "ux-lock-verify"
}'
```

Capture `runId`. Then record all per-item outcomes in one batched call:

```bash
node scripts/cross-skill.mjs record-plan-verify-items --json '{
  "runId": "<runId>",
  "planId": "<planId>",
  "items": [
    {
      "criterionHash": "<from parser>",
      "criterionIndex": <i>,
      "severity": "P0",
      "category": "visibility",
      "description": "<original text>",
      "setupText": "<original setup text or null>",
      "assertText": "<original assertion text or null>",
      "passed": true,
      "errorMessage": null,
      "durationMs": <ms>
    },
    ...
  ]
}'
```

### Step V6 — Report

```
═══════════════════════════════════════
  PLAN VERIFY — <plan-path>
  Spec: tests/e2e/verify-<plan-slug>.spec.js
  URL:  <baseUrl>
  Commit: <commit-sha>

  Criteria: <N> total
    P0: <passed>/<total> passing
    P1: <passed>/<total> passing
    P2: <passed>/<total> passing
    P3: <passed>/<total> passing

  Satisfaction: <pct>%   (<passed>/<total>)
  Status: <PLAN_SATISFIED | PLAN_PARTIAL | PLAN_NOT_SHIPPED>

  Failing P0 criteria (if any):
    ✗ [visibility] Cellar grid is visible after login
        Timeout 5000ms exceeded — getByRole('grid') never resolved
    ✗ [interaction] Wine card opens detail modal on click
        Expected dialog to be visible; found none

═══════════════════════════════════════
```

Status rubric:
- `PLAN_SATISFIED` — all P0 and P1 criteria pass
- `PLAN_PARTIAL` — ≥1 P0 passes, some P1/P2/P3 fail
- `PLAN_NOT_SHIPPED` — ≥1 P0 fails

Also remind the user that verify is repeatable — the criterion_hash is
stable, so re-running after fixes shows delta (`was failing → now passing`).

### Verify mode — failure policy

`/ux-lock verify` exits 0 even when criteria fail — it is a **report**, not
a blocker. To gate shipping on verification, `/ship` reads
`plan_satisfaction.failing_p0_criteria` via
`node scripts/cross-skill.mjs plan-satisfaction --plan-id <id>` and can
be configured to treat a non-empty list as a block reason.
