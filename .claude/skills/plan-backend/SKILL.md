---
name: plan-backend
description: |
  DEPRECATED — thin alias for `/plan --scope=backend`. The unified `/plan`
  skill auto-detects scope (backend / frontend / full-stack) and applies
  the right principle sets without you having to choose. Existing trigger
  words still route here for muscle memory; this just delegates.

  Use when the user asks to plan, design, or architect backend code —
  including new features, refactors, API endpoints, services, or
  database changes. Auto-invokes on: "I want to add an endpoint",
  "let's design the service", "plan the implementation", "how should we
  structure this", or "I need to refactor the backend".

  Accepts arguments describing the task: /plan-backend add a wine recommendation engine
---

# /plan-backend (deprecated alias)

This skill is a backward-compatibility shim. The unified `/plan` skill
replaces both `/plan-backend` and `/plan-frontend`, with scope detection
in Phase 0 + lazy reference loading so per-invocation token cost is the
same as before — and the output is one consolidated plan instead of
two that need merging.

**What to do:** invoke `/plan` (or pass the same arguments here — they
forward). The unified skill will detect scope as `backend` based on:
- Files cited in the task (routes, services, models, migrations, scripts)
- Phrasing ("endpoint", "API", "service", "database", "migration", "RPC")
- An explicit `--scope=backend` flag

If you genuinely want backend-only planning regardless of detection,
pass `--scope=backend` to `/plan` (or invoke this alias — it injects
the flag).

**Why deprecated:** for cross-stack work, /plan-backend + /plan-frontend
produced two separate plans that had to be merged manually, and the
child plans drifted from the merged file. The unified `/plan` produces
one document for one or both stacks, which is what `/audit-plan`,
`/audit-code`, `/ux-lock verify`, and `/ship` all consume anyway.

**Schedule:** kept as an alias indefinitely so muscle memory + existing
docs/links still work. Do NOT add new content to this file — edit
`skills/plan/SKILL.md` instead.

→ See [skills/plan/SKILL.md](../plan/SKILL.md) for the full flow.
