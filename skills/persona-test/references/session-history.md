---
summary: Post-session history readback — recurring-issue surface + cross-session pattern detection.
---

# Session History Readback

After saving the current session, surface patterns across prior sessions
so the user notices trends they might miss.

## Readback query

Fetch the last three sessions for this URL:

```bash
curl -s "$PERSONA_TEST_SUPABASE_URL/rest/v1/persona_test_sessions?url=eq.<url>&order=created_at.desc&limit=3" \
  -H "apikey: $PERSONA_TEST_SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $PERSONA_TEST_SUPABASE_ANON_KEY"
```

Or, when `repo_name` is set, prefer the repo-wide view:

```bash
curl -s "$PERSONA_TEST_SUPABASE_URL/rest/v1/persona_test_sessions?repo_name=eq.<repo>&order=created_at.desc&limit=5&select=persona,focus,verdict,p0_count,p1_count,findings,debrief_md,created_at" \
  -H "apikey: $PERSONA_TEST_SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $PERSONA_TEST_SUPABASE_ANON_KEY"
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

If `PERSONA_TEST_SUPABASE_URL` is set, the `persistent_p0s` view already
does this server-side:

```bash
curl -s "$PERSONA_TEST_SUPABASE_URL/rest/v1/persistent_p0s?url=eq.<url>" \
  -H "apikey: $PERSONA_TEST_SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $PERSONA_TEST_SUPABASE_ANON_KEY"
```

Returns P0s that have appeared in ≥2 sessions with confidence ≥0.7 —
these are the fix-first candidates.

## Graceful degradation

If Supabase vars are not set, skip history entirely — do not warn the
user. Session history is a nice-to-have, not a required output.
