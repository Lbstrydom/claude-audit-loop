---
name: audit-loop
description: |
  DEPRECATED — use `/cycle` for the full chained workflow, OR `/audit-plan`
  / `/audit-code` for atomic invocations. The orchestrator dispatcher modes
  this skill used to provide are now redundant: `/audit-loop plan <file>`
  is just `/audit-plan <file>` (one fewer word); `/audit-loop code <file>`
  is just `/audit-code <file>`; `/audit-loop full <task>` is now `/cycle <task>`.
  This skill remains as a discoverable shim for muscle memory.
  Triggers on: "audit loop", "plan and audit", "run the audit loop".
  Usage: /audit-loop full <task>     — DEPRECATED → use /cycle <task>
  Usage: /audit-loop plan <file>     — DEPRECATED → use /audit-plan <file>
  Usage: /audit-loop code <file>     — DEPRECATED → use /audit-code <file>
---

# /audit-loop (deprecated alias)

This skill is a backward-compatibility shim. Its functionality has been
unbundled into atomic skills + one orchestrator:

- **`/audit-plan <plan-file>`** — iteratively audit a plan file (was `/audit-loop plan <file>`)
- **`/audit-code <plan-file>`** — multi-pass code audit against plan (was `/audit-loop code <file>` and `/audit-loop <file>`)
- **`/cycle <task or plan-file>`** — chained workflow: plan → audit-plan → impl → audit-code → persona-test → ux-lock → ship (was `/audit-loop full <task>`)

**Why deprecated:** the old dispatcher modes (`/audit-loop plan ...`,
`/audit-loop code ...`) were pure overhead — they loaded an
orchestrator SKILL.md just to delegate to the underlying skill. The
only mode that added real value (chained execution) is now its own
clear skill, `/cycle`.

**What to do instead:**

| Old call | New call |
|---|---|
| `/audit-loop plan docs/plans/x.md` | `/audit-plan docs/plans/x.md` |
| `/audit-loop code docs/plans/x.md` | `/audit-code docs/plans/x.md` |
| `/audit-loop docs/plans/x.md` | `/audit-code docs/plans/x.md` |
| `/audit-loop full add a wine recommendation engine` | `/cycle add a wine recommendation engine` |
| `/audit-loop add a wine recommendation engine` | `/cycle add a wine recommendation engine` |

**Note on the user-global `/audit` skill**: there is also a
`~/.claude/skills/audit/SKILL.md` that is a *different* tool — it's a
single-pass Claude-only audit (no GPT/Gemini, no API cost) used for
quick mid-coding checks. That skill is intentionally separate from this
project's heavy multi-model audit pipeline. Don't conflate them.

→ See [skills/cycle/SKILL.md](../cycle/SKILL.md), [skills/audit-plan/SKILL.md](../audit-plan/SKILL.md), [skills/audit-code/SKILL.md](../audit-code/SKILL.md) for the active flows.
