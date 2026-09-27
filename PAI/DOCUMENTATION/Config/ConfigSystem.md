# PAI Configuration

PAI uses directly-edited configuration files. There is no template rendering or code generation step — files are what they are.

## Core Files

| File | Purpose | Git Status |
|------|---------|------------|
| `settings.json` | Claude Code runtime config — hooks, permissions, identity, env, notifications, tips | Tracked |
| `CLAUDE.md` | Operational instructions loaded at session start | Tracked |
| `PAI/USER/Config/PAI_CONFIG.yaml` | Credentials store for private skills (HOMEBRIDGE, etc.) | Gitignored |

## How It Works

**Edit directly.** When you need to change hooks, identity, permissions, or any runtime behavior, edit `settings.json` directly. When you need to change operational rules or context routing, edit `CLAUDE.md` — the single top instruction layer.

Changes to `settings.json` and `CLAUDE.md` take effect at the next session start.

## Public Releases

The secunit release system (`PAI/TOOLS/release.ts`) handles sanitization for public releases via **containment**, not filter-based reverse-templating. Pipeline: rsync clone with hard cache exclusions → delete sensitive zones (USER, MEMORY, private underscore-prefixed skills) → overlay fixed public templates from `skills/_PAI/TEMPLATES/` → scaffold empty USER/MEMORY → run four gates (ADR stubs, SecretScan, identifier, Grype) (zone deletion check, identity regex grep, Cloudflare ID grep, trufflehog scan, `.env` stray check) → write `.secunit-state.json` report.

See the _PAI skill workflows:

- **Release** — stage, scrub, gate, and push: `bun PAI/TOOLS/release.ts --bump <patch|minor|major>`
- **Dry run** — stage and scrub without pushing: `bun PAI/TOOLS/release.ts --dry-run`
- **Scan only** — run the four gates (ADR stubs, SecretScan, identifier, Grype) without pushing: `bun PAI/TOOLS/release.ts --scan-only`

The old filter/allowlist system (`release-patterns.yaml`, `template-map.yaml`, `SecurityVerifier.ts`, `IncrementalRelease.ts`, `CheckReleaseSafety.ts`) was retired. Under containment, sensitive-data policy lives in the tool's exclusion list and zone deletion code, not in YAML configs.

## PAI_CONFIG.yaml

This file is a credentials store, not a template source. Private skills (like `_HOMEBRIDGE`) read it directly for API keys and service credentials. It is gitignored and never included in public releases.

## Identity

DA and principal identity values live directly in `settings.json` under `daidentity` and `principal` keys. Hooks read these via `hooks/lib/identity.ts`.
