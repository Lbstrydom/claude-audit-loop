---
summary: Step 7 Gemini independent review protocol — transcript, verdict handling, re-review loop.
---

# Gemini Independent Review — Step 7 Protocol

After the final GPT-5.4 audit round (whether converged or not), run
Gemini 3.1 Pro as an independent third reviewer. This step is MANDATORY —
Gemini provides cross-model perspective that catches blind spots in the
Claude-GPT deliberation.

If `GEMINI_API_KEY` is not set, run Claude Opus fallback (`ANTHROPIC_API_KEY`).
Only skip Step 7 entirely when neither key is available. When skipped,
output `FINAL_GATE_SKIPPED` and do not claim full final-gate validation.

## Build the transcript

Assemble `/tmp/$SID-transcript.json` with the full audit trail:

- Plan content, code files list
- All rounds: GPT findings, Claude positions, GPT rulings, fixes applied
- Final state: remaining findings, dismissed findings
- Suppression data: kept / suppressed / reopened counts per round

## Run the review

```bash
node scripts/gemini-review.mjs review <plan-file> /tmp/$SID-transcript.json \
  --out /tmp/$SID-gemini-result.json 2>/tmp/$SID-gemini-stderr.log
```

Provider auto-selection order:
1. Gemini (when `GEMINI_API_KEY` is set)
2. Claude Opus fallback (when `ANTHROPIC_API_KEY` is set)

## Process the verdict

| Verdict | Action |
|---|---|
| `APPROVE` | Done → final report |
| `CONCERNS` | Step 7.1: Deliberate → fix → Gemini re-verify |
| `REJECT` | Present to user — needs human judgement |

Max 2 final-review rounds.

## Step 7.1 — Deliberate on Gemini Findings (CONCERNS only)

When Gemini returns `CONCERNS`, Claude deliberates on each `new_findings`
and `wrongly_dismissed` item — same peer relationship as GPT deliberation:

1. **For each Gemini finding**, decide: ACCEPT, PARTIAL, or CHALLENGE
   - CHALLENGE must cite evidence (file paths, code, conventions)
   - Gemini catches things GPT missed — give extra weight to Gemini findings
2. **Fix accepted findings** — track which files changed
3. **Update transcript** with Gemini findings, Claude positions, fixes applied
4. **Re-run Gemini review** with updated transcript:

```bash
node scripts/gemini-review.mjs review <plan-file> /tmp/$SID-transcript-v2.json \
  --out /tmp/$SID-gemini-result-v2.json 2>/tmp/$SID-gemini-stderr-v2.log
```

**CRITICAL**: Do NOT use GPT to verify Gemini's findings — GPT already
missed them. Gemini must verify its own concerns were addressed. This
closes the loop properly.

If Gemini returns `APPROVE` on re-review → done.
If `CONCERNS` again after 2 rounds → present to user.

## When Gemini makes category errors

Gemini sometimes reviews the current code state rather than the
plan/deliberation trail (e.g. flags "missing crash-safe WAL" when the
plan explicitly schedules that for a future phase). That's a category
error — Claude should CHALLENGE with evidence ("this is scheduled for
Phase B.1, not yet shipped"). Document the challenges in the final
report so reviewers see the deliberation trail.
