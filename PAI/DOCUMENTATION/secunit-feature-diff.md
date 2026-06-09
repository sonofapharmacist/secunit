# secunit vs upstream PAI — Feature Diff

> Reference document for launch. Tracks what secunit adds, changes, or removes relative
> to danielmiessler/PAI at v5.0.0 / Algorithm v6.3.0.
>
> Last updated: 2026-05-27 — ISA sweep completed (97 ISAs reviewed)

---

## Algorithm

| Feature | Upstream (v6.3.0) | secunit (v7.0.0) |
|---|---|---|
| Fail-safe routing | E3 (maximum ceremony on classifier failure) | **E2** — 8.59% of turns were over-escalating |
| E3 thinking floor | ≥4 capabilities | **≥1** — four-count produced phantom labels, not thinking |
| E3 ISC floor | ≥32 | **≥16** |
| E2 ISC floor | ≥16 | **≥10** |
| EUPHORIC SURPRISE PREDICTION | Mandatory freehand field | **Removed** — Class B hallucination surface, no verification path |
| DELIVERABLE MANIFEST | Mandatory E3 | **E4/E5 only** |
| Voice curl at phase transitions | 7 mandatory FIRST ACTIONs | **Removed** — failed silently on headless systems |
| PARALLELISM SCAN | Mandatory E3 | **Optional E3, mandatory E4/E5** |
| violations_self_reported field | Not present | **Mandatory** in algorithm-reflections.jsonl |
| Phase-completion checklist | Not present | **In VERIFY** — each gate named with pass/skip result |
| ObserveGate | Not present | **PreToolUse hook** — blocks observe→think transitions without scope gate passage (2026-05-27) |
| PhaseTransitionGuard | Not present | **PreToolUse hook** — enforces valid phase transitions across all Edit/Write calls (2026-05-27) |
| Scope gate rule | Not present | **"Don't warm the global temperature a degree"** — fires at E2+ OBSERVE before first ISC; four questions; auto-confirms unambiguous; surfaces gaps |
| Automated thinking invocation | Not present | **PromptProcessing hook** extended to classify ambiguous/architectural/load-bearing requests and pre-select thinking capabilities |
| Thinking capability vocabulary | Closed enumeration (v6.3.0) | Inherited + closed |
| ISA system | ✓ (introduced v6.0.0, expanded v6.2.0) | ✓ inherited |

**Provenance for v7.0.0:** 146 failure events in May 2026, 8.59% fail-safe rate, GP caught 3
violations on sessions that self-reported `within_budget: true`. Jaroslawicz 2025
(arXiv 2507.11538): 68% compliance ceiling under high instruction density.

---

## Local Inference Routing System

**Not in upstream. The largest architectural addition in secunit.**

A complete local-first inference layer built over five ISA sessions (P1–P5, May 2026):

| Component | Description |
|---|---|
| `inference-routing.yaml` | Manifest: 13+ models with tier assignments (fast/standard/smart), cold-start latencies, backend (claude/ollama/llama-server) |
| `skill-routing.yaml` | Per-skill routing overrides — specific skills can demand specific tiers or backends |
| Latency measurement | `Inference.ts --measure`: 5 cold-start + 5 warm probes, writes `latency-per-invocation.jsonl` |
| Data-driven tier assignment | `analyze-latency.ts` computes per-model stats, validates tier assignments against observed latency |
| Warmth-based routing | Pre-checks last 10 Ollama success entries; routes to already-warm models first |
| Per-GPU warmth tracking | Parameterized by resolved host URL — tracks warmth per GPU, not per host |
| Local-first mode | `localFirst: true` attempts local (45s timeout) before Claude fallback |
| Ollama fallback | When Claude hits usage/rate limits, retries via Ollama automatically |
| Multi-host routing | `inference_hosts` in PAI_CONFIG.yaml — host2, host1, autogen, or any llama-server endpoint |
| llama-server migration | Migrated from Ollama native API to OpenAI-compatible API (`/v1/chat/completions`) — works with any compatible backend |
| `QualityTestModels.ts` | Scores model output quality against standardized prompts; drives routing suggestions |
| `BenchmarkLocalModels.ts` | Benchmarks throughput (tok/s) across all configured hosts |
| `LocalInferenceEval.ts` | Full evaluation harness for local model comparison |
| `InferenceStats.ts` | Aggregate inference statistics CLI |

**Why this matters publicly:** users can configure PAI to use local models (Ollama, llama.cpp,
any OpenAI-compatible endpoint) with intelligent fallback. The routing layer handles tier
selection, warmth awareness, and Claude fallback automatically.

---

## TLDR Intelligence Pipeline

**Not in upstream.**

Daily feed system built on TLDR.tech newsletters:

| Tool | Description |
|---|---|
| `TLDRScraper.ts` | Fetches all article sections from configured TLDR newsletters (Tech, AI, InfoSec, Dev, DevOps, Fintech) |
| `TLDRHarvest.ts` | Scores each article for relevance to principal's security/AI profile; writes to `KNOWLEDGE/TLDR/` |
| `TLDRTriage.ts` | Interactive triage UI — surface, rate, tag articles |
| `TLDRSurface.ts` | Surfaces top-scored unread articles |
| `TLDRRescore.ts` | Re-scores existing entries when profile changes |
| `TLDRCatchup.ts` | Orchestration cron — detects stale days, scrapes, harvests in one command |
| `NormalizeContent.ts` | Normalizes external content (URL-decode, Unicode cleanup, encoding repair) before storage |

Feed is consumed by ContextSearch and MemoryRetriever during Algorithm runs — daily reading
automatically becomes retrievable session context.

---

## Knowledge Harvesting + Library System

**Not in upstream.**

### Knowledge Harvesting

| Tool | Description |
|---|---|
| `KnowledgeHarvester.ts` | Polls RSS feeds and newsletters on demand or via cron; rates for relevance; writes to `MEMORY/KNOWLEDGE/` |
| `HarvestExecutor.ts` | Batch execution layer for harvesting pipelines |
| `SessionHarvester.ts --mine` | Extracts knowledge from prior sessions; writes to `KNOWLEDGE/_harvest-queue/` |
| `KnowledgeHarvester.ts harvest --url` | Single-URL ingestion via agy CLI backend |

### Library System (1,737 ebooks)

| Tool | Description |
|---|---|
| `LibraryClassify.ts` | Classification pipeline: sorts ebooks by topic, quality, relevance |
| `LibraryIngest.ts` | Ingestion pipeline — metadata extraction, manifest entry |
| `LibraryFetch.ts` | Fetch by slug from library manifest; extracts full text for session context |
| `LibraryOCR.ts` | Pre-pass OCR repair — detects low-quality PDF ingests, runs `ocrmypdf` |

### Graph-Enhanced Retrieval (2026-05-26)

| Tool | Description |
|---|---|
| `KnowledgeGraphLib.ts` | Shared typed-graph-building core: extracts typed edges from `[[slug]] — description` wikilinks in memory files |
| `KnowledgeGraph.ts` | Graph navigation CLI — query, traverse, find related nodes |

`MemoryRetriever.ts` (BM25) + `KnowledgeGraph.ts` (typed graph) form a hybrid retrieval
layer — keyword scoring + relationship traversal.

---

## Observability Tooling

**Significantly expanded beyond upstream.**

| Tool / Feature | Description |
|---|---|
| `ObservabilityReport.ts` | Comprehensive CLI: mode/tier distribution, fail-safe rate, inference backends, latency percentiles, quality scores |
| `CostTracker.ts` | Tracks Claude API spend by session, day, model |
| `FailureCapture.ts` | Structured failure capture with stack traces and recovery suggestions |
| `AlgorithmPhaseReport.ts` | Phase distribution across sessions — where time is spent |
| Context stats JSONL | Per-session context size logged at session boundaries |
| `latency-per-invocation.jsonl` | 100% of Inference.ts calls logged with backend, model, latency, tier, success |
| `prompt-budget.jsonl` | Bounded JSONL of prompt timestamps — `PromptBudget.ts` queries Pro cap usage |
| `ratings.jsonl` | Session quality ratings via `RATE: X/10` banner → SatisfactionCapture hook |

---

## CLAUDE.md Operational Ruleset

**40+ failure-derived rules not in upstream. Selected:**

| Rule | Why it exists |
|---|---|
| Scope gate — fire before first ISC at E2+ | Once 30 ISCs are written, redirect cost triples |
| Sentinel file pattern for process gates | Prevents phase transitions without explicit model commitment |
| Forge auto-include at E3/E4/E5 | GPT-5.4 via codex exec at reasoning_effort=high on all substantial coding tasks |
| `spawnSync` must set `stdio: "pipe"` explicitly | `encoding: "utf-8"` does not imply pipe |
| Multi-site TypeScript edits: make params required | Compiler-as-test-harness — catches missed call sites |
| Hook changes need runtime smoke test | TypeScript compile ≠ correct runtime behavior |
| `rg` is a shell-function wrapper | Cannot be called from subprocesses |
| Never run `claude` subprocess inline | CLAUDECODE env blocks nested sessions |
| Open ISA check at Algorithm OBSERVE | Surface in-progress sessions before creating new ones |
| Surface controls as behavior, not flags | Infer params from context; expose flag for override only |
| Build over ask for reversible actions | Momentum matters |
| DA strategic thinking rules | Codified rules for when to ask vs execute immediately |
| primacy effect — Critical Rules at top 30 lines | Mid-document rules drop first under instruction density load |

---

## Skills

Upstream claims 45 public skills. secunit ships 42 public skills.

**Likely secunit-specific (not in upstream's closed enumeration or docs):**
`Apify` `BrightData` `Interceptor` `Migrate` `Optimize` `PAIUpgrade` `Daemon` `Loop`

**Confirmed shared with upstream (listed verbatim in upstream's v6.3.0 closed enumeration):**
`IterativeDepth` `ApertureOscillation` `FirstPrinciples` `SystemsThinking` `RootCauseAnalysis`
`Council` `RedTeam` `Science` `BeCreative` `Ideate` `BitterPillEngineering` `Evals`
`WorldThreatModel` `Fabric` `ContextSearch` `ISA`

---

## Hook System

Upstream ships 37 hooks. secunit additions (not in upstream):

| Hook | Trigger | Purpose |
|---|---|---|
| `ObserveGate.hook.ts` | PreToolUse | Blocks observe→think ISA transition without scope gate passage |
| `PhaseTransitionGuard.hook.ts` | PreToolUse Edit/Write | Enforces valid phase ordering; rejects illegal transitions |
| `HookCanary.hook.ts` | SessionStart | `git diff --name-only HEAD` + `git ls-files` integrity check |
| `LastUpdatedSync.hook.ts` | PostToolUse Edit/Write | Auto-updates `last_updated` in ISA frontmatter on every edit |
| `ISASync.hook.ts` | PostToolUse Edit/Write | Syncs ISA frontmatter phase changes to work.json + kitty tab |
| `WorkCompletionLearning.hook.ts` | Stop | Routes learnings to correct PAI surfaces |
| `SatisfactionCapture.hook.ts` | Stop | Captures RATE: X/10 signals to MEMORY/LEARNING |
| `RelationshipMemory.hook.ts` | Stop | Persists relationship context across sessions |
| `PromptProcessing.hook.ts` | UserPromptSubmit | Mode/tier classification + thinking pre-selection via Sonnet |
| `ToolActivityTracker.hook.ts` | PostToolUse | Every tool call logged to JSONL |
| `ToolFailureTracker.hook.ts` | PostToolUse | Failure tracking with stack traces |
| `DocIntegrity.hook.ts` | Stop | Cross-reference integrity + architecture summary rebuild |

---

## Security Library

Not in upstream:

- **Kohnfelder framework** — CIA/Gold Standard, Four Questions, STRIDE, DREAD, 15 patterns
  + 4 anti-patterns, Secure Design, SDR process. Wired into MemoryRetriever (auto-surfaces
  on security design queries) and ASA skill.
- **`CrossVendorAudit.ts`** — Cato cross-vendor audit CLI (E4/E5 gate)
- **`SecretScan.ts`** — credential scan tool (searches JSONL logs + config for exposed keys)
- **Canary token system** — cryptographically random 12-char canary injected at every
  SessionStart via hook; confirms model context injection is working

---

## Memory System

| Component | Upstream | secunit |
|---|---|---|
| Version | v7.x | v7.6 |
| BM25 retrieval | ✓ | ✓ `Tools/MemoryRetriever.ts` — 5 domains |
| Knowledge graph | Unknown | ✓ `KnowledgeGraphLib.ts` + `KnowledgeGraph.ts` |
| TLDR harvester | Unknown | ✓ full 7-tool TLDR pipeline |
| Knowledge harvester | Unknown | ✓ `KnowledgeHarvester.ts` + URL ingestion |
| Session harvester | Unknown | ✓ `SessionHarvester.ts --mine` |
| Observability JSONL | Unknown | ✓ `MEMORY/OBSERVABILITY/*.jsonl` |
| Library system | Unknown | ✓ 1,737 ebooks, classify/ingest/fetch/OCR pipeline |
| `LearningPatternSynthesis.ts` | Unknown | ✓ patterns across learning history |
| `WisdomCrossFrameSynthesizer.ts` | Unknown | ✓ cross-frame wisdom synthesis |

---

## Additional Tools (selected, not categorized above)

| Tool | Description |
|---|---|
| `CompleteProject.ts` | Marks project complete in PROJECTS.md, archives ISA, updates state |
| `ComputeGap.ts` | Current state vs ideal state gap computation |
| `HealthSnapshot.ts` | System health snapshot |
| `DAGrowth.ts` | DA personality evolution tracker |
| `InterviewDimensions.ts` | STATE dimension ratings (1-10) persisted to PAI_STATE |
| `LinuxPortabilityCheck.ts` | Verifies secunit-specific scripts work on non-Darwin |
| `AgentWatchdog.ts` | Background agent monitoring + timeout enforcement |
| `ArchitectureSummaryGenerator.ts` | Auto-regenerates ARCHITECTURE_SUMMARY.md when master doc changes |
| `audiobookify.ts` | URL → audiobook via ElevenLabs TTS (in progress) |
| `pai-sync` / `pai-push` profiles | Smart git sync — auto-discards known generated/runtime files before push |

---

## PAI Lite (work-in-progress, not in public release)

A minimal PAI configuration for your-organization consultants:
- Installable in under 5 minutes
- Delivers Algorithm mode + compounding memory
- No Pulse, no voice, no personal Telos
- ASA as centerpiece capability

*Excluded from secunit public release — work-client specific.*

---

## What is NOT different

- Algorithm phases (OBSERVE → THINK → PLAN → BUILD/EXECUTE → VERIFY → LEARN)
- ISA format — 12-section body, ID-stability rule, ISC quality requirements, tier completeness gate
- Thinking capability closed enumeration (19 names — secunit inherits verbatim)
- Pulse dashboard (localhost:31337)
- DA identity layer and voice system
- PAI-Install installer
- Founding principles (all 17, inherited from upstream)
- MIT license

---

## Summary

secunit is upstream PAI run hard by one person for one month, with the observability to prove
where it broke and the algorithm changes to address it. The delta is production data, not opinion.

**Three structural additions upstream doesn't have:**
1. Local inference routing layer — multi-host, warmth-aware, fallback-safe
2. TLDR/knowledge harvesting pipeline — daily reading becomes retrievable session context
3. Graph-enhanced retrieval — typed wikilink graph on top of BM25
</thinking>
