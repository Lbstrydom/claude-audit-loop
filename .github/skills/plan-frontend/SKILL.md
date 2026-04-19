---
name: plan-frontend
description: |
  Frontend UX and implementation planning with design and engineering principles. Use when the
  user asks to plan, design, or build frontend features — including UI components, pages, layouts,
  user flows, modals, forms, or visual changes. Also auto-invoke when detecting frontend planning
  context such as: "design the UI for", "plan the user flow", "add a new view", "build a component",
  "improve the UX of", "create a form for", or "redesign the layout".
  Accepts arguments describing the task: /plan-frontend redesign the cellar grid view
---

# Frontend UX & Implementation Planner

Structured frontend planning — every UI decision grounded in UX principles
AND technically sound. Do not skip phases — good UI requires both.

---

## Phase 0 — Repo Stack Detection

Invoke the shared CLI:

```bash
node scripts/cross-skill.mjs detect-stack
```

Response JSON includes `stack`, `pythonFramework`, `detectedFrom`.

| `stack` | Profile to apply |
|---|---|
| `js-ts` | Universal UX principles + JS/TS technical principles |
| `python` | Universal UX principles + Python frontend profile — see `references/python-frontend-profile.md` |
| `mixed` | File-based routing: if the task cites `.py` / `.html`/Jinja files → Python; if `.ts`/`.js`/`.tsx`/`.jsx`/`.vue`/`.svelte` → JS/TS; spans both → apply BOTH scoped to their language |
| `unknown` | Universal principles only, skip stack-specific sections |

---

## Phase 1 — Explore the Existing UI

**Understand what exists BEFORE designing anything new.** Study the current
frontend to ensure consistency and reuse.

1. **Audit the current UI**: Read relevant HTML, CSS, and JS files
2. **Map the component landscape**: existing patterns (modals, cards, grids, forms, toasts)
3. **Identify the design language**: colour palette, typography, spacing, button styles
4. **Trace user flows**: how the user currently navigates to and through related features
5. **Find reusable elements**: existing CSS classes, JS utilities, shared components
6. **Check responsive behaviour**: how the UI handles different screen sizes
7. **Note pain points**: what feels clunky, inconsistent, or confusing

Do NOT propose designs until this exploration is complete.

---

## Phase 2 — Apply UX & Design Principles

Every design decision is evaluated against 26 principles across four
groups: Gestalt, Interaction/Usability, Cognitive Load, Accessibility.
Plus Nielsen's 10 heuristics as a final cross-check pass.

Cite principle numbers in the plan's "UX Design Decisions" section when
justifying each choice.

Full tables: `references/ux-principles.md`.

---

## Phase 3 — Technical Implementation Principles

UX only works if the implementation is solid. 17 principles across
Component Architecture (27–31), State Management (32–35), Event Handling
(36–39), CSS & Styling (40–43).

Cite numbers in the plan's "Technical Architecture" section.

Full tables + anti-patterns: `references/technical-principles.md`.

---

## Phase 4 — Long-Term Sustainability

### UI-specific sustainability questions

- **What if the design system changes?** Are CSS variables + reusable
  classes ready for theming, or are colours/sizes hardcoded?
- **What if we add more items/views?** Does the layout scale from 5 to 500?
  From 3 tabs to 12?
- **What if we need proper mobile support?** Is the component architecture
  responsive-ready or would it require a rewrite?
- **What if accessibility requirements tighten?** Are ARIA attributes,
  keyboard flows, and focus management already in place?
- **Are we creating a reusable pattern?** If this is the first of its
  kind, design it as a template other features can follow.

Anti-patterns to flag: CSS soup, DOM spaghetti, event listener leaks,
god components, invisible state, stacked modals. Full list:
`references/technical-principles.md`.

---

## Phase 5 — Present the Plan

Structure output as:

### 1. Current UI Audit
- What exists today (from Phase 1)
- Existing patterns + design language
- Pain points + inconsistencies
- Components + CSS that can be reused

### 2. User Flow & Wireframe
- Step-by-step user journey
- ASCII wireframe or layout description for key screens/states
- Transitions between states

### 3. UX Design Decisions
- Key design choices and **which UX principles drove them** (cite #N)
- How Gestalt principles shaped the layout
- How cognitive load was managed
- Accessibility approach

### 4. Technical Architecture
- Component diagram (which JS modules, how they interact)
- State management approach
- Event handling strategy
- CSS architecture (new classes, variables, responsive approach)

### 5. State Map
For every component, document: Empty / Loading / Error / Success / Edge cases.

### 6. File-Level Plan
For each file to be created or modified:
- **File path** + purpose
- **Key functions/exports** with brief descriptions
- **Dependencies** (imports + what imports it)
- **Why this file** (which principle justifies it)

### 7. Risk & Trade-off Register
- Trade-offs made + why
- What could go wrong (browser compat, performance, a11y)
- What was deliberately deferred

### 8. Testing Strategy
- Visual/manual testing checklist
- Accessibility testing (keyboard walkthrough, screen reader, contrast)
- Responsive breakpoints to verify
- Edge-case scenarios

### 9. Acceptance Criteria (Playwright-verifiable)

This section is **machine-parseable** and drives `/ux-lock verify` —
which runs a real browser against the live implementation and grades
each criterion. Stick to the format exactly.

**Format**:

```
- [SEVERITY] [CATEGORY] <one-line description>
  - Setup: <how to reach the state this asserts on>
  - Assert: <what to check, as a semantic DOM contract>
```

**Severity** (same scale as `/persona-test`):
- `P0` — must work for the feature to be considered shipped
- `P1` — should work; failure is a degraded experience but not a blocker
- `P2` — cosmetic or secondary
- `P3` — observation only; nice to pass

**Category** (closed set — one of):
- `visibility` — element on/off screen
- `interaction` — click/type/submit → expected result
- `a11y` — WCAG AA / axe-core / keyboard / ARIA
- `state` — empty/loading/error/success state renders correctly
- `responsive` — layout at a specific viewport
- `text` — literal or regex content check
- `navigation` — URL/route change on action
- `other` — escape hatch; avoid

**Assertion rules** (critical — verify mode cannot work if you break these):
- Assert on **semantic DOM contracts only**: `getByRole(...)`, `getByLabel(...)`,
  `getByTestId(...)`, `aria-*` attributes, ARIA roles, axe-core violations
- **Never** reference CSS class names, internal state, or implementation details
- **Never** describe "it should feel fast" — that's `/persona-test` territory
- If a criterion can only be expressed via a class selector, either
  (a) propose adding a `data-testid` during implementation, or (b) move it
  to Section 8 as a manual test

**Example**:

```markdown
- [P0] [visibility] Cellar grid is visible after login
  - Setup: login → navigate to /cellar
  - Assert: getByRole('grid', { name: /cellar/i }) is visible
- [P0] [interaction] Wine card opens detail modal on click
  - Setup: login → navigate to /cellar
  - Assert: click getByRole('article').first() → getByRole('dialog') is visible
- [P1] [a11y] Grid has no WCAG AA violations
  - Setup: login → navigate to /cellar
  - Assert: axe-core violations on [role="grid"] == 0
```

**Coverage guidance**:
- At least **one P0 per primary user flow** the plan introduces
- At least **one a11y criterion** per new component
- At least **one state criterion** for components with loading/error/empty states
- At least **one responsive criterion** if mobile is a supported target

If you can't write ≥5 criteria for a non-trivial plan, it may be
under-specified — revisit Phase 5 §2 (User Flow) and §5 (State Map).

---

## Phase 6 — Persist the Plan

Save to `docs/plans/<descriptive-name>.md`. Create `docs/plans/` if
needed. Metadata header:

```markdown
# Plan: <Feature Name>
- **Date**: <today's date>
- **Status**: Draft | Approved | In Progress | Complete
- **Author**: Claude + <user>
```

Register in the cross-skill store so audit-loop + ux-lock can link:

```bash
node scripts/cross-skill.mjs upsert-plan --json '{
  "path": "docs/plans/<name>.md",
  "skill": "plan-frontend",
  "status": "draft"
}'
```

---

## Reminders

- **Explore before designing** — the existing UI is the ground truth
- **Name the principles** — every choice cites which principle(s) it serves
- **Think like the user** — not like the developer
- **Show every state** — Empty, Loading, Error, Success; if you can't describe all four, the design is incomplete
- **Wireframe before code** — ASCII layouts prevent expensive rework
- **Consistency beats novelty** — match existing patterns unless there's a strong reason not to
- **Accessibility is not optional** — it's a baseline
- **Section 9 is the ship gate** — `/ux-lock verify <plan.md>` grades the live implementation against these criteria. Brittle or aesthetic criteria make the grade meaningless — stick to semantic DOM contracts

---

## Reference files

This skill's canonical flow is above. The files below cover specialised
situations — read them only when the trigger applies.

| File | Summary | Read when |
|---|---|---|
| `references/ux-principles.md` | 26 UX + design principles — Gestalt, interaction, cognitive load, accessibility, state/resilience. | Phase 2 — evaluating a design decision and need to cite specific principles (especially first pass on a new component). |
| `references/technical-principles.md` | 17 technical implementation principles — component architecture, state, events, CSS/styling. | Phase 3 — writing the technical architecture section, OR flagging an anti-pattern. |
| `references/python-frontend-profile.md` | Python frontend profile — Jinja/Django/Flask template patterns + HTMX + anti-patterns. | Phase 0 detect-stack returned `python` or `mixed` with Python-facing files in the task. |
