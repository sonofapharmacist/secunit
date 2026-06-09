# Portkey + ASA: Workflow Integration for your-organization

---

## Executive Summary

Integrating Portkey logging into your ASA project enables three critical capabilities:

1. **Inference Supply Chain Evidence** — Audit trail for every LLM call used in vibe app assessments
2. **Agentic Risk Scoring** — Prompt injection detection + tool call audit as ASA finding class
3. **Client Cost Transparency** — Per-session inference cost attribution for ES client pitches

**Effort:** 4-6 hours implementation + 2-3 weeks for full analytics & narrative

**ROI:** High-confidence security audit trail replaces manual inference logging. Direct ES client value for "AI supply chain audit" narratives.

---

## Your Current ASA Workflow

**Current State:**
- ASA runs on work machine (Python CLI)
- asa.py covers SAST, SCA, DAST, SDR pillars
- No centralized logging of LLM inference decisions
- Cost tracking manual (if present at all)

**Portkey Addition:**
- Every model inference call (Sonnet reasoning, Haiku classification, DeepSeek fallback) logged
- Trace IDs link inference calls to ASA scan sessions
- Cost per scan broken down by model tier
- Prompt injection risk scored before model invocation

---

## Integration Points in ASA

### Point 1: Scan Initiation

When ASA starts a new scan, log the session:

```python
# In asa.py, at scan start
import os
from datetime import datetime

scan_trace_id = f"asa-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
os.environ['CLAUDE_SESSION_ID'] = scan_trace_id

# Log to observability
log_entry = {
    'timestamp': datetime.now().isoformat(),
    'session_id': scan_trace_id,
    'event': 'asa_scan_start',
    'target_app': args.app_path,
    'phase': 'sast',
}
```

Portkey will automatically group all inference calls under this trace ID.

### Point 2: Model Selection During Scan

When ASA chooses inference model (e.g., Sonnet for reasoning, Haiku for classification):

```python
# Call Inference.ts from Python
import subprocess

result = subprocess.run([
    'bun', '/home/<username>/.claude/PAI/TOOLS/Inference.ts',
    '--level', 'smart',  # or 'standard'/'fast'
    '--json',
    f'--backend claude',
    system_prompt,
    user_prompt,
], capture_output=True, text=True)

# Portkey automatically logs this call with:
# - trace_id = CLAUDE_SESSION_ID (your scan ID)
# - level = 'smart'
# - model = 'claude-opus-4.5'
# - tokens_used + cost estimated + latency tracked
```

### Point 3: Findings Correlated to Inference Calls

In your ASA report, reference the Portkey trace ID:

```
## Finding: Reflected XSS in /search endpoint

**Evidence Trail:**
- Portkey trace: asa-20260605-143200
- Span: inference:standard (DAST analysis phase)
- Model: claude-sonnet-4
- Prompt injection risk: 0.0 (clean)
- Cost: $0.12
- Latency: 2.1s

**Finding Details:**
[standard ASA analysis output]

**Chain of Custody:**
Every inference call for this scan is logged at https://dashboard.portkey.ai/logs?filter=trace_id:asa-20260605-143200
```

---

## Client Narrative: ASA AI Audit Trail

### Pitch to ES Clients

> Your ASA assessment is backed by a complete inference audit trail. Every AI-assisted decision point is traced, costed, and timestamped. This enables two things:
>
> 1. **Reproducibility**: If a finding is questioned, we replay the exact model, prompt, and reasoning from our Portkey logs
> 2. **Transparency**: You see the cost breakdown of our work (which inference tiers we used, why) — no black box
>
> All inference calls are logged to Portkey's centralized gateway. You can verify them yourself.

### Evidence Files to Include in Report

1. **Inference Cost Breakdown** (from Portkey dashboard):
   ```
   Tier Distribution (This Scan):
   - Fast (Haiku): 45% of calls, 5% of cost
   - Standard (Sonnet): 50% of calls, 80% of cost
   - Smart (Opus): 5% of calls, 15% of cost
   
   Total Inference Cost: $47.30
   ```

2. **Security Posture** (from Portkey + ASA):
   ```
   Inference Security Checks:
   - Prompt Injection Risk: All calls scored (avg 0.05, max 0.12)
   - Tool Execution Audit: 342 tool calls traced
   - Response Validation: 100% of model outputs inspected
   - No anomalies detected
   ```

3. **Scan Session Link**:
   ```
   View full trace (inference + tools + errors): 
   https://dashboard.portkey.ai/logs?filter=trace_id:asa-20260605-143200
   ```

---

## ASA Integration Phases

### Phase A: Logging Foundation (Week 1)

**Your Tasks:**
- [ ] Update asa.py to set CLAUDE_SESSION_ID at scan start
- [ ] Ensure Inference.ts calls emit structured events
- [ ] Verify Portkey receives ASA scan events

**Verification:**
- [ ] Run test scan: `./asa.py --app-path /tmp/test-app`
- [ ] Visit Portkey dashboard, filter by session ID
- [ ] See inference events for SAST, SCA, DAST phases

**Success Metric:** 5+ ASA scans logged to Portkey with inference calls visible

---

### Phase B: Cost Attribution (Week 2)

**Your Tasks:**
- [ ] Build Portkey query for cost per ASA scan
- [ ] Correlate cost with scan complexity (app size, number of findings)
- [ ] Template cost breakdown for client reports

**Queries to Add:**
```sql
-- Cost per scan
SELECT 
  trace_id,
  COUNT(*) as inference_calls,
  SUM(cost_cents) / 100 as total_cost_usd,
  AVG(response_time) as avg_latency_ms
FROM logs
WHERE trace_id LIKE 'asa-%'
GROUP BY trace_id
ORDER BY timestamp DESC;

-- Cost by tier
SELECT 
  trace_id,
  span_name,
  COUNT(*) as calls,
  SUM(cost_cents) / 100 as cost_usd
FROM logs
WHERE trace_id = 'asa-20260605-143200'
GROUP BY span_name;
```

**Success Metric:** Can generate cost report for any ASA scan in <5 minutes

---

### Phase C: Security Evidence (Week 3)

**Your Tasks:**
- [ ] Populate ASA findings with Portkey trace links
- [ ] Document prompt injection detection in ASA methodology
- [ ] Create "Inference Security" section of ASA report template

**Template Section:**
```markdown
## Inference Security Audit

This assessment uses AI-assisted analysis (Claude LLM). All inference calls are logged and traced.

### Safety Checks
- Prompt Injection Detection: Every user-supplied input scored for injection risk (threshold: 0.5)
- Tool Call Audit: Every model-invoked tool call logged with response hash
- Model Integrity: Cost and latency tracked; anomalies flagged

### Audit Trail
Portkey Trace ID: [SESSION_ID]
View full logs: https://dashboard.portkey.ai/logs?filter=trace_id:[SESSION_ID]

### Risk Assessment
No prompt injection attempts detected. No tool response anomalies. Cost within expected range for app size.
```

**Success Metric:** ASA reports include inference evidence section; clients ask about it in debrief

---

### Phase D: Automation & Dashboards (Week 4)

**Your Tasks:**
- [ ] Auto-generate cost summary in ASA report
- [ ] Create Portkey dashboard for ES leadership (cost trends, findings correlation)
- [ ] Integrate with billing system (inference cost → client invoice line item)

**Implementation:**
```python
# In asa.py, at report generation
import requests

portkey_token = os.getenv('PORTKEY_API_KEY')
trace_id = os.getenv('CLAUDE_SESSION_ID')

# Fetch cost data from Portkey
cost_data = requests.post(
    'https://api.portkey.ai/v1/analytics/costs',
    json={'trace_id': trace_id},
    headers={'Authorization': f'Bearer {portkey_token}'}
).json()

report['inference_cost_breakdown'] = cost_data
report['portkey_trace_url'] = f'https://dashboard.portkey.ai/logs?filter=trace_id:{trace_id}'
```

**Success Metric:** ASA reports auto-generate cost section; no manual entry needed

---

## Talking Points for ES Leadership

### Board/Executive Pitch

"We're implementing Portkey as a centralized gateway for all AI inference used in ASA assessments. This gives us three competitive advantages:

1. **Reproducibility at Scale** — Every finding is traceable to exact model + prompt + timestamp. Clients can verify our work.
2. **Cost Transparency** — Inference cost per scan breaks down to tier/model. We can pass this to clients or absorb it strategically.
3. **Security Posture** — Prompt injection detection + tool audit = we're demonstrating that AI-assisted security can itself be secure."

### Sales Pitch

"One of our differentiators in the ASA pitch: you get an AI audit trail. Not just findings — the AI reasoning chain itself. That's unusual and valuable. Clients see the cost breakdown, the model tier, everything. Transparency builds trust."

### Delivery/QA Pitch

"Portkey logs let us validate our own quality. We can correlate findings to inference decisions, spot patterns, and improve prompts. Also: if a client disputes a finding, we can replay the exact inference call that generated it."

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Portkey API key exposed | Attacker sees ASA scan data | Rotate key monthly; restrict to read-only token |
| Portkey API down during scan | ASA scan can't call inference | Implement local Ollama fallback; Portkey failure should not block scan |
| Cost overruns (runaway inference calls) | Budget surprise | Set Portkey budget alerts; log token counts locally |
| Prompt injection in ASA prompts | False findings | Pre-scan validation hook; injection risk scoring in Portkey |
| Client sees high cost | Negotiation friction | Include inference cost in proposal; make it a feature ("transparent AI") |

---

## Integration Checklist for ASA Project

### Pre-Integration (Prep)
- [ ] Review Portkey pricing (free tier sufficient for dev)
- [ ] Register Portkey account; get API key
- [ ] Add to ~/.claude/.env on your work machine
- [ ] Brief ES team on change

### Integration (Implementation)
- [ ] Implement Portkey transport in PAI (4-6 hours)
- [ ] Update asa.py to emit trace IDs (30 minutes)
- [ ] Test end-to-end: run ASA scan, verify Portkey receives events (1 hour)

### Validation (Testing)
- [ ] Run 5 ASA scans; verify all log to Portkey
- [ ] Query cost breakdown for each scan
- [ ] Demo to your manager + ASA sponsor

### Rollout (Deployment)
- [ ] Update ASA report template to include inference section
- [ ] Brief sales team on new "AI audit trail" differentiator
- [ ] Include Portkey trace links in client deliverables

---

## Timeline & Dependencies

**Dependency Graph:**
```
Week 1: Portkey transport (PAI/hooks)
   ↓
Week 2: asa.py integration + cost queries
   ↓
Week 3: ASA report template + evidence linking
   ↓
Week 4: Automation + dashboard + client narrative
```

**Critical Path:**
- Transport implementation is prerequisite for everything else
- Cost queries can start as soon as Week 1 events are flowing
- Client narrative can be drafted Week 2, refined Week 3

**Parallel Work:**
- Sales & delivery teams can review messaging while engineering builds

---

## Success Metrics (End of Month)

| Metric | Target |
|--------|--------|
| % of ASA scans logged to Portkey | 100% |
| Mean time to generate cost report | < 5 min |
| Client asks about AI audit trail in debrief | 3+ mentions |
| Inference cost as % of ASA billable time | < 5% |
| Prompt injection attempts detected | 0 (all pre-validation clean) |

---

## Questions for Your Manager

1. Should inference cost be passed to client or absorbed by ES?
2. Is ASA billable at hourly rate or fixed price? (Affects cost narrative)
3. Which clients are priority for "AI audit trail" narrative?
4. Should we display Portkey dashboard to clients, or just include links in reports?

