#!/usr/bin/env bash
# Weekly Gemini 3.8 Flash workload bench (cron). Detects silent model drift behind a stable slug.
# Exit codes: 0 clean · 1 regression below floors.yaml (Pulse notified) · 2 harness error · 3 write fence tripped.
set -u
# Subscription billing only for the Haiku judge: these outrank CLAUDE_CODE_OAUTH_TOKEN (see CLAUDE.md).
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
PAI_DIR="${PAI_DIR:-$HOME/.claude/PAI}"
BENCH="$PAI_DIR/USER/Evals/WorkloadBench"
cd "$PAI_DIR/TOOLS/FreeTierEvals" || exit 2
echo "=== workload_bench_weekly $(date -Is) ==="
bun workload_bench.ts --model flash38 --reps 5 --threshold-file "$BENCH/floors.yaml"
rc=$?
echo "=== exit $rc ==="
exit $rc
