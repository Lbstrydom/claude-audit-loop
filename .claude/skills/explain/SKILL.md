---
name: explain
description: |
  Explain WHY a piece of code is structured the way it is. Synthesises
  architectural-memory similar-symbols, git history (blame + commits +
  PR context), AGENTS.md/CLAUDE.md principles, and any plan documents
  that mention the target. Useful for onboarding ("why is this here?"),
  debugging ("why is X structured this way and not Y?"), and refactoring
  ("can I change this safely or is there hidden context?").
  Triggers on: "why is this", "explain this code", "why does this exist",
  "what is this for", "/explain", "give me context on".
  Usage: /explain <file>                       — Explain the file's purpose + history
  Usage: /explain <file>:<line>                — Explain a specific line/section
  Usage: /explain <symbol-name>                — Find + explain a function/class by name
  Usage: /explain <file>:<line> --depth=full   — Include full neighbourhood + all blame
---

# Code Explainer

Multi-source synthesiser for "why is this here?" questions. Given a
target (file, file:line, or symbol name), gathers context from four
sources and produces one coherent explanation.

**This skill does NOT modify code.** Read-only — gathers + synthesises.

---

## Step 0 — Parse Target

Input shapes:

| Input | Action |
|---|---|
| `<file>` (e.g., `scripts/openai-audit.mjs`) | Whole-file mode — explain purpose + history |
| `<file>:<line>` (e.g., `scripts/openai-audit.mjs:412`) | Section mode — explain the symbol containing that line |
| `<symbol-name>` (e.g., `runMultiPassCodeAudit`) | Symbol mode — find the file:line via architectural-memory + Grep, then explain |

Validate the file exists. If symbol mode + symbol not found, exit with
"Symbol '<name>' not found in repo via architectural-memory or grep —
narrow the query (try `<file>:<line>`)."

---

## Step 1 — Gather Architectural-Memory Context

If `cross-skill.mjs` exists in the repo and Supabase is configured:

```bash
node scripts/cross-skill.mjs get-neighbourhood --json '{
  "targetPaths": ["<file>"],
  "intentDescription": "Understand the purpose and shape of <symbol-or-file>",
  "k": 6
}'
```

Use the result to:
- Identify **what this symbol does** (the `purposeSummary` of the matching record)
- Identify **near-duplicates** — sibling symbols solving similar problems (this is critical context: "you might think this is unique but here are 3 similar ones")
- Identify **recommended uses** — if the matched record's recommendation is `reuse`, that's a signal this is the canonical version of a pattern

If Supabase is offline → skip this step and note `[arch-memory: unavailable]` in the output.

---

## Step 2 — Gather Git History

```bash
# Who wrote it + when (last 5 lines of context if line is specified)
git blame -L <line>,<line>+5 <file>

# When the file was created + changed (last 10 commits)
git log --oneline -10 -- <file>

# Recent commits that touched the symbol (if line known)
git log -L <line>,<line>+10:<file> --oneline | head -10

# PR context (if gh CLI available)
LAST_COMMIT=$(git log -1 --format=%H -- <file>)
gh api "repos/{owner}/{repo}/commits/$LAST_COMMIT/pulls" --jq '.[].title' 2>/dev/null
```

Extract:
- **Author + date** of the most recent change to this section
- **Commit message** that introduced the section (often has the WHY)
- **PR title** if available (often has the requirement / bug context)
- **Co-evolution** — files frequently changed together (signals coupling)

---

## Step 3 — Find Principle Citations

Search AGENTS.md, CLAUDE.md, and any docs/plans/*.md for mentions of:
- The file path
- The symbol name
- Patterns this code uses (e.g., "single source of truth", "graceful degradation" — these often have explicit citations near the relevant code)

```bash
grep -rn "<symbol-name>\|<file>" AGENTS.md CLAUDE.md docs/plans/ 2>/dev/null | head -20
```

Look specifically for:
- Plans that planned this code (often explain WHY a particular design)
- "Accepted Technical Debt" entries (explain what compromises were made)
- "Do NOT" rules (explain the discipline being enforced)

---

## Step 4 — Read the Code Itself

Read the target file (or the symbol's enclosing function/class). Look for:
- **Doc comments** — explicit author intent
- **Type signatures** — what contract is being enforced
- **Imports** — what this depends on
- **Surrounding code** — how it's called

For section mode (file:line): read 30 lines of context around the target line.

---

## Step 5 — Synthesise

Produce a single Markdown response with these sections (omit any that
have no data):

```markdown
## What it is

One sentence describing the symbol/file purpose.

## Why it exists (history)

- Created **YYYY-MM-DD** by **<author>** in commit `abc1234` ("commit message")
- Most recent substantive change: **YYYY-MM-DD** by **<author>** ("commit message")
- Originating PR: #N "<title>" (if known)
- Co-evolved with: <files frequently changed together>

## Why this shape (architectural context)

- Plan: `docs/plans/<plan-file>.md` motivated this design (cite the relevant section)
- Principle citations from AGENTS.md / CLAUDE.md: <list>
- Architectural-memory ranking: this is the **canonical** version of <pattern> / OR a **sibling** to <other symbols>
- Accepted technical debt: <relevant entries from AGENTS.md "Accepted Technical Debt">

## Near-duplicates / related code

If architectural-memory found similar symbols, list them with similarity scores:

| Sim | Symbol | Path | Purpose |
|---|---|---|---|
| 0.85 | `<other>` | `path:line` | <purpose> |

Note explicitly whether this is the canonical version or an alternate.

## Safe-change advice

Based on coupling + plan + principles:
- **Safe to change** (low coupling, no plan citations) — list any tests that will catch regressions
- **Change with care** (cited in plan, has near-duplicates) — list the plan section to update + sibling symbols to reconcile
- **Do not change without re-planning** (load-bearing per plan, frequently co-changed with multiple files) — recommend running `/plan` for the proposed change first

## Sources used

- arch-memory: <yes/no>
- git blame: <N lines>
- git log: <N commits>
- AGENTS.md/CLAUDE.md: <N matches>
- docs/plans/*.md: <N matches>
- file read: <bytes>
```

Keep the response under ~600 words. If a section is empty (e.g., no plan
mentions), omit it rather than padding.

---

## Output rules

- **Read-only** — never edit, never commit, never trigger workflows
- **Cite sources** — every claim must be traceable to one of the four sources
- **No speculation** — if the WHY isn't in any source, say "no recorded reason" rather than guessing
- **Useful for next action** — the "Safe-change advice" section is the most actionable part; make it specific
- **Cost is small** — at most 1 architectural-memory consultation (~$0.0003) + git operations (free) + 1 file read

---

## Reference files

This skill is a multi-source synthesiser — there are no references. All
data comes from the repo + architectural-memory + git, gathered fresh
each invocation.
