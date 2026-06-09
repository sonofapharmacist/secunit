# Drive Workflow

Drive an interactive CLI tool through a real tmux TTY and capture its output.

## When to invoke

- Testing a CLI tool that checks `isTTY` and exits under piped stdin
- Hook smoke tests where the tool needs a real terminal
- Multi-prompt interactive tools where you need to feed sequential responses
- Any scenario where `echo "y" | bun tool.ts` fails with isTTY guard

## The Core Problem

Claude Code's Bash tool runs in a non-TTY context. `process.stdin.isTTY` returns `false`. Interactive tools detect this and either refuse to run or skip all prompts. Piped stdin (`echo "y" | ...`) triggers the same guard. tmux creates a real pseudoterminal — the target process sees a genuine terminal.

## Tool Location

```
~/.claude/skills/TmuxCliDriver/Tools/TmuxDriver.ts
```

## Intent-to-Flag Mapping

### Session naming

| Intent | Approach |
|--------|----------|
| One-shot test | Use a timestamp: `test-$(date +%s)` |
| Named for debugging | Use a descriptive name: `asa-smoke`, `hook-test` |
| Parallel tests | Use unique names per test to avoid collision |

### Respond pairs

| User says | Flag pattern |
|-----------|-------------|
| "answer yes to confirm prompt" | `--respond "Confirm? [y/N]"=y` |
| "enter a URL when asked" | `--respond "Enter URL:"=https://example.com` |
| "no prompts / fully automated" | omit `--respond` entirely |

### Timeout

| Scenario | Flag |
|----------|------|
| Fast tool (<2s expected) | `--timeout 5000` |
| Default (most tools) | omit (defaults to 10000ms) |
| Slow scan or build | `--timeout 60000` |

## Execute Tool

### Simple case — single automated run

```bash
bun ~/.claude/skills/TmuxCliDriver/Tools/TmuxDriver.ts run \
  test-$(date +%s) \
  "bun path/to/my-tool.ts" \
  --respond "Prompt text here:"=response-value
```

Output: JSON on stdout — `{"output": "<full pane text>", "exitCode": 0}`

### Multi-prompt case

```bash
bun ~/.claude/skills/TmuxCliDriver/Tools/TmuxDriver.ts run \
  test-$(date +%s) \
  "python my_tool.py" \
  --respond "Enter target:"=https://example.com \
  --respond "Confirm? [y/N]"=y \
  --respond "Output format:"=json \
  --timeout 30000
```

### Manual step-by-step (when you need to inspect state between steps)

```bash
SESSION=debug-$(date +%s)

# Create session
bun TmuxDriver.ts create $SESSION

# Launch the tool
bun TmuxDriver.ts send $SESSION "bun my-tool.ts"

# Wait for first prompt, then respond
bun TmuxDriver.ts wait $SESSION "Enter name:" --timeout 5000
bun TmuxDriver.ts send $SESSION "test-value"

# Capture intermediate state
bun TmuxDriver.ts capture $SESSION

# Wait for second prompt
bun TmuxDriver.ts wait $SESSION "Confirm?" --timeout 5000
bun TmuxDriver.ts send $SESSION "y"

# Capture final output
bun TmuxDriver.ts capture $SESSION

# Clean up
bun TmuxDriver.ts kill $SESSION
```

## Interpreting Output

The `run` subcommand wraps your command as `<cmd>; echo "__EXIT_$?__"` before sending. After all responds are handled, it waits for `__EXIT_` to appear in the pane, parses the exit code, and returns:

```json
{
  "output": "<full captured pane text including all prompts and responses>",
  "exitCode": 0
}
```

The `output` field is the raw pane capture — it includes the prompt text, the responses you sent, and all tool output. Parse it for the content you care about.

## Gotchas

See `SKILL.md ## Gotchas` for the full list. The critical one for this workflow:

**Trigger-skip bug:** If a flag you're passing suppresses a prompt (e.g., `--yes` auto-confirms), do NOT include a `--respond` for that prompt. If you do, the driver waits for text that never appears and hangs until timeout.
