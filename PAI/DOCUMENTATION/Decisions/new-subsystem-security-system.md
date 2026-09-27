---
name: new-subsystem-security-system
title: "Security System — inspector pipeline hardening and canary subsystem"
date: 2026-05-31
status: complete
detected: new-subsystem
change: "New subsystem \"Security system\" added to Subsystem Reference"
corrected: 2026-08-19
---

> **Correction (2026-08-19).** The original text of this ADR claimed `SecurityPipeline.hook.ts` was "wholly written for this fork" and that it "did not exist at initial commit." Both claims are false. A `git diff` against the initial commit (`45aa5f65`) shows the pipeline, all five original inspectors, and the four security hooks shipped with the upstream scaffold. This revision restates the decision accurately: the fork's contribution is a **fail-open → fail-closed correction**, the **canary subsystem**, and **Algorithm phase enforcement at the tool layer** — not the pipeline itself. Provenance now cited per file.

## Decision

Hardened and extended the inherited PAI security pipeline. Three distinct contributions:

**1. Fail-closed correction (the substantive security fix).** The upstream `pipeline.ts` caught inspector exceptions, logged an `alert`, and called `continue` — skipping the failed layer and proceeding with the tool call. This fork changes that path to return `requireApproval(...)` with a `confirm` event. Rationale: a skipped inspector is indistinguishable from a bypass, so an inspector that cannot complete must not be treated as an inspector that passed.

**2. Canary subsystem (wholly new).** `CanaryInspector.ts`, `CanarySession.hook.ts`, and `HookCanary.hook.ts` did not exist upstream. A per-session integrity token is planted at SessionStart and checked on every PreToolUse call; its appearance in a tool argument, file write, or URL is a deterministic exfiltration signal rather than a heuristic. `HookCanary` separately verifies the hook chain is live, so a silently-unloaded security hook is detectable instead of invisible.

**3. Algorithm phase enforcement at the tool layer (wholly new).** `ObserveGate.hook.ts` (blocks writes unless the OBSERVE phase sentinel is committed) and `PhaseTransitionGuard.hook.ts` (enforces Algorithm phase ordering) move process discipline from prompt-level advice to tool-level enforcement.

Additionally: the five inherited inspectors were extended in place — PatternInspector (220→289 lines), EgressInspector (77→105), RulesInspector (117→125) — and the surrounding hooks tightened: `SecurityPipeline.hook.ts` (75→115), `ContentScanner.hook.ts` (58→71), `PromptGuard.hook.ts` (96→116). `SmartApprover.hook.ts` is unmodified at 188 lines.

## Provenance

Verified against `45aa5f65` (2026-05-04) on 2026-08-19.

| Component | Origin | Change |
|---|---|---|
| `SecurityPipeline.hook.ts` | upstream | 75 → 115 lines |
| `security/pipeline.ts` | upstream | 115 → 118; **fail-open → fail-closed** |
| `security/types.ts`, `logger.ts` | upstream | unchanged / minor |
| `PatternInspector.ts` | upstream | 220 → 289 lines |
| `EgressInspector.ts` | upstream | 77 → 105 lines |
| `RulesInspector.ts` | upstream | 117 → 125 lines |
| `InjectionInspector.ts`, `PromptInspector.ts` | upstream | minor |
| `ContentScanner.hook.ts` | upstream | 58 → 71 lines |
| `PromptGuard.hook.ts` | upstream | 96 → 116 lines |
| `SmartApprover.hook.ts` | upstream | unmodified |
| **`CanaryInspector.ts`** | **this fork** | 107 lines, new |
| **`CanarySession.hook.ts`** | **this fork** | new |
| **`HookCanary.hook.ts`** | **this fork** | new |
| **`ObserveGate.hook.ts`** | **this fork** | new |
| **`PhaseTransitionGuard.hook.ts`** | **this fork** | new |

The Inspector/pipeline pattern itself is credited in-source to Goose's `ToolInspectionManager`.

## Alternatives Rejected

**Leave the fail-open behaviour as shipped.** Rejected: an inspector that throws is the exact condition under which enforcement matters most, and the upstream path made that condition silent. The cost of fail-closed is occasional friction on a genuine inspector bug; the cost of fail-open is an undetectable gap.

**Claude Code's built-in permission system only.** No egress control, no prompt injection detection in web content, no phase ordering enforcement. The permission system controls what tools can run; it doesn't inspect what they carry.

**CLAUDE.md rules only.** Rules are advice; hooks are enforcement. Rules degrade under instruction density load (Jaroslawicz 2025); hooks run regardless of model compliance.

**Write-time containment guard.** Considered and later retired — see `containment-enforcement-consolidation`. Containment is enforced at release time by `release.ts`, not prospectively per write.

## Evidence

The threat model for an LLM system is not OWASP Top 10 — the attacker operates through the model via prompt injection in web content, crafted tool arguments, and instruction override. OWASP LLM Top 10 and the 2026 Five Eyes agentic AI guidance (sandbox isolation, HITL gates, agent RBAC) both point to pre-execution inspection as the correct enforcement layer.

The upstream scaffold had the right shape. What it lacked was a failure mode that held under error, a tripwire for the exfiltration case, and any enforcement of the Algorithm's own process invariants.

## Consequences

All PreToolUse security hooks fail closed on error (`permissionDecision: "ask"` — never silent pass). New inspectors are added to the pipeline, not to CLAUDE.md. The canary token is planted at session start and must never appear in generated output or tool arguments. PostToolUse hooks warn rather than block — Claude Code's API does not support blocking after content lands in context.

Because the fail-closed path returns `require_approval` rather than `deny`, a persistently broken inspector degrades to a prompt-on-every-call rather than a hard outage. That is the intended trade, but it means **inspector errors must be monitored** — a silently failing inspector now shows up as approval fatigue rather than an alert. Check `MEMORY/OBSERVABILITY/` for `confirm` events naming an inspector.

Claims of authorship in ADRs are now expected to cite a diff against the initial commit. This record's original overstatement went unchallenged for roughly three months and would have been repeated in any external write-up drawn from it.
