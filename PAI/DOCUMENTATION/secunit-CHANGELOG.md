# Changelog

All notable changes to secunit are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/). Versioning follows [SemVer](https://semver.org/).

---

## [0.5.0] — 2026-07-21

### Added
- **`install.sh` now installs system tools PAI's hooks and skills rely on:** `rtk` (Rust Token Killer, via its official installer), plus `jq`/`rg`/`fd`/`bat` via apt/brew/dnf/pacman auto-detection. Without `rtk`/`jq`, `hooks/ContextReduction.hook.sh` silently no-ops instead of compressing Bash output — this closes that gap by default on a fresh install. Prints an upfront banner naming each tool and exactly what degrades if it's skipped. Handles Debian's `fd-find`→`fdfind` binary rename via symlink, and detects root-vs-sudo so it works both on a normal dev machine and inside a container with neither `sudo` nor a non-root user.
- **Opt out of tool installation** via `SECUNIT_SKIP_TOOLS=1` (always available — for CI/scripted installs) or an interactive `[Y/n]` prompt (only shown when stdin is a TTY, so non-interactive runs never hang).
- `test-secunit-install.sh` now exercises both the default-install and `SECUNIT_SKIP_TOOLS=1` paths in the same Docker E2E run.

### Fixed
- Release identifier gate: extended sanitization to catch personal machine names, a Tailscale IP, and a LAN IP across `PULSE.toml`, `NightlyCodeReview.ts`, `threat_model_bench.ts`, and two `DOCUMENTATION/Decisions/` docs that had no prior sanitization entries.
- `PAI/TOOLS/FreeTierEvals/threat_model_bench_results/` (personal benchmark run history) is now stripped from the release rather than shipped — it's run data, not a template.
- Redacted a burned (already-rotated) Anthropic API key that was sitting in plaintext in `passage-secret-disclosure-guard.md`.
- `hooks/ContextReduction.hook.sh` now warns to stderr when `rtk`/`jq` are missing instead of silently passing the command through unmodified — the silent case was previously indistinguishable from the hook working correctly.
- `release.ts`'s own success message no longer prints a hardcoded personal Tailscale domain; derives the printed remote from `SECUNIT_REMOTE` instead.
- `pai.repoUrl` in `settings.json` had a typo in the GitHub handle (`sonsofapharmacist` → `sonofapharmacist`).

---

## [0.4.0] — 2026-07-05

### Added
- **Backend-switch scripts:** `glm.sh`, `minimax.sh`, `offline.sh`, `offline-off.sh` at repo root — source them to switch Claude Code's own CLI session (not just `Inference.ts` subtask calls) to Z.ai GLM, MiniMax M3, or a local Ollama host, and back to Anthropic direct. New `PAI/backends/` source directory; `release.ts` promotes its `.sh` files to repo root with the executable bit set, same pattern as `install.sh`. `glm.sh`/`minimax.sh` read credentials via `passage` if installed, else fall back to `GLM_API_KEY`/`MINIMAX_API_KEY` env vars. `offline.sh` takes its target host from `PAI_OFFLINE_HOST` (defaults to `127.0.0.1`) instead of a hardcoded address. Documented in the README under "Backend switching."

### Fixed
- Release identifier gate: `PAI/PROFILES/work/CLAUDE.md` carried a personal domain and a username-derived path; added to the sanitizer so the staged copy scrubs both without touching the live file.

---

## [0.3.0] — 2026-06-29

### Added
- **Backend fallback chain:** `BackendHealth.ts` health CLI probes all configured inference backends with clean ✅/❌ output. Resilience chain Anthropic → Z.ai GLM → MiniMax M3 → Ollama autogen, with `FaultTaxonomy.md` documenting failure mode → fallback action mappings. `Inference.ts` now treats `ECONNREFUSED`/`ETIMEDOUT`/HTTP 503 as usage-limit signals so it fails over instead of hanging.
- **Pulse nightly autopilot code review:** `NightlyCodeReview.ts` runs a report-only `/code-review high` pass against configured repos via `claude -p`, writing findings to a JSONL queue. Never auto-fixes — findings are queryable over HTTP via the Pulse `code-review` module. Wired into `pulse.ts` module loading and HTTP route dispatch.
- **SettingsIntegrityCheck hook:** validates `settings.json` structure at session start.
- **Incremental release commits:** `release.ts` now clones existing secunit history and commits only the diff, instead of force-pushing a single squashed snapshot each time. First release (empty remote) still falls back to a fresh `git init`. `--force-snapshot` preserves the old wipe-and-force behavior for emergencies. Forgejo and GitHub pushes share one work dir so both land the same commit.
- **release.ts defaults to push:** dropped the old two-step "scan, then re-run with `--push`" friction — gates passing now leads straight to the confirm prompt. Use `--scan-only` to stop after the gate.

### Fixed
- Pulse `loadPulseConfig()` was silently dropping unlisted TOML sections, so `code-review.enabled` never reached `loadModules()` despite being set in `PULSE.toml`.
- Pulse shutdown could take up to 60s (or hang indefinitely) on SIGTERM: `Bun.sleep()` ignores `AbortSignal`, so the cron heartbeat loop wasn't interruptible, and a detached Telegram supervise-retry loop kept the process alive after `main()` returned. SIGTERM now exits in ~1s.
- Release gate hardening: `PRIVATE_SKILL_DIRS` coverage gaps, sanitizer coverage gaps, and a stale ADR stub (Kohnfelder full synthesis subsystem entry) that had been wiped back to `status: stub` by an unrelated sync commit.

## [0.2.0] — 2026-06-01

### Added
- **ADR system:** `ArchitectureSummaryGenerator.ts` auto-stubs Architecture Decision Records on structural threshold changes (algorithm version bump, new subsystem, new pipeline domain). Stubs block release via `release.ts` gate.
- **Architecture knowledge domain:** BM25-indexed ADRs in `MEMORY/KNOWLEDGE/Architecture/` surface during OBSERVE via MemoryRetriever.
- **Algorithm v7.1.0:** ISA state surfaces as a one-line stub entry; full state read directly. No AI narration of phase or progress — narrated status embeds fabrications as ground truth.
- **Git tags:** releases now create an annotated tag (`v{version}`) on the secunit repo.
- **CHANGELOG, SECURITY.md, GitHub issue/PR templates:** standard public release scaffolding.

### Fixed
- `settings.json` hook commands used hardcoded system path (`/home/$USER/.bun`) instead of `$HOME`.
- `QualityTestModels.ts` usage string had hardcoded system path.
- `PROFILES/work/CLAUDE.md` referenced a username-derived Claude project memory path.
- Release identifier gate now catches the system username and Claude-derived project memory paths.

### Changed
- secunit README: version headline updated to v7.1.0; ADR gate section added to production-hardened.

---

## [0.1.0] — 2026-05-04

Initial release.

### Added
- **Algorithm v7.0.0** — reliability release targeting documented failure modes: 8.59% fail-safe rate, 146 failure events in May 2026, Jaroslawicz 2025 (arXiv 2507.11538) 68% compliance ceiling. Six coordinated changes: fail-safe routing to E2, tier floor reductions, ceremony elimination, primacy repositioning, compliance observability, chunked E2 execution.
- **SecurityPipeline.hook.ts** — PreToolUse inspector chain: CanaryInspector (prompt injection), PatternInspector (dangerous commands), EgressInspector (outbound data), RulesInspector (policy). ObserveGate and PhaseTransitionGuard on Write/Edit. Hooks fail closed on error.
- **Local inference routing** — `Inference.ts` with warmth-aware routing, `inference-routing.yaml` tier manifest, `skill-routing.yaml` per-skill overrides, automatic Claude fallback. `BenchmarkLocalModels.ts` + `QualityTestModels.ts` for model evaluation.
- **Knowledge acquisition pipeline** — `TLDRCatchup.ts` cron orchestrator, `TLDRHarvest.ts` profile-scored ingestion, `KnowledgeHarvester.ts` with agy backend, `KnowledgeGraphLib.ts` typed graph layer with wikilink traversal.
- **Observability layer** — JSONL instrumentation across prompt classification, tool activity, failures, satisfaction signals. Tripwires at >3 fail-safe events/session or >5% weekly.
- **Projects retrieval domain** — active project notes BM25-indexed and graph-traversable via MemoryRetriever, KnowledgeGraph, KnowledgeGraphLib.
- **Release pipeline** — `release.ts` with SecretScan, TruffleHog, identifier gate, Grype, SBOM (CycloneDX 1.5), private zone stripping, personal identifier sanitization.
