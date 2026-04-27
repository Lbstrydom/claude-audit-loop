# CLAUDE.md — Fence Test Addendum

@./AGENTS.md

## Claude Code-only Notes

Inside a code block we mention a non-allowlist heading, but it should be ignored:

```markdown
## Architecture

This text inside a fence must NOT trigger a non-allowlist-heading finding,
nor should the heading match `## Architecture` from AGENTS.md for drift
purposes — the drift checker should treat fenced content as opaque.
```

Real text outside the fence continues here.
