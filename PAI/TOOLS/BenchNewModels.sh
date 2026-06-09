#!/usr/bin/env bash
# BenchNewModels.sh — automated bench + quality pipeline for new your-inference-host GGUFs
# Usage: bash PAI/TOOLS/BenchNewModels.sh [--dry-run]
set -euo pipefail

your-inference-host="your-inference-host"
UBULLM_HOST="127.0.0.1"
TEMP_PORT=11435
RESULTS="/tmp/bench-new-models-$(date +%Y%m%d-%H%M%S).txt"
PAI_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
DRY_RUN="${1:-}"

# model-file | alias | min_size_gb | no_think
MODELS=(
  "gemma-3-27b-it-Q4_K_M.gguf|gemma-3-27b|15|false"
  "mistral-small-3.1-24b-Q4_K_M.gguf|mistral-small-3.1-24b|13|false"
  "nemotron-nano-9b-v2-Q4_K_M.gguf|nemotron-nano-9b-v2|6|true"
  "nemotron-3-nano-30b-a3b-IQ4_NL.gguf|nemotron-3-nano-30b-a3b|17|true"
)

log()  { echo "[$(date +%H:%M:%S)] $*" | tee -a "$RESULTS"; }
sep()  { log "────────────────────────────────────────────"; }

wait_for_download() {
  local file="$1" min_gb="$2"
  while true; do
    size=$(ssh "$your-inference-host" "stat -c%s /data/models/$file 2>/dev/null || echo 0")
    size_gb=$(awk "BEGIN{printf \"%.1f\", $size/1000000000}")
    if awk "BEGIN{exit !($size_gb >= $min_gb)}"; then
      log "  ✓ $file ready (${size_gb}GB)"
      return 0
    fi
    log "  ⏳ $file at ${size_gb}GB / ${min_gb}GB — waiting 30s..."
    sleep 30
  done
}

bench_model() {
  local file="$1" alias="$2"
  log "llama-bench: $alias"
  [[ "$DRY_RUN" == "--dry-run" ]] && { log "  [dry-run]"; return; }
  ssh "$your-inference-host" "llama-bench -m /data/models/$file -ngl 99 -p 512 -n 128 2>&1 | grep -E '\|'" | tee -a "$RESULTS"
}

quality_test() {
  local file="$1" alias="$2" no_think="$3"
  log "quality: $alias (no_think=$no_think)"
  [[ "$DRY_RUN" == "--dry-run" ]] && { log "  [dry-run]"; return; }

  ssh "$your-inference-host" "nohup llama-server \
    -m /data/models/$file -ngl 99 \
    --port $TEMP_PORT --host 0.0.0.0 \
    --alias $alias --log-disable -c 4096 \
    > /tmp/llama-${alias}.log 2>&1 &" || true

  log "  waiting for server..."
  for _ in $(seq 1 40); do
    curl -sf "http://$UBULLM_HOST:$TEMP_PORT/health" > /dev/null 2>&1 && break
    sleep 3
  done

  local flags="--chat"
  [[ "$no_think" == "true" ]] && flags="$flags --no-think"

  (cd "$PAI_DIR" && bun PAI/TOOLS/QualityTestModels.ts \
    --host "$UBULLM_HOST:$TEMP_PORT" \
    --models "$alias" \
    $flags 2>&1) | tee -a "$RESULTS"

  ssh "$your-inference-host" "pkill -f 'llama-server.*$TEMP_PORT' 2>/dev/null || true"
  sleep 5
}

# ── main ──────────────────────────────────────────────────────────────────────

log "BenchNewModels — $(date)"
log "Results: $RESULTS"
sep

log "Stopping main llama-server..."
[[ "$DRY_RUN" != "--dry-run" ]] && ssh "$your-inference-host" "sudo systemctl stop llama-server"

# Phase 1: bench all (server stopped, no VRAM conflicts)
sep
log "PHASE 1 — llama-bench"
sep
for entry in "${MODELS[@]}"; do
  IFS='|' read -r file alias min_gb no_think <<< "$entry"
  wait_for_download "$file" "$min_gb"
  bench_model "$file" "$alias"
  sep
done

# Phase 2: quality test each model via temp server
sep
log "PHASE 2 — quality tests"
sep
for entry in "${MODELS[@]}"; do
  IFS='|' read -r file alias min_gb no_think <<< "$entry"
  quality_test "$file" "$alias" "$no_think"
  sep
done

# Restore
log "Restarting main llama-server (qwen3:30b-a3b-q4_K_M)..."
[[ "$DRY_RUN" != "--dry-run" ]] && ssh "$your-inference-host" "sudo systemctl start llama-server"

log "Done. Full results at $RESULTS"
