---
name: audit-loop
description: >
  Multi-model audit loop: plans code using the current AI assistant, then sends to GPT-5.4
  for independent audit via scripts/openai-audit.mjs. GPT returns structured findings.
  The assistant deliberates (accept/challenge/compromise), fixes, then re-audits until
  0 HIGH findings, ≤2 MEDIUM, 0 quick-fix warnings. Max 4 rounds.
  Use for: "audit the plan", "audit the code", "run audit loop", "GPT audit",
  "check plan quality", "review implementation against plan".
---

# Self-Driving Audit Loop (Multi-Model: Assistant + GPT-5.4)

You are orchestrating an automated quality loop. You (the assistant) plan and fix.
GPT-5.4 audits independently via `scripts/openai-audit.mjs`. You operate as **peers** —
you can accept, partially accept, or challenge any GPT finding.

## Prerequisites

- `scripts/openai-audit.mjs` must exist in the project (run `node setup.mjs` to install)
- `OPENAI_API_KEY` must be set in `.env` or environment
- Dependencies: `openai`, `zod`, `dotenv` (install via `npm install openai zod dotenv`)

## Modes

| User Request | Mode | Action |
|---|---|---|
| "audit the plan at docs/plans/X.md" | PLAN_AUDIT | GPT audits plan quality iteratively |
| "audit code against docs/plans/X.md" | CODE_AUDIT | GPT audits implementation against plan |
| "plan and audit \<description\>" | PLAN_CYCLE | Create plan → GPT audit → fix → repeat |

## Step 1 — Run GPT-5.4 Audit

Execute in the terminal:

```bash
node scripts/openai-audit.mjs plan <plan-file> --json
```

Or for code audits:
```bash
node scripts/openai-audit.mjs code <plan-file> --json
```

The script runs **multi-pass parallel** code audits:
- Wave 1: Structure + Wiring (reasoning: low, ~25s each)
- Wave 2: Backend + Frontend quality (reasoning: high, ~90-170s each)
- Wave 3: Sustainability (reasoning: medium, ~90s)

All limits are **adaptive** — they scale to the codebase size automatically.

Parse the JSON output to get `findings`, `verdict`, `_failed_passes`.

### Handle Failed Passes

If `_failed_passes` is non-empty, tell the user what failed and offer:
- A) Re-run with lower reasoning effort
- B) Continue with partial results
- C) Split further and retry

## Step 2 — Deliberate on Findings (You Are a Peer)

For EACH finding from GPT-5.4, form your own position:

### ACCEPT
The finding is valid. Fix it.

### PARTIAL ACCEPT
The problem is real but: severity is wrong, or you have a better sustainable fix,
or the scope should be different. Provide your alternative with reasoning.

### CHALLENGE
The finding is wrong because of project conventions, upstream handling, or intentional
design decisions. Provide counter-evidence (cite files, CLAUDE.md, conventions).

### Send Rebuttals to GPT

If you challenged any findings, write a rebuttal document and run:

```bash
node scripts/openai-audit.mjs rebuttal <plan-file> <rebuttal-file> --json
```

GPT will respond with:
- **SUSTAIN** — GPT holds position, you must fix it
- **OVERRULE** — You were right, finding dismissed
- **COMPROMISE** — Modified recommendation

**Deliberation is final** — no infinite back-and-forth.

## Step 3 — Fix Surviving Findings

Fix all findings that survived deliberation:
- Auto-fix mechanical issues (missing async/await, raw fetch, dead code)
- Apply accepted + sustained recommendations
- Apply compromises
- **Reject all quick fixes** — devise sustainable alternatives
- Batch design decisions for user

## Step 4 — Re-audit (Loop)

Re-run Step 1. Continue until:
- 0 HIGH findings
- ≤ 2 MEDIUM findings
- 0 quick-fix warnings
- Maximum 4 rounds

## Step 5 — Final Report

Save summary to `docs/plans/<name>-audit-summary.md` with round-by-round progress,
deliberation outcomes, and remaining items.

## Convergence Display

After each round show:

```
═══════════════════════════════════════════════════════
  AUDIT LOOP — Round 2 of 4 (max)
  HIGH:     5 → 1  (3 fixed, 1 overruled)
  MEDIUM:   8 → 3  (4 fixed, 1 compromised)
  Status: NOT CONVERGED — 1 HIGH remaining
═══════════════════════════════════════════════════════
```

## Key Principles

1. **Peer relationship** — neither model blindly defers to the other
2. **No quick fixes** — every fix must be sustainable
3. **Adaptive** — token limits and timeouts scale to codebase size
4. **Graceful degradation** — failed passes don't crash the audit
5. **Transparency** — every round's report is saved
