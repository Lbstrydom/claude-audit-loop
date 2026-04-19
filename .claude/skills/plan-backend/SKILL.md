---
name: plan-backend
description: |
  Backend architecture planning with engineering principles. Use when the user asks to plan,
  design, or architect backend code — including new features, refactors, API endpoints, services,
  or database changes. Also auto-invoke when detecting backend planning context such as:
  "I want to add an endpoint", "let's design the service", "plan the implementation",
  "how should we structure this", or "I need to refactor the backend".
  Accepts arguments describing the task: /plan-backend add a wine recommendation engine
---

# Backend Architecture Planner

Structured backend planning — every design grounded in 20 engineering
principles across core design, robustness, performance, and sustainability.

---

## Phase 0 — Repo Stack Detection

```bash
node scripts/cross-skill.mjs detect-stack
```

Returns `{ stack, pythonFramework, detectedFrom }`.

| `stack` | Profile to apply |
|---|---|
| `js-ts` | Universal principles (Phase 2) |
| `python` | Universal principles + Python backend profile — see `references/python-backend-profile.md` |
| `mixed` | File-based routing: task cites `.py` files → Python; `.ts`/`.js` → JS/TS; spans both → apply BOTH scoped to their language |
| `unknown` | Universal principles only |

**Primary-language fallback** (when no files cited yet): count source files
of each language in the repo, apply the profile of the majority. Log
`Mixed repo, majority Python — applying Python profile.`

---

## Phase 1 — Understand Before You Design

**Explore the codebase FIRST.** The biggest planning failure is proposing
solutions without understanding what already exists.

### Pre-step — Persona test history

If `PERSONA_TEST_SUPABASE_URL` and `PERSONA_TEST_REPO_NAME` are set,
check whether persona testing has already surfaced pain points in the
area being planned:

```bash
curl -s "$PERSONA_TEST_SUPABASE_URL/rest/v1/persona_test_sessions?repo_name=eq.$PERSONA_TEST_REPO_NAME&order=created_at.desc&limit=5&select=persona,focus,verdict,findings,p0_count,p1_count" \
  -H "apikey: $PERSONA_TEST_SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $PERSONA_TEST_SUPABASE_ANON_KEY"
```

Filter sessions whose `focus` overlaps with the feature. If matches
found, include in the Context Summary as **Known user-visible issues**:

```
Known user-visible issues (from persona testing):
  • [P0] Form submit unresponsive — "Pieter" session, Apr 14 (focus: adding a bottle)
  • [P1] No loading state on search — 3 sessions, recurring
```

This prevents the plan from ignoring already-discovered UX failures.
Treat P0/P1 matches as HIGH priority in the design.

### Exploration checklist

1. **Map the landscape**: routes, services, models, utilities
2. **Identify existing patterns**: how does the codebase already solve similar problems?
3. **Find reusable components**: existing services, utilities, abstractions
4. **Check for prior art**: something similar partially built or attempted?
5. **Understand the data flow**: request lifecycle from route → service → DB and back

Do NOT propose a plan until exploration is complete.

---

## Phase 1.5 — Execution Model (Operations with Dependencies)

Forced question: **Are any of the planned operations dependent on others?**
If yes, identify chains, prerequisites, and per-chain atomicity.

This phase catches sequencing bugs that surface as HIGH findings in
audit round 3+.

### When this phase matters

- **Batch operations**: moves, imports, migrations — order matters, partial failure needs rollback
- **Multi-step workflows**: wizard flows, onboarding sequences — step N depends on step N-1
- **State transitions**: status changes, approval chains — invalid intermediate states must be prevented
- **Cross-entity operations**: swaps, cycles, rebalancing — A↔B swap is not two independent moves

### What to produce

1. **Dependency graph**: which operations must complete before others can start?
2. **Chain identification**: group dependent operations into atomic chains
3. **Failure semantics**: for each chain — rollback, retry, skip?
4. **Concurrency model**: can chains run in parallel, or must they be serial?

If all operations are independent — document that explicitly and move on.
If ANY dependency exists — the plan MUST define execution order,
atomicity boundary, and partial-failure recovery before proceeding.

---

## Phase 2 — Apply Engineering Principles

Every design decision evaluated against 20 principles:
- **Core Design** (1–10): DRY, SOLID, Modularity, No Hardcoding, Single Source of Truth
- **Robustness** (11–16): Testability, Validation, Idempotency, Transaction Safety, Error Handling, Graceful Degradation
- **Performance & Sustainability** (17–20): N+1 prevention, Backward Compat, Observability, Long-Term Flexibility

Cite principle numbers in the plan's "Proposed Architecture" section.

Full tables + anti-patterns: `references/engineering-principles.md`.

---

## Phase 3 — Long-Term Sustainability

Resist the urge to solve only the immediate problem. Every plan answers:

### System-level thinking

- **What assumptions does this design encode?** Which might change?
- **If requirements change in 6 months, what breaks?** Design seams now so changes are localised.
- **Does this tighten or loosen coupling?** Prefer loose coupling — components communicate through well-defined interfaces.
- **Patterns or exceptions?** If this is the first of its kind, design as a pattern others can follow. If it deviates, justify why.

### Architecture flexibility checklist

- [ ] **Data-driven over logic-driven**: can behaviour change by modifying data/config rather than rewriting code?
- [ ] **Strategy pattern over switch**: would a new variant require a new file (good) or modifying existing function (bad)?
- [ ] **Composable pipeline**: can processing steps be added, removed, reordered without rewriting?
- [ ] **Abstraction boundaries**: if we swap DB, AI provider, or external API, how many files change? Target: 1–2 adapter files.
- [ ] **Migration path**: if this outgrows its design, is there a clear upgrade path without rewrite?

---

## Phase 4 — Present the Plan

Structure output as:

### 1. Context Summary
- What exists today (Phase 1)
- What patterns the codebase already uses
- What we can reuse vs. what is new
- Known user-visible issues (if persona data available)

### 2. Proposed Architecture
- Component diagram (which files/modules, how they interact)
- Data flow (request → response path)
- Key design decisions and **which principles drove them** (cite #N)

### 3. Sustainability Notes
- Assumptions that could change
- How the design accommodates future change
- Extension points deliberately built in

### 4. File-Level Plan
For each file to be created or modified:
- **File path** + purpose
- **Key functions/exports** with brief descriptions
- **Dependencies** (imports + what imports it)
- **Why this file** (which principle justifies it)

### 5. Risk & Trade-off Register
- Trade-offs made + why
- What could go wrong
- What was deliberately deferred (and why that is OK)

### 6. Testing Strategy
- What gets unit tested
- What gets integration tested
- Key edge cases to cover

---

## Phase 5 — Persist the Plan

Save to `docs/plans/<descriptive-name>.md`. Create `docs/plans/` if
needed. Metadata header:

```markdown
# Plan: <Feature Name>
- **Date**: <today's date>
- **Status**: Draft | Approved | In Progress | Complete
- **Author**: Claude + <user>
```

Register in the cross-skill store so audit-loop can link:

```bash
node scripts/cross-skill.mjs upsert-plan --json '{
  "path": "docs/plans/<name>.md",
  "skill": "plan-backend",
  "status": "draft"
}'
```

Update status as implementation progresses.

---

## Reminders

- **Explore before proposing** — the codebase is ground truth, not assumptions
- **Name the principles** — every design choice cites which principle(s) it serves
- **Challenge yourself** — ask "what if this requirement changes?" for every major decision
- **Prefer boring solutions** — simple, proven patterns beat clever novel approaches
- **Show your reasoning** — the user wants to understand WHY, not just WHAT

---

## Reference files

This skill's canonical flow is above. The files below cover specialised
situations — read them only when the trigger applies.

| File | Summary | Read when |
|---|---|---|
| `references/engineering-principles.md` | 20 engineering principles — core design, robustness, performance, sustainability. | Phase 2 — writing Proposed Architecture section and need to cite specific principles, OR spotting an anti-pattern. |
| `references/python-backend-profile.md` | Python backend profile — framework-tagged principle checks + stack commands + anti-patterns. | Phase 0 detect-stack returned `python` or `mixed` with Python-facing files in the task. |
