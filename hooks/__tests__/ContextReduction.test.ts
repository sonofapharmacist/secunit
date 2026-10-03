import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { join } from 'path'

// Contract test for the RTK rewrite hook: rewrite only when stdout reaches
// the transcript, never auto-approve, never corrupt piped data.
const HOOK = join(import.meta.dir, '..', 'ContextReduction.hook.sh')

function run(command: string, extra: Record<string, unknown> = {}) {
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command, ...extra } })
  const r = spawnSync('bash', [HOOK], { input, encoding: 'utf-8', stdio: 'pipe' })
  expect(r.status).toBe(0)
  return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput : null
}
const rewritten = (c: string) => run(c)?.updatedInput?.command ?? null

describe('rewrites terminal-bound commands', () => {
  test('simple git', () => expect(rewritten('git status')).toBe('rtk git status'))
  test('&& chain', () => expect(rewritten('cd x && git log -3')).toBe('cd x && rtk git log -3'))
  test('pipe into head is display-only', () => expect(rewritten('git log --oneline | head -5')).toBe('rtk git log --oneline | head -5'))
  test('stderr redirect is fine', () => expect(rewritten('ls -la 2>/dev/null')).toContain('rtk ls'))
  test('|| is not a pipe', () => expect(rewritten('git status || true')).toContain('rtk git status'))
})

describe('never corrupts data fed to another program', () => {
  for (const c of [
    'ls | wc -l',
    'git status --porcelain | wc -l',
    'ls -la hooks | awk \'{s+=$5} END{print s}\'',
    'cd x && ls | wc -l',
    'x=$(git status --porcelain); echo $x',
    'echo `ls`',
    'git log --format=%h > out.txt',
    'ls >> list.txt',
    'ls &> all.txt',
    'curl -s localhost/health | jq .',
  ]) test(c, () => expect(run(c)).toBeNull())
})

describe('shape', () => {
  test('no permissionDecision: CC runs its normal permission check', () => {
    const out = run('git status')
    expect(out.permissionDecision).toBeUndefined()
    expect(out.hookEventName).toBe('PreToolUse')
  })
  test('other tool_input fields are preserved', () => {
    const out = run('git status', { description: 'd', timeout: 5000 })
    expect(out.updatedInput).toEqual({ command: 'rtk git status', description: 'd', timeout: 5000 })
  })
  test('already-rtk, unknown, multi-line and heredoc commands pass through', () => {
    for (const c of ['rtk git status', 'echo hi', 'git status\ngit log', 'cat <<EOF\nx\nEOF']) expect(run(c)).toBeNull()
  })
  test('interceptor screenshot --save is moved out of the cwd', () => {
    expect(rewritten('interceptor screenshot --save')).toBe('mkdir -p /tmp/pai-screenshots && ( cd /tmp/pai-screenshots && interceptor screenshot --save )')
  })
  test('empty and malformed stdin pass through', () => {
    for (const input of ['', 'not json']) {
      const r = spawnSync('bash', [HOOK], { input, encoding: 'utf-8', stdio: 'pipe' })
      expect(r.status).toBe(0)
      expect(r.stdout.trim()).toBe('')
    }
  })
})
