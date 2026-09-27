/**
 * AlgorithmVersionAudit.ts — Deterministic Algorithm version consistency checker
 *
 * Reads PAI/ALGORITHM/LATEST as the canonical version, then checks all known
 * version-bearing files for drift. Auto-fixes regex-replaceable mismatches.
 * Triggers ARCHITECTURE_SUMMARY regeneration if PAISystemArchitecture.md was patched.
 *
 * TRIGGER: Stop hook (via DocIntegrity.hook.ts)
 * CONDITION: Runs when any PAI/ALGORITHM/ file OR a version-bearing doc was modified.
 *
 * FILES AUDITED:
 *   PAI/DOCUMENTATION/PAISystemArchitecture.md  — 3 version refs
 *   PAI/DOCUMENTATION/Algorithm/AlgorithmSystem.md — Current version header
 *   settings.json → pai.algorithmVersion
 *
 * AUTO-FIXES: All three surfaces (regex replace on .md files, JSON patch on settings.json).
 * ARCHITECTURE_SUMMARY.md is auto-generated — not audited directly; regen triggered if needed.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getPaiDir, getClaudeDir } from '../lib/paths';
import { handleRebuildArchSummary } from './RebuildArchSummary';

const TAG = '[AlgorithmVersionAudit]';

// ── Surface definition ───────────────────────────────────────────────────────

interface VersionSite {
  /** Human-readable label for logs */
  label: string;
  /** Absolute path to the file */
  path: string;
  /** Regex that captures the version string in group 1 */
  pattern: RegExp;
  /** Build the replacement string given the canonical version */
  replace: (content: string, version: string) => string;
}

function buildSurface(paiDir: string, claudeDir: string): VersionSite[] {
  return [
    {
      label: 'PAISystemArchitecture.md — version banner',
      path: join(paiDir, 'DOCUMENTATION/PAISystemArchitecture.md'),
      pattern: /PAI \d+\.\d+\.\d+ \| Algorithm v(\d+\.\d+\.\d+)/,
      replace: (content, v) =>
        content.replace(
          /(\bPAI \d+\.\d+\.\d+ \| Algorithm v)\d+\.\d+\.\d+/g,
          `$1${v}`,
        ),
    },
    {
      label: 'PAISystemArchitecture.md — subsystem Version field',
      path: join(paiDir, 'DOCUMENTATION/PAISystemArchitecture.md'),
      pattern: /- \*\*Version:\*\* v(\d+\.\d+\.\d+)/,
      replace: (content, v) =>
        content.replace(
          /(- \*\*Version:\*\* v)\d+\.\d+\.\d+/g,
          `$1${v}`,
        ),
    },
    {
      label: 'PAISystemArchitecture.md — pipeline topology ref',
      path: join(paiDir, 'DOCUMENTATION/PAISystemArchitecture.md'),
      pattern: /currently v(\d+\.\d+\.\d+)\)/,
      replace: (content, v) =>
        content.replace(
          /(currently v)\d+\.\d+\.\d+(\))/g,
          `$1${v}$2`,
        ),
    },
    {
      label: 'AlgorithmSystem.md — Current version header',
      path: join(paiDir, 'DOCUMENTATION/Algorithm/AlgorithmSystem.md'),
      pattern: /\*\*Current version:\*\* v(\d+\.\d+\.\d+)/,
      replace: (content, v) =>
        content.replace(
          /(\*\*Current version:\*\* v)\d+\.\d+\.\d+/g,
          `$1${v}`,
        ),
    },
    {
      label: 'AlgorithmSystem.md — Spec location path',
      path: join(paiDir, 'DOCUMENTATION/Algorithm/AlgorithmSystem.md'),
      pattern: /`PAI\/ALGORITHM\/v(\d+\.\d+\.\d+)\.md`/,
      replace: (content, v) =>
        content.replace(
          /(`PAI\/ALGORITHM\/v)\d+\.\d+\.\d+(\.md`)/g,
          `$1${v}$2`,
        ),
    },
    {
      label: 'settings.json — pai.algorithmVersion',
      path: join(claudeDir, 'settings.json'),
      pattern: /"algorithmVersion":\s*"(\d+\.\d+\.\d+)"/,
      replace: (content, v) =>
        content.replace(
          /("algorithmVersion":\s*")\d+\.\d+\.\d+(")/g,
          `$1${v}$2`,
        ),
    },
  ];
}

// ── Modified file extraction (mirrors DocCrossRefIntegrity pattern) ──────────

function getModifiedFiles(transcriptPath: string): Set<string> {
  const modified = new Set<string>();
  try {
    const content = readFileSync(transcriptPath, 'utf-8');
    for (const line of content.split('\n').filter(Boolean)) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'tool_use' && (entry.name === 'Write' || entry.name === 'Edit')) {
          const p = entry.input?.file_path || '';
          if (p) modified.add(p);
        }
        if (entry.type === 'assistant' && entry.message?.content) {
          for (const block of Array.isArray(entry.message.content) ? entry.message.content : []) {
            if (block.type === 'tool_use' && (block.name === 'Write' || block.name === 'Edit')) {
              const p = block.input?.file_path || '';
              if (p) modified.add(p);
            }
          }
        }
      } catch { /* skip malformed */ }
    }
  } catch { /* transcript unavailable */ }
  return modified;
}

// ── Trigger condition ────────────────────────────────────────────────────────

function shouldRun(modifiedFiles: Set<string>): boolean {
  for (const f of modifiedFiles) {
    if (f.includes('/ALGORITHM/')) return true;
    if (f.includes('PAISystemArchitecture.md')) return true;
    if (f.includes('AlgorithmSystem.md')) return true;
    if (f.endsWith('settings.json')) return true;
  }
  return false;
}

// ── Main handler ─────────────────────────────────────────────────────────────

export async function handleAlgorithmVersionAudit(
  transcriptPath: string,
): Promise<void> {
  const modifiedFiles = getModifiedFiles(transcriptPath);
  if (!shouldRun(modifiedFiles)) {
    console.error(`${TAG} No Algorithm version files modified, skipping`);
    return;
  }
  const paiDir = getPaiDir();
  const claudeDir = getClaudeDir();

  // Read canonical version from LATEST
  const latestPath = join(paiDir, 'ALGORITHM/LATEST');
  if (!existsSync(latestPath)) {
    console.error(`${TAG} LATEST file not found at ${latestPath}, skipping`);
    return;
  }
  const canonical = readFileSync(latestPath, 'utf-8').trim().replace(/^v/i, '');
  if (!/^\d+\.\d+\.\d+$/.test(canonical)) {
    console.error(`${TAG} LATEST contains unexpected value: "${canonical}", skipping`);
    return;
  }
  console.error(`${TAG} Canonical version from LATEST: v${canonical}`);

  const surface = buildSurface(paiDir, claudeDir);
  let fixes = 0;
  let archSummaryTriggerNeeded = false;

  for (const site of surface) {
    if (!existsSync(site.path)) {
      console.error(`${TAG} [SKIP] ${site.label} — file not found`);
      continue;
    }

    const content = readFileSync(site.path, 'utf-8');
    const match = content.match(site.pattern);

    if (!match) {
      // Pattern not present — not necessarily an error (e.g. file format changed)
      console.error(`${TAG} [SKIP] ${site.label} — pattern not matched`);
      continue;
    }

    const found = match[1];
    if (found === canonical) {
      console.error(`${TAG} [OK] ${site.label}: v${found}`);
      continue;
    }

    // Mismatch — auto-fix
    console.error(`${TAG} [DRIFT] ${site.label}: found v${found}, expected v${canonical}`);
    const fixed = site.replace(content, canonical);
    if (fixed === content) {
      console.error(`${TAG} [WARN] ${site.label}: replace produced no change, check regex`);
      continue;
    }
    writeFileSync(site.path, fixed);
    console.error(`${TAG} [FIXED] ${site.label}: v${found} → v${canonical}`);
    fixes++;

    if (site.path.includes('PAISystemArchitecture.md')) {
      archSummaryTriggerNeeded = true;
    }
  }

  if (fixes === 0) {
    console.error(`${TAG} All version sites consistent at v${canonical}`);
    return;
  }

  console.error(`${TAG} Fixed ${fixes} version drift(s) to v${canonical}`);

  // Trigger ARCHITECTURE_SUMMARY regeneration if the master doc was patched
  if (archSummaryTriggerNeeded) {
    console.error(`${TAG} Triggering ARCHITECTURE_SUMMARY regeneration after PAISystemArchitecture.md patch`);
    try {
      await handleRebuildArchSummary();
    } catch (err) {
      console.error(`${TAG} Arch summary regen failed: ${err}`);
    }
  }
}
