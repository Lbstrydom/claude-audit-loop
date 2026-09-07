# Final-Review Shadow Bake-Off — marginal-value re-test verdict

- **Date of decision**: 2026-08-28
- **Recorded here**: 2026-08-28
- **Verdict**: **KEEP opus.** SELECT opus as the final-review shadow model.
  No challenger (kimi, grok, qwen, deepseek) cleared the pre-registered
  relative effectiveness floor. No production change.
- **Status**: settled — this file transcribes an existing decision, it does
  not make a new one.
- **Corrected 2026-09-07**: the decision stands, but the metric had no
  precision counterweight, one arm was mischaracterised and a control arm was
  omitted from the table. See the Correction section at the end.

> **This document is a transcription, not an adjudication.** The decision was
> computed on 2026-08-28 and recorded in
> [`docs/plans/final-review-shadow-bakeoff.md`](../plans/final-review-shadow-bakeoff.md)
> §0.7d "Close-out". That plan's `Status:` is `Complete`. Nothing here
> re-opens or re-litigates it; this file exists so the decision is
> discoverable at the path this repo's tooling looks for, rather than only
> inside a closed plan's close-out section.

## The decision, as taken

`final-review-scoped-2026q3` reached its pre-registered target (N=12
complete snapshots) and the campaign tooling's own gate evaluation reports
`DECISION_READY` — every gate passed. The computed verdict:

```
node scripts/campaign.mjs verdict --campaign final-review-scoped-2026q3
```

| Arm | Accepted (of 12 snapshots) | Rate/snapshot | Result |
|---|---|---|---|
| **opus** (incumbent) | 23 | **1.916667** | **CLEARS the floor** |
| qwen | 15 | 1.25 | blocked — 0.167/snapshot short of the floor |
| deepseek | 10 | 0.833333 | blocked |
| kimi | 8 | 0.666667 | blocked |
| grok | 1 | 0.083333 | blocked |

Floor: opus's own rate minus a pre-registered margin of 0.5/snapshot →
**1.416667/snapshot**. A challenger had to reach that bar to be considered
at all; none did. Cost (`$8`/accepted ceiling) was never reached as a
tiebreak for any challenger, since none passed the effectiveness gate first.
Opus's own cost: **$1.5721/accepted**.

**How close was the nearest challenger, in plain terms.** Think of each of
the 12 snapshots as one full audit pass. Opus flagged real, keepable issues
at just under 2 per pass (23 across 12). The bar a cheaper model had to clear
wasn't "match Opus exactly" — it was allowed to fall short by half an issue
per pass and still qualify, which works out to needing roughly 1.42 keepable
findings per pass. Qwen, the best of the four alternatives, averaged 1.25 —
it was finding real things, about two out of every three that Opus found —
but it landed just under that discounted bar, roughly one issue short every
six passes. Close, genuinely competitive, but not close enough. The other
three weren't in the same conversation: DeepSeek caught under half of what
Opus found, Kimi about a third, and Grok essentially missed almost
everything — one accepted finding across all 12 passes where Opus had 23,
the gap between a careful reviewer and one skimming the document.

## Sensitivity check

`matcher sensitivity: INVARIANT — identical decision at all 6 matcher
variant(s)`. The cross-arm clustering threshold that decides "is this the
same underlying defect across two arms' wording" is itself unvalidated (the
campaign's own module documents it as "PROVISIONAL — labels are
model-generated... Not a validated calibration") — the sweep is what makes
that acceptable here: the verdict is identical regardless of where that
threshold sits, so its lack of validation does not weaken this result.

## One honest caveat, disclosed rather than omitted

The adjudicator model is `latest-opus` — the same family as the incumbent
arm it is judging. Calibration self-family share: opus **77%**, every other
arm **0%**. Human-vs-agent override rates on the calibration sample ran
37–69% across arms (opus's own: 37%). A same-family adjudicator judging its
own arm's output is a real methodological risk this repo has hit before
(`self_family` bias, fixed elsewhere 2026-08-23) — but opus's margin here (23
accepted vs. qwen's next-best 15, a 53% lead) is large enough that a leniency
effect would have to be implausibly strong to change the outcome. Recorded
as a caveat on confidence, not treated as a reason to distrust the verdict.

## A note on what rule actually ran

The plan's original §6.3 (pre-registered 2026-07-29) specified an **absolute**
floor — `marginal ≥ 0.2 accepted HIGH/MED per run` — against a zero-shadow
baseline (the question: should a shadow exist at all). The live campaign's
decision rule, built under the role-agnostic comparison-campaign framework
that generalized this plan's bespoke machinery, is a **relative** floor
against a declared incumbent (opus's own rate minus a margin) — a different
question (which model, given a shadow already exists) than the one
originally pre-registered. Both share the same $8/accepted cost ceiling.
Disclosed here rather than silently presented as an unmodified execution of
§6.3 — see `docs/plans/final-review-shadow-bakeoff.md` §0.7c/§0.7d for the
full campaign-migration history.

## What does NOT change

Production final-review keeps opus as its shadow model exactly as configured
before this campaign ran. No config, code, or default changes as a result of
this verdict — it confirms the status quo rather than prescribing a change.

---

## Correction — added 2026-09-07: the metric had no precision counterweight

**The headline stands: KEEP opus.** What follows corrects the *runner-up
ordering*, one characterisation of an arm, and an omission from the table above.
Added after a separate investigation found the same defect class one layer up —
a scoring rule with no counterweight, applied to model-generated labels
([experiment-6](./experiment-6-adjudicator-swap-and-the-unreachable-rule.md),
where neither candidate beat a classifier that read nothing).

### What the original metric could not see

`accepted per snapshot` is a **count**. An arm that emits twice as many findings
at the same hit-rate scores twice as well. The table above never reports how many
findings each arm *emitted*, so the ranking cannot be read as quality.

Recomputed on the verdict's own cohort (`0d3d4031`, 12 snapshots, non-superseded
runs, latest adjudication event per finding):

| arm | emitted | accepted | dismissed | **precision** | emitted/snapshot |
|---|---|---|---|---|---|
| opus | 73 | 46 | 26 | 63.9% | 6.08 |
| qwen | 61 | 31 | 30 | 50.8% | 5.08 |
| deepseek | 29 | 16 | 13 | **55.2%** | 2.42 |
| kimi | 35 | 15 | 20 | 42.9% | 2.92 |
| **gemini-control** | 21 | 14 | 7 | **66.7%** | 1.75 |
| grok | 13 | 6 | 7 | 46.2% | 1.08 |

**Metric definitions**, since the original reported only one of these:

- **emitted** — findings the arm produced across the 12 snapshots. The
  denominator the original never printed.
- **accepted / dismissed** — the adjudicator's ruling, taking the LATEST event
  per finding (some findings carry more than one; counting every event
  double-counts those, which is why a naive query returns 48/26 for opus against
  73 judged).
- **precision** — `accepted / (accepted + dismissed)`. Of the findings an arm
  made that got a ruling, the share judged real. **Volume-independent**, which is
  exactly what the original metric was not.
- **accepted per snapshot** — the original's decision metric. A count, so it
  scales with how much an arm says.

**These accepted counts are NOT the same basis as the table above** (46 here vs
23 there for opus). The original counts post-clustering, crediting a defect once
across arms; this counts per-arm findings. The two are not comparable in
absolutes — precision is offered as a *ratio*, which is robust to that choice,
and every arm is computed identically.

### Three things that change

**1. The Grok characterisation is wrong.** The prose above reads *"Grok
essentially missed almost everything… the gap between a careful reviewer and one
skimming the document."* Grok emitted 13 findings and was right about **46%** of
them — mid-pack, and within noise of qwen's 50.8%, the arm called "genuinely
competitive". Grok is **conservative, not careless**. That is a different
diagnosis, and it is the one that matters if the live question is ever "cheapest
adequate reviewer" rather than "does opus stay".

**2. The runner-up ordering reverses.** On the count metric qwen (2nd) beat
deepseek (3rd). On precision **deepseek 55.2% beats qwen 50.8%** — while emitting
less than half as much (29 vs 61). The original ranked the arm that talked more.

**3. `gemini-control` is missing from the verdict table entirely.** It appears
twice in the plan and zero times in this document, yet it scored the **highest
precision of any arm (66.7%)** on the smallest output (21 findings). A control
arm dropped from the reported ranking is the kind of omission that makes a result
hard to trust later, independent of whether it would have changed the decision.

### Why the decision still holds

Opus ranks **first on volume and second on precision (63.9%, within 3 points of
the control)**, so its win is not an artifact of the volume-biased metric. That is
the strongest available defence of this verdict — and the original does not make
it, because it never computed precision.

### Two caveats the original disclosed but did not propagate

- **Label error was never put into an interval.** §"One honest caveat" reports
  human-vs-agent override rates of **37–69%**, then argues the 23-vs-15 margin is
  too large for leniency to explain. With label error in that range, 23 and 15 are
  not precise quantities; no interval was ever placed around them.
- **The verdict is no longer reproducible by its own tooling.** As of 2026-09-07,
  `node scripts/campaign.mjs verdict --campaign final-review-scoped-2026q3`
  returns *"no cohort recorded for this campaign under the current lock — no
  verdict is computable."* The cohort is still in the store (`0d3d4031`); the lock
  digest has moved on. A settled verdict that its own command cannot recompute is
  worth knowing before anyone cites it.

### The generalisable lesson

Both this bake-off and the 2026-09-07 adjudicator eval failed the same way: **a
scoring rule with no counterweight, scored against model-generated labels.** A
**degenerate-arm control** — score "accept everything" and "accept nothing"
alongside the real arms — would have exposed both, costs nothing to compute, and
is now implemented for the adjudicator role in
`adjudicator-executor.mjs::degenerateBaselines`. It should be standard for any
future comparison campaign.
