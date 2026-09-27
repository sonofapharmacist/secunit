#!/bin/bash
# Revert PAI offline/fallback mode — restore normal Anthropic routing
# Clears all backend env vars: ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY (cloud backends),
# ANTHROPIC_AUTH_TOKEN (Ollama), ANTHROPIC_DEFAULT_OPUS_MODEL (GLM Opus override), NO_PROXY
# and model-slot overrides (ANTHROPIC_DEFAULT_SONNET_MODEL, HAIKU, SMALL_FAST)
unset ANTHROPIC_BASE_URL
unset ANTHROPIC_API_KEY
unset ANTHROPIC_AUTH_TOKEN
unset ANTHROPIC_DEFAULT_OPUS_MODEL
unset ANTHROPIC_DEFAULT_SONNET_MODEL
unset ANTHROPIC_DEFAULT_HAIKU_MODEL
unset ANTHROPIC_SMALL_FAST_MODEL
unset ANTHROPIC_MODEL
unset NO_PROXY
echo "PAI back online — routing to api.anthropic.com"
