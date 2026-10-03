/**
 * changelog-section.ts — pull one version's section out of a Keep-a-Changelog file.
 *
 * Used by release.ts to publish a GitHub Release whose notes are exactly the
 * CHANGELOG entry that shipped in the repo, so the two can't drift.
 */

/**
 * Body of the `## [<version>]` section: everything after its heading up to the
 * next `## [` heading, with `---` separator lines and surrounding blank lines
 * dropped. Returns null when the version has no section.
 */
export function changelogSection(changelog: string, version: string): string | null {
  const lines = changelog.split('\n')
  const esc = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const start = lines.findIndex((l) => new RegExp(`^## \\[${esc}\\]`).test(l))
  if (start === -1) return null
  let end = lines.findIndex((l, i) => i > start && /^## \[/.test(l))
  if (end === -1) end = lines.length
  const body = lines.slice(start + 1, end).filter((l) => l.trim() !== '---').join('\n').trim()
  return body || null
}

/** `owner/repo` from a GitHub remote URL (scp-style, ssh://, or https). Null if not GitHub. */
export function githubRepoSlug(remote: string): string | null {
  const m = remote.match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/)
  return m ? `${m[1]}/${m[2]}` : null
}
