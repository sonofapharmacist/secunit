# Portkey AI Gateway Integration Guide

## Overview

This guide shows how to integrate Portkey AI's logging infrastructure with Claude Code's agentic observability pipeline. The integration enables centralized LLM monitoring, cost tracking, and observability across multiple inference backends (Claude, Ollama, DeepSeek, etc.).

**Current Status:** PAI 5.0.0 uses a pluggable observability target system. Portkey is added as a new target type, alongside existing Cloudflare KV and HTTP transports.

---

## Architecture

### Current PAI Observability (Simplified)

```
Hooks & Tools (inference, tool activity)
    ↓
JSONL event streams (tool-activity.jsonl, tool-failures.jsonl)
    ↓
observability-transport.ts (fan-out router)
    ├→ Cloudflare KV (sync:events, sync:work_state)
    ├→ HTTP POST (local or remote dashboards)
    └→ [NEW] Portkey Logs API
```

### Integration Point

The **observability-transport.ts** module handles all target routing. It already:
- Reads events from JSONL sources
- Normalizes field names (timestamp, session_id, source)
- Fans out to multiple targets via `Promise.allSettled()`
- Handles per-target failures gracefully

**Zero changes needed to existing hooks.** Adding Portkey is a transport-layer feature.

---

## Implementation Steps

### Step 1: Add Portkey Target Type

File: `/home/<username>/.claude/hooks/lib/identity.ts`

Add to the `ObservabilityTarget` type union:

```typescript
export type ObservabilityTarget = 
  | { type: 'cloudflare-kv'; name: string; url?: string; headers?: Record<string, string> }
  | { type: 'http'; name: string; url: string; headers?: Record<string, string> }
  | { type: 'portkey'; name: string; url: string; apiKey: string; orgId?: string; metadata?: Record<string, unknown> };
```

### Step 2: Configure Portkey in settings.json

File: `/home/<username>/.claude/settings.json`

Add a Portkey target to the observability.targets array:

```json
{
  "observability": {
    "targets": [
      {
        "type": "http",
        "name": "local",
        "url": "http://localhost:31337"
      },
      {
        "type": "portkey",
        "name": "portkey-production",
        "url": "https://api.portkey.ai/v1",
        "apiKey": "${PORTKEY_API_KEY}",
        "orgId": "${PORTKEY_ORG_ID}",
        "metadata": {
          "environment": "production",
          "version": "5.0.0",
          "system": "pai"
        }
      }
    ]
  }
}
```

Store credentials in `~/.claude/.env`:

```
PORTKEY_API_KEY=pk-xxxxxxxxxx
PORTKEY_ORG_ID=org-xxxxxxxxxx
```

### Step 3: Add Portkey Transport Handler

File: `/home/<username>/.claude/hooks/lib/observability-transport.ts`

Add this function after the existing pushToCFKV() function:

```typescript
async function pushToPortkey(target: ObservabilityTarget, events: any[]): Promise<void> {
  if (target.type !== 'portkey') return;
  if (!target.url || !target.apiKey) return;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${target.apiKey}`,
  };

  if (target.orgId) {
    headers['x-portkey-organization'] = target.orgId;
  }

  const portkeySessions = transformEventsToPortkeyFormat(events, target.metadata || {});

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    await fetch(`${target.url}/logs`, {
      method: 'POST',
      headers,
      body: JSON.stringify(portkeySessions),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function transformEventsToPortkeyFormat(
  events: any[],
  metadata: Record<string, unknown>
): any[] {
  return events.map(event => {
    const trace_id = event.session_id || 'unknown';
    const timestamp = event.timestamp || new Date().toISOString();

    return {
      trace_id,
      span_id: event.id || `span-${Math.random().toString(36).slice(2, 9)}`,
      span_name: event.source,
      request: {
        url: 'local://pai-event',
        method: 'POST',
        headers: {},
        body: JSON.stringify({
          tool: event.tool_name,
          source: event.source,
          event_type: event.type,
        }),
      },
      response: {
        status: 200,
        headers: {},
        body: JSON.stringify({ recorded: true }),
        response_time: event.duration_ms || 0,
      },
      organization: metadata.organization || 'default',
      environment: metadata.environment || 'development',
      version: metadata.version || '5.0.0',
      user: metadata.user || 'system',
      timestamp,
    };
  });
}
```

### Step 4: Update pushEventsToTargets()

In the same file, update the main export:

```typescript
export async function pushEventsToTargets(): Promise<void> {
  try {
    const events = collectEvents();

    const config = getObservabilityConfig();
    const promises = config.targets.map(async (target) => {
      try {
        if (target.type === 'cloudflare-kv') {
          const eventsJson = JSON.stringify(events);
          await pushToCFKV('sync:events', eventsJson);
        } else if (target.type === 'http') {
          const eventsJson = JSON.stringify(events);
          await pushToHTTPTarget(target, '/api/observability/events', eventsJson);
        } else if (target.type === 'portkey') {
          await pushToPortkey(target, events);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[pushEventsToTargets] ${target.name}: ${msg}\n`);
      }
    });

    await Promise.allSettled(promises);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[pushEventsToTargets] Failed: ${msg}\n`);
  }
}
```

---

## Verification & Debugging

### Test Event Flow

```bash
# 1. Read recent events
tail -5 ~/.claude/PAI/MEMORY/OBSERVABILITY/tool-activity.jsonl | jq .

# 2. Check Portkey dashboard
# https://dashboard.portkey.ai/logs

# 3. Verify transform manually
bun << 'EOF'
const lines = require('fs').readFileSync(
  '/home/<username>/.claude/PAI/MEMORY/OBSERVABILITY/tool-activity.jsonl',
  'utf-8'
).split('\n').filter(l => l);

const events = lines.slice(-5).map(l => JSON.parse(l));
console.log(JSON.stringify(events, null, 2));
EOF
```

---

## Integration with Inference.ts

The Inference.ts tool should emit structured events. Update Inference.ts logging (around line 100+):

```typescript
const inferenceLogEntry = {
  timestamp: new Date().toISOString(),
  session_id: process.env.CLAUDE_SESSION_ID || 'unknown',
  tool_name: 'Inference',
  id: `inference-${Date.now()}`,
  level: args.level || 'standard',
  model: selectedModel,
  backend: args.backend || 'claude',
  duration_ms: endTime - startTime,
  tool_input: {
    level: args.level,
    backend: args.backend,
  },
  tool_response: {
    status: 200,
    model: selectedModel,
    tokens: tokensUsed,
  },
};

appendFileSync(INFERENCE_LOG, JSON.stringify(inferenceLogEntry) + '\n');
```

---

## Cost Tracking

Portkey automatically calculates per-request costs. Enable cost attribution in PAI:

1. **Per-session:** Portkey groups events by trace_id (your session_id)
2. **Cost trends:** Dashboard shows costs by inference level (fast/standard/smart)
3. **Budget alerts:** Configure in Portkey console

---

## Rollout Checklist

### Phase 0: Local Setup (2 hours)
- [ ] Create Integration directory
- [ ] Add Portkey target type to identity.ts
- [ ] Implement pushToPortkey() + transform
- [ ] Test with mock events

### Phase 1: Production (1 day)
- [ ] Register Portkey account (https://portkey.ai)
- [ ] Create API key + Org ID
- [ ] Add credentials to ~/.claude/.env
- [ ] Enable in settings.json
- [ ] Verify events flow to dashboard

### Phase 2: Analytics (1 week)
- [ ] Dashboard queries for cost trends
- [ ] ES client narratives (cost attribution)
- [ ] ASA integration (quality scoring)

---

## Integration Points

| Component | File | Change |
|-----------|------|--------|
| **Target Type** | hooks/lib/identity.ts | Add portkey to ObservabilityTarget union |
| **Transport Handler** | hooks/lib/observability-transport.ts | Add pushToPortkey() + transformEventsToPortkeyFormat() |
| **Configuration** | settings.json | Add portkey target to observability.targets[] |
| **Credentials** | ~/.claude/.env | PORTKEY_API_KEY, PORTKEY_ORG_ID |
| **Inference Events** | PAI/TOOLS/Inference.ts | Emit structured JSON with model/tokens/latency |

---

## References

- **Portkey Logs API:** https://portkey.ai/docs/api-reference/admin-api/data-plane/logs/insert-a-log
- **Portkey Documentation:** https://portkey.ai/docs
- **PAI Observability:** ~/.claude/PAI/DOCUMENTATION/Observability/ObservabilitySystem.md

