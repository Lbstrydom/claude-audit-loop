---
summary: Post-session history readback — recurring-issue surface + cross-session pattern detection.
---

# Session History Readback

After saving the current session, surface patterns across prior sessions
so the user notices trends they might miss.

## Readback query

Use the cross-skill bridge for both queries below. After the 20260507
RLS hardening these tables require service-role; cross-skill holds it.

Fetch the last three sessions for this URL:

```bash
node scripts/cross-skill.mjs get-persona-sessions-by-url \
  --url "<url>" --limit 3
```

Or, when `repo_name` is set, prefer the repo-wide view:

```bash
node scripts/cross-skill.mjs get-persona-sessions-by-repo \
  --repo "<repo>" --limit 5 \
  --select persona,focus,verdict,p0_count,p1_count,findings,debrief_md,created_at
```

## Output

If prior sessions exist, emit a **SESSION HISTORY** block:

```
SESSION HISTORY (last 3 runs on this URL)
  2026-04-10 — "new user on desktop" → Needs work (P0:2 P1:3)
  2026-04-12 — "power user" → Needs work (P0:1 P1:2)
  2026-04-14 — "first-time user on mobile" → Blocked (P0:3 P1:1)  ← this session
```

## Recurring-issue detection

Scan the `findings` arrays of prior sessions. When the same finding
(matched by `element` + `observed` substring) appears in ≥2 sessions,
surface it as recurring:

```
RECURRING ISSUES (appeared in 2+ sessions):
  • [P1] .search-results — no loading state (3 sessions)
  • [P0] #submit-btn — unresponsive on mobile (2 sessions)
```

Rank by:
1. Severity (P0 first, then P1, then P2, then P3)
2. Session count descending
3. Most recent first

Show the top 5. Skip entries with `confidence < 0.6` in any occurrence —
uncertain findings aren't evidence of a pattern.

## Persistent-P0 detection

The `persistent_p0s` view derives from `persona_test_sessions` and is
subject to the same service-role RLS post-20260507. Until a dedicated
cross-skill subcommand wraps it, derive client-side from the
`get-persona-sessions-by-url` result above: count P0 findings with the
same `element` + `observed` substring across the returned sessions; flag
those appearing in ≥2 sessions with confidence ≥0.7.

## Graceful degradation

If Supabase vars are not set, skip history entirely — do not warn the
user. Session history is a nice-to-have, not a required output.
