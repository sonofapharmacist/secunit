# ContentScanner reads `tool_response`; security hooks get runtime contract tests

- **Status:** Accepted
- **Date:** 2026-09-28
- **Scope:** `hooks/ContentScanner.hook.ts`, new `hooks/__tests__/security-hooks.contract.test.ts`

## Context

ContentScanner is the PostToolUse prompt-injection tripwire. It runs on every tool (a matcherless registration) and warns via `additionalContext` when tool output carries an injection pattern.

It read the tool output from `input.tool_result`. Claude Code builds the PostToolUse payload as `{hook_event_name, tool_name, tool_input, tool_response, tool_use_id, duration_ms}` (checked in the 2.1.283 CLI bundle); there is no `tool_result`. Every real payload therefore scanned as empty and passed. Runtime probe before the fix: the same injection text as `tool_response` → no output, exit 0; as `tool_result` → "Injection detected". The hook's 2026-08-26 "verified" note had piped a hand-built payload with the wrong field name, so the check could never have caught this.

Separately, it read and parsed stdin inside one try/catch and returned silently on both, so malformed input also passed unscanned. That breaks the CLAUDE.md critical rule (read failure → allow; parse failure → fail closed).

## Decision

- Read `tool_response` (fall back to `tool_result` for old synthetic callers). Responses are often objects (Bash `{stdout, stderr}`, Read `{file: {content}}`), so the hook scans every string leaf joined by newlines, not `JSON.stringify` output, to keep real line breaks.
- Split stdin read and parse. Unreadable stdin → silent allow. Present but unparseable → `additionalContext` warning that the output went unscanned.
- Pin both security gates on gate events (ContentScanner, PromptGuard) with runtime contract tests that spawn the real hook with payloads mirroring the CLI bundle's construction.
- Add a drift guard: every command or HTTP hook on PreToolUse / PostToolUse / UserPromptSubmit must be classified as a security gate (with a contract test file) or an explicit non-gate. A new hook fails the suite until someone decides which it is.

## Consequences

- The tripwire now actually fires. Expect warnings when reading security code or test fixtures that contain injection phrases; that is the pattern tripwire working, not a regression. Its known limit stands: it catches loud overrides, not deliberate attacks.
- Hand-built hook payloads are only valid evidence when their shape mirrors the CLI bundle. The contract tests encode that shape; update them if Claude Code changes it.
- The HTTP policy hooks (`skill-guard`, `agent-guard`) fail open when Pulse is down. They are classified as non-gates (policy/cost), so that is accepted, but it is recorded here.
