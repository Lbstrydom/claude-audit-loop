# Plan: Score the final-review gate on the claims it already makes

- **Date**: 2026-09-07
- **Status**: Parked — **NO-GO, closed 2026-09-07.** The §5 assumption was measured and does not hold; Features A/B/C are not built. See §5 for the measurement.
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

## 5. Open questions — SETTLED 2026-09-07. Verdict: **NO-GO.**

> **Status: this plan does not proceed.** The §5 assumption was measured and it
> does not hold. Features A, B and C are not built. What follows is the
> measurement, because the negative result is the deliverable.

### 5.1 How long does a challenge take to resolve? — **it doesn't**

The plan assumed the risk was *latency* — that a challenge might take months. The
measurement says latency is not the problem and never was. **Resolution
essentially does not happen at all**, and the ~1% that does resolve, resolves in
hours.

**This is a proxy, and it is stated as one.** The challenge link is not persisted
(that is Feature A), so there is no direct data. The closest available proxy is
the dismissal → reopen / dismissal → accepted latency distribution: a challenge
targets a finding the loop dismissed, so the question "does a dismissed finding
ever acquire a contradicting outcome, and how fast" is the same shape. Its
limitation is named in §5.3.

**Measured** 2026-09-07, store fingerprint `d5a9d07b91225a93`, repo
`6461a693-6690-4bf3-98ee-14c0385cc357` (`Lbstrydom/claude-engineering-skills`).
Population: 1,230 findings observed dismissed between 2026-07-17 and 2026-09-04.

| cohort | n | resolved | **never resolved** | p50 | p90 | max | vindicated |
|---|---|---|---|---|---|---|---|
| all dismissals | 1,230 | 15 | **98.78%** | 7.07 h | 7.30 h | 7.39 h | 3 |
| dismissed >7d ago (uncensored) | 1,149 | 15 | **98.69%** | 7.07 h | 7.30 h | 7.39 h | 3 |
| dismissed >30d ago | 436 | 0 | **100.00%** | — | — | — | 0 |

- *resolved* = a state observation strictly later than the dismissal, from either
  write path (see §5.2).
- *vindicated* = that later observation is `accepted` or `severity_adjusted` —
  i.e. the challenge would have been scored correct. **3 of 1,230 (0.24%).**
- **Censoring is not the explanation.** The entire observed resolution
  distribution completes inside 7.4 hours, so a dismissal older than one day has
  already had 3x the maximum observed resolution time. The >7d cohort is
  effectively uncensored and reads the same. The >30d cohort is *worse*, not
  better — resolution is anti-correlated with age, because it is not a function
  of elapsed time at all (§5.3).

**Against the pre-registered decision rule** (stated before the query ran):
p50 ≤ ~2 weeks **and** <50% never-resolved → viable; long tail **or** majority
never-resolved → stop. The first clause passes (p50 = 7 hours). The second fails
by a factor of two: **98.8% never resolved**. Rule fires: **stop.**

This is precisely the two-sided miss the p50/p90-plus-never-resolved framing
exists to catch. A single averaged number here would read *"mean resolution
latency ≈ 7 hours"* and be a spectacular lie — it would be the mean over the 1.2%
that resolved, describing a population that does not exist.

### 5.2 Why the plan's core premise is false, not merely thin

§1.2 claims the label "arrives as a side effect of work already happening":
*"That finding is already in the adjudication pipeline and will acquire an
outcome without anyone doing extra work."* **It is not.** There is no pipeline
that revisits a dismissal.

All 15 resolutions carry `adjudicator_kind = 'human'`, and every one lands on a
`final-review` or `final-review-shadow` finding. They arrive in two tight
clusters (≈1.5 h and ≈7.1 h after their dismissals) — the signature of a person
sitting down and working a batch. **The only mechanism in this store that ever
revisits a dismissal is the manual adjudication worksheet** — the mechanism §1
already measured as not scaling (6 labels in two months) and that this entire
plan exists to avoid depending on.

The automatic path revisits nothing. Across 1,230 dismissals and 52 days, the
number of dismissals revisited by anything other than a human worksheet is
**zero**.

Feature C's floor is ~30 resolved challenges. At the measured 1.22% resolution
rate that needs ≈2,460 challenges *(derived; assumes challenges resolve at the
same rate as dismissals generally)*. The gate raised 345 final-review findings in
total over the 52-day window — so even if **every** finding it ever raised were a
challenge, the expected yield is ≈4 resolved. C is roughly a year away, and only
if the human worksheet keeps firing, which is the assumption the plan was
supposed to remove.

### 5.3 The proxy's limitation, stated

The proxy cannot see one thing: whether *the act of challenging* would itself
provoke a human to look, creating resolutions that do not occur today. That is a
real gap and it is not closed by this measurement.

It does not rescue the plan, because the provoked look **is** the human
worksheet. The plan's value proposition is that labels accrue with no human step;
if the challenge only resolves when it prompts someone to adjudicate, Feature C
is a worksheet with extra persistence, and §1's measured 6-of-345 throughput
applies unchanged.

### 5.4 Instrument verification (the naive answer was 81.5%, and it was wrong)

Recording this because the first union query returned a number that would have
inverted the decision.

- **Positive control.** The query provably sees transitions: 141 findings carry
  more than one adjudication event, all with distinct timestamps, and the
  transition enumeration returns `dismissed → accepted` (3),
  `needs_triage → accepted` (35), `accepted → dismissed` (8). Not structurally
  blind.
- **A second write path exists.** `audit_findings.adjudication_outcome` /
  `decided_at` are mutated *without* writing a `finding_adjudication_events` row:
  49 rows read `dismissed` while their latest event reads `accepted`, and in
  every one sampled `decided_at` is later than that event. An event-only
  instrument undercounts, so the measurement above unions both paths.
- **The artifact.** Unioning naively gave *81.5% revisited* — a viable-looking
  answer. **988 of those 1,003 "revisits" land within 60 seconds** of the
  dismissal: they are the event write and the row write of a **single** decision,
  not a revisit. Excluding sub-hour deltas, the union instrument and the
  event-only instrument agree exactly at 15. The 1-hour floor is the reported
  method.
- **The third write path is a real zero, not a false one.**
  `suppression_events.action='reopened'` fires 98 times, and **not once after a
  dismissal**: 69 of the 70 matched pairs fall within ±1 hour (same round — the
  suppression layer reopening at raise time), and 1 precedes its dismissal. The
  vacuity guard confirms the join is live — 40 reopened fingerprints do match
  dismissed findings — so the zero is a fact about the mechanic, not a dead join.
  "Reopen" here is a within-round event and is not a later revisit signal.

<details>
<summary>Query of record (run against the store above)</summary>

```sql
WITH scoped_f AS (
  SELECT f.* FROM audit_findings f JOIN audit_runs r ON r.id = f.run_id
  WHERE r.repo_id = '6461a693-6690-4bf3-98ee-14c0385cc357'
),
-- BOTH write paths: the event log and the mutable row.
obs AS (
  SELECT e.finding_id, e.created_at AS at, e.adjudication_outcome AS outcome
  FROM finding_adjudication_events e JOIN scoped_f f ON f.id = e.finding_id
  UNION ALL
  SELECT f.id, f.decided_at, f.adjudication_outcome FROM scoped_f f
  WHERE f.decided_at IS NOT NULL AND f.adjudication_outcome IS NOT NULL
),
t0 AS (
  SELECT finding_id, min(at) AS dismissed_at FROM obs
  WHERE outcome = 'dismissed' GROUP BY 1
),
res AS (
  -- the 1-hour floor excludes same-decision write-lag; without it this reads 81.5%.
  SELECT t0.finding_id, t0.dismissed_at,
    min(o.at) FILTER (WHERE o.at > t0.dismissed_at + interval '1 hour') AS revisit_at,
    min(o.at) FILTER (WHERE o.at > t0.dismissed_at + interval '1 hour'
      AND o.outcome IN ('accepted','severity_adjusted'))              AS vindicate_at
  FROM t0 LEFT JOIN obs o ON o.finding_id = t0.finding_id
  GROUP BY 1, 2
)
SELECT count(*) AS dismissed_n,
       count(revisit_at) AS resolved,
       round(100.0 * count(*) FILTER (WHERE revisit_at IS NULL) / count(*), 2) AS pct_never,
       count(vindicate_at) AS vindicated,
       percentile_disc(0.5) WITHIN GROUP (
         ORDER BY EXTRACT(EPOCH FROM (revisit_at - dismissed_at)) / 3600) AS p50_hours,
       percentile_disc(0.9) WITHIN GROUP (
         ORDER BY EXTRACT(EPOCH FROM (revisit_at - dismissed_at)) / 3600) AS p90_hours
FROM res;
```
</details>

### 5.5 Should an unresolved challenge time out into `no-signal`? — **No. Never.**

The plan leaned unresolved-forever. The measurement makes that a conclusion
rather than a lean, and the case is stronger than the plan supposed.

- **A timeout would be ~99% of the label.** 98.8% of dismissals never resolve, so
  a timeout of any length becomes the label on essentially the whole corpus. The
  field would encode elapsed time and nothing else.
- **It would capture zero real resolutions.** The entire observed resolution
  distribution completes within **7.4 hours**. Any timeout long enough to be
  defensible (days, weeks) fires strictly after every true resolution has already
  landed. It adds no information — it only converts *unknown* into a fabricated
  *no-signal*.
- **It is not even weakly correlated with truth.** Resolution is driven by
  whether a human happened to run a worksheet batch over that run, not by elapsed
  time — which is why the >30d cohort resolves **0** while the recent cohort
  resolves 15. A time-based label would be anti-correlated with the signal it
  claims to summarise.
- **Scale against the precedent.** Commit `0d82efa3` removed a contaminated label
  from `getAdjudicatorGroundTruth` where the measured contamination was **8.9%,
  and explicitly a floor** — 97 dismissals carrying a signal that the claim was
  not false. That was enough to invalidate the corpus. A `no-signal` timeout here
  would be ~99% timeout-derived. It is the same defect, an order of magnitude
  worse, re-introduced deliberately.

Unresolved stays unresolved. `unmeasured` is the honest output, and per §5.1 it
is the output for essentially the whole population — which is the reason this
plan stops.

### 5.6 What is still open

Q1 (is the gate earning its cost) and Q2 (would a cheaper model do) remain
**unanswered**, and this plan is now a sixth closed route to answering them,
alongside the five in §1. The specific thing that is closed: *outcome labels
cannot be harvested from the adjudication pipeline as a side effect, because the
pipeline does not revisit dismissals.* Any future attempt needs a mechanism that
creates the label, not one that waits for it — and §1 already measures what
creating it by hand costs.

The §1.1 defect stands on its own merits and is **not** refuted by this result:
the gate does emit four checkable claims and does discard all of them at
persistence. Feature B (three `audit_runs` columns for the deliberation
self-assessment) is the one part of this plan whose value does not depend on
challenge resolution — its calibration measurement compares *claimed* GPT
false-positive count against *observed* dismissals in the same run, which needs
no later revisit at all. If any of this is revived, revive B alone, on that
argument, and re-derive its own viability rather than inheriting this plan's.
