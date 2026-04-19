---
summary: Sample full persona-test output — structured report + debrief fences and example content.
---

# Example — Full persona-test Output

Reference output for the combined report + debrief wrapper format.

## Structured Report (Phase 5)

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  PERSONA TEST REPORT
  Persona: first-time wine collector on mobile (iPhone 13)
  URL: https://winecellar.railway.app
  Focus: adding first bottle
  Tool: Playwright MCP — 11 steps — 4m 12s
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

FINDINGS
────────────────────────────────────────────────────
  P0 (broken)
  1. [P0] "Add Bottle" button submits but shows no feedback (confidence: 0.92)
     Element:  button[data-testid="add-bottle-submit"]
     Observed: Tapped submit; no loading spinner; page stayed on form for 3s
               before silently redirecting. User had no signal of success.
     Fix:      Add inline feedback — disable button + show spinner on click;
               preserve error state for ≥500ms so the user can read it.

  P1 (degraded)
  2. [P1] Search input has no loading state (confidence: 0.78)
     Element:  input[role="searchbox"]
     Observed: Typing into search produces a 1.5s delay before results
               appear. No skeleton or spinner — the list simply freezes.
     Fix:      Render a skeleton grid while results load.

  P2 (cosmetic)
  3. [P2] Wine card image overflows its container at 390px (confidence: 0.71)
     Element:  .wine-card img
     Observed: Image extends 8px past the card edge on iPhone 13 viewport.
     Fix:      Set max-width: 100% on .wine-card img.

  P3 (observation)
  4. [P3] Colour palette reads slightly dated compared to peer apps (confidence: 0.6)

OVERALL: Needs work
  Reason: P0 "no feedback after submit" blocks the primary user flow
          (adding a bottle). Fix before next user-facing release.

AUDIT CORRELATIONS
────────────────────────────────────────────────────
  Persona P0: "Add Bottle form submits without feedback"
  → Possible root cause: [audit HIGH] src/routes/wines.js — missing
    try/catch on POST handler. Unhandled promise rejection would cause
    silent redirect without error signal.
    Detail: "addWine() has no error boundary; fetch() rejection is
    swallowed instead of surfacing to UI"

  Persona P1: "Search has no loading state"
  → No matching audit finding — this is a pure UX state gap, not a
    code logic issue.

Note: correlations are keyword-matched — verify before assuming causation.
```

## Persona Debrief (Phase 5b)

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  PERSONA DEBRIEF — first-time wine collector on mobile (iPhone 13)
  [Written in first person as the persona]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

I've been collecting wine for about two years — mostly small producers,
nothing serious, just enough that my shelf needs a spreadsheet. A friend
mentioned this app, so I tried it on my phone walking home from the shop.

My first impression was good. The landing page was clean and didn't
overload me. I could see this was for people who actually drink wine,
not for wine investors. The sign-up only asked me for the essentials
and didn't try to be clever with personality quizzes. I appreciated that.

Then I tried to add my first bottle. I found a 2020 Barbera I'd just
bought, tapped the button, filled in the fields… and when I hit Submit,
nothing happened. The button didn't change, there was no spinner, no
toast. I sat there for what felt like ages, worried I'd lost my typing.
Eventually it just flicked back to my cellar and the bottle was there.
It worked — but it didn't feel like it worked. In the moment I thought
I'd have to retype everything.

That's the kind of moment that makes me lose trust. If I have to retype
a whole bottle on an overcrowded train, I stop using the app. I want
something that tells me — clearly — that it's doing the thing I asked.
Even a greyed-out button with a spinner would be enough.

The search was similar — not broken, just slow without signal. I tapped,
waited, wondered, and the results finally popped in. Small thing, but
when you're trying to find the bottle you just added, a second and a
half of nothing feels long.

On the positive side, the cellar grid looked great. Big photos, clear
varietals, and I could tell at a glance what was ready to drink versus
cellaring. That's exactly the reason I'd open this app — to know which
bottle to pull on a Tuesday night. I found myself wanting to add
"drinking window" notes even though I wasn't asked to.

What I wouldn't use: the tasting notes section felt overbuilt. I'm not
writing a WSET essay. A 3-star rating and "would buy again?" would cover
95% of what I'd ever want to record. Anything more detailed is for
someone else, not me.

What would drive me away: repeatedly losing entries because the app
didn't signal success. If the Add-Bottle feedback isn't fixed, I'd use
this once and delete it.

What would delight me: a clear "drink or wait?" indicator on each card
— backed by the actual drinking window, not just a guess. Even a colour
dot would do it. I'd open the app daily for that.

If this were my call, the priorities are simple:
  1. Fix the Add-Bottle feedback — no more silent submits.
  2. Add a drink-or-wait colour dot per card.
  3. Shrink the tasting-notes section to the 3-star + "buy again?"
     minimum. Keep the detail view for people who want it; don't put
     it in my face every time.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## Notes on emitting this shape

- The two fences are required — `PERSONA TEST REPORT` and `PERSONA DEBRIEF`.
- Findings are sorted P0 first, ties by confidence descending.
- `AUDIT CORRELATIONS` is omitted entirely when no audit DB is configured
  or no P0/P1 findings exist.
- The debrief is 400–700 words; don't collapse it into bullets.
