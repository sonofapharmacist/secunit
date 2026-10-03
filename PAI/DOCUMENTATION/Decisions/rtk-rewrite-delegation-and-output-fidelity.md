# RTK hook delegates to `rtk rewrite` and never rewrites piped output

- **Status:** Accepted
- **Date:** 2026-09-29
- **Scope:** `hooks/ContextReduction.hook.sh`, new `hooks/__tests__/ContextReduction.test.ts`

## Context

`ContextReduction.hook.sh` rewrote Bash commands to `rtk` equivalents using ~200 lines of hand-kept patterns. It only matched the first command in a line, and it returned `permissionDecision: "allow"`. rtk now ships `rtk rewrite`, which its authors call the single source of truth for hooks. It also handles `&&`/`;` chains.

While testing the swap, we found that rtk compresses output even when stdout is not a TTY:

- `rtk ls | wc -l` → 52; `ls | wc -l` → 53.
- `rtk git status --porcelain | wc -l` → 14; the raw command gives 15.
- `rtk ls -la | awk '{s+=$5}'` → 0; the raw command gives 342983.

The old hook already rewrote pipelines that started with a matching command. On a corpus of 485 real Bash commands taken from transcripts, 26 of its 37 rewrites fed rtk output into another program. One of them, `find ~ -printf ... | awk`, produced a garbled disk-usage histogram on 2026-09-28. A plain delegation to `rtk rewrite` would have made this worse, because it also rewrites inside chains.

## Decision

- The hook passes the command to `rtk rewrite` and keys on its output, not its exit code. The binary exits 3 on a rewrite, although its `--help` says 0.
- The hook rewrites only when every command's stdout reaches the transcript. It skips any pipe except trailing display filters (`| head`, `| tail`), any `$( )` or backticks, and any stdout redirect. Stderr redirects (`2>`, `2>&1`) are allowed.
- The hook emits `updatedInput` without a `permissionDecision`. Claude Code 2.1.284 then applies the rewrite and runs its normal permission check (`hookUpdatedInput`), where it used to auto-approve every rewritten command.
- The PAI-specific interceptor-screenshot cwd rewrite stays in the wrapper.

## Consequences

- On the corpus: 48 rewrites (was 37), and none of them feed a program. Latency is unchanged at ~35 ms per call.
- Savings are lost on pipelines into programs. That's accepted, because correct data comes before tokens.
- Rewritten commands are no longer auto-approved by this hook. In auto mode they go through the classifier like any other command.
- `rtk init --show` still says "no hook installed", because it only recognizes its own hook file. Don't run `rtk init -g`; it would add a duplicate hook.
- The 20-case contract test pins the behavior: it rewrites terminal-bound commands, skips 10 data-feeding shapes, includes no permissionDecision, and preserves the other input fields.
