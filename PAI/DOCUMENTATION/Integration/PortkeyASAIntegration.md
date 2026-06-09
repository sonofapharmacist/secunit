# Portkey + ASA Integration: Agentic Security Observability

## Overview

Portkey's centralized logging enables three critical ASA capabilities:
1. **Inference Supply Chain Audit** — Every LLM call traced with model/cost/latency
2. **Prompt Injection Detection** — Anomalous request patterns and safety verdicts
3. **AI Component Risk Scoring** — Evidence-based security posture for agentic systems

This document maps Portkey data to ASA findings and client narratives.

---

## ASA Finding Categories

### Category 1: Inference Governance

**Finding:** "Unmonitored inference paths allow unauthorized model escalation"

**Evidence from Portkey:**
- Trace every `Inference.ts` call with model name, tier (fast/standard/smart), cost
- Identify requests that escalate tier without explicit approval
- Flag model switching (Claude → DeepSeek → Ollama) without governance

**Portkey Query:**
```sql
SELECT trace_id, model, level, cost
FROM logs
WHERE span_name = 'inference'
  AND (level != LAG(level) OVER (PARTITION BY trace_id ORDER BY timestamp))
  OR (model != LAG(model) OVER (PARTITION BY trace_id ORDER BY timestamp))
```

**Remediation:** Deploy ISA gates at inference tier escalation points

---

### Category 2: Prompt Injection Attempt Detection

**Finding:** "Insufficient validation of user-supplied prompts before model invocation"

**Evidence from Portkey:**
- Log request body (debug=true) with hash-based deduplication
- Compare against known injection patterns (jailbreak, context leakage, goal hijack)
- Track refusal rate by model (abnormally high = attack pattern)

**Portkey Transform Enhancement:**

```typescript
function extractPromptSecuritySignals(event: any) {
  if (event.source !== 'tool-activity' || event.tool_name !== 'Inference') return null;

  const systemPrompt = event.tool_input?.system_prompt || '';
  const userPrompt = event.tool_input?.user_prompt || '';
  
  // Hash for dedup
  const hash = crypto.createHash('sha256')
    .update(userPrompt)
    .digest('hex')
    .slice(0, 8);

  // Check for known injection markers
  const injectionIndicators = {
    context_leakage: /system prompt|internal instructions|secret/i.test(userPrompt),
    goal_hijack: /ignore previous|you are now|forget instructions/i.test(userPrompt),
    jailbreak: /do not refuse|bypass safety|unlawful request/i.test(userPrompt),
  };

  return {
    hash,
    length_chars: userPrompt.length,
    indicators: injectionIndicators,
    risk_score: Object.values(injectionIndicators).filter(Boolean).length / 3,
  };
}
```

**ASA Recommendation:**
- Pre-inference validation hook that scores injection risk
- Block or escalate requests with risk_score > 0.5
- Feed signals to prompt injection detector (Portkey guardrails)

---

### Category 3: Tool Execution Audit

**Finding:** "MCP tool responses uninspected before agent use"

**Evidence from Portkey:**
- Log every tool call + response in hierarchical spans
- Capture response size, latency, error codes
- Flag responses that arrive too quickly (cache poisoning risk) or change unexpectedly

**Portkey Span Hierarchy:**

```
trace_id: session-abc123
├─ span_id: agent-main
│   ├─ span_id: tool:web_fetch (response_time: 1200ms)
│   ├─ span_id: tool:bash_execute (response_time: 45ms) ← suspicious speed
│   └─ span_id: inference:planning (response_time: 2500ms)
└─ span_id: tool:git_commit (response_time: 300ms)
```

**Query for anomalies:**

```sql
SELECT trace_id, span_name, response_time, response_body_hash
FROM logs
WHERE source = 'tool-activity'
GROUP BY span_name
HAVING response_time < PERCENTILE(response_time, 0.01)
  -- tool completed 100x faster than normal = cache/mock response risk
```

**ASA Recommendation:**
- Alert on response_time outliers (< 1st percentile)
- Validate response signatures against expected schemas
- Log tool responses to separate audit trail

---

### Category 4: Cost Attribution & Budget Enforcement

**Finding:** "No cost visibility across inference tiers or models; shadow spending undetected"

**Evidence from Portkey:**
- Automatic cost calculation per request
- Aggregation by tier, model, session
- Budget threshold tracking

**Sample Portkey Payload with Cost:**

```json
{
  "trace_id": "session-abc123",
  "span_name": "inference:standard",
  "model": "claude-sonnet-4",
  "tokens_input": 1543,
  "tokens_output": 287,
  "cost_cents": 15,
  "timestamp": "2026-06-05T14:32:00Z"
}
```

**Narrative for Clients:**
> "Every inference call through PAI is traced with model, tier, and cost. Monthly spend broken down by tier (fast: 30%, standard: 60%, smart: 10%) reveals zero shadow inference — all LLM calls flow through approved gateway. Cost trends by team enable FinOps oversight."

---

## Implementation: Enhanced Portkey Transform

Update `observability-transport.ts` to emit ASA-enriched events:

```typescript
function transformEventsToPortkeyFormatWithSecuritySignals(
  events: any[],
  metadata: Record<string, unknown>
): any[] {
  return events.map(event => {
    const basePayload = {
      trace_id: event.session_id || 'unknown',
      span_id: event.id || `span-${Math.random().toString(36).slice(2, 9)}`,
      span_name: event.source,
      timestamp: event.timestamp || new Date().toISOString(),
      organization: metadata.organization || 'default',
      environment: metadata.environment || 'development',
      version: metadata.version || '5.0.0',
    };

    // Inference security signals
    if (event.source === 'tool-activity' && event.tool_name === 'Inference') {
      const injectionSignals = extractPromptSecuritySignals(event);
      const riskScore = injectionSignals?.risk_score || 0;

      return {
        ...basePayload,
        request: {
          url: 'local://inference',
          method: 'POST',
          headers: { 'x-injection-risk': riskScore.toFixed(2) },
          body: JSON.stringify({
            level: event.tool_input?.level,
            model: event.tool_response?.model,
            prompt_hash: injectionSignals?.hash,
            injection_indicators: injectionSignals?.indicators,
          }),
        },
        response: {
          status: 200,
          headers: {
            'x-tokens-input': event.tool_response?.tokens?.input || '0',
            'x-tokens-output': event.tool_response?.tokens?.output || '0',
            'x-estimated-cost-cents': estimateInferenceCost(
              event.tool_response?.model,
              event.tool_response?.tokens?.input,
              event.tool_response?.tokens?.output
            ),
          },
          body: JSON.stringify({
            model: event.tool_response?.model,
            tokens_used: event.tool_response?.tokens,
            latency_ms: event.duration_ms,
          }),
          response_time: event.duration_ms,
        },
      };
    }

    // Tool execution audit
    if (event.source === 'tool-activity') {
      return {
        ...basePayload,
        request: {
          url: `local://tool/${event.tool_name}`,
          method: 'POST',
          headers: {},
          body: JSON.stringify({
            tool: event.tool_name,
            input: event.tool_input ? '[REDACTED]' : null,
          }),
        },
        response: {
          status: event.tool_response?.status || 200,
          headers: {
            'x-response-time-percentile': calculateLatencyPercentile(
              event.tool_name,
              event.duration_ms
            ),
          },
          body: JSON.stringify({
            response_hash: hashToolResponse(event.tool_response),
            size_bytes: JSON.stringify(event.tool_response).length,
          }),
          response_time: event.duration_ms,
        },
      };
    }

    // Tool failure audit
    if (event.source === 'tool-failure') {
      return {
        ...basePayload,
        request: {
          url: `local://tool/${event.tool_name}`,
          method: 'POST',
          headers: { 'x-failure': 'true' },
          body: JSON.stringify({ tool: event.tool_name }),
        },
        response: {
          status: event.error_code || 500,
          headers: {
            'x-error-type': event.error_type,
          },
          body: JSON.stringify({
            error: event.error_message,
            stacktrace_hash: hashStackTrace(event.error_stacktrace),
          }),
          response_time: event.duration_ms,
        },
      };
    }

    // Default: passthrough
    return {
      ...basePayload,
      request: {
        url: 'local://event',
        method: 'POST',
        headers: {},
        body: JSON.stringify(event),
      },
      response: {
        status: 200,
        headers: {},
        body: JSON.stringify({ recorded: true }),
        response_time: 0,
      },
    };
  });
}

function extractPromptSecuritySignals(event: any): any {
  const userPrompt = event.tool_input?.user_prompt || '';
  const systemPrompt = event.tool_input?.system_prompt || '';

  const injectionIndicators = {
    context_leakage: /system prompt|internal instructions|secret key/i.test(userPrompt),
    goal_hijack: /ignore previous|you are now|forget instructions/i.test(userPrompt),
    jailbreak: /do not refuse|bypass safety|unlawful/i.test(userPrompt),
  };

  const hash = require('crypto')
    .createHash('sha256')
    .update(userPrompt)
    .digest('hex')
    .slice(0, 8);

  return {
    hash,
    length_chars: userPrompt.length,
    indicators: injectionIndicators,
    risk_score: Object.values(injectionIndicators).filter(Boolean).length / 3,
  };
}

function estimateInferenceCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing: Record<string, { input: number; output: number }> = {
    'haiku-4-5': { input: 0.8, output: 4 },      // per MTok
    'sonnet-4': { input: 3, output: 15 },
    'opus-4-5': { input: 15, output: 75 },
    'qwen3-14b': { input: 0, output: 0 },         // local, free
  };

  const rates = pricing[model] || { input: 0, output: 0 };
  return Math.round(
    (inputTokens * rates.input + outputTokens * rates.output) / 1_000_000 * 100
  );
}

function calculateLatencyPercentile(toolName: string, latencyMs: number): string {
  // Placeholder: would query historical percentiles
  if (latencyMs < 100) return 'p05';
  if (latencyMs < 500) return 'p25';
  if (latencyMs < 2000) return 'p50';
  if (latencyMs < 5000) return 'p90';
  return 'p95+';
}

function hashToolResponse(response: any): string {
  return require('crypto')
    .createHash('sha256')
    .update(JSON.stringify(response))
    .digest('hex')
    .slice(0, 8);
}

function hashStackTrace(trace: string | undefined): string {
  if (!trace) return '';
  return require('crypto')
    .createHash('sha256')
    .update(trace)
    .digest('hex')
    .slice(0, 8);
}
```

---

## Client Narrative: AI Inference Audit Trail

### Executive Brief

> Every LLM inference call at [ES Client Name] routes through Portkey's centralized gateway. Zero blind spots. Full trace of model selection, cost, latency, and prompts (with configurable PII masking). Monthly reports show inference tier distribution, cost per feature, and anomaly flags.

### Technical Details

**Traceability:**
- 100% of inference covered (fast/standard/smart tiers)
- Hierarchical spans connect prompts → model → tokens → cost
- Session-level aggregation for cost attribution by team/project

**Governance:**
- Budget thresholds trigger alerts (% of allocated spend)
- Tier escalation decisions logged and auditable
- Model switching requires explicit trace-visible approval

**Security:**
- Prompt injection risk scored before model invocation
- Tool response anomalies flagged (latency outliers, schema mismatches)
- Unified audit log for compliance (HIPAA, SOC2) and incident response

**Cost Visibility:**
- Inference cost broken down by tier (fast 30%, standard 60%, smart 10%)
- Per-session cost tracking for chargeback/showback
- Shadow AI detection (unauthorized calls would appear as unexplained costs)

---

## Rollout for ASA Integration

### Week 1: Foundational Logging
- [ ] Deploy Portkey transport in observability-transport.ts
- [ ] Verify inference calls log to Portkey
- [ ] Enable debug=true (full prompts) for initial validation

### Week 2: Security Signal Enrichment
- [ ] Add prompt injection detection logic
- [ ] Implement cost estimation headers
- [ ] Deploy latency percentile calculation

### Week 3: Client Dashboard & Narrative
- [ ] Build Portkey dashboard queries (cost by tier, injection attempts, tool failures)
- [ ] Create client report template
- [ ] Document remediation paths (guardrails, pre-inference validation)

### Week 4: Automation
- [ ] Set budget alerts in Portkey
- [ ] Tie anomaly flags to ticketing system
- [ ] Automate weekly cost & security summary

---

## Glossary

| Term | Definition |
|------|-----------|
| **Trace** | Complete session lifecycle; trace_id = session_id in PAI |
| **Span** | Single operation within trace (inference, tool call, etc.) |
| **Span Name** | Operation type (e.g., "inference:standard", "tool:bash_execute") |
| **Response Time** | Latency in milliseconds |
| **Debug Flag** | Controls whether full prompt/response content is logged (vs metrics only) |
| **Risk Score** | Injection likelihood (0–1); threshold for escalation typically 0.5 |

