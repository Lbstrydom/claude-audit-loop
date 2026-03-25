# Claude Audit Loop

A self-driving **plan → audit → deliberate → fix → re-audit** loop that uses your **AI coding assistant** (Claude, Copilot, etc.) for planning and fixing, and **GPT-5.4** as an independent auditor. The two models operate as **peers** — neither blindly defers to the other.

Works with **any codebase, any AI assistant**. No hardcoded paths or project-specific config — the script adapts to your project size automatically.

## Supported Environments

| Environment | Skill Location | How to Invoke |
|-------------|---------------|---------------|
| **Claude Code** (CLI or VS Code) | `.claude/skills/audit-loop/` | `/audit-loop plan docs/plans/X.md` |
| **VS Code Copilot** | `.github/skills/audit-loop/` | `/audit-loop` in Copilot Chat |
| **Any terminal** | N/A | `node scripts/openai-audit.mjs plan <file>` |

## Quick Start

### Option A: Automated Setup (Recommended)

```bash
git clone https://github.com/Lbstrydom/claude-audit-loop.git
cd claude-audit-loop
node setup.mjs --target /path/to/your/project
```

The setup script will:
1. Check Node.js 18+, npm, git
2. Install dependencies (`openai`, `zod`, `dotenv`) if missing
3. Copy `scripts/openai-audit.mjs` to your project
4. Install skills for both Claude Code AND VS Code Copilot
5. Set up `.env` with your OpenAI API key
6. Add `.env` to `.gitignore`

### Option B: Manual Setup

```bash
# 1. Copy files into your project
cp scripts/openai-audit.mjs <your-project>/scripts/
mkdir -p <your-project>/.claude/skills/audit-loop
cp .claude/skills/audit-loop/SKILL.md <your-project>/.claude/skills/audit-loop/
mkdir -p <your-project>/.github/skills/audit-loop
cp .github/skills/audit-loop/SKILL.md <your-project>/.github/skills/audit-loop/

# 2. Install dependencies
cd <your-project>
npm install openai zod dotenv

# 3. Add API key to .env
echo "OPENAI_API_KEY=sk-..." >> .env
```

## How It Works

```
┌──────────────────────────────────────────────────────────┐
│  Your AI assistant creates/updates plan or code           │
└──────────┬───────────────────────────────────────────────┘
           ▼
┌──────────────────────────────────────────────────────────┐
│  GPT-5.4 audits independently (multi-pass, parallel)      │
│                                                            │
│  Wave 1: Structure + Wiring    (reasoning: low)  ~25s     │
│  Wave 2: Backend + Frontend    (reasoning: high) ~90-170s │
│  Wave 3: Sustainability        (reasoning: medium) ~90s   │
└──────────┬───────────────────────────────────────────────┘
           ▼
┌──────────────────────────────────────────────────────────┐
│  AI assistant deliberates on each finding:                │
│    ✅ ACCEPT — fix as recommended                         │
│    🔄 PARTIAL ACCEPT — problem real, but better fix       │
│    ❌ CHALLENGE — finding is wrong (cites evidence)       │
└──────────┬───────────────────────────────────────────────┘
           ▼ (challenged findings only)
┌──────────────────────────────────────────────────────────┐
│  GPT-5.4 deliberation round:                              │
│    🔴 SUSTAIN — GPT holds, assistant must fix             │
│    🟢 OVERRULE — assistant was right, finding dismissed   │
│    🟡 COMPROMISE — modified recommendation                │
└──────────┬───────────────────────────────────────────────┘
           ▼
│  Fix surviving findings → re-audit → repeat (max 4 rounds)│
│  Converges: 0 HIGH, ≤2 MEDIUM, 0 quick-fix warnings      │
└──────────────────────────────────────────────────────────┘
```

## Usage

### With Claude Code (CLI or VS Code Extension)

```bash
/audit-loop plan docs/plans/my-feature.md     # Audit plan quality iteratively
/audit-loop code docs/plans/my-feature.md     # Audit code against plan
/audit-loop full add user authentication      # Plan → audit → implement → audit code
/audit-loop add a REST API for notifications  # Plan → audit loop
```

### With VS Code Copilot Chat

Type `/audit-loop` in Copilot Chat, then describe what you want:

```
/audit-loop audit the plan at docs/plans/my-feature.md
/audit-loop audit code against docs/plans/my-feature.md
/audit-loop plan and audit a new REST API for notifications
```

Copilot will use the `.github/skills/audit-loop/SKILL.md` skill to orchestrate the loop,
running `scripts/openai-audit.mjs` in the terminal for each GPT-5.4 audit pass.

### Without Any AI Assistant (Script Only)

```bash
# Audit a plan
node scripts/openai-audit.mjs plan docs/plans/my-feature.md

# Audit code against a plan
node scripts/openai-audit.mjs code docs/plans/my-feature.md

# JSON output for piping to other tools
node scripts/openai-audit.mjs plan docs/plans/my-feature.md --json

# Send rebuttals for GPT deliberation
node scripts/openai-audit.mjs rebuttal docs/plans/my-feature.md rebuttal.md --json
```

## What It Checks

### Plan Audits
- SOLID principles (all 5), DRY, modularity, no dead code, no hardcoding
- Long-term sustainability — will this design accommodate change in 6 months?
- Specificity — can a developer implement from this plan without guessing?
- Gestalt principles (frontend) — proximity, similarity, continuity, closure
- State coverage — loading, error, empty states specified?
- Data flow — traceable end-to-end (UI → API → Service → DB)?
- Vague language detection — flags "as needed", "TBD", "handle appropriately"

### Code Audits (5 Parallel Passes)

| Pass | Focus | Reasoning | Time |
|------|-------|-----------|------|
| **Structure** | Files exist? Exports match plan? | low | ~25s |
| **Wiring** | Frontend API calls ↔ backend routes | low | ~25s |
| **Backend** | SOLID, DRY, async/await, security, N+1 | high | ~90-170s |
| **Frontend** | Gestalt, CSP, accessibility, states | high | ~90-170s |
| **Sustainability** | Quick fixes, dead code, coupling | medium | ~90s |

### Quick-Fix Detection
Every finding has an `is_quick_fix` flag. Band-aid solutions are flagged and rejected — both models enforce sustainable fixes only.

## Adaptive Sizing

The script sizes token limits and timeouts to your codebase — no tuning needed:

| Codebase Size | Files | Max Tokens | Timeout |
|--------------|-------|-----------|---------|
| Tiny | 3 | ~4,500 | 60s |
| Small | 8 | ~7,000 | 77s |
| Medium | 15 | ~12,000 | 110s |
| Large | 25+ | ~19,000 | 157s |

If a backend has >12 files, it auto-splits into routes + services sub-passes.

## Graceful Degradation

If any pass fails (timeout, token limit, API error):
- Other passes continue normally (no crash)
- `_failed_passes` in JSON output shows what failed
- The skill prompts you with recovery options (re-run with lower reasoning, continue with partial results, or split further)

## Project Structure

```
claude-audit-loop/
├── scripts/
│   └── openai-audit.mjs               # GPT-5.4 multi-pass audit script
├── .claude/
│   └── skills/audit-loop/SKILL.md      # Claude Code skill
├── .github/
│   └── skills/audit-loop/SKILL.md      # VS Code Copilot skill
├── setup.mjs                           # Interactive installer
├── .env.example                        # Env var template
├── package.json
└── README.md
```

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `OPENAI_API_KEY` | (required) | Your OpenAI API key |
| `OPENAI_AUDIT_MODEL` | `gpt-5.4` | GPT model for auditing |
| `OPENAI_AUDIT_REASONING` | `high` | Reasoning effort: low/medium/high/xhigh |
| `OPENAI_AUDIT_MAX_TOKENS` | `32000` | Hard ceiling — output tokens per pass |
| `OPENAI_AUDIT_TIMEOUT_MS` | `300000` | Hard ceiling — timeout per pass (ms) |
| `OPENAI_AUDIT_SPLIT_THRESHOLD` | `12` | Backend file count that triggers splitting |

## Peer Deliberation Model

Unlike traditional linting, this system treats the AI assistant and GPT-5.4 as **equals**:

- **Your assistant has codebase context** — knows conventions, patterns, project history
- **GPT-5.4 has fresh eyes** — catches blind spots from familiarity bias
- **Deliberation is final** — once GPT rules on a challenge, that ruling is accepted

Research shows multi-model adversarial review catches **80% of bugs** vs 53% for single-model review (27 percentage point improvement).

## Related Projects

This tool was inspired by and builds on ideas from:

| Project | What It Does | What We Learned |
|---------|-------------|-----------------|
| [adversarial-review](https://github.com/alecnielsen/adversarial-review) | Multi-agent debate (Claude + GPT Codex) | Adversarial structure prevents consensus bias |
| [claude-review-loop](https://github.com/hamelsmu/claude-review-loop) | Claude implements → Codex reviews | Hook-based two-phase lifecycle |
| [desloppify](https://github.com/peteromallet/desloppify) | Mechanical + LLM hybrid detection | Queue-based fix prioritization |
| [ralphex](https://github.com/umputun/ralphex) | Multi-agent parallel review | 5 specialized agents in parallel |
| [heavy3 code-audit](https://github.com/heavy3-ai/code-audit) | Multi-model consensus validation | Consensus catches what single models miss |

**Key differentiators of this tool:**
- **Peer deliberation** — not just audit, but structured accept/challenge/compromise
- **Multi-pass parallel** — 5 focused passes instead of one monolithic call
- **Adaptive sizing** — works on any codebase without configuration
- **Quick-fix rejection** — both models enforce sustainable solutions
- **Portable** — works with Claude Code, VS Code Copilot, or raw terminal

## License

MIT
