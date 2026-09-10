# PAI Fork — Architecture Catalog

What this installation added on top of the PAI scaffold pulled at `45aa5f65` (2026-05-04), measured against that commit. Written 2026-08-19.

**Scale:** 1,949 → 7,001 files. 5,554 changed — 5,075 added, 396 modified, 60 renamed, 23 deleted. +774,572 / −10,033 lines. 896 commits, no upstream remote, nothing pushed back.

The ADR corpus (`PAI/DOCUMENTATION/Decisions/`, 27 records) is the narrative spine — most architectural moves below have a corresponding record with context, alternatives rejected, and consequences.

---

## 1. Security — the most differentiated layer

Five enforcement points across the session lifecycle, six inspectors, fail-closed by construction.

| Event | Hook | Role |
|---|---|---|
| UserPromptSubmit | `PromptGuard` | Heuristic injection/exfil/evasion screening, no LLM inference |
| PreToolUse | `SecurityPipeline` | Inspector chain gates Bash/Write/Edit/MultiEdit |
| PostToolUse | `ContentScanner` | `InjectionInspector` on WebFetch/WebSearch results |
| PermissionRequest | `SmartApprover` | Trusted-workspace classification |
| SessionStart | `CanarySession` + `HookCanary` | Plants session token; verifies the hook chain is live |

**Inspectors** (priority-ordered, short-circuit on deny): Pattern(100), Canary(95), Prompt(95), Egress(90), Injection(80), Rules(50).

**Honest provenance.** The pipeline skeleton was inherited, not written here — `SecurityPipeline.hook.ts` (75→115), `pipeline.ts` (115→118), `PatternInspector.ts` (220→289), `EgressInspector.ts` (77→105), `RulesInspector.ts` (117→125), `ContentScanner.hook.ts` (58→71), `PromptGuard.hook.ts` (96→116). `SmartApprover.ts` is untouched at 188 lines.

**What is genuinely new here:**
- **The fail-closed correction.** Upstream `pipeline.ts` caught inspector exceptions, logged an `alert`, and called `continue` — proceeding with the tool call after skipping the failed layer. This fork returns `requireApproval(...)` instead. A skipped inspector is indistinguishable from a bypass; this is the substantive security fix in the subsystem and it was made against inherited code.
- `CanaryInspector.ts` (107 lines) plus `CanarySession.hook.ts` and `HookCanary.hook.ts` — the session-canary subsystem is this fork's design. A per-session token planted at SessionStart and checked on every PreToolUse; appearance in a tool argument is a deterministic exfiltration signal, not a heuristic.
- `ObserveGate` and `PhaseTransitionGuard` on Write/Edit — Algorithm phase ordering enforced at the tool layer, not by prompt.

The `new-subsystem-security-system` ADR originally claimed `SecurityPipeline.hook.ts` was "wholly written for this fork" and "did not exist at initial commit." Both were false; the ADR was corrected 2026-08-19 with a per-file provenance table.

Pattern credited in-source to Goose's `ToolInspectionManager`.

**ADRs:** `new-subsystem-security-system`, `containment-enforcement-consolidation`, `passage-secret-disclosure-guard`, `hook-wiring-5-orphaned-hooks-2026-07`.

---

## 2. Containment and release — the private/public boundary

`release.ts` (1,615 lines, wholly new) is the sole sanctioned egress path from a tree that holds identity, contacts, financial context, and full conversation history. Clones live tree → deletes private zones → overlays public templates → runs gates → hard-fails on any identifier hit. Includes SBOM generation (CycloneDX 1.5 via cdxgen) and a grype vulnerability gate blocking HIGH+.

The `containment-enforcement-consolidation` ADR is the sharpest architectural reasoning in the corpus: a prospective write-time guard (`ContainmentGuard.hook.ts` + `containment-zones.ts`) was **retired as dead code** in favour of release-time enforcement, with the behavioural half of the rule moved to CLAUDE.md because no hook can observe it. Choosing one real enforcement point over two partial ones is the correct call and it's documented as such.

---

## 3. Algorithm — versioned doctrine

v6.3.0 (inherited) → **v7.1.1**, with four new version files and three ADRs.

- **v7.0.0** — six coordinated reliability changes: fail-safe routes to E2 not E3 on classifier error (over-escalation was the documented failure mode), tier floor reductions, ceremony elimination, primacy repositioning of the three most-violated rules, mandatory `violations_self_reported`, chunked E2 execution.
- **v7.1.0** — "stub surface, silent internals." Entry emits one line; ISA state surfaces only via file Read, never AI narration.
- **v7.1.1** — Cross-Vendor Audit moved from `Agent(subagent_type: "Cato")` to a direct `CrossVendorAudit.ts` Bash call. Agent definition retained as persona documentation only.

The through-line: **replacing model-mediated steps with deterministic ones**, and treating over-escalation as a bug rather than safe behaviour.

---

## 4. Inference routing — local-first, evidence-based

`Inference.ts` is the single most-churned inherited file (2,155 lines changed, 24 commits) — substantially rewritten. Around it, a routing layer that did not exist upstream:

- `inference-routing.yaml` (1,008 lines changed) — tier manifest, model → fast/standard/smart
- `skill-routing.yaml` — per-skill backend overrides
- Warmth-aware routing, automatic Claude fallback on local failure or rate limit, per-invocation latency logging
- Any OpenAI-compatible backend: Ollama, llama.cpp, llama-server, LM Studio
- Fourth tier `fable` added via Anthropic API direct (the CLI doesn't expose Fable 5, betas, or `effort`)

**The evidence base is the notable part.** `FreeTierEvals/` — `unified_bench.ts` (712), `threat_model_bench.ts` (2,270), `coding_battery.py` (1,540), `llamacpp_eval.py` (2,327), `or_unified_bench.py` (512) — plus `BenchmarkLocalModels.ts` and `QualityTestModels.ts` (750). Model-tier decisions cite bench results rather than vendor claims, and the ADRs show the discipline holding: GPT-5.6 Luna scored 48/53 on the general suite and was still kept off the Tier-0 security table for failing the security-class discriminator.

**ADRs:** `local-inference-routing`, `inference-tier-fable`, `threat-model-tier-0-routing`, `deepseek-r1-distill-routing`, `glm-backend-newest-model-default`, `local-inference-dual-model-fast-standard-tier`, `bench-vs-chat-sampler-tuning`, `forge-cato-codex-openrouter-cascade`.

---

## 5. Knowledge acquisition — a subsystem that didn't exist upstream

`TLDRScraper.ts` (477) → `TLDRHarvest.ts` (480, profile-scored ingestion) → `TLDRCatchup.ts` (cron orchestrator), feeding `MEMORY/KNOWLEDGE/`. Plus `SessionHarvester.ts` mining prior sessions, `LibraryIngest.ts` (550) and `LibraryOCR.ts` (468), and `MigrateKnowledgeToArchive.ts` (545) enforcing the auto-memory vs KNOWLEDGE split.

`KnowledgeGraphLib.ts` (500, wholly new) adds typed graph retrieval with wikilink traversal. Projects added as a first-class retrieval domain across `MemoryRetriever.ts`, `KnowledgeGraph.ts`, and `KnowledgeGraphLib.ts` — upstream had People/Companies/Ideas/Research, and active project state was not retrievable.

**ADRs:** `new-subsystem-feed-system`, `new-subsystem-memory-system`.

---

## 6. Observability and self-audit

JSONL instrumentation at `MEMORY/OBSERVABILITY/` — tool activity, tool failures, prompt classification, satisfaction signals. `ObservabilityReport.ts` (1,081) and `NightlyCodeReview.ts` (889) consume it.

Per the ADR, the upstream hooks existed as infrastructure; **the discipline of using them as an evidence base, and the tripwires that act on them, is this fork's addition** — e.g. the fail-safe-rate tripwire in CLAUDE.md that reverts a routing change if it fires more than 3× per session.

Doc Integrity is a distinct pipeline domain: `DocIntegrity.hook.ts` (Stop) → `DocCrossRefIntegrity.ts` + `RebuildArchSummary.ts` → `ArchitectureSummaryGenerator.ts`, which auto-stubs ADRs on architectural threshold detection. **Stubs block secunit release until filled** — the documentation obligation is mechanically enforced rather than aspirational.

**ADRs:** `new-subsystem-observability-system`, `new-pipeline-domain-doc-integrity`, `nightly-review-chunking-design-review`.

---

## 7. Hooks — 37 → 43

Eight added: `CanarySession`, `HookCanary`, `SettingsIntegrityCheck`, `SessionStart`, `BudgetWarning`, `ImperativeExtractor`, `AutoPromoteQueue`, `SessionHarvestMine`. Twenty-four inherited hooks modified.

Five hooks that shipped in the initial commit but were **never registered in settings.json** were wired: ConfigChange, PostToolUseFailure, StopFailure, TaskCreated, PermissionRequest. That's an audit finding against inherited scaffolding, not new construction — and it's the kind of gap only a systematic review surfaces.

---

## 8. Agents and skills

**Agents:** 15 inherited personas rewritten; `M3Researcher` and `ProofReader` added. The roster is deliberately multi-vendor — Forge (OpenAI/codex), Anvil (Meituan LongCat), Cato (cross-vendor auditor), Engineer (Claude-family) — with an explicit principle that an audit model should not share training lineage with the model it grades.

**Skills:** 137 files added, 142 modified. New: `app-security-assessment` (the ASA scanner, G1), `Recon`, `TabletopExercise`, `_THREATMODEL`, `_COMMITREVIEW`, `_ES_VENDOR_INTEL`, `_ES_SOLUTIONS_PLACEMENT`, `esi-branded-docx`, `Verify`, `DualCheck`, `SessionFork`, `Agents`, `TmuxCliDriver`, `PAIUpgrade`, `Aphorisms`.

The `_`-prefixed skills are private-by-convention and excluded from release — the naming convention *is* the containment mechanism, hardened in the `containment-enforcement-consolidation` ADR.

---

## 9. Domain grounding

The Kohnfelder *Designing Secure Software* framework (CIA, Four Questions, STRIDE, DREAD, 15 patterns + 4 anti-patterns, SDR) registered as a retrieval-indexed subsystem, auto-surfacing on security design queries. This is a security consultant's working vocabulary wired into the assistant's retrieval path.

`ai-grc/` (13 files) is a further domain addition.

**ADRs:** `new-subsystem-kohnfelder-framework`, `new-subsystem-kohnfelder-full-synthesis`.

---

## 10. Subtraction as architecture

Three ADRs record deliberate removals — the most opinionated part of the fork:

- `system-prompt-retirement` — `PAI_SYSTEM_PROMPT.md` deleted; CLAUDE.md becomes the only authored top instruction layer. One rule migrated, the rest judged covered, hook-enforced, or obsolete.
- `launcher-retirement` — `pai.ts` deleted; bare `claude` is the only supported launch path.
- `containment-enforcement-consolidation` — write-time guard retired in favour of a single release-time enforcer.

`nooa-pass-by-reference` is the outlier and arguably the most disciplined record in the corpus: **an explicit decision to defer, not reject**, because the cost evidence was compelling but the measurement on a PAI-shaped workload had not been made. Recording a non-decision with its reasoning is unusual and worth keeping.

---

## What the numbers overstate

4,215 of the 5,075 added files are under `PAI/MEMORY` — knowledge notes, benchmark artifacts, ISAs, session state. That's the system *running*, not the system being *built*.

The construction is the other ~860 additions (275 tools, 137 skills, 41 docs, 18 hooks) plus the 396 modifications — and the modifications are where the real surgery shows: 142 skills reworked, 24 hooks changed, `Inference.ts` substantially rewritten, 15 agent personas rewritten.

**The honest one-line summary:** this fork took a working scaffold and added a security enforcement layer with a canary tripwire, a release-time containment gate, an evidence-based multi-vendor routing layer, a knowledge acquisition pipeline, and a documentation-integrity system that mechanically blocks release on unfilled ADR stubs — then versioned the core Algorithm three times to remove model-mediated steps in favour of deterministic ones.
