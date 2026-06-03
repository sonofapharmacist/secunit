#!/usr/bin/env bash
# BenchV100.sh — raw speed benchmark for all on-disk GGUFs on your-inference-host V100
# Phase 1: llama-bench (tg128 + pp512) for each model, using fork-optimal binary
# Phase 2: BenchmarkLocalModels.ts latency via temp server on port 11435
#
# Usage: bash PAI/TOOLS/BenchV100.sh [--dry-run] [--phase1-only] [--phase2-only]
set -euo pipefail

your-inference-host="your-inference-host"
UBULLM_HOST="127.0.0.1"
TEMP_PORT=11435
PAI_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
DRY_RUN=false
PHASE1=true
PHASE2=true

for arg in "$@"; do
  case $arg in
    --dry-run) DRY_RUN=true ;;
    --phase1-only) PHASE2=false ;;
    --phase2-only) PHASE1=false ;;
  esac
done

RESULTS_DIR="/tmp/bench-v100-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$RESULTS_DIR"
LOG="$RESULTS_DIR/summary.txt"

IK_BENCH="/home/<username>/ik_llama.cpp/build/bin/llama-bench"
MAIN_BENCH="/home/<username>/llama.cpp/build/bin/llama-bench"
EXPERTS_BENCH="/home/<username>/experts-llama.cpp/build/bin/llama-bench"
IK_SERVER="/home/<username>/ik_llama.cpp/build/bin/llama-server"
EXPERTS_SERVER="/home/<username>/experts-llama.cpp/build/bin/llama-server"
MAIN_SERVER="/home/<username>/llama.cpp/build/bin/llama-server"

# file | alias | bench_fork | server_fork | no_think | notes
# Ordered: smaller first to avoid VRAM fragmentation
MODELS=(
  "nemotron-nano-9b-v2-Q4_K_M.gguf|nemotron-nano-9b-v2|main|main|true|9B SSM fast"
  "NousCoder-14B-Q4_K_M.gguf|nouscoder-14b|main|main|false|14B code"
  "mistral-small-3.1-24b-Q4_K_M.gguf|mistral-small-3.1-24b|main|main|false|24B dense"
  "gemma-4-26B-A4B-it-UD-Q4_K_M.gguf|gemma4:26b|experts|experts|false|26B MoE hot-cache"
  "gemma-3-27b-it-Q4_K_M.gguf|gemma-3-27b|main|main|false|27B dense (legacy)"
  "Qwen3.6-27B-Q4_K_M.gguf|qwen3.6:27b|ik|ik|true|27B dense MTP"
  "Qwen3-30B-A3B-Instruct-2507-IQ4_XS.gguf|qwen3:30b-a3b-q4_K_M|ik|ik|true|30B MoE IQ4_XS baseline"
  "nemotron-3-nano-30b-a3b-IQ4_NL.gguf|nemotron-3-nano-30b-a3b|main|main|true|30B SSM/MoE"
  "Qwen3-30B-A3B-Instruct-2507-UD-Q4_K_XL.gguf|qwen3:30b-a3b-q4_K_XL|ik|ik|true|30B MoE Q4_K_XL"
  "gemma-4-31B-it-Q4_K_M.gguf|gemma4:31b|experts|experts|false|31B dense"
  "Qwen3.6-35B-A3B-UD-Q4_K_M.gguf|qwen3.6:35b-a3b|ik|ik|true|35B MoE largest"
)

log()  { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }
sep()  { log "────────────────────────────────────────────────────────────"; }
dry()  { $DRY_RUN && { log "  [dry-run] would run: $*"; return 0; }; return 1; }

select_bench() {
  case $1 in ik) echo "$IK_BENCH" ;; experts) echo "$EXPERTS_BENCH" ;; *) echo "$MAIN_BENCH" ;; esac
}
select_server() {
  case $1 in ik) echo "$IK_SERVER" ;; experts) echo "$EXPERTS_SERVER" ;; *) echo "$MAIN_SERVER" ;; esac
}

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

# ── PHASE 1: llama-bench raw speed ────────────────────────────────────────────

if $PHASE1; then
  log "╔══════════════════════════════════════════════════════════════╗"
  log "║  PHASE 1 — llama-bench (V100 only, CUDA_VISIBLE_DEVICES=0)  ║"
  log "╚══════════════════════════════════════════════════════════════╝"
  log "Columns: model | pp512 tok/s | tg128 tok/s | fork"
  sep

  P1_LOG="$RESULTS_DIR/phase1-raw.txt"

  for entry in "${MODELS[@]}"; do
    IFS='|' read -r file alias bench_fork _server _no_think notes <<< "$entry"
    bench=$(select_bench "$bench_fork")

    log "  $alias  ($notes)  [$bench_fork fork]"
    if dry "CUDA_VISIBLE_DEVICES=0 $bench -m /data/models/$file -ngl 99 -p 512 -n 128 -r 3 -o csv"; then
      continue
    fi

    result=$(ssh "$your-inference-host" "CUDA_VISIBLE_DEVICES=0 $bench \
      -m /data/models/$file \
      -ngl 99 -p 512 -n 128 -r 3 -o csv 2>&1" || echo "FAILED")

    echo "=== $alias ($bench_fork) ===" >> "$P1_LOG"
    echo "$result" >> "$P1_LOG"

    # extract pp and tg from csv output
    pp=$(echo "$result" | grep -E '^[^,]+,[^,]+,pp' | awk -F',' '{print $NF}' | head -1 | xargs)
    tg=$(echo "$result" | grep -E '^[^,]+,[^,]+,tg' | awk -F',' '{print $NF}' | head -1 | xargs)
    if [[ -n "$pp" && -n "$tg" ]]; then
      log "  ✓ pp512=${pp} tok/s  tg128=${tg} tok/s"
    else
      log "  ✗ parse failed — see $P1_LOG"
    fi
    sep
  done
fi

# ── PHASE 2: BenchmarkLocalModels latency via temp server ─────────────────────

if $PHASE2; then
  log "╔══════════════════════════════════════════════════════════════╗"
  log "║  PHASE 2 — BenchmarkLocalModels.ts (latency, port $TEMP_PORT) ║"
  log "╚══════════════════════════════════════════════════════════════╝"

  log "Stopping main llama-server..."
  dry "ssh $your-inference-host sudo systemctl stop llama-server" || \
    ssh "$your-inference-host" "sudo systemctl stop llama-server 2>/dev/null || true"

  for entry in "${MODELS[@]}"; do
    IFS='|' read -r file alias _bench server_fork no_think _notes <<< "$entry"
    server=$(select_server "$server_fork")

    log "Model: $alias  [$server_fork server]"

    if ! dry "start $alias on port $TEMP_PORT"; then
      ssh "$your-inference-host" "nohup env CUDA_VISIBLE_DEVICES=0 $server \
        -m /data/models/$file -ngl 99 \
        --port $TEMP_PORT --host 0.0.0.0 \
        --alias \"$alias\" --log-disable -c 8192 -np 2 \
        > /tmp/bench-$(echo $alias | tr ':/' '--').log 2>&1 &" || true

      if ! wait_for_server "$TEMP_PORT"; then
        log "  SKIP — server failed to start"
        kill_temp_server
        sep
        continue
      fi
    fi

    flags="--host $UBULLM_HOST:$TEMP_PORT --models $alias --timeout-ms 120000 --gpu-name V100 --gpu-name 'Tesla V100 32GB'"
    [[ "$no_think" == "true" ]] && flags="$flags --no-think"

    dry "(cd $PAI_DIR && bun PAI/TOOLS/BenchmarkLocalModels.ts $flags)" || \
      (cd "$PAI_DIR" && bun PAI/TOOLS/BenchmarkLocalModels.ts $flags 2>&1) | tee -a "$LOG"

    $DRY_RUN || kill_temp_server
    sep
  done

  log "Restarting main llama-server..."
  dry "ssh $your-inference-host sudo systemctl start llama-server" || \
    ssh "$your-inference-host" "sudo systemctl start llama-server"
fi

log "Done. Results at $RESULTS_DIR"
log "  Phase 1 raw:   $RESULTS_DIR/phase1-raw.txt"
log "  Full log:      $LOG"
log ""
log "Next: run QualityTestModels.ts on top candidates, then update inference-routing.yaml"
