---
name: brainstorm
description: |
  Multi-LLM concept-level brainstorming. Sends the user's topic to OpenAI
  (and optionally Gemini) so the user can compare independent perspectives
  alongside Claude's. Convergence is manual — Claude waits for the user
  to ask for synthesis instead of auto-merging the views.
  Triggers on: "brainstorm", "let's think about", "get other LLMs on this",
  "what would Gemini/GPT say", "/brainstorm".
  Usage:
    /brainstorm <topic>                          # OpenAI only (default)
    /brainstorm --with-gemini <topic>            # both
    /brainstorm --models openai,gemini <topic>   # explicit
disable-model-invocation: true
---

# /brainstorm — Multi-LLM Brainstorming

You're acting as the user's brainstorming partner alongside one or more
external LLMs. Your job is to fetch the other models' views, present them
faithfully, add your own take, then **wait for the user to drive the
conversation**. Do NOT auto-synthesise — that's the whole point of this
skill.

**Input**: `$ARGUMENTS` — `[flags] <topic-or-question>`.

---

## Step 0 — Parse Arguments

Flags:

| Flag | Default | Meaning |
|---|---|---|
| `--with-gemini` | off | Add Gemini alongside OpenAI |
| `--models <csv>` | `openai` | Explicit list (e.g. `openai,gemini`); overrides `--with-gemini` |
| `--openai-model <id>` | `latest-gpt` | OpenAI sentinel or concrete ID |
| `--gemini-model <id>` | `latest-pro` | Gemini sentinel or concrete ID |

Strip flags; remainder is the **topic**. If empty, ask the user what they
want to brainstorm and stop.

---

## Step 1 — Kickoff

Print a single-line kickoff (no resolution lookup — the helper resolves
sentinels and reports back):

```
═══════════════════════════════════════
  /brainstorm — Calling: openai[, gemini]
  Sentinels: openai=latest-gpt | gemini=latest-pro
  Topic: <first 80 chars>...
  Calling providers…
═══════════════════════════════════════
```

---

## Step 2 — Invoke the helper via temp-file stdin

**Write the topic to a repo-local temp file using the `Write` tool**, then
pipe it to the helper. Do NOT use a shell heredoc and do NOT interpolate
the topic into a command string — both are shell-injection / delimiter-collision
risks (Plan v6 §2.1, Gemini-G1 v1+v2).

1. Compute a session ID: `SID=$(date +%s%3N)` (epoch ms) — run via Bash.
2. Use `Write` (Claude tool) to create the file:
   - Path: `.claude/tmp/brainstorm-<SID>.txt`
   - Content: the topic verbatim (no escaping, no transformation)
3. Run the helper with stdin redirected from the file:
   ```bash
   node scripts/brainstorm-round.mjs \
     --topic-stdin \
     --models openai[,gemini] \
     [--openai-model <id>] [--gemini-model <id>] \
     --out /tmp/brainstorm-<SID>.json \
     < .claude/tmp/brainstorm-<SID>.txt
   ```
4. Always clean up:
   ```bash
   rm -f .claude/tmp/brainstorm-<SID>.txt
   ```

The helper exits 0 even when providers fail or are misconfigured — read the
JSON output's per-provider `state` field, not the exit code, to know what
worked. Only exit 1 means an argv error or helper bug; surface that to the
user verbatim.

---

## Step 3 — Render Per-Provider Blocks

Read the JSON from `--out`. For each provider entry, render exactly one
block. Use the resolved model ID from the helper's `resolvedModels` field
in the heading (e.g. `### OpenAI (gpt-5.4)` not `### OpenAI (latest-gpt)`).

State-driven rendering (the helper guarantees one of these states per
provider):

| State | Render |
|---|---|
| `success` | `### <Provider> (<resolved-model>)`<br>`<text verbatim>` |
| `misconfigured` | `### <Provider>`<br>`⚠ Not called: <errorMessage>` |
| `timeout` | `### <Provider> (<resolved-model>)`<br>`⚠ Timeout after <latencyMs>ms. Try again or lower --max-tokens.` |
| `http_error` | `### <Provider> (<resolved-model>)`<br>`⚠ HTTP <httpStatus>: <errorMessage>` |
| `empty` | `### <Provider> (<resolved-model>)`<br>`⚠ Empty response (<errorMessage>).` |
| `malformed` | `### <Provider> (<resolved-model>)`<br>`⚠ Malformed response: <errorMessage>` (path is in errorMessage) |
| `blocked` | `### <Provider> (<resolved-model>)`<br>`⚠ Blocked by safety filter: <errorMessage>` |

If the JSON's `redactionCount > 0`, prepend a single line above the blocks:
> ⚠ Redacted N secret pattern(s) from your topic before sending.

After all provider blocks, render a separator and your own take:

```markdown
---

### Claude (my take)
<your independent perspective — 200–400 words. Don't recap what the others
said; add what they missed or where you disagree.>
```

End with this single line:

> **Your call** — push back, refine the topic, ask me to synthesise, or
> just let the divergence sit. Say `/brainstorm done` (or just stop
> invoking) when you've heard enough.

Then **STOP**. No follow-up actions, no "shall I implement this?", no
proactive synthesis. The user drives.

---

## Step 4 — Synthesis (Only When Asked)

The user will explicitly ask: "synthesise", "converge", "what should I
do", "sum it up", or `/brainstorm done`. When they do:

```markdown
## Synthesis

**Where we agree**: <bullets — only true convergence>
**Where we diverge**: <bullets — and what the divergence reveals>
**Open questions**: <what the user still needs to decide>
**My recommendation**: <one paragraph, opinionated>
**Next concrete step**: <one sentence>
```

---

## Notes

- **Repo-bound in v1** — this skill works only when invoked from a repo
  that has the synced helper bundle (audit-loop, wine-cellar, ai-organiser).
  Standalone install is a v2 task.
- **Cost** — kickoff message includes a pre-call ceiling; final cost is
  in the JSON's `totalCostUsd`. Typical round: $0.001–$0.05.
- **No memory writes** — brainstorming is conversational scaffolding, not
  durable state. Don't save to memory unless the user explicitly says
  "save this".
- **Anti-pattern**: do not rank the LLMs ("Gemini gave the best answer").
  Present them as peers; the user judges.
