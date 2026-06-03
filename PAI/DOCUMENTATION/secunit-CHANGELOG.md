# Changelog

All notable changes to secunit are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/). Versioning follows [SemVer](https://semver.org/).

---

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
