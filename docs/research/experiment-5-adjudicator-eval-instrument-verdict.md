# Experiment 5 — Adjudicator-role eval: the instrument is the defect

**Date**: 2026-09-07 · **Role**: adjudicator · **Subject of the claim**:
`gemini-pro-latest`, the production final-review model.

## The claim under test

> The production final-review adjudicator accepted **80%** of findings a human
> had already DISMISSED. For a gate whose job is rejecting bad findings, that is
> close to a rubber stamp.

**Verdict: the claim does not survive.** It is not a finding about
`gemini-pro-latest`, and it is not a finding about the production gate. It is
two independent instrument defects — a **contaminated label** and a **metric a
constant classifier beats** — sitting on top of a smaller, real, and much less
alarming signal.

The one thing that should change is the harness. Nothing about the production
final-review gate is indicated by this measurement, in either direction.

## Provenance

The enabling work was uncommitted in another worktree when this investigation
started; it landed mid-session as **`8018e0bc`** *("fix(model-eval): the
adjudicator eval could never run — a repo_uuid where a row id was required")*
and is now on `origin/main`. All figures below were produced against the
`cranky-pike-3525bf` worktree at `9e4e4d23` (clean tree), which contains it.

| | |
|---|---|
| Store | NAS Postgres, fingerprint `d5a9d07b91225a93` (db `audit_loop`) |
| Repo scope | `audit_repos.id = 6461a693-6690-4bf3-98ee-14c0385cc357` |
| Corpus | 3,413 labeled rows *(measured)*; 2,328 `accepted` / 1,085 `dismissed` in the harness's own 180-day window |
| Spend, this investigation | **$0.43** *(derived from measured tokens at HEAD's rate card)* — $0.314 replication + ~$0.12 paired control |

Costs are `derived`; token counts are `measured` and unaffected by the rate-card
fix (`9e4e4d23`) that landed during this session. Re-deriving the two stored runs'
costs at HEAD's table reproduces the stored values exactly, so no figure here
straddles that change.

## Result summary

| Figure | Value | Label |
|---|---|---|
| Stored incumbent, n=10 | recall 0.80 · **FPR 0.80** · F1 0.615 | measured |
| Replication, n=50 | recall 0.84 · **FPR 0.64** · F1 0.677 | measured |
| Constant-`true_positive` baseline, balanced sample | recall 1.0 · FPR 1.0 · **F1 0.667** | derived |
| Scored negatives carrying a signal that the claim was NOT false | **6 of 25 (24%)** | measured |
| Eval prompt, input tokens per adjudication | **92.3** (n=50) / 94.6 (n=10) | measured |
| Production final review, input tokens per call | **mean 58,043** (n=220, max 204,233) | measured |
| Evidence gap | **~620x** | derived |

The headline 0.80 was a small-sample high read. The stable figure is **0.64**
*(measured, n=50)* — and even that is not a false-accept rate, for the reasons
below.

---

## Instrument check 1 — does the eval exercise the production path?

**Structurally, no. But impoverished evidence is NOT what produces the number** —
this was tested directly and the hypothesis failed.

### 1a. The evidence gap is real and large

The eval's entire adjudication prompt is **332 characters** *(measured)* — a
76-char system line and a 256-char user turn built by `buildAdjudicatorPrompt`
(`scripts/lib/model-eval/structured-extractor.mjs`) from `toRawContext(row)`:
`category — primaryFile — detailSnapshot`, plus a severity. No diff. No code. No
plan. No rulings block. No definition of what "false positive" means.

Production's `REVIEW_SYSTEM` prompt is **5,699 characters** *(measured)* before
any transcript, diff, files-in-scope list or repo-context block is appended.

Measured end to end from the store, the gap is larger still:

```bash
node scratch/q.mjs "SELECT count(*), min(final_review_shadow_input_tokens), round(avg(final_review_shadow_input_tokens)), max(final_review_shadow_input_tokens) FROM audit_runs WHERE repo_id='6461a693-6690-4bf3-98ee-14c0385cc357' AND final_review_shadow_input_tokens > 0"
```

n=220, min=2, avg=**58,043**, max=204,233 *(measured)*.

**92.3 tokens versus 58,043** — the eval gives the model **0.16%** of the
evidence the production gate sees *(derived)*.

### 1b. The task is different, not merely smaller

`GeminiFinalReviewSchema` (`scripts/gemini-review.mjs:182`) has **no per-finding
true/false verdict at all**. Production emits a run-level `verdict`, plus
`new_findings[]` and `wrongly_dismissed[]` — the latter being the model's
*challenge* to a dismissal, capped at 10 and fenced by an escalation cap and a
provenance requirement (system-prompt rules 7 and 8). The production
adjudicator's default behaviour toward a finding it agrees was correctly
dismissed is to **say nothing**.

So "accepted 80% of dismissed findings" has no production analogue to be high or
low against. The eval scores a task the gate does not perform.

### 1c. The controlled test — and it refutes the leading hypothesis

The obvious mechanism ("a model given three fields has no basis to say no") is
testable with one variable. Same 20 rows, same model, same prompt template, same
output schema, same egress gate — the only change is whether the cited file's
real source is appended to `findingText`.

3 rows were refused by the egress gate (correctly — the appended source mentions
`.env`), leaving **17 rows scored by both arms** *(measured)*:

| Arm | recall | falsePositiveRate |
|---|---|---|
| Impoverished (harness as-is) | 0.875 | **0.667** |
| Evidence (same rows + cited file source) | 0.750 | **0.667** |

**Identical false-accept rate.** Giving the model the code did not make it reject
a single additional "dismissed" finding; it only cost recall.

This is a useful negative result: enriching the harness's prompt would **not**
have moved the number, so the obvious remediation is the wrong one. The
disagreement is not the model failing to check the code. It is the label.

---

## Instrument check 2 — what does `humanLabel` actually mean? (the real defect)

`getAdjudicatorGroundTruth` maps `adjudication_outcome='dismissed'` →
`false_positive` (`scripts/lib/store/model-ab.mjs:645`). That mapping is wrong,
and the store proves it mechanically.

### 2a. "human" is a misnomer

**931 of 1,085** dismissed rows have `user_action = NULL` *(measured)*. Neither
writer that records a human disposition (`setFindingOutcome`,
`adjudicateFinalReviewFinding`) leaves it null — both write it alongside. The
actual writer is **`recordAdjudicationEvent`**
(`scripts/lib/store/runs-findings.mjs:1925`), which sets `adjudication_outcome`
and `decided_at` and nothing else. It is fed by the audit's own R2+ deliberation
ledger via `outcome-sync.mjs`.

So ~86% of the "human DISMISSED" corpus is **the author model's in-loop triage**,
not a human verdict on truth.

### 2b. Rows labelled `false_positive` that the repo itself treats as true

Of 1,085 dismissed rows, **100 (9.2%)** carry at least one signal that the claim
was not false *(measured)*:

| Signal | n | Why it contradicts `false_positive` |
|---|---:|---|
| `ruling = 'sustain'` | 51 | The deliberation **upheld** the finding. `dbRuling` derives `sustain` only from `accepted`, so a stored `sustain` + `dismissed` pair came from an explicit ledger ruling — an internal contradiction. |
| `remediation_state` in {planned 25, fixed 9, regressed 1} | 35 | Someone **planned or shipped a fix** for it. |
| duplicate-suppression rationale | 20 | `semantic-suppress.mjs:176` writes `adjudicationOutcome:'dismissed'` for a semantic duplicate whose own rationale says *"the canonical finding remains open."* A duplicate of a true finding is true. |
| `user_action` in {auto_dismissed, needs_triage, fix-now} | 11 | `auto_dismissed` is the documented **out-of-scope auto-deferral** path; `needs_triage` means not yet decided. |

Query used:

```bash
node scratch/contam.mjs
```

**9.2% is a floor, not an estimate**: 854 of the 1,085 rows carry no rationale at
all, so most rows cannot be tested for contamination in either direction.

One candidate mechanism was checked and **ruled out**: a `defer` ruling does not
land here. The sanctioned shape for a deferral is `accepted` + `pending`
(`scripts/lib/ledger.mjs:897`), so deferrals are labelled `true_positive`, not
`false_positive`.

### 2c. In the sample that was actually scored, it is 24%

Of the **25 negatives** in the n=50 draw, **6 carry a contradicting signal**
*(measured)*:

```
rs=fixed    ruling=sustain      tests/debt-memory-durable-write.test.mjs
rs=fixed    ruling=sustain      scripts/lib/audit-store-writers.mjs
rs=pending  ruling=sustain      tests/install/transaction-hardening.test.mjs
rs=pending  ruling=sustain      scripts/lib/store/runs-findings.mjs
rs=pending  ruling=sustain      scripts/lib/audit/stage0-relevance-context.mjs
rs=planned  ruling=compromise   scripts/symbol-index/extract.mjs
```

Two of them were **sustained in deliberation and then fixed**. They sit in the
ground truth as `false_positive`, and the adjudicator is penalised for calling
them real.

Reading the n=10 sample's five negatives by hand agrees. One is
*"[Sustainability] Documentation Maintainability — agents.md — Always-loaded
canonical guidance includes substantial incident history… Historical dossiers
obscure durable operational guidance."* That is not a false claim; it is the
exact concern AGENTS.md's own 92,000-character cap exists to enforce. Another
pair (`audit-store-writers.mjs` and its test) is one claim recorded twice against
two files — the dedup is by fingerprint, not by claim, so five negative rows
carry only four distinct assertions.

**A corrected false-accept rate cannot be computed** without relabelling the
corpus. Removing the six known-bad rows leaves n=4 negatives, which is not a
rate. That is the honest ceiling on what this measurement can say.

---

## Instrument check 3 — n, and a metric a constant beats

### 3a. The replication

Same `getAdjudicatorGroundTruth` → `selectBalancedSample` →
`scoreAgainstGroundTruth` path the CLI uses, at n=50:

- route resolved: `gemini-pro-latest`; draw `{"true_positive":25,"false_positive":25}`
- **recall 0.84 · falsePositiveRate 0.64 · F1 0.677** · 4,616 in / 25,395 out tokens · 341.8s *(measured)*

0.80 → **0.64**. The lean is real but the headline figure was a small-sample high
read, exactly as suspected.

### 3b. The degenerate baseline (the finding the harness is missing)

`scoreBinaryClassification` is arithmetically correct — both stored runs
reconcile exactly against it. But on a **balanced** sample, a classifier that
reads nothing and always answers `true_positive` scores *(derived)*:

> precision 0.5 · recall 1.0 · **F1 0.667**

The incumbent's measured n=50 F1 is **0.677** — **+0.010 over a constant**.
`minF1` is the screen tier's only threshold. A gate keyed on F1 alone over a
balanced binary sample cannot distinguish a working adjudicator from a stuck one.

### 3c. The floor rejects by construction

`adjudicator-thresholds.json` (version 3) sets
`screen.thresholds.oracle.minF1 = 0.95`, with its own `calibrationNote`
conceding *"v0.1 bootstrap values, uncalibrated against any real run."* The
production incumbent measures 0.615 / 0.677. Both stored runs returned
`verdict: inconclusive`, `next_action: reject` — consistent, and unavoidable:
**no candidate can ever pass a floor the incumbent misses by 0.27.**

---

## Does the production path show the same lean? Not measurable.

Existing evidence does not answer this, and no new spend would fix it cheaply.

By pass, over the 180-day window *(measured)*: the `final-review` pass raised
**345** findings and only **6** were ever adjudicated (1 accepted / 5 dismissed).
n=6 is not a measurement.

The run-level picture *(measured)*: 180 `APPROVE` · 114 `CONCERNS` · 24
`CONCERNS_REMAINING` · 8 `REJECT` across 326 graded runs (634 ungraded). 44.8% of
graded runs raise concerns or reject — so the production gate is visibly **not** a
rubber stamp at run level. That is a different question from per-finding accept
rate and should not be read as answering it.

---

## What should change

Ranked. The first two are the actual result of this investigation.

1. **Stop calling it `false_positive`.** `getAdjudicatorGroundTruth`'s
   `humanLabel` measures *agreement with the audit loop's own triage*, not
   correctness. Rename the metric to what it measures
   (`disagreementWithTriage`), or — better — **exclude the four contamination
   classes at the query**: `ruling='sustain'`, `remediation_state` terminal or
   `planned`, duplicate-suppression rationales, and `user_action` in
   {`auto_dismissed`, `needs_triage`, `fix-now`}. That is a ~9% cut of the
   dismissed corpus and a 24% cut of what actually got scored. Until then the
   runbook's *"the verdict rides on false-positive rate and cost"* points the
   adjudicator role at a number that does not mean what it says.

2. **Add degenerate-classifier controls to the harness.** Score
   constant-`true_positive` and constant-`false_positive` alongside every
   candidate and refuse a verdict that does not beat both by a stated margin. The
   incumbent currently clears the always-yes baseline by 0.010 and nothing in the
   harness notices. This is the "audit your success paths" rule applied to a
   scorer: *can this emit a passing-shaped number without having discriminated
   anything?*

3. **Recalibrate `minF1`, and gate on FPR rather than F1.** A `version: 4` bump
   is justified — the floor of 0.95 is unreachable by the production model and
   rejects every candidate by construction. Do this only **after** (1), or the
   recalibration bakes the contaminated label into the threshold.

4. **Do not enrich the eval prompt.** Measured, paired, n=17: adding the cited
   file's full source left the false-accept rate unchanged at 0.667 and cost
   recall. Recording the negative result is the point — it removes the most
   obvious and most expensive remediation from the table.

5. **Leave the production gate alone.** Nothing measured here is evidence about
   `gemini-pro-latest`'s behaviour in `gemini-review.mjs`, which sees ~620x the
   evidence, answers a different question, and is fenced by an escalation cap and
   a provenance requirement the eval prompt has none of.

## Incidental observations (not pursued)

- `getAdjudicatorGroundTruth`'s `catch` returns `{cloud: true, rows: []}` — a
  broken query and an empty corpus leave by the same path. This is the shape
  `isSchemaFaultSqlstate` / `describeSchemaFault` exist to prevent, and the same
  class as the `repo_uuid` bug `8018e0bc` just fixed one layer up.
- The egress gate refused `scripts/lib/audit/llm-helpers.mjs` with
  `sensitive file path(s): tokens/latency/accept-rate` — a prose fragment matched
  as a path by `findSensitivePathMentions`. It fails closed, so it is harmless,
  but it is a false positive in a scanner.
- The `final-review` pass's 98% never-adjudicated rate (339 of 345) is why the
  production-lean question is unanswerable. If that question matters, the fix is
  adjudication coverage, not another eval run.

## Reproduce

```bash
node scripts/model-eval-adjudicator.mjs --candidate '{"kind":"sentinel","value":"latest-pro"}' --tier screen --out <file>
```

Stored runs: `87b5f691-57e6-48f0-bc5c-2ccf42ca35a0` (incumbent, n=10) and
`cca4bd14-52d7-4ea7-bcec-35f49cdadb8a` (candidate `gemini-3.8-flash`, n=10), both
`superseded_at IS NULL` in `model_eval_runs`.

The n=50 replication and the paired evidence control were run through the same
library functions but not via the CLI (the CLI's sample size is
`tierConfig.minSampleSize`, fixed at 10 for the screen tier) and were **not**
written to `model_eval_runs` — they are scratch measurements, reported here
rather than stored as verdicts.
