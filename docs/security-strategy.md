# Security Strategy

> Source-of-truth for proactive security memory. Indexed by
> `npm run security:refresh` into Supabase `security_incidents`, then
> consulted by `/plan` Phase 0.5c whenever planning touches paths that
> historically had security issues.
>
> **Lifecycle**: this file is created empty when the repo opts in to
> security memory and is populated incrementally by the
> `/security-strategy` skill (`bootstrap` for the threat model + first
> incidents; `add-incident` thereafter). Refresh treats it as the
> authoritative inventory of *known* incidents — anything not present
> here gets swept to `historical` on the default branch (sweep is gated
> behind a clean parse — see `scripts/security-memory/refresh-incidents.mjs`).

## Threat model

<!-- Filled in by `/security-strategy bootstrap`. Describe: who attacks
this repo, what assets matter, which trust boundaries exist, which
classes of bug are unacceptable. Keep it tight — 5–10 sentences. -->

_(no threat model recorded yet — run `/security-strategy bootstrap`)_

## Incidents

<!-- Each incident is a markdown block bounded by HTML comment markers.
Keep them in chronological order, oldest first.

Required fields: id (in the start marker) + Description.
Optional fields: Affected paths, Mitigation, Lessons learned.

Mitigation forms recognised by parse-strategy.mjs:
  - semgrep:my-local-rule           → semgrep/my-local-rule.yml
  - semgrep:p/owasp-top-ten         → registry ruleset
  - semgrep:r/python.lang.security…  → registry rule
  - scripts/path/to/check.mjs       → file-ref (manual verification)
  - manual                          → human-only verification
-->

_(no incidents recorded yet — run `/security-strategy add-incident` after the next post-mortem)_
