# Plan: Phase H — Public-Distribution Hardening

- **Date**: 2026-04-05
- **Status**: Draft (follows Phase G)
- **Author**: Claude + Louis
- **Parent**: [skill-bundle-mega-plan.md](./skill-bundle-mega-plan.md)
- **Depends on**: Phase G complete (pluggable adapters shipped)
- **Scope**: supply-chain integrity, signed checksums, release channels, security audit, first public launch. No new runtime features — release-engineering + security.

---

## 1. Context

Phases E/F/G built the skill bundle, install infrastructure, and pluggable
storage. Phase H makes the repo safe + trustworthy for public consumption.

The current distribution model (Phase F) fetches scripts from GitHub raw URLs
and executes them — trusting the `main` branch implicitly. For a few users this
is fine; for public distribution we need supply-chain integrity so consumers
can verify what they're running.

### Key Requirements

1. **Signed checksums** — every release publishes a signed SHA manifest as a GitHub Release asset
2. **Release channels** — `main` (latest, unverified) vs `stable` (tagged, verified)
3. **Checksum verification in installer + bootstrap** — fetch checksums, verify downloaded scripts, fail if mismatch
4. **Security audit** — env var handling, secret patterns, CODEOWNERS defaults, dependency vulnerabilities
5. **Community docs** — SECURITY.md, CONTRIBUTING.md, CODE_OF_CONDUCT.md
6. **Automated release workflow** — GitHub Action cuts tagged releases with checksums

### Non-Goals

- npm package publishing (GitHub raw URLs remain the distribution channel)
- Code signing via GPG/Sigstore (future — simple SHA manifest is enough for v1)
- Reproducible builds (scripts are plain JS, no build step)
- CVE scanning integration (GitHub's default Dependabot is enough for v1)
- Legal review of licensing (MIT assumed, operator confirms)

---

## 2. Proposed Architecture

### 2.1 Release Channels

Two channels, two URL paths in consumer installers:

| Channel | URL base | Use case | Verification |
|---|---|---|---|
| `main` | `raw.githubusercontent.com/Lbstrydom/claude-engineering-skills/main/...` | Latest, bleeding-edge | None (trust the branch) |
| `stable` | `raw.githubusercontent.com/Lbstrydom/claude-engineering-skills/stable/...` OR release-tag-specific URLs | Production-grade | Checksum manifest verified |

Consumers choose via `--channel main|stable` flag on installer. Default is
`stable` for production installs, `main` for dev/testing.

**Release cadence**: `stable` branch updated by automated workflow when a new
tag is pushed (e.g., `v1.0.0`, `v1.1.0`). Between releases, `main` is ahead.

### 2.2 Signed Checksum Manifest

**Published with each release** as a GitHub Release asset:

```
claude-engineering-skills-v1.0.0/
├── checksums.json          # canonical manifest of all file SHAs
├── checksums.json.sig      # detached signature (GitHub-provided via workflow)
└── skills-bundle.tar.gz    # archived skills/ directory for offline install
```

**`checksums.json` structure**:

```json
{
  "version": "v1.0.0",
  "releasedAt": "2026-05-15T12:00:00Z",
  "bundleVersion": "a3bc12de4f56-20260515",
  "files": {
    "skills/audit-loop/SKILL.md": "sha256-abc1234...",
    "skills/plan-backend/SKILL.md": "sha256-def5678...",
    "scripts/install-skills.mjs": "sha256-...",
    "scripts/check-skill-updates.mjs": "sha256-...",
    "scripts/lib/stores/noop-store.mjs": "sha256-...",
    "skills.manifest.json": "sha256-..."
  }
}
```

**How signing works** (v1 simple approach):
- GitHub Actions workflow with `id-token: write` permission generates a cosign-like signature OR uses GitHub's native release signing
- Signature published alongside manifest
- Installer verifies signature via GitHub's published public key

**Fallback if signing too complex for v1**: publish raw SHA256 manifest without
signature, rely on GitHub's TLS + repo verification as trust root. Signature
can be added post-v1.

### 2.3 Checksum Verification in Installer

`scripts/install-skills.mjs` gains a `--verify` flag (default ON for `stable`
channel, default OFF for `main`):

**Flow**:
1. Before any file write, fetch `checksums.json` from the release (or `stable` branch)
2. If `--channel stable` → also fetch `checksums.json.sig`, verify signature
3. For each file to be written: fetch content, compute SHA256, compare to manifest
4. On mismatch: **abort install**, exit 1 with specific file + expected/actual SHAs
5. Only proceed with install if all checksums verify

**Consumer-facing flag**: `--no-verify` to opt out (explicit). Never silent.

**Bootstrap cache verification**: same pattern in `.audit-loop/bootstrap.mjs` —
before executing a cached script, verify its SHA matches the last-known-good
manifest. Stale cache with wrong SHA → re-fetch from remote.

### 2.4 Automated Release Workflow

**New file**: `.github/workflows/release.yml`

Triggers on push of semver tags (`v*.*.*`). Steps:

1. Build canonical `skills-bundle.tar.gz` from `skills/` directory
2. Compute SHA256 of every file in `skills/` + `scripts/` + `skills.manifest.json`
3. Write `checksums.json` with all SHAs
4. Sign manifest (GitHub OIDC → cosign-equivalent)
5. Create GitHub Release with: tarball, checksums.json, checksums.json.sig
6. Update `stable` branch to point at the tagged commit (`git branch -f stable <tag>`)
7. Push `stable` branch

**Manual release trigger**: `workflow_dispatch` for on-demand releases. Louis
cuts a release by running the workflow or pushing a tag.

**Release notes**: auto-generated from commit messages between previous tag
and current tag, published in the GitHub Release description.

### 2.5 Security Audit + Documentation

**Security audit checklist** (one-pass before first public release):

- [ ] No API keys, tokens, or personal refs in committed code (search `grep` for common shapes)
- [ ] `.env.example` has placeholders only (already done)
- [ ] Every shell-exec uses `execFileSync` with argv arrays (no shell strings, already enforced in Phase C linter)
- [ ] Secret-pattern scanner coverage includes all common keys (Phase D.2)
- [ ] CODEOWNERS defaults set to `@Lbstrydom` for all paths
- [ ] Dependabot enabled for npm + GitHub Actions
- [ ] `package.json` has no `postinstall` scripts that execute fetched code
- [ ] Installer uses `execFileSync` for git/gh commands, never shell-interpolated user input
- [ ] All URLs baked into code point to the public renamed repo (no leftover `claude-audit-loop` refs)
- [ ] Test fixtures use synthetic values (no AWS docs values, no real-format tokens — already done)

**Community documentation** (new files):

| File | Content |
|---|---|
| `SECURITY.md` | How to report vulnerabilities (email or GitHub private advisory), supported versions, response SLA |
| `CONTRIBUTING.md` | Dev setup, test commands, PR process, skill authoring guidelines |
| `CODE_OF_CONDUCT.md` | Contributor Covenant v2.1 (standard) |
| `LICENSE` | MIT (operator confirms) |
| `.github/ISSUE_TEMPLATE/bug_report.md` | Bug template |
| `.github/ISSUE_TEMPLATE/feature_request.md` | Feature template |
| `.github/PULL_REQUEST_TEMPLATE.md` | PR checklist incl. tests + audit-loop run |

### 2.6 Dependabot + Security Scanning

`.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "weekly"
```

GitHub's native secret scanning + code scanning alerts enabled via repo
settings (manual action, one-time).

### 2.7 Public Launch Checklist

Separate from the technical implementation — a launch runbook:

- [ ] Verify all docs/setup/*.md walkthroughs work end-to-end on clean machines
- [ ] Clean Supabase project (remove any smoke-test data)
- [ ] Update repo description + topics on GitHub
- [ ] Enable GitHub Discussions for community Q&A
- [ ] Write launch blog post / README top-banner
- [ ] Set up `stable` branch at v1.0.0
- [ ] Announce via whatever channels make sense

---

## 3. File Impact Summary

**New files**:

| File | Purpose |
|---|---|
| `.github/workflows/release.yml` | Automated tagged-release workflow |
| `.github/dependabot.yml` | Weekly dep updates |
| `.github/ISSUE_TEMPLATE/*.md` | Bug + feature templates |
| `.github/PULL_REQUEST_TEMPLATE.md` | PR checklist |
| `SECURITY.md` | Vulnerability reporting + supported versions |
| `CONTRIBUTING.md` | Dev + contribution guide |
| `CODE_OF_CONDUCT.md` | Contributor Covenant 2.1 |
| `LICENSE` | MIT |

**Modified files**:

| File | Change |
|---|---|
| `scripts/install-skills.mjs` | Add `--channel`, `--verify`, `--no-verify` flags |
| `scripts/lib/bootstrap-template.mjs` | Cache verification before execution |
| `scripts/check-skill-updates.mjs` | Honor release channel |
| `README.md` | Add security section, channel selection, verification flow |
| `CODEOWNERS` | Default owners for all paths |

**No changes to**: skills content, existing scripts beyond flag additions,
storage adapters, tests (new Phase H tests added separately).

---

## 4. Testing Strategy

### Unit Tests

| Test | Validates |
|---|---|
| Checksum verification: manifest match → install proceeds | Positive case |
| Checksum verification: manifest mismatch → install aborts | Safety |
| Checksum verification: missing manifest + `--channel stable` → fail | Channel policy |
| `--no-verify` on stable channel logs warning, proceeds | Override semantics |
| Bootstrap cache verification: stale SHA → re-fetch | Cache integrity |
| Release workflow YAML syntax valid | Workflow correctness |
| `checksums.json` format validates against Zod schema | Manifest integrity |

### Integration Tests

- Fake GitHub Release with bad checksum → installer aborts
- Fake GitHub Release with valid checksum → installer succeeds
- `--channel main` bypasses checksum verification (with log warning)
- Stable channel URL resolves to latest tag

### Release Workflow Dry-Run

Before cutting v1.0.0, run the workflow against a throwaway tag (`v0.9.0-rc`)
to verify:
- Tarball builds correctly
- Checksums.json generated
- Signature valid
- `stable` branch updated

### Manual Pre-Launch Verification

- Fresh clone + install on Linux, macOS, Windows (3 machines)
- Verify each documented `docs/setup/*.md` walkthrough actually works
- Verify `gh repo view` shows correct name, description, topics
- Verify Dependabot + secret scanning enabled

---

## 5. Rollback Strategy

- **Bad release**: delete the GitHub Release + tag; `stable` branch auto-reverts to previous tag on next successful release
- **Bad checksum verification**: `--no-verify` flag lets consumers unblock; root cause fixed in subsequent release
- **Bad workflow**: disable the workflow, cut releases manually until fixed

All Phase H additions are documentation + release infrastructure. No runtime
code changes that would require application-level rollback.

---

## 6. Implementation Order

1. **Security audit checklist** — run through items in §2.5, fix anything found. May spawn sub-tasks.
2. **Community docs** — SECURITY, CONTRIBUTING, CODE_OF_CONDUCT, LICENSE, ISSUE_TEMPLATEs, PULL_REQUEST_TEMPLATE. Zero code, high leverage.
3. **Dependabot config** — `.github/dependabot.yml`. Enable in repo settings.
4. **Release workflow** — `.github/workflows/release.yml` (tarball + checksums + signing + release). Test against `v0.9.0-rc` throwaway tag.
5. **Checksum verification in installer** — `--verify` flag, manifest fetch, SHA compare, abort on mismatch. Tests.
6. **Bootstrap cache verification** — verify cached scripts against last-known-good before execution. Tests.
7. **Release channels** — `--channel stable|main` flag, URL resolution per channel. Tests.
8. **README public-facing rewrite** — security section, channel explanation, verification flow, install commands for both channels.
9. **Manual pre-launch verification** — fresh installs on 3 OSes, walkthrough each setup guide.
10. **Cut v1.0.0** — tag, workflow runs, `stable` branch updated, GitHub Release published.
11. **Public launch** — GitHub Discussions enabled, blog post / top-banner, topics set.

---

## 7. Known Limitations (accepted for Phase H)

1. **GPG / Sigstore full crypto** — v1 uses GitHub-OIDC-backed signing OR plain SHA256 manifest. Full Sigstore integration is future-phase.
2. **Reproducible builds** — scripts are plain JS, no build step, so "reproducibility" is trivial. Tarball contents may vary by 1 byte (timestamp metadata) between re-runs of the release workflow; not a real concern.
3. **No supply-chain attestations (SLSA)** — future-phase.
4. **Dependabot is our only vuln scanner** — GitHub's built-in, not a dedicated SAST tool.
5. **Manual launch checklist** — not automated. Low-frequency activity, manual is fine.
6. **License compatibility audit** — operator confirms MIT is appropriate; no automated dep-license auditing in Phase H.
7. **Public issue triage SLA** — none committed; `SECURITY.md` documents best-effort response.

---

## 8. Resolved Design Decisions

| # | Question | Decision | Why |
|---|---|---|---|
| Q1 | Signing scheme? | v1: SHA256 manifest + GitHub OIDC signature OR plain SHA256 if OIDC too complex | Keeps v1 shippable; Sigstore is a future improvement |
| Q2 | Distribution channel? | GitHub raw URLs + GitHub Releases (no npm) | Matches existing Phase F pattern |
| Q3 | Release channels? | `main` (latest) + `stable` (tagged) | Two-tier is standard; covers dev + prod use cases |
| Q4 | Default channel for consumers? | `stable` for production, `main` for dev/testing | Safe default, explicit override |
| Q5 | License? | MIT | Standard permissive open-source; operator confirms |
| Q6 | CVE scanning? | Dependabot only in v1 | GitHub-native, zero config |
| Q7 | Community code? | Adopt Contributor Covenant 2.1 | Industry standard |
| Q8 | Verification mandatory on `stable`? | Default ON, `--no-verify` opt-out | Safe-by-default |
| Q9 | Release cadence? | On-demand + automated on tag push | Louis controls cadence |
| Q10 | Launch announcement? | Manual — blog post + repo banner + GitHub Discussions | Low-volume, high-touch |
