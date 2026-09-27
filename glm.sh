#!/bin/bash
# PAI Backend Resilience Chain — Z.ai GLM-5.3 / GLM-4.7 Fallback
# ═══════════════════════════════════════════════════════════════
# Tier 0: Anthropic direct (api.anthropic.com)
# Tier 1: Z.ai GLM-5.3 / GLM-4.7 (api.z.ai) ← THIS SCRIPT
# Tier 2: MiniMax M3 (api.minimax.io)
# Tier 3: Ollama local (your-ollama-host.example.com:11436)
# ═══════════════════════════════════════════════════════════════
# Source this file to switch to Z.ai GLM backend:
#   source ~/.claude/glm.sh
#
# Model tiers (Coding Plan):
#   GLM-4.7      → Sonnet-level performance, 1× quota multiplier (legacy default)
#   GLM-5.3      → Opus-level performance, current default (thinking always-on, no disable)
#   GLM-4.5-air  → Haiku-level performance, 1× quota multiplier
#
# GLM-5.3 released 2026-08-14; same base model as GLM-5.2, gains from post-training/RL only.
# Z.ai's own devpack docs: requests for GLM-5.2/5.1 now auto-route server-side to GLM-5.3.
# BREAKING (confirmed 2026-08-16): thinking can no longer be disabled — omitting the
# `thinking` block on a direct API call returns HTTP 400 code 1210. Claude Code itself
# handles this transparently; only matters if you're calling api/anthropic directly.
# PAI unified-bench (2026-08-15): 40/53 (75.5%) — T=8/9, R=16/17, C=16/27. See
# PAI/MEMORY/KNOWLEDGE/Research/glm-5-3-announcement-2026-08-14.md for full detail.
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
# GLM-5.3 for Sonnet + Opus (thinking always-on, 3× quota on Coding Plan)
# GLM-4.5-air for Haiku + small/fast (cheap, 1× quota)
export ANTHROPIC_DEFAULT_SONNET_MODEL="glm-5.3"
export ANTHROPIC_DEFAULT_OPUS_MODEL="glm-5.3"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="glm-4.5-air"
export ANTHROPIC_SMALL_FAST_MODEL="glm-4.5-air"

# CORRECTED 2026-08-16: prior "practical window ≈ 200K" claim was wrong — the
# 200K value caused Claude Code to hard-stop sessions at real 200K token usage
# ("Context limit reached · /compact or /clear") while Z.ai's serving path was
# never actually near its limit. Verified via direct API probes against
# https://api.z.ai/api/anthropic/v1/messages (model glm-5.3): 156K, 250K, 500K,
# and 949K input tokens ALL returned HTTP 200 with coherent output — the
# server genuinely honors close to its nominal 1M window. See
# MEMORY/WORK/20260816-010534_statusline-context-desync/ISA.md for the full
# investigation (this bug masqueraded as a statusline display bug at first).
# Set to 1000000 (nominal ceiling): tested directly up to 949K clean; the
# 949K-1M gap itself is untested — if a cliff exists in that gap, symptom
# will be the same "Context limit reached" wall documented in the ISA above,
# and the fix is the same diagnostic path (probe the real ceiling, adjust
# this value). Auto-compact fires at 83.5% of this ≈ 835K.
export CLAUDE_CODE_AUTO_COMPACT_WINDOW="1000000"

echo ""
echo "═══ PAI BACKEND: Z.AI GLM-5.3 (OPUS-LEVEL, THINKING ALWAYS-ON) ══════"
echo "  Endpoint:   https://api.z.ai/api/anthropic"
echo "  Sonnet:     GLM-5.3 (Opus-level, 3× quota, 200K ctx, 131K output)"
echo "  Opus:       GLM-5.3 (same slot — 3× quota, 200K ctx)"
echo "  Haiku:      GLM-4.5-air (cheap, 1× quota) for haiku + small/fast"
echo "  Works:      E1–E5 Algorithm | hooks | memory | tools | skills | voice"
echo "  Bench:      unified-bench 40/53 (75.5%) — 2026-08-15, see KNOWLEDGE/Research"
echo "  Caveat:     thinking cannot be disabled (HTTP 400 code 1210 if attempted)"
echo "  Health:     bun ~/.claude/PAI/TOOLS/BackendHealth.ts"
echo "  Off:        source ~/.claude/offline-off.sh"
echo "════════════════════════════════════════════════════════════════════════"
echo ""

#if [[ -n "${ANTHROPIC_DEFAULT_OPUS_MODEL:-}" ]]; then
#    echo "⚠  OPUS MODE ENABLED: Using ${ANTHROPIC_DEFAULT_OPUS_MODEL} (3× quota multiplier)"
#    echo ""
#fi
