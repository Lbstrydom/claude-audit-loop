---
name: audit-loop
description: |
  Self-driving plan-audit-fix loop using Claude for planning and GPT-5.4 for independent auditing.
  Claude and GPT-5.4 operate as PEERS — Claude can accept, partially accept, or challenge any finding.
  Challenged findings go through a deliberation round where GPT-5.4 can sustain, overrule, or compromise.
  Automates the full cycle: plan creation → GPT-5.4 audit → Claude deliberation → fix → re-audit → repeat.
  Triggers on: "audit loop", "plan and audit", "run the audit loop", "auto-audit",
  "plan-audit-fix loop", "iterate on the plan", "GPT audit".
  Usage: /audit-loop <task-description>           — Full cycle: plan + audit loop
  Usage: /audit-loop plan <plan-file>             — Audit an existing plan iteratively
  Usage: /audit-loop code <plan-file>             — Audit code against plan iteratively
  Usage: /audit-loop full <task-description>      — Plan + implement + audit code
---

# Self-Driving Audit Loop

Orchestrate an automated plan-audit-fix quality loop. Show clear progress, not raw JSON.

**Input**: `$ARGUMENTS` — task description or `plan|code|full <path>`.

---

## Step 0 — Parse Mode and Validate

| Input | Mode |
|-------|------|
| `plan docs/plans/X.md` | PLAN_AUDIT — audit plan iteratively |
| `code docs/plans/X.md` | CODE_AUDIT — audit code against plan |
| `full <description>` | FULL_CYCLE — plan → audit → implement → audit code |
| `<description>` | PLAN_CYCLE — plan → audit → fix → repeat |

Validate: plan file exists (if applicable), `OPENAI_API_KEY` is set.

Show kickoff card:
```
═══════════════════════════════════════
  AUDIT LOOP — [MODE] — Starting
  Plan: <path> | Max 6 rounds
═══════════════════════════════════════
```

---

## Step 1 — Plan Generation (PLAN_CYCLE / FULL_CYCLE only)

Generate plan with `/plan-backend` or `/plan-frontend`, save to `docs/plans/<name>.md`. Skip otherwise.

---

## Step 2 — Run GPT-5.4 Audit

Use `--out` to write JSON to file (keeps terminal clean). Use `--history` from round 2+ to prevent re-raising resolved findings.

```bash
# Round 1
node scripts/openai-audit.mjs code <plan-file> --out /tmp/audit-$$-result.json 2>/tmp/audit-$$-stderr.log

# Round 2+ (with history)
node scripts/openai-audit.mjs code <plan-file> --out /tmp/audit-$$-result.json --history /tmp/audit-$$-history.json 2>/tmp/audit-$$-stderr.log
```

Read stderr log for pass progress, then **read result from the JSON file** (not stdout):

```bash
cat /tmp/audit-$$-result.json
```

Parse JSON directly — no format conversion needed.

### History File

Maintain `/tmp/audit-$$-history.json` — a JSON array of round summaries. After each round:

```json
[{
  "round": 1,
  "findings": [{"id": "H1", "severity": "HIGH", "detail": "Missing auth..."}],
  "fixed_ids": ["H1", "M2"],
  "dismissed_ids": ["M4"],
  "resolutions": [{"finding_id": "M3", "gpt_ruling": "compromise", "final_severity": "LOW"}]
}]
```

Append to history after deliberation + fixes, pass `--history` on next audit call.

### Handle Failed Passes

If `_failed_passes` is non-empty, show and offer: re-run with lower reasoning, continue with partial results, or split further.

### Show Results

```
═══════════════════════════════════════
  ROUND 1 AUDIT — SIGNIFICANT_ISSUES
  H:6 M:10 L:5 | Cost: ~$0.45
  Top: [H1] Missing auth on /api/...
═══════════════════════════════════════
```

---

## Step 3 — Deliberation

**You are a peer, not a subordinate.** For each finding:
- **ACCEPT** — valid, will fix
- **PARTIAL** — real but severity wrong or better fix exists
- **CHALLENGE** — wrong (cite evidence: file paths, conventions)

### Convergence Check

Quality threshold: `HIGH == 0 && MEDIUM <= 2 && quickFix == 0`
Stability: quality met for **2 consecutive rounds** with zero new findings.

New finding detection: compare `category + section + detail` against prior round (>70% word overlap = same finding).

Max 6 rounds. If reached without stability, present remaining to user.

### Send Rebuttal (if challenges exist)

Write rebuttal to temp file, then:
```bash
node scripts/openai-audit.mjs rebuttal <plan-file> <rebuttal-file> --out /tmp/resolution-$$-result.json 2>/tmp/rebuttal-$$-stderr.log
```

Read result from `/tmp/resolution-$$-result.json`.

Show unified status:
```
═══════════════════════════════════════
  ROUND 1 DELIBERATION
  Accepted: 12 | Partial: 4 | Challenged: 5
  Sustained: 2 | Overruled: 2 | Compromise: 1
═══════════════════════════════════════
```

---

## Parallel Execution

**Safe to parallelise:**
- Fix accepted findings WHILE waiting for rebuttal response
- Fix mechanical issues (await, fetch, CSP) alongside recommendation fixes
- Run tests alongside writing summary notes

**Must be sequential:**
- Sustained/compromise fixes depend on rebuttal response
- Verification audit must run AFTER all fixes complete

---

## Step 4 — Fix Findings

ALL HIGH must be fixed. MEDIUM until ≤2 remain. LOW if mechanical.

Show what changed:
```
═══════════════════════════════════════
  FIXING — 17 findings
  Auto-fixed: 3 (mechanical)
  Fixed per recommendation: 8
  Compromises: 2
  Skipped (LOW): 4
═══════════════════════════════════════
```

List each fix: `[ID] description → file:lines`

Batch genuine design decisions into one user prompt.

---

## Step 5 — Verify and Loop

After fixes, re-audit (back to Step 2). Track finding churn:
- Resolved (fixed successfully)
- Recurring (persisted)
- New (introduced by fixes — resets stability counter)

```
═══════════════════════════════════════
  ROUND 2 → ROUND 3
  H:0 M:2 L:1 | New: 0 | Stable: 1/2
═══════════════════════════════════════
```

| Condition | Action |
|-----------|--------|
| Threshold NOT met | Fix → re-audit |
| Threshold met, new findings | Fix new → re-audit (stability resets) |
| Threshold met, 0 new, 1/2 stable | Re-audit once more |
| Threshold met, 0 new, 2/2 stable | **CONVERGED** → Step 6 |
| Round 6, not stable | Present to user |

---

## Step 6 — Final Report

```
═══════════════════════════════════════
  CONVERGED — Round 4
  Final: H:0 M:2 L:1
  Rounds: 4 | Time: 14m | Cost: ~$1.20
  Files changed: 6
  Remaining (accepted): [M3], [M7]
═══════════════════════════════════════
```

Save full report to `docs/plans/<name>-audit-summary.md`.

---

## Step 6.5 — Opus Deep Review (Final Gate)

After GPT-5.4 convergence, run a single holistic review using the highest-capability model.

**Opus checks what passes miss:**
- Architectural coherence across files
- Over-engineering from audit pressure
- Cross-file naming/pattern consistency
- Missing integration tests
- User-facing impact

Deliberate on Opus findings locally (ACCEPT/PARTIAL/CHALLENGE). Fix accepted items, verify once. Max 3 Opus rounds.

---

## Step 7 — Code Audit Transition (FULL_CYCLE only)

After plan converges: implement, then run Steps 2-6 with CODE_AUDIT mode.

---

## UX Rules

1. Status card after every phase (compact format above)
2. Never dump raw JSON — parse and summarize
3. Show every fix with file + line reference
4. Cost tracking: `cost ≈ (input × 2.5 + output × 10) / 1M`
5. Batch all user decisions into one prompt
6. Progress: show pass timings from stderr

## Key Principles

1. **Peer relationship** — neither model blindly defers
2. **Three-model system** — work + iterate + final gate
3. **Fix all HIGH**, MEDIUM until ≤2, LOW optional
4. **Stability over speed** — 2 clean rounds required
5. **No quick fixes** — band-aids rejected by all models
6. **Deliberation is final** — no infinite debate
7. **Graceful degradation** — failed passes offer recovery

---

## Compatibility

| Environment | Skill Location | Notes |
|-------------|---------------|-------|
| Claude Code | `.claude/skills/audit-loop/` | Native bash |
| VS Code Copilot | `.github/skills/audit-loop/` | Terminal tool |
| Cursor / Windsurf | `.github/skills/audit-loop/` | Terminal tool |
| Any AI + terminal | Direct script | `node scripts/openai-audit.mjs` |

The script auto-detects project context from `CLAUDE.md`, `Agents.md`, or `.github/copilot-instructions.md`.
