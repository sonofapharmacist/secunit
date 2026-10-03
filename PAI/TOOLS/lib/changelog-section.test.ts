import { describe, expect, test } from 'bun:test'
import { changelogSection, githubRepoSlug } from './changelog-section'

const CL = [
  '# Changelog', '', '## [Unreleased]', '', '---', '',
  '## [0.9.0] — 2026-09-28', '', 'Intro line.', '', '### Security', '- **Fix A.** detail', '', '---', '',
  '## [0.8.1] — 2026-09-27', '', '### Security', '- older', '',
].join('\n')

describe('changelogSection', () => {
  test('returns the section body between its heading and the next version', () => {
    const s = changelogSection(CL, '0.9.0')!
    expect(s.startsWith('Intro line.')).toBe(true)
    expect(s).toContain('- **Fix A.** detail')
    expect(s).not.toContain('0.8.1')
    expect(s).not.toContain('---')
  })
  test('last section runs to end of file', () => {
    expect(changelogSection(CL, '0.8.1')).toBe('### Security\n- older')
  })
  test('missing version → null', () => expect(changelogSection(CL, '1.0.0')).toBeNull())
  test('dots are literal (0.9.0 does not match 0x9y0)', () => {
    expect(changelogSection('## [0x9y0]\nbody', '0.9.0')).toBeNull()
  })
})

describe('githubRepoSlug', () => {
  test('scp-style', () => expect(githubRepoSlug('git@github.com:owner/repo.git')).toBe('owner/repo'))
  test('ssh://', () => expect(githubRepoSlug('ssh://git@github.com/owner/repo.git')).toBe('owner/repo'))
  test('https without .git', () => expect(githubRepoSlug('https://github.com/owner/repo')).toBe('owner/repo'))
  test('non-GitHub → null', () => expect(githubRepoSlug('ssh://git@forge.example:2222/owner/repo.git')).toBeNull())
})
