# Hermes Delegation Convention

Cost-optimized delegation patterns for the Hermes/AGY co-processor architecture.
PAI/Claude remains the Algorithm and memory layer; Hermes/AGY are executors.

## Core Principle

Claude = reasoning, memory, Algorithm decisions.
Hermes/AGY = execution of well-defined, bounded subtasks where the output shape is known in advance.

## When to Delegate to Hermes

| Task Type | Delegate? | Rationale |
|-----------|-----------|-----------|
| Batch scoring / ranking (e.g. TLDR triage) | Yes | Repetitive, output shape fixed, no PAI memory needed |
| Single-URL content extraction | Yes | Stateless fetch → structured output |
| Image generation for UI mockups | Yes (AGY) | `generate_image` is subscription-backed |
| Cross-platform message relay | Yes (Hermes) | Hermes owns platform connectors |
| Algorithm decisions (OBSERVE/THINK/PLAN) | No | Requires PAI context and ISA state |
| Memory writes (LEARN phase) | No | SessionHarvester/KnowledgeHarvester own this |
| ISA scaffolding / verification | No | PAI doctrine, not portable |
| Security pipeline decisions | No | Fail-closed semantics require trust boundary |

## AGY Delegation Pattern

```bash
# Subscription-backed — zero marginal cost
agy --print "system prompt" "task prompt"

# Via Inference.ts
bun ~/.claude/PAI/TOOLS/Inference.ts --backend antigravity --level fast "system" "task"
```

**When to prefer AGY over Claude:**
- Task is self-contained (no PAI memory lookup needed)
- Output is structured and checkable
- Latency matters more than depth
- Claude subscription cap is near

## Hermes Delegation Pattern

Hermes excels at platform-bridged tasks — Telegram, Discord, Slack notifications and reads.

```
# Via MCP tools in session
mcp__hermes__messages_send / mcp__hermes__messages_read
```

**When to prefer Hermes:**
- Sending notifications across platforms
- Reading inbound messages for routing decisions
- Polling external channels on a schedule

## Cost Tracking

First 3 batch delegations should log: task description, token estimate, platform used, outcome.

| # | Task | Platform | Tokens saved | Notes |
|---|------|----------|--------------|-------|
| 1 | TLDR daily triage (120 items) | AGY | ~15k input | Cron running since 2026-05-16 |
| 2 | — | — | — | |
| 3 | — | — | — | |

## Anti-Patterns

- Don't delegate when the subtask needs to read PAI MEMORY — the co-processor has no access
- Don't delegate security gate decisions — they must fail-closed, which requires PAI trust context
- Don't batch delegate Algorithm phases — each phase has doctrine that only PAI enforces
