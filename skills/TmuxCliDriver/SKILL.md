---
name: TmuxCliDriver
description: "Drive interactive CLI tools through a real tmux TTY — solves isTTY=false failures where piped stdin makes interactive tools exit immediately without rendering prompts. TmuxDriver.ts manages tmux session lifecycle (create/send/capture/kill/wait/run); the run subcommand accepts trigger=response pairs for automated prompt handling and returns JSON {output, exitCode}. USE WHEN testing interactive CLI, isTTY check fails, need real TTY for CLI testing, hook smoke test needs interactive input, CLI exits on piped stdin, test a prompt-driven tool. NOT FOR web UI testing (use Interceptor or Playwright MCP), NOT FOR non-interactive scripts."
effort: low
---

## Voice Notification

```bash
curl -s -X POST http://localhost:31337/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the WORKFLOWNAME workflow in TmuxCliDriver to ACTION"}' \
  > /dev/null 2>&1 &
```

# TmuxCliDriver

Drives interactive CLI tools through a real tmux TTY. Solves the fundamental problem: Claude Code's Bash tool runs in a non-TTY context, so any CLI that checks `process.stdin.isTTY` (or the shell equivalent) exits immediately when driven via piped stdin. tmux creates a real pseudoterminal that the target process sees as a genuine terminal.

**Tool:** `~/.claude/skills/TmuxCliDriver/Tools/TmuxDriver.ts`

## Workflow Routing

| Workflow | Trigger | File |
|----------|---------|------|
| **Drive** | "drive interactive CLI", "test with tmux", "interactive test", "real TTY" | `Workflows/Drive.md` |

## Quick Reference

- `bun TmuxDriver.ts create <session>` — create named detached session
- `bun TmuxDriver.ts send <session> <text>` — send keystroke + Enter
- `bun TmuxDriver.ts capture <session>` — get current pane text
- `bun TmuxDriver.ts wait <session> <pattern> [--timeout <ms>]` — poll until pattern appears
- `bun TmuxDriver.ts kill <session>` — destroy session
- `bun TmuxDriver.ts run <session> <command> [--respond trigger=response ...] [--timeout <ms>]` — full drive; returns JSON

## Examples

**Example 1: Test a hook that checks isTTY**
```
User: "smoke test my hook — it exits immediately under piped stdin"
→ Invokes Drive workflow
→ bun TmuxDriver.ts run test-hook "bun hooks/MyHook.ts" \
    --respond "Proceed? [y/N]"=y
→ Returns JSON { output: "...", exitCode: 0 }
```

**Example 2: Drive a multi-prompt interactive CLI**
```
User: "test asa.py interactively with tmux"
→ bun TmuxDriver.ts run asa-test "python asa.py" \
    --respond "Enter target URL:"=https://example.com \
    --respond "Confirm scan? [y/N]"=y
→ Captures full session output + exit code
```

**Example 3: Manual step-by-step session**
```
bun TmuxDriver.ts create my-session
bun TmuxDriver.ts send my-session "bun my-tool.ts"
bun TmuxDriver.ts wait my-session "Enter name:"
bun TmuxDriver.ts send my-session "test-value"
bun TmuxDriver.ts capture my-session
bun TmuxDriver.ts kill my-session
```

## Gotchas

- **Trigger-skip bug:** If you pass `--respond "Some prompt"=yes` but a flag like `--force` skips that prompt, the driver will wait for "Some prompt" forever and hang. Remove triggers for any prompts your flags suppress.
- **Session name collision:** If a session with the same name already exists, `create` fails. Either `kill` the old session first or use a timestamp-based name (e.g., `test-$(date +%s)`).
- **bun PATH in tmux:** tmux inherits the environment of the shell that launched it, not the full login shell. If `bun` is in a path added by `.bashrc`/`.zshrc` (not `.profile`), it may not be on PATH inside the session. Pass the full path to bun if needed: `/home/<user>/.bun/bin/bun`.
- **Output buffering:** Some CLIs buffer stdout when not writing to a real TTY, even inside tmux. If `capture` returns empty output unexpectedly, add a short sleep before capturing or use `wait` with a known output pattern.
- **`__EXIT_N__` collision:** The exit-code marker `__EXIT_0__` etc. is chosen to be unusual, but if your CLI genuinely outputs this string, the exit code parse will misfire. Rename the marker in TmuxDriver.ts if needed.
- **tmux must be installed:** The tool calls tmux directly via `spawnSync`. If tmux is absent, every command fails with exit 127. On a fresh PAI VM: `sudo apt install tmux`. Verify with `which tmux` before using the skill.
- **Scrollback vs visible pane:** `capture-pane` without `-S -` only captures the *visible* terminal area. `TmuxDriver.ts` uses `-S -` to capture full scrollback — but if you call tmux directly without that flag, output past the terminal height is silently missing.
- **send-keys → capture race:** `send-keys` is async relative to the process consuming the input. For fast tools like `echo` this doesn't matter; for real interactive tools, use `wait <session> <pattern>` between send and capture instead of a raw `capture` immediately after `send`.
- **Keystroke escaping:** Strings containing `;`, `$`, `"`, or leading `-` may be misinterpreted by tmux before reaching the target process. If your trigger responses contain special characters, test the `send` step manually first.
- **Session name `$$` across invocations:** `$$` expands to the current shell PID. If you call `create` and `send` in separate Bash tool calls, they get different PIDs and therefore different session names. Use a stored variable or a fixed name rather than inline `$$`.
