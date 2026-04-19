---
summary: Full persona debrief generation rules, tone guide, and output wrapper.
---

# Persona Debrief — Generation Rules

After the structured findings report (Phase 5), persona-test produces a
**Persona Debrief** — a first-person narrative written entirely in the
persona's voice. This is the product discovery artefact: not a bug list,
but an honest reaction from a real-feeling user.

## Purpose

| Artefact | Reader | Purpose |
|---|---|---|
| Structured report (Phase 5) | Developer | What to fix — specific, actionable items with severity |
| Persona debrief (this) | Product team | What to build next — texture, emotion, priority |

The two artefacts serve different readers. Don't collapse them into one.

## Tone rules

- **Write in first person** as the persona — their vocabulary, their frame
  of reference. Not a developer describing a user.
- **Be specific** about what the persona actually encountered — draw from
  the Reflect notes taken during the session.
- **No bullet-point lists** of features — this is a stream of thought,
  not a spec.
- **Include texture**: emotional reactions, hesitations, moments of
  delight, pet peeves.
- **Mention what they would and wouldn't use**, and why.
- **End with a clear priority ranking** — what they'd build first if it
  were their call.
- **Length**: 400–700 words. Long enough to be substantive, short enough
  to be readable.

## Structure

Write as flowing prose, not under headers. The narrative should cover
these beats in this order:

1. **Opening context** — what the persona was trying to do, their state
   of mind going in.
2. **Feature-by-feature honest take** — what worked, what confused them,
   what was missing.
3. **What would drive them crazy** — the specific things that would erode
   trust or cause them to leave.
4. **What would delight them** — specific, in-context moments of "yes,
   this gets me".
5. **What they wouldn't use** — and why, without judgement.
6. **Bottom line** — their top 3 priorities in plain language.

## Output wrapper

Emit the debrief inside this fence:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  PERSONA DEBRIEF — <persona>
  [Written in first person as the persona]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

<400–700 word first-person narrative here>

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## Grounding rule

The debrief **must be grounded** in what actually happened during the
session. Every point should trace back to something observed in a Reflect
step. Generic user opinions ("users want fast apps") are not grounded.
Specific session observations ("the form hung for 3 seconds after I hit
Add Bottle and I assumed it had frozen") are.

If the session was too short to support a 400-word debrief, say so
explicitly at the start:

```
[SHORT SESSION — debrief is necessarily brief]
```

Then write honestly about the limited surface area covered.
