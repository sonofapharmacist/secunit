#!/bin/bash
# PAI Backend Resilience Chain — MiniMax M3 Fallback
# ═══════════════════════════════════════════════════════════════
# Tier 0: Anthropic direct (api.anthropic.com)
# Tier 1: Z.ai GLM-4.7/5.2 (api.z.ai)
# Tier 2: MiniMax M3 (api.minimax.io) ← THIS SCRIPT
# Tier 3: Ollama local (your-ollama-host.example.com:11436)
# ═══════════════════════════════════════════════════════════════
# Source this file to switch to MiniMax backend:
#   source ~/.claude/minimax.sh
#
# Model mapping:
#   All slots   → MiniMax-M3 (only eval-verified model; slug is exact)
#
# CREDENTIAL: reads from `passage show api/minimax` if passage (Filippo Valsorda's
# age-backed password manager) is installed, else falls back to MINIMAX_API_KEY
# env var. Set one or the other before sourcing.
# ═══════════════════════════════════════════════════════════════

export ANTHROPIC_BASE_URL="https://api.minimax.io/anthropic"
if command -v passage >/dev/null 2>&1; then
    export ANTHROPIC_API_KEY="$(passage show api/minimax 2>/dev/null)"
else
    export ANTHROPIC_API_KEY="${MINIMAX_API_KEY}"
fi

# Guard: fail clearly if the key source is missing or empty
if [[ -z "${ANTHROPIC_API_KEY// /}" ]]; then
    echo "⚠  ERROR: no MiniMax API key found"
    echo "   Either: passage insert api/minimax   (if using passage)"
    echo "   Or:     export MINIMAX_API_KEY=...    (before sourcing this script)"
    unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY
    return 1 2>/dev/null || exit 1
fi

# Cleanup from potential prior offline mode
unset ANTHROPIC_AUTH_TOKEN
unset NO_PROXY
unset ANTHROPIC_DEFAULT_OPUS_MODEL

# Model-slot mapping — MiniMax does NOT auto-alias Anthropic model names; must set explicitly
export ANTHROPIC_DEFAULT_HAIKU_MODEL="MiniMax-M3"
export ANTHROPIC_DEFAULT_SONNET_MODEL="MiniMax-M3"
export ANTHROPIC_DEFAULT_OPUS_MODEL="MiniMax-M3"
export ANTHROPIC_SMALL_FAST_MODEL="MiniMax-M3"

# M3 managed context cap = 512K. Native window is 1M (MiniMax-M3[1m] variant), but
# empirical data (r/opencodeCLI 2026-06-18) shows M3 degrades past ~200K — subagents
# at 300-400K burn tokens and get stuck. Operating at 512K gives visibility, headroom,
# and a clean compaction trigger well before the quality cliff.
# See: PAI/MEMORY/KNOWLEDGE/Research/m3-220k-empirical-ceiling-2026-06-18.md
export CLAUDE_CODE_AUTO_COMPACT_WINDOW=512000

echo ""
echo "═══ PAI BACKEND: MINIMAX M3 (CLOUD FALLBACK #2) ════════════════════"
echo "  Endpoint:   https://api.minimax.io/anthropic"
echo "  Model tier: M3 (Sonnet/Opus-level)"
echo "  Model map:  Haiku→text-01, Sonnet/Opus→M3"
echo "  Works:      E1–E5 Algorithm | hooks | memory | tools | skills | voice"
echo "  Note:       Secondary fallback; prefer Z.ai GLM first"
echo ""
echo "  Health:     bun ~/.claude/PAI/TOOLS/BackendHealth.ts"
echo "  Off:        source ~/.claude/offline-off.sh"
echo "  Primary:    source ~/.claude/glm.sh"
echo "════════════════════════════════════════════════════════════════════"
echo ""
