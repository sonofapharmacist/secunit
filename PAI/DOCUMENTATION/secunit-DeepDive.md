# secunit — the deep dive

> Everything the README used to say before it learned to stop. This is the reference layer: what diverged from upstream PAI, what the security instrumentation actually does, inference routing, backend switching, the knowledge pipeline, mobile access. Read the [README](../../README.md) first; come here when you want the why and the wiring.

---

## What's different from upstream

The headline: **Algorithm v7.1.0 vs upstream's v6.3.0.**

The Algorithm is PAI's structured task-execution framework — five ordered phases (OBSERVE →
THINK → PLAN → EXECUTE → VERIFY) with effort tiers (E1–E5) that scale ceremony to task
complexity.

v7.0.0 is a reliability release targeting documented failure modes with evidence. Internal
observability logged 146 failure events in May 2026, an 8.59% fail-safe rate above the 5%
tripwire, and self-reported compliance on sessions where violations were caught after the fact.
Jaroslawicz 2025 (arXiv 2507.11538) establishes a 68% compliance ceiling under high instruction
density; this fork is built around that finding.

**Six coordinated changes in v7.0.0:**

1. **Fail-safe routing:** classifier errors route to E2 (extended effort), not E3 (advanced effort). Was injecting maximum ceremony
   on 8.59% of turns.
2. **Tier floor reductions:** E3 thinking floor ≥4→≥1 (four-count forced phantom label
   compliance, not genuine thinking); E3 ISC (Ideal State Criteria — the per-task verification checklist) floor ≥32→≥16.
3. **Ceremony elimination:** EUPHORIC SURPRISE PREDICTION removed (Class B hallucination
   surface with no verification path); DELIVERABLE MANIFEST deferred to E4/E5; voice curl
   removed from mandatory phase transitions (failed silently on headless systems).
4. **Primacy repositioning:** three most-violated CLAUDE.md rules moved to top 30 lines.
   Primacy effect means earlier rules survive instruction density degradation; mid-document
   rules drop first under load.
5. **Compliance observability:** `violations_self_reported` field mandatory in
   algorithm-reflections.jsonl (the per-session Algorithm execution log). `within_budget: true`
   alone is no longer sufficient.
6. **Execution pattern:** chunked E2 sessions with a compaction between each. Shorter sessions,
   less context accumulation, more reliable execution.

**Three coordinated changes in v7.1.0:**

1. **Stub surface, silent internals:** ISA state surfaces as a one-line stub entry in Algorithm
   context; the full ISA is read directly at OBSERVE. No AI narration of current phase or
   progress — narrated status embeds fabrications as ground truth. The Read is authoritative.
2. **Architecture Decision Records:** `ArchitectureSummaryGenerator.ts` detects structural
   threshold changes — algorithm version bumps, new subsystems, new pipeline domains — and
   writes a stub ADR to `DOCUMENTATION/Decisions/`. Stubs block release: `release.ts` exits 1
   if any `status: stub` ADRs exist. The reasoning behind architectural choices lives in the
   repository alongside the code.
3. **Architecture knowledge domain:** ADRs are BM25-indexed and surface automatically during
   OBSERVE via MemoryRetriever. Architecture decisions inform execution without requiring manual
   context loading.

**The CLAUDE.md operational ruleset** (Claude Code's project-level instruction file) is the other major differentiator. 40+ rules traceable
to specific incidents — a record of failures, not a promise of compliance. Scope gate (pre-execution
check confirming what's being built and how success is measured), sentinel file pattern, Forge
(GPT-based coding subagent) auto-include at E3/E4/E5, spawnSync stdio pipe, multi-site TypeScript param
discipline: institutional knowledge that isn't in the upstream documentation because it comes
from issues, not design.

**Security orientation.** RedTeam, WorldThreatModel, and a security architecture library
(Kohnfelder framework, STRIDE/DREAD/CIA, threat modeling patterns) reflect a security
consultant's daily use, not a general-purpose install.

---

## What 'production-hardened' actually means

**Observability over intuition.** Every session writes to `MEMORY/OBSERVABILITY/`. Prompt
classification, tool activity, failures, and satisfaction signals are logged as JSONL. The
8.59% fail-safe rate that drove v7.0.0 wasn't felt; it was counted. Changes require log evidence, not gut feeling. Tripwires are set: >3 fail-safe events per session or >5% weekly.

**Input gates (PreToolUse).** Every Bash, Write, Edit, and MultiEdit call passes through
`SecurityPipeline.hook.ts` before execution; a composable inspector chain:

- **CanaryInspector:** session integrity token planted in the system prompt. If it appears
  in a tool argument, that's a prompt injection attack propagating into execution. Hard block.
- **PatternInspector:** dangerous command patterns (exfil, destructive ops, known abuse chains).
- **EgressInspector:** outbound data screening. Catches credentials and personal data in the
  tool call arguments before they leave the system — not after.
- **RulesInspector:** policy enforcement (no nested claude calls, containment zones, etc.)

Write and Edit additionally pass through **ObserveGate** (blocks file writes if the OBSERVE
phase hasn't been committed as a sentinel; enforces that analysis precedes action) and
**PhaseTransitionGuard** (enforces Algorithm phase ordering at the tool call level).

**Output gates (PostToolUse).** External content gets its own inspector: `ContentScanner.hook.ts`
runs InjectionInspector on every WebFetch and WebSearch result before it lands in the conversation.
Web content is screened for prompt injection attempts on the way in. All tool I/O passes through
`ToolActivityTracker` asynchronously; every call and result logged to `MEMORY/OBSERVABILITY/`.

**Stop gate.** `DocIntegrity.hook.ts` fires before the final response goes out, running
cross-reference checks across documentation the session may have touched. Catches
inconsistencies before they're committed.

**Architecture Decision Records.** `ArchitectureSummaryGenerator.ts` detects structural threshold changes — algorithm version bumps, new subsystems, new pipeline domains — and writes a stub ADR to `DOCUMENTATION/Decisions/`. Stubs block release: `release.ts` scans for `status: stub` before push, exits 1 if any exist. `DOCUMENTATION/Decisions/` ships with secunit; the reasoning behind architectural choices lives in the repository alongside the code.

**ISA crash recovery.** The ISA (Ideal State Artifact) is a per-session document tracking
goal, phase, and open verification criteria — the Algorithm's single source of truth. It survives
connection drops, context compaction, and token limits; sessions resume mid-phase without
re-deriving state.

**Operational rules from incidents.** The 40+ rules in CLAUDE.md each exist because something
failed in a real session: `spawnSync` with `stdio: "pipe"` (output silently went to terminal
instead of being captured); scope gate (sessions ran at length in the wrong direction before
anyone noticed); primacy repositioning (mid-document rules drop first under instruction-density
load). The rules aren't policy; they're scar tissue.

**Threat model.** The attacker operates through the LLM — prompt injection in web content,
crafted tool arguments, instruction override attempts — not through network endpoints. OWASP
Top 10 mostly doesn't apply; the relevant frameworks are the OWASP LLM Top 10 and the 2026
Five Eyes agentic AI guidance (sandbox isolation, agent RBAC, HITL gates). The security
architecture maps onto both. Two known trade-offs: Bash inspection is blocklist-based because
a complete allowlist for shell commands isn't feasible, and the hook code itself isn't
integrity-checked (modifying a hook requires prior filesystem access, which is a higher-order
breach than the injection attacks the system is designed to catch). PostToolUse hooks warn
rather than block — Claude Code's API doesn't support blocking after content lands in context.

---

## Local inference routing

secunit ships a complete local-first inference layer on top of Claude Code. Configure any
OpenAI-compatible backend (Ollama, llama.cpp, llama-server, LM Studio) and PAI routes to it
automatically based on tier, model warmth (whether the model is already loaded in memory), and availability.

**Caveat:** Claude Code — and the Claude model behind it — is still the orchestrator. The Algorithm,
DA, and skill execution all run on Claude; that requires the Anthropic API, or a frontier-capable
model behind an OpenAI-compatible endpoint (e.g., a self-hosted Qwen3-235B or similar). Local
models handle sub-tasks at specific tiers; they are workers, not the main brain.

- **`inference-routing.yaml`:** manifest mapping model names to tiers (fast/standard/smart);
  ships with example configs; populate latencies from your own `BenchmarkLocalModels.ts` run.
- **`skill-routing.yaml`:** per-skill routing overrides; specific skills can demand specific
  backends
- **Warmth-aware routing:** checks recent inference history; routes to already-loaded models
  to avoid cold-start penalty
- **Local-first with fallback:** attempts local endpoint first (configurable timeout), falls
  back to Claude automatically on failure or rate limits
- **Benchmark tooling:** `BenchmarkLocalModels.ts` and `QualityTestModels.ts` measure
  throughput and quality across configured endpoints before you commit a model to a tier

Any OpenAI-compatible endpoint works. Point `inference_hosts` in `PAI_CONFIG.yaml` at your
hardware and the routing layer handles the rest.

**Backend fallback chain.** When the primary provider is rate-limited or down, `Inference.ts`
fails over automatically instead of stalling: Anthropic → secondary cloud provider → local
Ollama. `BackendHealth.ts` is a one-shot CLI that probes every configured backend and prints
a clean ✅/❌ readout, so you know what's actually reachable before you're mid-session and
something times out. `ECONNREFUSED`, `ETIMEDOUT`, and HTTP 503 are treated as usage-limit
signals that trigger failover, not silent hangs. `DOCUMENTATION/Resilience/FaultTaxonomy.md`
documents the failure-mode → fallback-action mapping the chain is built from.

---

## Backend switching — when Claude Code itself needs a different endpoint

`Inference.ts` fallback (above) covers tool- and subagent-level calls. Sometimes you need
Claude Code's own CLI session — the orchestrator, not just a subtask — to run against a
different Anthropic-compatible endpoint: a cloud provider when Anthropic is rate-limited, or a
local model when you're offline entirely. Four small scripts at the repo root handle this by
setting/unsetting the `ANTHROPIC_*` env vars Claude Code reads at startup. **Source them, don't
execute them** — they need to modify your current shell's environment.

| Script | Switches to | Notes |
|---|---|---|
| `glm.sh` | Z.ai GLM (cloud) | Opus-level GLM-5.2 for Sonnet/Opus slots, GLM-4.5-air for Haiku |
| `minimax.sh` | MiniMax M3 (cloud) | Secondary cloud fallback; all model slots map to MiniMax-M3 |
| `offline.sh` | Local Ollama | Routes to a local/LAN inference host; works fully offline |
| `offline-off.sh` | Anthropic direct | Unsets every override, restores default routing |

```bash
# Switch to a cloud fallback when Anthropic is rate-limited
source ~/.claude/glm.sh        # or: source ~/.claude/minimax.sh

# Go fully local (e.g. Ollama running on this machine or a LAN host)
export PAI_OFFLINE_HOST=127.0.0.1   # or a Tailscale/LAN IP of a dedicated inference box
source ~/.claude/offline.sh

# Revert to Anthropic direct
source ~/.claude/offline-off.sh
```

**Credentials.** `glm.sh` and `minimax.sh` read their API keys via `passage show api/glm` /
`passage show api/minimax` if [passage](https://github.com/FiloSottile/passage) (Filippo
Valsorda's age-backed password manager) is installed; otherwise they fall back to the
`GLM_API_KEY` / `MINIMAX_API_KEY` env vars. Set whichever you use before sourcing the script.
Both scripts guard against an empty key and print the fix instead of starting Claude Code
against a backend with no credentials.

**Offline mode** (`offline.sh`) expects an Ollama instance reachable at `$PAI_OFFLINE_HOST` on
port 11435, serving a tool-use-capable model (Claude Code's tool-call grammar needs a model that
actually supports function calling — not every small local model does). `PAI_OFFLINE_HOST`
defaults to `127.0.0.1`. `offline.sh` documents the same fallback tiers `Inference.ts` uses
(Nous, OpenRouter, direct Ollama) for when you need inference outside the Claude Code shell too.

Each script prints what it just changed and how to reverse it — check the terminal output after
sourcing before you start relying on the new backend.

---

## Pulse autopilot code review

Pulse (the always-on companion process) can run a nightly, report-only code review against
configured repos: `/code-review high` via a headless `claude -p` call, findings written to a
JSONL queue, served over HTTP through a Pulse module. It never auto-fixes — it surfaces
findings for you to triage in the morning, the same way you'd review a teammate's overnight
PR comments. Configure repos and schedule in `PULSE.toml`.

---

## Feed + knowledge pipeline

secunit adds a knowledge acquisition layer that turns daily reading into retrievable session
context. A cron-driven pipeline handles scraping, scoring, and harvesting automatically;
`tldr-suggestions.md` is the human-readable output; cherry-pick from there to `PROJECTS_TODO.md`.

- **TLDR pipeline:** `TLDRCatchup.ts` orchestrates the full run: scrapes newsletters (Tech,
  AI, InfoSec, Dev, DevOps), scores each article against your profile via `TLDRHarvest.ts`,
  auto-triages by score threshold, harvests above-threshold items to `MEMORY/KNOWLEDGE/TLDR/`,
  and surfaces results in `tldr-suggestions.md`
- **Knowledge harvester:** `KnowledgeHarvester.ts` ingests RSS feeds, URLs, or single
  articles on demand; `SessionHarvester.ts` mines prior sessions for extractable knowledge
- **Graph-enhanced retrieval:** `KnowledgeGraphLib.ts` builds a typed edge graph from
  `[[wikilink]]` references in memory files; BM25 (lexical keyword search) + graph traversal run in parallel.
  GBrain (Tan, 2026) found +31.4pt precision improvement from graph extraction on a
  comparable corpus scale. DCI (arXiv:2605.05242) found BM25+grep outperforms semantic
  embeddings by 16 points for agentic retrieval at bounded corpus sizes — validating the
  lexical-first retrieval choice.

The result: your reading and prior session work surface automatically during Algorithm
OBSERVE (the first phase — context and prior work gathered before any planning) instead of
requiring explicit recall.

### Project memory

Active projects get the same treatment as research notes and people: a structured knowledge
file in `MEMORY/KNOWLEDGE/Projects/`, indexed by BM25, wikilinked into the graph.

The format is a contract with the retrieval system:

```yaml
---
name: project-asa
title: ASA vibe appsec scanner          # BM25 title match — highest weight
description: ...
type: project-todo
tags: [appsec, python, cli, dast, sast] # tag co-occurrence scoring
---

## Open Tasks
- [ ] DAST coverage tuning ...

## Context                               # this section is what BM25 excerpts
Design context, architecture notes, key constraints.
What you'd want surfaced when the Algorithm asks "what's the state of this project?"

## Related
[[knowledge_designing_secure_software]] [[knowledge_owasp_agentic_top10]]
```

`title:` carries the highest BM25 weight. `tags:` add co-occurrence scoring. `## Context`
is what gets excerpted in retrieval results — design notes and constraints, not just a
task list. `## Related` wikilinks are live graph edges; a query that lands on this file
can hop to linked research files in a single `--graph` traversal step.

The practical effect: ask about your appsec scanner during OBSERVE and the retrieval
layer surfaces the project's open tasks, current priorities, and design constraints
automatically — same as it would surface a person's background or a research paper's
key findings. The backlog is ambient context, not something you paste in.

The alternative — a single large `PROJECTS_TODO.md` — isn't retrievable. BM25 can't
score it, the graph can't traverse it, and OBSERVE can't excerpt it selectively. It
accumulates until it's too large to quote and gets manually grepped session by session.

**Caveat:** This is retrieval, not replay. Prior sessions don't resurface as full context —
what surfaces is what was explicitly captured: harvested knowledge items, work-completion
learning, and ISA state for in-progress tasks. A session that produced no loggable artifacts
leaves no retrievable trace. The memory system compounds deliberately over time; it doesn't
reconstruct what was never logged.

---

## Pairs well with

**Hermes** is a cross-platform messaging bridge — Telegram, Discord, Slack, WhatsApp, Signal,
Matrix. Configured as an MCP server alongside secunit, it makes conversation context from
connected platforms available during sessions. Worth noting for security-conscious installs:
Hermes ships its own defense-in-depth (pre-execution scanner, context injection protection,
hardline blocklist) that aligns with secunit's threat model rather than creating a gap in it.

**Antigravity** (agy) is Google's agent platform — brings a real browser where `WebFetch`
breaks: JS-heavy pages, Reddit threads, SPAs. The knowledge pipeline handles clean URLs
natively; route anything that needs rendering through agy.

Neither is required. Both extend the same surface secunit already builds on.

---

## Skills (46 public)

Skills are composable domain units that self-activate based on task triggers — PAI's way of
extending Claude's capabilities without bloating the system prompt.

**Cognition**
`ApertureOscillation` `Council` `FirstPrinciples` `IterativeDepth`
`RootCauseAnalysis` `Science` `SystemsThinking` `Aphorisms`

**Research**
`ArXiv` `ContextSearch` `ExtractWisdom` `Knowledge` `PrivateInvestigator` `Research`

**Creative**
`Art` `BeCreative` `Ideate` `Webdesign` `WriteStory`

**Infrastructure**
`Agents` `CreateCLI` `CreateSkill` `Daemon` `Delegation` `DualCheck` `Evals`
`ISA` `Loop` `Migrate` `Optimize` `PAIUpgrade` `Prompting` `SessionFork` `TmuxCliDriver` `Verify`

**Security**
`RedTeam` `WorldThreatModel`

**Web / Data**
`Apify` `BrightData` `Browser` `Fabric` `Interceptor`

**Life OS**
`BitterPillEngineering` `Interview` `Sales` `Telos`

---

## Mobile access

secunit runs on a VM. VMs run all the time. Tailscale is free.

Put secunit on a home VM, add it to your Tailnet, and it's reachable via SSH from anywhere
with an internet connection — phone, tablet, borrowed laptop, hotel WiFi. On Android,
ConnectBot handles the SSH side. You open a terminal, you're in your session, your DA has
context, the Algorithm runs. The full thing, from a phone, from anywhere.

The pieces: a Linux VM running Claude Code + secunit, a Tailscale node on that VM, Tailscale
on your phone, ConnectBot (or any SSH client). No port forwarding, no VPN config, no
exposed services. Tailscale handles the NAT traversal.

What you get: a personal AI infrastructure that travels with you without any of it living
on your phone or in a cloud you don't control.

---

## Contributing

You're in Claude Code. Go forth — fix, improve, extend as you see fit.

Do us all a favor: ask it to work carefully. Use the scope gate. Let OBSERVE finish before it
builds anything. Run the security pipeline on changes before pushing. If you're adding a skill,
have it write a test. If you're modifying a hook, smoke-test it with synthetic stdin before
assuming the typecheck passing means anything.

The codebase is instrumented — `algorithm-reflections.jsonl` and `MEMORY/OBSERVABILITY/` will
tell you if something's quietly wrong. Check them.

PRs welcome. Open issues for anything you find broken.
