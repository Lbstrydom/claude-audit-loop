# Plan: Score the final-review gate on the claims it already makes

- **Date**: 2026-09-07
- **Status**: Draft — not yet audited
- **Author**: Claude + Louis
- **Scope**: backend
- **Stack**: js-ts + postgres
- **Target domain(s)**: `audit-orchestration`, `stores`

> **Right-sizing banner — read before adding anything.**
> [`final-review-shadow-bakeoff.md`](./final-review-shadow-bakeoff.md) was audited
> to completion and then **PARKED**, because its instrument (six tables, a
> calibration corpus, a 12-row verification matrix) cost more than the decision it
> would settle. This plan adds **three columns and one table**, and buys its ground
> truth from data the loop already produces. If it starts growing a corpus, a
> collector, or a human queue, stop and re-read that banner.

---

## 1. The question, and why nothing currently answers it

Two questions have been open since the final reviewer shipped:

- **Q1** — is the final-review gate earning its cost?
- **Q2** — would a cheaper model do the same job? (live: is `gemini-3.8-flash` a
  viable replacement for `gemini-pro-latest`?)

Both need per-decision outcome labels on the gate's real output. Five routes to
those labels were checked on 2026-09-07 against the live store (fingerprint
`d5a9d07b91225a93`, repo `6461a693-6690-4bf3-98ee-14c0385cc357`). **All five are
closed.**

| Route | Result | Why it is closed |
|---|---|---|
| Human adjudication | **6 of 345** *(measured)* | The mechanism from [`final-review-credit-and-cheap-shadow.md`](./final-review-credit-and-cheap-shadow.md) is built and marked Complete, but adjudication is a human **worksheet** step. It produced 6 labels in two months; 339 rows are `null`/`null`/`null`. It does not scale, and nagging will not change that. |
| Cross-pass fingerprint corroboration | **0 matches** *(measured)* | `finding_fingerprint` is content-derived. Gemini phrases a defect differently from GPT, so the same defect gets different hashes. Structurally dead, not merely sparse. |
| Semantic corroboration (pgvector) | **35 of 345 embedded** *(measured)* | Only 10% of final-review findings have a `finding_embeddings` row. Fixable going forward, but it yields a *similarity*, not an outcome. |
| Offline eval harness (`model-eval-adjudicator`) | **neither model beats a constant** *(measured, n=50)* | flash F1 0.489, pro F1 0.557, always-yes 0.667. It scores a task the gate does not perform, on 92 input tokens against a production mean of 58,043 *(measured, n=220)* — a ~620x evidence gap. Appending the cited file's source moved the false-accept rate **not at all** (paired, n=17), so enriching the prompt is not the fix. |
| Run-level `gemini_verdict` | persisted, but coarse | 180 APPROVE / 114 CONCERNS / 24 CONCERNS_REMAINING / 8 REJECT over 326 graded runs *(measured)*. Shows the gate is not a rubber stamp at run level; says nothing about per-finding correctness. |

### 1.1 The actual defect, in one sentence

**The gate emits four independently checkable claims per run, and every one of
them is discarded at persistence.**

| Claim in `GeminiFinalReviewSchema` | Checkable against | Persisted today? |
|---|---|---|
| `wrongly_dismissed[]` — "Claude wrongly dismissed GPT finding *X*" | *X*'s own subsequent `adjudication_outcome` | **No.** `projectWronglyDismissed` ([gemini-review.mjs](../../scripts/gemini-review.mjs)) maps the entry onto `{category, section, detail, severity}` for the existence gate and **drops the cited id** — even though the system prompt requires the model to cite it exactly. |
| `deliberation_quality.gpt_false_positive_count` | how many of that run's GPT findings were actually dismissed | **No** — no column exists |
| `deliberation_quality.claude_bias_detected` | whether that run's dismissals were later reopened | **No** |
| `new_findings[]` | remediation / recurrence | Rows persisted, outcomes not |

`audit_runs` keeps `gemini_verdict` and `final_review_model` and nothing else
from the review. The information needed to grade the gate is produced on every
run and thrown away.

### 1.2 Why this is the right lever

`wrongly_dismissed` is **self-labelling**. The gate names an existing finding by
id and asserts it was wrongly dismissed. That finding is already in the
adjudication pipeline and will acquire an outcome without anyone doing extra
work: if it ends `accepted` or is reopened, the challenge was right; if it stays
dismissed after a human has seen the challenge, it was wrong.

No corpus, no collector, no worksheet. The label arrives as a side effect of work
already happening.

---

## 2. Design

### Feature A — persist the challenge link (the load-bearing change)

New table `final_review_challenges`:

| column | meaning |
|---|---|
| `run_id` | the review's run |
| `challenged_finding_id` | FK to `audit_findings.id` — the id the model cited |
| `recommended_severity` | what the gate argued for |
| `reason`, `evidence_basis` | the model's stated grounds |
| `created_at` | |

Written where `wrongly_dismissed` is already iterated in `gemini-review.mjs`. A
table rather than a column because one review may challenge up to 10 findings.

**Fail closed on an unresolvable id.** The system prompt demands an exact id; one
that does not resolve is a *fabrication*, and storing it as a challenge would
launder a hallucination into evidence. Unresolvable ids are counted and reported,
never stored — and that count is itself a quality signal about the model.

Writes go through `durableWrite` with a declared `rowKey`, per the store-write
durability rule.

### Feature B — persist the deliberation self-assessment

Three columns on `audit_runs`: `fr_gpt_false_positive_count`,
`fr_claude_bias_detected`, `fr_architectural_coherence`.

This makes `gpt_false_positive_count` gradeable: the run's own GPT findings have
outcomes, so the *claimed* FP count can be compared against the *observed*
dismissals. That is a **calibration** measurement of the gate, computable per run
with zero human input.

### Feature C — the scorer

`npm run final-review:calibration`, reporting over a window:

- **challenge precision** — of resolved challenges, the fraction whose target
  ended `accepted` or reopened
- **FP-count calibration** — claimed vs observed as a *signed* error
  distribution, never one averaged number that hides a two-sided miss
- **fabricated-citation rate** — unresolvable ids per review
- **coverage** — how many challenges remain unresolved, printed beside every
  figure, because a precision over 3 resolved challenges is not a measurement

**Every output carries its n**, and a window that resolves nothing reports
`unmeasured` rather than a clean-looking zero. That failure mode is what this
whole investigation was about.

### 2.1 What Q2 gets for free

The shadow mechanism already runs a second reviewer over the same input
(`FINAL_REVIEW_SHADOW`, currently off). Its A/B was closed partly because scoring
needed a human queue — 84 of 536 shadow findings adjudicated *(measured)*.

With A and C a shadow arm becomes **self-scoring**: both reviewers challenge
dismissals in the same run, both challenge sets resolve against the same
outcomes, and challenge precision is directly comparable. Q2 becomes a paired
comparison on live work with no new labelling.

Deliberately **not** a sixth standing collector — it adds no new collection, it
makes the existing one scorable.

### 2.2 Explicitly NOT in scope

- No calibration corpus, no golden set, no new human queue.
- No change to the gate's prompt or schema — the claims already exist.
- No retrofit of the 339 unlabelled rows. Historical labels are unrecoverable,
  and pretending otherwise is how a contaminated corpus gets built.
- No repair of `model-eval-adjudicator`'s screen tier. It answers a different
  question badly; this removes the need for it in this role.

---

## 3. Sequence

1. **B first** (3 columns, ~1 day). Cheapest, and starts accruing calibration
   data on every real run immediately.
2. **A** (1 table, 1 writer, fail-closed id resolution).
3. **C**, once A has roughly 30 resolved challenges — not before, or the first
   report is a precision over n=2 that someone will quote.
4. **Then** re-open Q2 with a shadow arm scored by C.

## 4. Acceptance criteria

- A review challenging a finding writes exactly one `final_review_challenges` row
  per resolvable cited id, and zero rows for an unresolvable one.
- An unresolvable cited id increments a reported counter and never silently
  disappears.
- `final-review:calibration` prints `unmeasured` with a reason when the resolved
  set is below its stated floor, and never emits a rate without its n.
- A run whose review is skipped or fails writes no calibration row at all —
  absent, not zero.
- Cloud-off remains supported throughout: no new hard dependency on the store.

## 5. Open questions

- **How long does a challenge take to resolve?** Unknown. The plan assumes days.
  If the tail is months, C's floor is unreachable and this needs re-thinking
  before A is built. **Measure this first**, from the existing dismissal-to-reopen
  latency distribution — it is the single assumption that can invalidate the plan.
- Should a challenge nobody revisits stay unresolved forever, or time out into
  `no-signal`? Leaning unresolved-forever: a timeout that becomes a label is
  precisely the contaminated-label defect just removed from
  `getAdjudicatorGroundTruth`.
