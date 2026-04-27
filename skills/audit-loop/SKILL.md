---
name: audit-loop
description: |
  Orchestrator for /audit-plan + /audit-code. Dispatches by mode keyword
  or shorthand. Use when you want the full plan-then-code cycle, or aren't
  sure which audit mode applies. For atomic invocations and lower token
  cost, prefer /audit-plan or /audit-code directly.
  Triggers on: "audit loop", "plan and audit", "run the audit loop",
  "auto-audit", "plan-audit-fix loop", "iterate on the plan", "GPT audit",
  "full cycle".
  Usage: /audit-loop plan <plan-file>             — Delegate to /audit-plan
  Usage: /audit-loop code <plan-file>             — Delegate to /audit-code
  Usage: /audit-loop <plan-file>                  — Shorthand → /audit-code
  Usage: /audit-loop full <task-description>      — /audit-plan then /audit-code
  Usage: /audit-loop <task-description>           — PLAN_CYCLE → /audit-plan
---

# Audit Loop Orchestrator

Thin dispatcher for the audit-plan and audit-code skills. Routes by input
shape, then delegates to the appropriate sub-skill.

**Input**: `$ARGUMENTS` — mode keyword + path, path alone, or task description.

---

## Step 0 — Parse and Dispatch

| Input | Dispatch to |
|---|---|
| `plan <plan-file>` | `/audit-plan <plan-file>` |
| `code <plan-file>` | `/audit-code <plan-file>` |
| `<plan-file>` (path resolves to existing file) | `/audit-code <plan-file>` |
| `full <task description>` | chained: `/audit-plan <task>` → on success → `/audit-code <plan>` |
| `<task description>` (no path) | `/audit-plan <task>` (PLAN_CYCLE) |

Detection rules:
- A token is a plan-file path if it ends in `.md` AND `fs.existsSync(path)`.
- Otherwise treat it as a task description.

Show kickoff card:
```
═══════════════════════════════════════
  /audit-loop — Dispatching
  Mode: <PLAN_AUDIT | CODE_AUDIT | FULL_CYCLE | PLAN_CYCLE>
  Delegate: /audit-<plan|code>
═══════════════════════════════════════
```

---

## FULL_CYCLE flow

1. Invoke `/audit-plan <task>` — generate plan, audit iteratively, converge.
2. On success (Step 6 of audit-plan emits APPROVE), prompt the user to begin
   implementation against the converged plan.
3. Once code exists for the plan, invoke `/audit-code <plan-file>`.

If `/audit-plan` does not converge within max-3 rounds, halt and present
findings — the user decides whether to proceed with implementation despite
unresolved plan concerns.

---

## Why this is a thin orchestrator

The audit-plan and audit-code skills have distinct concerns:

- Plan audits have infinite refinement surface; max 3 rounds with
  rigor-pressure early stop.
- Code audits use multi-pass parallelism, R2+ ledger suppression, debt
  capture, and 6-round 2-stable convergence.

Splitting them gives Claude clearer routing, lower per-invocation token
cost (~30% reduction on direct sub-skill invocations), and prevents drift
between mode-specific instructions. This orchestrator preserves muscle
memory and consumer-repo hooks that reference `/audit-loop` directly.

---

## See also

- `/audit-plan` — plan-only audits (max 3 rounds, rigor-pressure stop)
- `/audit-code` — code-only audits (5 passes, R2+ suppression, debt capture)
