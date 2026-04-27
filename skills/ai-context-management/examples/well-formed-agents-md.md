---
summary: 100-150 line AGENTS.md exemplar with reasoned rules and standard sections.
---

# Example: Well-Formed AGENTS.md

A canonical AGENTS.md should be 100-150 lines (Augment Code's empirically
optimal range), with longer detail extracted to references. Each rule has
a `Reason:` line.

```markdown
# AGENTS.md — <Project Name>

> **Canonical project context for all AI coding agents.** Read by Claude Code,
> Copilot, Cursor, Windsurf, Codex CLI, Gemini CLI.

## Project Overview

**Purpose**: <one-sentence purpose>
**Runtime**: <stack and version>
**Status**: <production / beta / WIP>

## Build & Test

\`\`\`bash
npm install
npm run build
npm test
\`\`\`

## Architecture

<2-3 paragraphs on module layout, key flows, data path>

## Coding Rules

- Use functional components only.
  Reason: codebase uses React hooks throughout; class components can't use them.
- All API responses go through the Zod validation layer at the boundary.
  Reason: prevents type drift between server and client.
- No \`any\` types. Use \`unknown\` and narrow.
  Reason: <past incident> demonstrated silent type breakage in production.

## Forbidden patterns

- Do NOT use \`fs.readFile\` synchronously in request handlers.
- Do NOT add new dependencies without updating both `package.json` and the
  Dependencies table below.

## Dependencies

| Package | Version | Notes |
|---|---|---|
| react | 19.0.0 | Concurrent features required for our scheduler |
| zod | 4.0.0 | Zod 4 API — `_def.type` not `_def.typeName` |

## Environment Variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | Yes | — | Postgres connection string |
| `LOG_LEVEL` | No | `info` | Logging verbosity |

## Gotchas

- \`/api/v1/users\` was renamed to \`/api/v2/users\` in commit \`abc123\`.
  Reason: v1 still exists for legacy clients but is deprecated.
- The `users.created_at` column is **UTC**, not local time.
  Reason: legacy migration left a mix until 2026-Q1.
```

Notes:
- Every "rule" includes a `Reason:` line so future readers can judge edge cases.
- Sections you don't need can be omitted — there's no required structure beyond
  what your project genuinely contains.
- Push detail into reference files when AGENTS.md exceeds ~150 lines. Subdirectory
  AGENTS.md is fine for monorepo packages — closest-wins merging is automatic.
