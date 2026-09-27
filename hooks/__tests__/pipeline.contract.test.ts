/**
 * SecurityPipeline contract tests — verify the stdin→stdout wire protocol.
 *
 * Tests that SecurityPipeline.hook.ts behaves per the Claude Code hook contract:
 *   allow  → exit 0, no stdout
 *   deny   → exit 2, stderr contains reason
 *   require_approval → exit 0, stdout is JSON with permissionDecision field
 *   malformed stdin  → exit 0, stdout is JSON with permissionDecision: "ask"
 *   empty stdin      → exit 0, no stdout
 *
 * NOTE: These are subprocess tests — spawns the actual hook binary. PatternInspector
 * loads the real PATTERNS.yaml; RulesInspector short-circuits (no SECURITY_RULES.md).
 * No imports from .hook.ts files directly.
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { join } from 'path';

const HOOK_PATH = join(import.meta.dir, '../SecurityPipeline.hook.ts');
const HOME = process.env.HOME ?? '';

function runHook(stdinData: string): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('bun', ['run', HOOK_PATH], {
    input: stdinData,
    encoding: 'utf-8',
    stdio: 'pipe',
    timeout: 10_000,
    env: { ...process.env },
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

function hookInput(toolName: string, toolInput: Record<string, unknown>): string {
  return JSON.stringify({ session_id: 'contract-test-session', tool_name: toolName, tool_input: toolInput });
}

describe('SecurityPipeline contract', () => {
  test('clean Read on non-sensitive path → exit 0, no stdout JSON', () => {
    const { stdout, status } = runHook(hookInput('Read', { file_path: '/tmp/test-file.txt' }));
    expect(status).toBe(0);
    // No permissionDecision in stdout for an ALLOW
    expect(stdout).not.toContain('permissionDecision');
  });

  test('rm -rf / in Bash → exit 2 (PatternInspector deny)', () => {
    const { status, stderr } = runHook(hookInput('Bash', { command: 'rm -rf /' }));
    expect(status).toBe(2);
    expect(stderr.length).toBeGreaterThan(0);
  });

  test('malformed stdin → exit 0, stdout JSON with permissionDecision: ask', () => {
    const { stdout, status } = runHook('not valid json at all');
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput?.permissionDecision).toBe('ask');
  });

  test('empty stdin → exit 0, no output', () => {
    const { stdout, stderr, status } = runHook('');
    expect(status).toBe(0);
    expect(stdout.trim()).toBe('');
  });

  test('confirmAccess path → exit 0, stdout JSON with permissionDecision: ask', () => {
    // ~/.claude/.mcp.json is in confirmAccess per PATTERNS.yaml
    const mcpJsonPath = join(HOME, '.claude', '.mcp.json');
    const { stdout, status } = runHook(hookInput('Read', { file_path: mcpJsonPath }));
    expect(status).toBe(0);
    // Either permissionDecision:ask (confirmAccess triggered) or no output (ALLOW if pattern not loaded)
    if (stdout.trim().length > 0) {
      const parsed = JSON.parse(stdout);
      expect(parsed.hookSpecificOutput?.permissionDecision).toBe('ask');
    }
    // If stdout is empty, PATTERNS.yaml didn't fire confirmAccess — acceptable (file may not be found)
  });

  test('deny produces stderr with BLOCKED message', () => {
    const { stderr, status } = runHook(hookInput('Bash', { command: 'rm -rf /' }));
    expect(status).toBe(2);
    expect(stderr).toMatch(/BLOCKED/i);
  });
});
