# Portkey Integration Implementation Checklist

**Target Duration:** 4-6 hours (including testing)

---

## Phase 0: Setup (30 minutes)

- [ ] Create `/home/<username>/.claude/PAI/DOCUMENTATION/Integration/` directory
- [ ] Review `ObservabilitySystem.md` (5 min refresh on current architecture)
- [ ] Read `PortkeyIntegration.md` once end-to-end
- [ ] Register Portkey account at https://portkey.ai (free tier)
- [ ] Create API key + Organization ID
- [ ] Add credentials to `~/.claude/.env`:
  ```
  PORTKEY_API_KEY=pk-xxxxx
  PORTKEY_ORG_ID=org-xxxxx
  ```

---

## Phase 1: Type Definition (20 minutes)

**File:** `/home/<username>/.claude/hooks/lib/identity.ts`

- [ ] Locate `ObservabilityTarget` type definition
- [ ] Add `portkey` to the type union:
  ```typescript
  | { type: 'portkey'; name: string; url: string; apiKey: string; orgId?: string; metadata?: Record<string, unknown> }
  ```
- [ ] Verify TypeScript compilation: `bun check hooks/lib/identity.ts`

---

## Phase 2: Transport Handler (60 minutes)

**File:** `/home/<username>/.claude/hooks/lib/observability-transport.ts`

### Implementation Steps

1. [ ] After `pushToCFKV()` function (line ~217), add `pushToPortkey()`:
   - Copy function body from PortkeyIntegration.md "Step 3"
   - Paste into observability-transport.ts
   - Verify syntax

2. [ ] Add `transformEventsToPortkeyFormat()` helper (same location):
   - Copy from PortkeyIntegration.md
   - Test with sample event data

3. [ ] Modify `pushEventsToTargets()` (line ~255):
   - Add `else if (target.type === 'portkey')` branch
   - Call `await pushToPortkey(target as PortkeyTarget, events);`
   - Keep existing Cloudflare KV and HTTP logic intact

4. [ ] Compile and test:
   ```bash
   cd ~/.claude && bun check hooks/lib/observability-transport.ts
   ```
   - Should show zero errors
   - If PortkeyTarget type missing, add it to identity.ts imports

---

## Phase 3: Configuration (15 minutes)

**File:** `/home/<username>/.claude/settings.json`

- [ ] Locate `observability.targets` array (line ~40 area)
- [ ] Add new target entry:
  ```json
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
  ```
- [ ] Verify JSON syntax (no trailing commas, quotes consistent)
- [ ] Test settings load: `bun << 'EOF'
import { readFileSync } from 'fs';
const settings = JSON.parse(readFileSync('/home/<username>/.claude/settings.json', 'utf-8'));
console.log('Targets:', settings.observability.targets.length);
EOF`

---

## Phase 4: Testing (90 minutes)

### Unit Test: Transform Function

- [ ] Create `/tmp/test_portkey_transform.bun`:
  ```typescript
  import { readFileSync } from 'fs';

  // Mock event
  const mockEvent = {
    timestamp: new Date().toISOString(),
    session_id: 'test-session-001',
    source: 'tool-activity',
    tool_name: 'Inference',
    id: 'event-123',
    tool_input: { level: 'standard', user_prompt: 'Hello' },
    tool_response: { model: 'claude-sonnet-4', tokens: 50 },
    duration_ms: 1200,
  };

  // Call transformEventsToPortkeyFormat (paste from observability-transport.ts)
  const result = transformEventsToPortkeyFormat([mockEvent], {
    environment: 'test',
    version: '5.0.0',
  });

  console.log(JSON.stringify(result, null, 2));
  ```
- [ ] Run: `bun /tmp/test_portkey_transform.bun`
- [ ] Verify output has expected fields:
  - `trace_id` = session_id
  - `span_name` = source
  - `request.url` and `response.body` present
  - `timestamp` is ISO 8601

### Integration Test: Hook Trigger

- [ ] Manually trigger a tool call (e.g., `Read` or `Bash`)
- [ ] Check event was logged:
  ```bash
  tail -1 ~/.claude/PAI/MEMORY/OBSERVABILITY/tool-activity.jsonl | jq .
  ```
- [ ] Verify Portkey received it:
  - [ ] Visit Portkey dashboard: https://dashboard.portkey.ai/logs
  - [ ] Filter by `trace_id` (session ID from your Claude Code session)
  - [ ] Should see 1+ events with `span_name` matching your tool call
  - [ ] Check response body for expected fields

### End-to-End Test: Inference Call

- [ ] Run `bun Inference.ts --level fast "Say hello" "Hello there"`
- [ ] Check that inference event logs:
  ```bash
  tail -5 ~/.claude/PAI/MEMORY/OBSERVABILITY/tool-activity.jsonl | jq '.[] | select(.tool_name=="Inference")'
  ```
- [ ] Verify in Portkey dashboard:
  - Filter by `span_name` = "inference:fast" (or whatever level you used)
  - Check cost headers are present

### Error Scenarios

- [ ] Test with bad Portkey API key (change in settings.json to `pk-bad-key`):
  - Run inference call
  - Should NOT crash; check stderr for graceful error
  - Verify HTTP and local targets still work
- [ ] Test with network timeout (kill internet briefly):
  - Events should still log locally
  - Portkey push should timeout gracefully (8s max)
  - Session continues without interruption

---

## Phase 5: Documentation & Handoff (30 minutes)

- [ ] Create integration record in `PAI/MEMORY/KNOWLEDGE/`:
  - File: `integration_portkey_llm_logging.md`
  - Content: "Portkey logs all LLM inference calls (Inference.ts). Configured in settings.json. Cost tracking + injection detection. See PortkeyIntegration.md for full details."

- [ ] Add to MEMORY.md index:
  ```markdown
  - [Portkey LLM logging integration](../../../PAI/DOCUMENTATION/Integration/PortkeyIntegration.md) — centralized inference monitoring, cost tracking, ASA audit trail
  ```

- [ ] Review checklist items:
  ```bash
  grep -c "^\- \[x\]" /tmp/portkey_checklist.md  # Should be 30+
  ```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "PortkeyTarget not found" on compile | Type not exported from identity.ts | Add to ObservabilityTarget union + export |
| Events logged but not reaching Portkey | API key invalid or env var not loaded | Check ~/.claude/.env, verify PORTKEY_API_KEY is set |
| Transform errors in stderr | Malformed event in JSONL | Check tool-activity.jsonl for non-JSON lines; pipe through `jq .` to validate |
| Portkey dashboard shows no events | URL wrong or network blocked | Verify `https://api.portkey.ai/v1` is reachable: `curl -I https://api.portkey.ai/v1` |
| Cost calculation wrong | Pricing table out of date | Update `pricing` object in `estimateInferenceCost()` |

---

## Success Criteria

After completing all phases, you should be able to:

1. **Run an inference call** and see it logged in Portkey within 2 minutes
2. **Query Portkey dashboard** and find your trace by session ID
3. **See cost header** in Portkey response (x-estimated-cost-cents)
4. **Trigger an injection pattern** and see risk_score > 0 in logs
5. **Verify graceful failure**: break API key, re-run inference, session still works (only Portkey fails)

---

## Quick Verification Commands

```bash
# 1. Check credentials are set
cat ~/.claude/.env | grep PORTKEY

# 2. Validate settings.json syntax
jq '.observability.targets[] | select(.type=="portkey")' ~/.claude/settings.json

# 3. Verify most recent event in tool-activity.jsonl
tail -1 ~/.claude/PAI/MEMORY/OBSERVABILITY/tool-activity.jsonl | jq '.session_id'

# 4. Check Portkey push logs (stderr from hook)
# (These appear in Claude Code's hook error output if present)

# 5. Visit Portkey dashboard and search by trace_id
# https://dashboard.portkey.ai/logs?filter=trace_id:<your_session_id>
```

---

## Next Steps After Integration

1. **Cost Attribution** (Week 2): Add cost summaries to ISA
2. **Guardrails** (Week 3): Integrate Portkey safety checks for injection detection
3. **Analytics** (Week 4): Dashboard queries for cost trends by tier + model
4. **ASA Integration** (Week 5): Embed Portkey evidence in security audit reports

