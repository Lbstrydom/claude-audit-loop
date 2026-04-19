---
summary: Full browser-tool detection algorithm with tier priority, fallback rules, and Windows caveats.
---

# Browser Tool Detection — Full Protocol

persona-test needs a live browser to drive the app. It supports three tiers
of tools and picks the first that works for the target URL.

## Step 1 — Check the URL hostname

- If `localhost`, `127.0.0.1`, `0.0.0.0`, ends in `.local`/`.internal`, or
  matches a known own-app domain (`*.railway.app`, `*.vercel.app`,
  `*.netlify.app`, `*.up.railway.app`) → skip BrightData entirely and go
  directly to Playwright MCP (Tier 1 below). Log:
  `[OWN APP] Using Playwright — BrightData skipped for own-app hostname`.

- Otherwise (external / third-party URL) → try tools in order below.

## Tier 1: Playwright MCP (preferred for own apps — free, direct)

- Attempt `browser_navigate` from Playwright MCP (`@playwright/mcp`)
- If it responds: `browser_tool = "Playwright MCP"`
- Use for: own apps, localhost, any URL where anti-bot is not needed
- **Prerequisites**: `npx playwright install chromium` must be run once
  before first use. If tools don't appear after restart, this step was
  likely skipped — the server crashes silently when Chromium is missing.
- **Windows caveat**: if Playwright tools still don't appear, add this
  override to `~/.claude/settings.json`:
  ```json
  "mcpServers": {
    "playwright": {
      "command": "npx.cmd",
      "args": ["@playwright/mcp@latest", "--headless"]
    }
  }
  ```
  Then restart Claude Code. Windows requires `npx.cmd` (the `.cmd` wrapper)
  rather than bare `npx` for Claude Code's process spawner to resolve it
  correctly.

## Tier 2: BrightData Scraping Browser (for external / anti-bot sites)

- If Playwright fails and the URL is external, attempt BrightData via the
  `mcp__brightdata__*` tools (`brightdata_scrape_as_markdown`,
  `brightdata_session_open`, etc.)
- Use for: sites with CAPTCHA, anti-bot protection, sites that block
  headless browsers
- Requires a paid BrightData account with KYC approval. If the account
  isn't configured, this tier is unavailable — fall through to Tier 3.

## Tier 3: Native browser tool (fallback)

- If neither MCP is available, attempt the built-in WebFetch tool
- Static-content only — cannot click, type, or take screenshots
- **Persona test quality degrades** — you can read pages but can't drive
  flows. Report at the top of the test output:
  `[DEGRADED MODE] No browser automation available — static analysis only`

## Tier 4: None (error)

If none of the above respond, exit with a clear diagnostic:

```
[BLOCKED] No browser tool available.
  - Playwright MCP: <last error>
  - BrightData: <last error>
  - WebFetch: <last error>
Fix one of the above and retry.
```

## Tool command mapping

| Action | Playwright MCP | BrightData | WebFetch |
|---|---|---|---|
| Navigate | `browser_navigate({url})` | `brightdata_session_open({url})` | `webfetch({url})` |
| Click | `browser_click({selector})` | `brightdata_session_click` | — |
| Type | `browser_type({selector, text})` | `brightdata_session_type` | — |
| Screenshot | `browser_take_screenshot({selector})` | `brightdata_session_screenshot` | — |
| Close | `browser_close()` | `brightdata_session_close` | — |

Log the chosen tool once at the start of the session and use it
consistently — do not mix tool families mid-session.
