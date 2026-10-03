#!/bin/bash
# RTK auto-rewrite hook for Claude Code PreToolUse:Bash.
#
# Delegates the rewrite itself to `rtk rewrite`, which covers far more
# commands than the old hand-rolled pattern list and handles && / ; chains.
# This wrapper owns two things rtk doesn't:
#
# 1. Output fidelity. rtk compresses output even when stdout is not a TTY:
#    `rtk ls | wc -l` is off by one, and `rtk ls -la | awk '{s+=$5}'` sums to 0
#    (measured 2026-09-29). So we only rewrite when every command's stdout
#    reaches the transcript: no pipes (except into head/tail), no $( ) or
#    backticks, and no stdout redirects.
# 2. PAI-specific rewrites (the interceptor screenshot cwd).
#
# No permissionDecision in the output. Claude Code then applies updatedInput and
# runs its normal permission check on the rewritten command, instead of
# auto-approving it as the old "allow" did.
#
# `rtk rewrite` exits 3 on a rewrite and 1 on no rewrite, not the 0 its --help
# claims, so we key on its output rather than its exit code.

# Guards: pass through if dependencies are missing, but warn. A silent skip
# looks exactly like RTK working (see feedback_rtk_hook_session_restart_required.md).
if ! command -v rtk &>/dev/null; then
  echo "[ContextReduction.hook.sh] rtk not found on PATH — RTK rewrite skipped, command passed through unmodified" >&2
  exit 0
fi
if ! command -v jq &>/dev/null; then
  echo "[ContextReduction.hook.sh] jq not found on PATH — RTK rewrite skipped, command passed through unmodified" >&2
  exit 0
fi

INPUT=$(cat 2>/dev/null) || exit 0
[ -z "$INPUT" ] && exit 0
CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
[ -z "$CMD" ] && exit 0

emit() {
  printf '%s' "$INPUT" | jq -c --arg cmd "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecisionReason: "RTK auto-rewrite",
      updatedInput: (.tool_input + {command: $cmd})
    }
  }'
  exit 0
}

# Multi-line scripts and heredocs: pass through untouched.
case "$CMD" in
  *$'\n'*|*'<<'*) exit 0 ;;
esac

# PAI: keep interceptor screenshots out of the cwd (usually ~/.claude).
if [[ "$CMD" =~ ^interceptor[[:space:]]+screenshot([[:space:]]|$) && "$CMD" == *--save* ]]; then
  emit "mkdir -p /tmp/pai-screenshots && ( cd /tmp/pai-screenshots && $CMD )"
fi

# Output fidelity: only rewrite when stdout goes to the transcript.
# Drop trailing display-only filters (| head ..., | tail ...) before checking.
PROBE="$CMD"
while [[ "$PROBE" =~ ^(.*[^|])\|[[:space:]]*(head|tail)([[:space:]][^|]*)?$ ]]; do
  PROBE="${BASH_REMATCH[1]}"
done
PROBE="${PROBE//||/}"                     # logical OR is not a pipe
case "$PROBE" in
  *'|'*|*'$('*|*'`'*) exit 0 ;;           # pipe into a program, or substitution
esac
PROBE="${PROBE//[0-9]>&[0-9]/}"           # 2>&1 and friends
PROBE="${PROBE//2>>/}"; PROBE="${PROBE//2>/}"  # stderr-only redirects
case "$PROBE" in
  *'>'*) exit 0 ;;                        # stdout redirect to a file
esac

REWRITTEN=$(rtk rewrite "$CMD" 2>/dev/null)
[ -n "$REWRITTEN" ] && [ "$REWRITTEN" != "$CMD" ] && emit "$REWRITTEN"
exit 0
