---
name: new-subsystem-security-system
title: "Added subsystem: Security System — inspector pipeline"
date: 2026-05-31
status: complete
detected: new-subsystem
change: "New subsystem \"Security system\" added to Subsystem Reference"
---

## Decision

Added a PAI-layer security system on top of Claude Code's built-in permissions: `SecurityPipeline.hook.ts` (wholly written for this fork) with composable inspectors — CanaryInspector (session integrity token; if it appears in a tool argument, that's prompt injection propagating into execution), PatternInspector (dangerous command patterns, exfil, destructive ops), EgressInspector (credential and PII screening before data leaves the system), RulesInspector (policy enforcement: no nested claude calls, containment zones). Write and Edit calls additionally pass through ObserveGate (blocks writes if OBSERVE phase sentinel not committed) and PhaseTransitionGuard (enforces Algorithm phase ordering at tool level). ContentScanner runs InjectionInspector on all WebFetch/WebSearch results on the way in.

## Alternatives Rejected

Claude Code's built-in permission system only: no egress control, no prompt injection detection in web content, no phase ordering enforcement. The permission system controls what tools can run; it doesn't inspect what they carry.

CLAUDE.md rules only: rules are advice; hooks are enforcement. Rules degrade under instruction density load (Jaroslawicz 2025); hooks run regardless of model compliance.

## Evidence

The threat model for an LLM system is not OWASP Top 10 — the attacker operates through the model via prompt injection in web content, crafted tool arguments, and instruction override. OWASP LLM Top 10 and the 2026 Five Eyes agentic AI guidance (sandbox isolation, HITL gates, agent RBAC) both point to pre-execution inspection as the correct enforcement layer. `SecurityPipeline.hook.ts` did not exist at initial commit.

## Consequences

All PreToolUse security hooks fail closed on error (`permissionDecision: "ask"` — never silent pass); new inspectors are added to the pipeline, not to CLAUDE.md; the CanaryInspector integrity token is planted at session start and must never appear in generated output or tool arguments. PostToolUse hooks warn rather than block — Claude Code's API does not support blocking after content lands in context.
