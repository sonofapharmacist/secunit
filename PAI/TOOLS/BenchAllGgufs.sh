#!/usr/bin/env bash
# BenchAllGgufs.sh — warm_p50_ms benchmark for all GGUFs on your-inference-host
# Stops main llama-server, cycles each GGUF through a temp instance on port 11435,
# runs BenchmarkLocalModels.ts for each, then restores the main service.
# Usage: bash PAI/TOOLS/BenchAllGgufs.sh [--dry-run]
set -euo pipefail

your-inference-host="your-inference-host"
UBULLM_HOST="127.0.0.1"
TEMP_PORT=11435
PAI_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
DRY_RUN="${1:-}"
RESULTS_DIR="/tmp/bench-all-ggufs-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$RESULTS_DIR"
LOG="$RESULTS_DIR/summary.txt"

# file | alias | no_think | timeout_ms
MODELS=(
  "nemotron-nano-9b-v2-Q4_K_M.gguf|nemotron-nano-9b-v2|true|60000"
  "NousCoder-14B-Q4_K_M.gguf|nouscoder-14b|true|90000"
  "nemotron-3-nano-30b-a3b-IQ4_NL.gguf|nemotron-3-nano-30b-a3b|true|90000"
  "gemma-3-27b-it-Q4_K_M.gguf|gemma-3-27b|false|120000"
  "mistral-small-3.1-24b-Q4_K_M.gguf|mistral-small-3.1-24b|false|120000"
)

log()  { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }
sep()  { log "────────────────────────────────────────────"; }

wait_for_server() {
  local port="$1"
  log "  waiting for llama-server on port $port..."
  for _ in $(seq 1 60); do
    curl -sf "http://$UBULLM_HOST:$port/health" > /dev/null 2>&1 && return 0
    sleep 3
  done
  log "  ERROR: server on port $port never became healthy"
  return 1
}

kill_temp_server() {
  ssh "$your-inference-host" "pkill -f 'llama-server.*$TEMP_PORT' 2>/dev/null; exit 0" || true
  sleep 3
}

bench_model() {
  local alias="$1" no_think="$2" timeout_ms="$3"
  local flags="--host $UBULLM_HOST:$TEMP_PORT --models $alias --timeout-ms $timeout_ms"
  [[ "$no_think" == "true" ]] && flags="$flags --no-think"
  log "  BenchmarkLocalModels: $alias (no_think=$no_think)"
  [[ "$DRY_RUN" == "--dry-run" ]] && { log "  [dry-run]"; return; }
  (cd "$PAI_DIR" && bun PAI/TOOLS/BenchmarkLocalModels.ts $flags 2>&1) | tee -a "$LOG"
}

# ── main ──────────────────────────────────────────────────────────────────────

log "BenchAllGgufs — $(date)"
log "Results dir: $RESULTS_DIR"
sep

# Phase 0: bench currently loaded model without touching the service
log "PHASE 0 — qwen3:30b-a3b-q4_K_M (currently loaded, port 11434)"
[[ "$DRY_RUN" != "--dry-run" ]] && wait_for_server "11434"
[[ "$DRY_RUN" != "--dry-run" ]] && \
  (cd "$PAI_DIR" && bun PAI/TOOLS/BenchmarkLocalModels.ts \
    --host "$UBULLM_HOST:11434" \
    --models "qwen3:30b-a3b-q4_K_M" \
    --timeout-ms 90000 2>&1) | tee -a "$LOG"
sep

# Stop main service for GGUF cycling
log "Stopping main llama-server..."
[[ "$DRY_RUN" != "--dry-run" ]] && ssh "$your-inference-host" "sudo systemctl stop llama-server"

sep
log "PHASE 1 — GGUF models via temp server (port $TEMP_PORT)"
sep

for entry in "${MODELS[@]}"; do
  IFS='|' read -r file alias no_think timeout_ms <<< "$entry"

  log "Model: $alias  ($file)"

  if [[ "$DRY_RUN" != "--dry-run" ]]; then
    # Start temp server
    ssh "$your-inference-host" "nohup llama-server \
      -m /data/models/$file -ngl 99 \
      --port $TEMP_PORT --host 0.0.0.0 \
      --alias $alias --log-disable -c 4096 \
      > /tmp/bench-$alias.log 2>&1 &" || true

    if ! wait_for_server "$TEMP_PORT"; then
      log "  SKIP — server failed to start"
      kill_temp_server
      sep
      continue
    fi
  fi

  bench_model "$alias" "$no_think" "$timeout_ms"
  [[ "$DRY_RUN" != "--dry-run" ]] && kill_temp_server
  sep
done

# Restore main service
log "Restarting main llama-server (qwen3:30b-a3b-q4_K_M)..."
[[ "$DRY_RUN" != "--dry-run" ]] && ssh "$your-inference-host" "sudo systemctl start llama-server"

log "Done. Full results at $LOG"
