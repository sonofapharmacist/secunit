# Changelog

All notable changes to secunit are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/). Versioning follows [SemVer](https://semver.org/).

---

## [0.6.1] — 2026-08-04

### Fixed
- **The installer silently produced a broken harness on the machine configuration the README requires.** `install.sh`'s bundle-copy is skip-if-exists, and `settings.json` always already exists on a machine with Claude Code — which the README lists as a prerequisite. The shipped `settings.json` was therefore never applied: **58 hook registrations across 13 events** were dropped, along with `statusLine`, `contextFiles`, `env`, `spinnerVerbs` and roughly 30 other keys, while the script printed `✓`, printed `Done`, and exited 0. On a machine *without* prior Claude Code the same script installed perfectly, so the failure was invisible to anyone smoke-testing on a clean box. Replaced the `pai.*`-only merge with an ownership-aware merge: machine-owned keys (`hooks`, `statusLine`, `contextFiles`, …) take the template; user-owned keys (`permissions`, `model`, `theme`) are never touched; `env` is deep-merged so a user's own variables survive alongside secunit's. A backup is written to `settings.json.secunit-backup`. Found by running the fresh-clone smoke test against published v0.6.0.
- **No public `CLAUDE.md` shipped at all.** The release correctly strips the private root `CLAUDE.md` (it carries identity, contacts, and business context) but staged no public replacement — it was absent from the repo root, from `PAI/TEMPLATES/`, and from `release.ts`'s promotion rules, even though the same mechanism already promotes `secunit-README.md` to `README.md`. A new user's DA booted with no modes, no format templates, and no context routing. Added `PAI/TEMPLATES/CLAUDE.md` (modes, operational rules, path routing) and a promotion rule that **throws rather than warns** when it is missing, since a release without it is precisely this bug.
- **`permissions` is no longer merged from the template.** Unioning allow-lists would silently widen a user's security posture on install. The user's block is now preserved verbatim.

### Added
- **Post-install verification.** The installer now asserts its own outcome — hook-event and registration counts, `CLAUDE.md` presence, and the `skills/`, `hooks/`, and `PAI/` trees — then prints `Install INCOMPLETE` and exits non-zero with a named recovery path when any check fails. Copying a file is not the same as the configuration being in effect; a silent `Done` over a dead harness can no longer happen.
- **`PAI_INSTALL_ROOT`.** Redirects the install target so the installer can be smoke-tested against a scratch directory instead of a real `~/.claude`. Unset, behavior is byte-identical to before.
- **README next-steps names a concrete check.** Replaced the bare `/interview` pointer with what the installer does to `settings.json`, where the backup lands, and a one-question verification ("ask your DA what mode you're in") that confirms the harness actually loaded.

### Security
- **Two known-vulnerable dependency versions in the release toolchain.** `undici` 7.28.0 → 7.29.0 (GHSA-4cwx-7wf7-3272, HIGH) and `brace-expansion` 5.0.8 → 5.0.9 (GHSA-rgw5-rvv9-x895, HIGH). Pre-existing and unrelated to the installer work, but release-blocking; Grype confirmed clean after the bump.

---

## [0.6.0] — 2026-08-04

### Added
- **`DualCheck` is now a public skill.** Adversarial code-review check using two independent models called directly and in parallel (Devstral Medium via Mistral's own API, MiniMax M3 via OpenRouter's own API), reporting both verdicts side by side rather than treating either as the deciding vote. Was built in a prior session but never added to the release allow-list — the private-zone gate correctly flagged it as unlisted, review confirmed it's generic (env-var/secret-store key names only, no hardcoded credentials or business context) and safe to ship.

### Fixed
- **Release ADR `containment-enforcement-consolidation.md` quoted real principal-identifying strings** (home-directory username, personal email, employer name, machine hostnames) as prose examples of what the identifier gate's pattern list scans for. Genericized to placeholder language while preserving the documented reasoning — the identifier gate correctly caught this as a real leak, not a false positive, since an ADR that ships publicly by default shouldn't contain literal private values even when quoting them as illustrations.
- **Two `settings.json` prose tips leaked a Tailscale-tailnet-specific hostname alias** (`pai:31337`) distinct from the generic `localhost:31337` convention used everywhere else in the codebase. Genericized or removed the port reference; the prose-tip gate's classifier correctly flagged both instances.
- **`generateSBOM()` can report zero components for a reason unrelated to the original pre-strip fix.** If `PAI/TOOLS/node_modules` isn't installed at all (rather than merely stripped post-generation), cdxgen has nothing to enumerate and produces a technically-valid but empty SBOM — same failure signature as the bug the earlier SBOM-ordering fix addressed, different root cause. No code change; documenting the precondition here since the gate's error message doesn't distinguish the two cases.
- **Two known-vulnerable dependency versions in the release toolchain.** `brace-expansion` 5.0.7 → 5.0.8 (GHSA-mh99-v99m-4gvg, HIGH), `tar` 7.5.19 → 7.5.21 (GHSA-r292-9mhp-454m, MEDIUM). Grype flagged both during a routine release scan; confirmed clean after the bump.

---

## [0.5.1] — 2026-07-22

### Fixed
- **SBOM generation now runs while the complete dependency graph is still available.** `release.ts` generates the CycloneDX 1.5 SBOM before stripping staged `node_modules`, verifies that cdxgen produced valid JSON even when its summary-table renderer exits non-zero, and scans that fresh artifact rather than an empty or stale dependency view.
- **Grype now fails closed on SBOM and vulnerability-scan errors.** A missing or invalid SBOM can no longer skip Grype and report success; HIGH or CRITICAL findings block the release, while visible MEDIUM/LOW findings remain reviewable without being silently swallowed.
- **Vulnerable package versions in the release toolchain were upgraded or pinned.** Updated `undici` to 7.28.0, `tar` to 7.5.19, `sharp` to 0.35.0, `protobufjs` to 7.6.5, `brace-expansion` to 5.0.7, `js-yaml` to 4.3.0, and Vite to 6.4.3. The resulting 312-component SBOM contains no HIGH or CRITICAL findings.
- **`Inference.ts` CLI silently dropped the query on malformed args.** A bare positional word before flags (e.g. a level name typed without its `--level` prefix) was swept into `positionalArgs` instead of erroring; with 3+ positional args the old length check (`< 2`) passed and only the first two were used, silently discarding the real query. Now errors loudly with a diagnostic hint when positional-arg count isn't exactly 2.
- **`SessionFork`'s `Fork.md` handoff defaulted to `claude --continue --fork-session`, which can silently fork the wrong session.** `--continue` resumes the most recent conversation *in the current directory*, not a specific session — with concurrent sessions in the same working directory, it forks an unrelated conversation with no error. Default is now `claude --resume {parent_session_id} --fork-session`, using the session id already captured in the fork's tracking file.
- **`SessionFork`'s `Fork.md` Step 5 treated the native fork invocation as something the assistant could attempt and retry on failure.** It cannot — `--fork-session` is a top-level shell flag that launches a new `claude` process, and nested `claude` invocation is blocked. Step 5 now correctly frames this as a user handoff: the assistant prepares the tracking file and hands the exact command to the user to run interactively.

### Added
- **`SessionFork`'s `Merge` workflow gained same-parent delta-mode reintegration.** When `Merge` runs in the exact same process as the fork's recorded parent session (a mechanical `$CLAUDE_CODE_SESSION_ID` comparison against the tracking file's `parent_session_id`, never a guess), it surfaces a compressed delta — only what's newly true — instead of restating context the parent session already holds. Falls back to full-verbose on any ambiguity or mismatch; the fallback direction is fixed, never a coin flip. `Conclude`'s full anchored artifact is unchanged and always written to disk regardless of reader mode.
- **`SessionFork`'s `Conclude` workflow gained a scope-boundary rule.** C/R/L (Conjectured/Refuted-by/Learned/Criterion-now) fields now exclude pre-fork backstory — content describing why the fork was spawned rather than what happened inside it — since that context already exists verbatim in the fork's tracking JSON. This is a mechanical content-scope test, not a reader-awareness guess, so it stays safe under the same class of risk that makes naive "be less verbose" summarization fixes unreliable.
- **`CreateSkill`'s `UpdateSkill` workflow gained a Content Consistency checklist item**, triggered after 2+ edit passes to the same file(s) in one session — checks for near-duplicate rationale and stale summary lines left standing next to a later, corrected detailed instruction.

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
