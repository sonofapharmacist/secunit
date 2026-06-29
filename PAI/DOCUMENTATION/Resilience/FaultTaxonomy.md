# PAI Backend Resilience: Fault Taxonomy & Recovery

## Resilience Chain

```
Tier 0: Anthropic Direct (api.anthropic.com)          — primary
   ↓ Fails on: quota exhaustion, 5xx outages, network issues
Tier 1: Z.ai GLM-4.7/5.2 (api.z.ai)                 — primary cloud fallback
   ↓ Fails on: service outage, rate limits
Tier 2: MiniMax M3 (api.minimax.io)                   — secondary cloud fallback
   ↓ Fails on: service outage, API changes
Tier 3: Ollama Local (your-ollama-host.example.com:11436)       — airgap fallback
```

## Tier Capabilities

| Feature | Anthropic | Z.ai GLM | MiniMax M3 | Ollama Local |
|---------|-----------|----------|------------|--------------|
| E1/E2 Native | ✓ | ✓ | ✓ | ✓ |
| E3+ Algorithm | ✓ | ✓ | ✓ | E1 only (slower) |
| Voice (ElevenLabs) | ✓ | ✓ | ✓ | ✓ |
| Feeds (TLDR, etc.) | ✓ | ✓ | ✓ | ✓ |
| Forge/codex (OpenAI) | ✓ | ✓ | ✓ | ✓ |
| TPM ceiling | Yes | No (subscription) | Yes | Hardware-bound |
| Quota cost | $ | $16/mo flat | per-token | Free |
| Eval result | — | 1 F5 violation | 1 F5 violation | E1 only |

## Failure Mode Taxonomy

| Failure Mode | Symptom | Cause | Action | Script |
|--------------|---------|-------|--------|--------|
| **Anthropic quota exhausted** | HTTP 402, "quota exceeded" | Monthly token limit hit | Switch to Z.ai GLM | `source ~/.claude/glm.sh` |
| **Anthropic API outage (5xx)** | HTTP 500/502/503 | Anthropic service degraded | Switch to Z.ai GLM | `source ~/.claude/glm.sh` |
| **Model overloaded (529)** | HTTP 529, "overloaded" | Anthropic capacity full | Switch to Z.ai GLM | `source ~/.claude/glm.sh` |
| **Network timeout (ETIMEDOUT)** | Request hangs, then errors | DNS/routing failure | Run health check, switch | `bun BackendHealth.ts` |
| **Connection refused (ECONNREFUSED)** | Immediate error | Firewall, port blocked | Check VPN, switch backend | `source ~/.claude/minimax.sh` |
| **Inference.ts auto-fallback triggered** | Console: "Claude usage limit" | `isUsageLimitError()` matched | Auto-falls back to Ollama | No action needed |
| **Z.ai rate limited** | HTTP 429 | Prompt quota window full | Wait 5hr window or switch | `source ~/.claude/minimax.sh` |
| **Z.ai outage** | TIMEOUT or 5xx | Z.ai service down | Switch to MiniMax | `source ~/.claude/minimax.sh` |
| **MiniMax outage** | TIMEOUT or 5xx | MiniMax service down | Switch to Ollama | `source ~/.claude/offline.sh` |
| **Ollama not running** | ECONNREFUSED on :11436 | Local service stopped | Start Ollama or cloud | `source ~/.claude/glm.sh` |
| **API degradation (slow)** | 15s+ latency | Anthropic partially down | Watch `latency-per-invocation.jsonl` | If pattern: switch |

## Quick-Reference Recovery Commands

```bash
# Check all backend health (no keys needed)
bun ~/.claude/PAI/TOOLS/BackendHealth.ts

# Switch to Z.ai GLM-4.7 (primary cloud fallback, subscription)
source ~/.claude/glm.sh

# Enable GLM-5.2 Opus-level (after sourcing glm.sh, 3× quota cost)
export ANTHROPIC_DEFAULT_OPUS_MODEL="glm-5.2"

# Switch to MiniMax M3 (secondary cloud fallback)
source ~/.claude/minimax.sh

# Switch to Ollama local (airgap mode, E1 Native only)
source ~/.claude/offline.sh

# Restore Anthropic direct (normal operation)
source ~/.claude/offline-off.sh

# Check current active backend
echo ${ANTHROPIC_BASE_URL:-"api.anthropic.com (default)"}
```

## API Degradation Signature (Pattern B)

When Bash appears dead and API is the cause (not a hook bug):

```bash
# Check for degradation signature
jq 'select(.error | test("Timeout after"))' \
  ~/.claude/PAI/MEMORY/OBSERVABILITY/latency-per-invocation.jsonl | tail -5
```

Multiple `"Timeout after 15000ms"` entries in a short window = API degradation event.
Action: switch backend immediately, don't wait for recovery. Revert once `BackendHealth.ts` shows Anthropic back up.

## Notes

- All cloud backends (Z.ai, MiniMax) speak native Anthropic protocol — no proxy
- Offline/local Ollama requires `ANTHROPIC_AUTH_TOKEN=ollama` (not ANTHROPIC_API_KEY)
- `offline-off.sh` clears BOTH `ANTHROPIC_API_KEY` (cloud) and `ANTHROPIC_AUTH_TOKEN` (local)
- Eval baseline: 2026-06-14, Z.ai Test 19 and MiniMax Test 17 in `non-anthropic-backend-eval-plan/TEST-PLAN.md`
