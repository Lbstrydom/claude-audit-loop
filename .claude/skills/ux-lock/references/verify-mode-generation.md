---
summary: VERIFY mode — criterion parser wiring, translation rules, per-criterion run+record protocol.
---

# VERIFY Mode — Plan Verification Protocol

VERIFY mode grades a `/plan-frontend` plan against its live implementation
by parsing its Section 9 (Acceptance Criteria), generating one Playwright
`test()` per criterion, running the spec, and recording per-criterion
outcomes keyed by stable `criterion_hash` for time-series tracking.

## Step V0 — Parse the plan

Read the plan file at the path in `$ARGUMENTS` (first positional after
`verify`). Parse Section 9 via the shared parser:

```bash
node -e "
import('./scripts/lib/plan-criteria-parser.mjs').then(m => {
  const fs = require('node:fs');
  const md = fs.readFileSync('<plan-path>', 'utf8');
  console.log(JSON.stringify(m.parseAcceptanceCriteria(md), null, 2));
});
"
```

Returns `{ criteria: [...], errors: [...], found: boolean }`.

- `found = false` → tell the user the plan has no Acceptance Criteria
  section; offer to run `/plan-frontend` to add one, or have them add
  Section 9 manually.
- `errors.length > 0` → print and stop — malformed criteria need fixing
  first.

Register the plan:

```bash
node scripts/cross-skill.mjs upsert-plan --json '{
  "path": "<plan-path>",
  "skill": "plan-frontend",
  "status": "in_progress"
}'
```

Capture `planId`.

## Step V1 — Base URL resolution

Priority: `--url` flag → `E2E_BASE_URL` → `PERSONA_TEST_APP_URL` → ask.

## Step V2 — Generate one spec, N tests

Create `tests/e2e/verify-<plan-slug>.spec.js` (slug = lowercased plan
filename without extension, hyphens only).

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

## Translation rules (critical)

The quality of verification depends on honest translation. Never fall
back to CSS class selectors.

| Assertion hint contains | Emit |
|---|---|
| `getByRole(...)` literal | Keep as-is in the spec |
| `axe-core` / `WCAG` / `violations == 0` | `await expectNoA11yViolations(page, { include: '<selector>' })` |
| `viewport` / `<N>px` / `mobile` / `desktop` | `await page.setViewportSize({ width: <N>, height: ... })` before other actions |
| `visible` / `shown` | `await expect(locator).toBeVisible()` |
| `hidden` / `not visible` | `await expect(locator).toBeHidden()` |
| `click` / `press` / `submit` | `await locator.click()` |
| `count == N` / `has N items` | `await expect(locator).toHaveCount(N)` |
| `role=` / `aria-*=` | `toHaveAttribute(<name>, <value>)` |
| `text matches` / `contains` | `toHaveText(/.../i)` or `toContainText(/.../i)` |

If a criterion can only be expressed via a class selector, flag it as
un-verifiable in Step V5 and skip it rather than emitting a brittle
assertion.

## Step V3 — Register the generated spec

```bash
node scripts/cross-skill.mjs record-regression-spec --json '{
  "specPath": "tests/e2e/verify-<plan-slug>.spec.js",
  "description": "Plan verification for <plan-path>",
  "assertionCount": <total criteria>,
  "domContractTypes": [<unique set of categories across the plan>],
  "sourceKind": "plan-frontend-verify",
  "sourceFindingId": "<planId from V0>",
  "sourceFindingType": "plan"
}'
```

Capture `specId`.

## Step V4 — Run the spec

```bash
export E2E_BASE_URL="<baseUrl>"
START=$(date +%s%3N)
npx playwright test tests/e2e/verify-<plan-slug>.spec.js \
  --reporter=json \
  --output=.audit/plan-verify-results.json \
  > .audit/plan-verify-output.txt 2>&1
TOTAL_MS=$(( $(date +%s%3N) - START ))
```

Parse the JSON report. For each criterion, extract
`status ∈ {passed, failed, skipped}` plus `duration` and (on fail)
`errors[].message`.

## Step V5 — Record run + per-criterion outcomes

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

Capture `runId`. Then batch all per-item outcomes:

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
      "setupText": "<original setup or null>",
      "assertText": "<original assertion or null>",
      "passed": true,
      "errorMessage": null,
      "durationMs": <ms>
    },
    ...
  ]
}'
```

## Step V6 — Report

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

## Failure policy

`/ux-lock verify` exits 0 even when criteria fail — it is a **report**,
not a blocker. To gate shipping on verification, `/ship` reads
`plan_satisfaction.failing_p0_criteria` via
`cross-skill.mjs plan-satisfaction --plan-id <id>` and can be configured
to treat a non-empty list as a block reason.
