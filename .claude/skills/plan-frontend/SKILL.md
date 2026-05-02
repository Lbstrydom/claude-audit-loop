---
name: plan-frontend
description: |
  DEPRECATED — thin alias for `/plan --scope=frontend`. The unified `/plan`
  skill auto-detects scope (backend / frontend / full-stack) and applies
  the right principle sets without you having to choose. Existing trigger
  words still route here for muscle memory; this just delegates.

  Use when the user asks to plan, design, or build frontend features —
  including UI components, pages, layouts, user flows, modals, forms,
  or visual changes. Auto-invokes on: "design the UI for", "plan the
  user flow", "add a new view", "build a component", "improve the UX of",
  "create a form for", or "redesign the layout".

  Accepts arguments describing the task: /plan-frontend redesign the cellar grid view
---

# /plan-frontend (deprecated alias)

This skill is a backward-compatibility shim. The unified `/plan` skill
replaces both `/plan-frontend` and `/plan-backend`, with scope detection
in Phase 0 + lazy reference loading so per-invocation token cost is the
same as before — and the output is one consolidated plan instead of
two that need merging.

**What to do:** invoke `/plan` (or pass the same arguments here — they
forward). The unified skill will detect scope as `frontend` based on:
- Files cited in the task (components, pages, layouts, styles, forms)
- Phrasing ("UI", "UX", "modal", "form", "layout", "design", "view", "page")
- An explicit `--scope=frontend` flag

If you genuinely want frontend-only planning regardless of detection,
pass `--scope=frontend` to `/plan` (or invoke this alias — it injects
the flag).

**Why deprecated:** for cross-stack work, /plan-frontend + /plan-backend
produced two separate plans that had to be merged manually, and the
child plans drifted from the merged file. The unified `/plan` produces
one document for one or both stacks, which is what `/audit-plan`,
`/audit-code`, `/ux-lock verify`, and `/ship` all consume anyway.

**Schedule:** kept as an alias indefinitely so muscle memory + existing
docs/links still work. Do NOT add new content to this file — edit
`skills/plan/SKILL.md` instead.

**Section 9 acceptance criteria** (Playwright-verifiable, drives
`/ux-lock verify`) is now Section 10 in the unified `/plan` output —
same format, same machine-parseability. See `skills/plan/SKILL.md`
Phase 6 §10.

→ See [skills/plan/SKILL.md](../plan/SKILL.md) for the full flow.
