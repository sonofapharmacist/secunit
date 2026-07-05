#!/bin/bash
# PAI Backend Resilience Chain — Z.ai GLM-4.7 / GLM-5.2[1m] Fallback
# ═══════════════════════════════════════════════════════════════
# Tier 0: Anthropic direct (api.anthropic.com)
# Tier 1: Z.ai GLM-4.7 / GLM-5.2[1m] (api.z.ai) ← THIS SCRIPT
# Tier 2: MiniMax M3 (api.minimax.io)
# Tier 3: Ollama local (your-ollama-host.example.com:11436)
# ═══════════════════════════════════════════════════════════════
# Source this file to switch to Z.ai GLM backend:
#   source ~/.claude/glm.sh
#
# Model tiers (Coding Plan):
#   GLM-4.7      → Sonnet-level performance, 1× quota multiplier (legacy default)
#   GLM-5.2      → Opus-level performance, 128K ctx, 3× quota multiplier (current default)
#   GLM-5.2[1m]  → Opus-level, 1M ctx, 3× quota (use glm-5.2-1m.sh for 1M context)
#   GLM-4.5-air  → Haiku-level performance, 1× quota multiplier
#
# GLM-5.2 launched 2026-06-13; supersedes GLM-5.1 on Coding Plan.
# 1M context variant (glm-5.2[1m]) available; 128K regular, 131K output, 2 thinking modes (High/Max), MIT license.
# No published benchmarks at launch — treat as unverified quality claim.
#
# CREDENTIAL: reads from `passage show api/glm` if passage (Filippo Valsorda's
# age-backed password manager) is installed, else falls back to GLM_API_KEY env var.
# ═══════════════════════════════════════════════════════════════

export ANTHROPIC_BASE_URL="https://api.z.ai/api/anthropic"
if command -v passage >/dev/null 2>&1; then
    export ANTHROPIC_API_KEY="$(passage show api/glm 2>/dev/null)"
else
    export ANTHROPIC_API_KEY="${GLM_API_KEY}"
fi

# Guard: fail clearly if the key source is missing or empty
if [[ -z "${ANTHROPIC_API_KEY// /}" ]]; then
    echo "⚠  ERROR: no Z.ai GLM API key found"
    echo "   Either: passage insert api/glm   (if using passage)"
    echo "   Or:     export GLM_API_KEY=...    (before sourcing this script)"
    unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY
    return 1 2>/dev/null || exit 1
fi

# Cleanup from potential prior offline mode
unset ANTHROPIC_AUTH_TOKEN
unset NO_PROXY

# Model-slot mapping — Z.ai server maps these automatically, but explicit overrides are safer
# GLM-5.2 for Sonnet + Opus (128K ctx, 3× quota on Coding Plan)
# GLM-4.5-air for Haiku + small/fast (cheap, 1× quota)
export ANTHROPIC_DEFAULT_SONNET_MODEL="glm-5.2"
export ANTHROPIC_DEFAULT_OPUS_MODEL="glm-5.2"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="glm-4.5-air"
export ANTHROPIC_SMALL_FAST_MODEL="glm-4.5-air"

# 128K context window — set auto-compact to match (use glm-5.2-1m.sh for 1M)
export CLAUDE_CODE_AUTO_COMPACT_WINDOW="128000"

echo ""
echo "═══ PAI BACKEND: Z.AI GLM-5.2 (OPUS-LEVEL, 128K CTX, 3× QUOTA) ══════"
echo "  Endpoint:   https://api.z.ai/api/anthropic"
echo "  Sonnet:     GLM-5.2 (Opus-level, 3× quota, 128K ctx, 131K output)"
echo "  Opus:       GLM-5.2 (same slot — 3× quota, 128K ctx)"
echo "  Haiku:      GLM-4.5-air (cheap, 1× quota) for haiku + small/fast"
echo "  Works:      E1–E5 Algorithm | hooks | memory | tools | skills | voice"
echo "  Caveat:     GLM-5.2 launched 2026-06-13 — no published benchmarks"
echo "  1M ctx:     ANTHROPIC_DEFAULT_SONNET_MODEL=glm-5.2[1m] (and compact=1000000)"
echo "  Health:     bun ~/.claude/PAI/TOOLS/BackendHealth.ts"
echo "  Off:        source ~/.claude/offline-off.sh"
echo "════════════════════════════════════════════════════════════════════════"
echo ""

#if [[ -n "${ANTHROPIC_DEFAULT_OPUS_MODEL:-}" ]]; then
#    echo "⚠  OPUS MODE ENABLED: Using ${ANTHROPIC_DEFAULT_OPUS_MODEL} (3× quota multiplier)"
#    echo ""
#fi
