---
summary: Canonical 30-line CLAUDE.md template after AGENTS.md flip.
---

# Example: Slim CLAUDE.md (~30 lines)

This is the canonical shape of a slim CLAUDE.md after flipping to
AGENTS.md-canonical. Copy as a starting template.

```markdown
# CLAUDE.md — Claude Code-Specific Addendum

@./AGENTS.md

> **Shared project context lives in [AGENTS.md](./AGENTS.md).** That's the
> canonical file — both Claude and other coding agents (Copilot, Cursor,
> Windsurf, Codex CLI) read it. Edit shared rules there, not here. This file
> holds Claude Code-only material that doesn't apply to other agents.

## Claude Code-only Notes

### Windows MCP override (Playwright)

If Playwright MCP tools don't appear in Claude Code after installing Chromium
and restarting, add this to `~/.claude/settings.json`:

\`\`\`json
"mcpServers": {
  "playwright": {
    "command": "npx.cmd",
    "args": ["@playwright/mcp@latest", "--headless"]
  }
}
\`\`\`

### Memory & the `#`-key

During a Claude Code session, press `#` to have Claude auto-incorporate
learnings into memory. Default target: **AGENTS.md** (canonical, shared with
teammates). Only use this CLAUDE.md for learnings that are genuinely
Claude-specific.

Auto-memory directory: `~/.claude/projects/<repo-slug>/memory/`
```

Notes:
- Length target: ≤80 lines (default `maxClaudeMdLines` cap).
- All h2 headings must be in the allowlist (default includes "Claude Code-only Notes").
- The `@./AGENTS.md` import is required within the first 30 lines.
