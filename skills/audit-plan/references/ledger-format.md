---
summary: Adjudication ledger schema + writer invocation example for each finding outcome.
---

# Adjudication Ledger — Writing Entries

After each deliberation round, write ledger entries for every finding
before proceeding to Step 4 (Fix). The ledger is the source of truth for
R2+ rulings injection and post-output suppression.

## Status fields

Two orthogonal axes track a finding's lifecycle:

| Axis | Values | Meaning |
|---|---|---|
| **adjudicationOutcome** | `dismissed` / `accepted` / `severity_adjusted` | How was the finding judged during deliberation |
| **remediationState** | `pending` / `planned` / `fixed` / `verified` / `regressed` | What's the implementation status |

Typical flows:
- Dismissed finding: `dismissed` + `pending` (never progresses)
- Fixed HIGH finding: `accepted` + `fixed` → `verified` after R2+ confirms
- Severity-adjusted: `severity_adjusted` + flows same as accepted at new severity

## Writer invocation

Call from the orchestrator for each finding:

```bash
node -e "
import { writeLedgerEntry, generateTopicId, populateFindingMetadata } from './scripts/shared.mjs';

// Example: dismissed finding
const finding = {
  section: 'scripts/shared.mjs',
  category: 'SOLID-SRP Violation',
  principle: 'SRP',
  _pass: 'backend',
};
populateFindingMetadata(finding, 'backend');

writeLedgerEntry('/tmp/\$SID-ledger.json', {
  topicId: generateTopicId(finding),
  semanticHash: 'abcd1234',
  adjudicationOutcome: 'dismissed',
  remediationState: 'pending',
  severity: 'MEDIUM',
  originalSeverity: 'MEDIUM',
  category: finding.category,
  section: finding.section,
  detailSnapshot: 'shared.mjs mixes concerns...',
  affectedFiles: ['scripts/shared.mjs'],
  affectedPrinciples: ['SRP'],
  ruling: 'overrule',
  rulingRationale: '300-line file, 2 consumers, acceptable',
  resolvedRound: 1,
  pass: 'backend'
});
" --input-type=module
```

## Ledger ordering rule

**Write the ledger BEFORE proceeding to Step 4.** If Step 4's fixes
happen first, the ledger captures pre-fix state and R2+ rulings injection
uses stale data. The ledger is the R2+ contract — treat it as the source
of truth.

After Step 4 completes, update ledger entries for the fixed items:

```bash
node -e "
import { writeLedgerEntry } from './scripts/shared.mjs';
writeLedgerEntry('/tmp/\$SID-ledger.json', {
  topicId: '<existing topicId>',
  remediationState: 'fixed',
  // other fields unchanged — writeLedgerEntry merges on topicId
});
" --input-type=module
```

## What the ledger enables

1. **Rulings injection** — R2+ prompts include the prior dismissals as
   "do not raise these again" instructions.
2. **Post-output suppression** — fuzzy match new findings against ledger
   topics; suppress re-raises of dismissed items.
3. **Reopen detection** — when fixed code regresses, R2+ detects it via
   the `remediationState: 'fixed'` entries that match new raises.
4. **Debt capture** — out-of-scope deferrals in Step 3.6 reference ledger
   entries for cross-linkage.
