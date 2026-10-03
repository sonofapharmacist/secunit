import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { selectOld, targets, within, type Target } from './DiskPrune'

const dir = mkdtempSync(join(tmpdir(), 'diskprune-test-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const DAY = 86_400_000
const now = Date.now()
function touch(p: string, ageDays: number, body = 'x') {
  writeFileSync(p, body)
  const t = new Date(now - ageDays * DAY)
  utimesSync(p, t, t)
}

describe('selectOld', () => {
  test('entries scope: only children older than the cutoff', () => {
    const root = join(dir, 'entries'); mkdirSync(root)
    touch(join(root, 'old'), 40); touch(join(root, 'fresh'), 5)
    const got = selectOld({ name: 't', root, scope: 'entries', maxAgeDays: 30 }, now).map((c) => c.path)
    expect(got).toEqual([join(root, 'old')])
  })
  test('files scope recurses and keeps fresh files', () => {
    const root = join(dir, 'files'); mkdirSync(join(root, 'a/b'), { recursive: true })
    touch(join(root, 'a/b/old.log'), 20); touch(join(root, 'a/new.log'), 1)
    const got = selectOld({ name: 't', root, scope: 'files', maxAgeDays: 14 }, now).map((c) => c.path)
    expect(got).toEqual([join(root, 'a/b/old.log')])
  })
  test('match filter limits by basename', () => {
    const root = join(dir, 'bin'); mkdirSync(root)
    touch(join(root, 'agy'), 60); touch(join(root, 'agy.123.old'), 60)
    const got = selectOld({ name: 't', root, scope: 'entries', maxAgeDays: 7, match: /\.old$/ }, now).map((c) => c.path)
    expect(got).toEqual([join(root, 'agy.123.old')])
  })
  test('does not follow a symlinked dir out of the root', () => {
    const outside = join(dir, 'outside'); mkdirSync(outside); touch(join(outside, 'precious'), 90)
    const root = join(dir, 'links'); mkdirSync(root)
    symlinkSync(outside, join(root, 'escape'))
    const got = selectOld({ name: 't', root, scope: 'files', maxAgeDays: 0 }, now + DAY).map((c) => c.path)
    expect(got.some((p) => p.startsWith(outside))).toBe(false)
  })
  test('missing root → no candidates', () => {
    expect(selectOld({ name: 't', root: join(dir, 'nope'), scope: 'entries', maxAgeDays: 0 })).toEqual([])
  })
})

describe('allowlist', () => {
  test('within() rejects the root itself and escapes', () => {
    expect(within('/a/b', '/a/b/c')).toBe(true)
    expect(within('/a/b', '/a/b')).toBe(false)
    expect(within('/a/b', '/a/bc')).toBe(false)
    expect(within('/a/b', '/a/b/../c')).toBe(false)
  })
  test('no target root covers data dirs', () => {
    const home = '/h'
    const data = ['/h/backups', '/h/.claude/.git', '/h/.claude/projects', '/h/.claude/.claude/worktrees']
    for (const t of targets(home) as Target[]) {
      for (const d of data) {
        expect(t.root === d || within(t.root, d) || within(d, t.root)).toBe(false)
      }
    }
  })
})
