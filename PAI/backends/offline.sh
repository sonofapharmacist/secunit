#!/bin/bash
# PAI Offline Mode — routes Claude Code shell to a local Ollama/llama-server host
#
# USE WHEN: Anthropic quota hit or API outage
# SOURCE (don't execute): source ~/.claude/offline.sh
# REVERT: source ~/.claude/offline-off.sh  OR  unset ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN NO_PROXY
#
# SETUP: set PAI_OFFLINE_HOST to your local inference host before sourcing, e.g.
#   export PAI_OFFLINE_HOST=127.0.0.1        # Ollama running on this machine
#   export PAI_OFFLINE_HOST=100.x.y.z        # Tailscale IP of a dedicated inference box
# Defaults to 127.0.0.1 if unset.
#
# ─── RESILIENCE CHAIN ───────────────────────────────────────────────────────
#
# Tier 1 — Claude Code shell routing (this script):
#   ANTHROPIC_BASE_URL → Ollama on your inference host (Anthropic-compat /v1/messages, port 11435)
#   Ollama's Anthropic-compat shim handles Claude Code tool-use grammar.
#   Point this at any machine running Ollama with a tool-use-capable model (e.g. qwen3:30b-a3b).
#   NOTE: OpenRouter/Nous CANNOT be used here — they speak OpenAI format, not Anthropic format.
#
# Tier 2 — Inference.ts cloud fallbacks (available even when Anthropic is down):
#   bun ~/.claude/PAI/TOOLS/Inference.ts --backend nous "sys" "user"
#     → Nous Research (inference-api.nousresearch.com/v1) | NOUS_API_KEY required
#     → Model: nvidia/nemotron-3-ultra:free (or as set in PAI_CONFIG.yaml nous.model)
#   bun ~/.claude/PAI/TOOLS/Inference.ts --backend openrouter "sys" "user"
#     → OpenRouter (openrouter.ai/api/v1) | OPENROUTER_API_KEY required
#     → Model: anthropic/claude-sonnet-4-6 (or any OpenRouter model via --model)
#     → Get key: https://openrouter.ai/keys
#
# Tier 3 — Local Ollama direct (Inference.ts):
#   bun ~/.claude/PAI/TOOLS/Inference.ts --backend ollama "sys" "user"
#     → Routes to your configured host per inference-routing.yaml
#
# ────────────────────────────────────────────────────────────────────────────
#
# What works offline:    E1 Native | hooks | memory | tools | skills | Pulse
#                        Inference.ts → nous, openrouter, ollama (independent of Claude Code)
# What doesn't work:     E3+ Algorithm | voice (ElevenLabs) | feeds | Forge/codex (OpenAI)
#
# Model: any small tool-use-capable model works as a floor (e.g. nemotron-nano-9b-v2, ~5GB)
#   larger models (e.g. qwen3:30b-a3b) give better quality — swap with: claude --model <name>
# Ollama's Anthropic-compat shim runs on :11435 by convention; keep OpenAI-compat servers
# (llama-server, LM Studio) on a separate port so Inference.ts and this script don't collide.

PAI_OFFLINE_HOST="${PAI_OFFLINE_HOST:-127.0.0.1}"

export ANTHROPIC_BASE_URL="http://${PAI_OFFLINE_HOST}:11435"
export ANTHROPIC_AUTH_TOKEN=ollama
export NO_PROXY="${PAI_OFFLINE_HOST},localhost,127.0.0.1"

echo "═══ PAI OFFLINE MODE ═══════════════════════════════════════"
echo "  Shell   : Ollama @ ${PAI_OFFLINE_HOST}:11435"
echo "  Works   : E1 Native | hooks | memory | tools | skills"
echo "  Missing : E3+ Algorithm | voice | feeds | cloud agents"
echo ""
echo "  Inference.ts fallbacks (independent of Claude Code):"
echo "    --backend nous        → Nous Research (NOUS_API_KEY)"
echo "    --backend openrouter  → OpenRouter (OPENROUTER_API_KEY)"
echo "    --backend ollama      → local host (PAI_OFFLINE_HOST)"
echo "════════════════════════════════════════════════════════════"
echo ""
echo "Run:  claude --model <your-tool-use-capable-model>"
echo "Off:  source ~/.claude/offline-off.sh"
