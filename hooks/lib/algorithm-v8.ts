/**
 * algorithm-v8.ts — shared gate and helpers for Algorithm v8 hook behavior.
 *
 * Every v8 behavior is gated on isV8Active(), which reads PAI/ALGORITHM/LATEST.
 * Writing `7.1.1` to LATEST restores v7 behavior everywhere (ADR:
 * PAI/DOCUMENTATION/Decisions/algorithm-v8-harness-first.md).
 *
 * PAI_ALGORITHM_VERSION overrides LATEST so hooks can be smoke-tested
 * under v8 without flipping the live pointer.
 */

import { existsSync, readFileSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { paiPath } from './paths';

export function algorithmVersion(): string {
  const override = process.env.PAI_ALGORITHM_VERSION;
  if (override && override.trim()) return override.trim().replace(/^v/, '');
  try {
    return readFileSync(paiPath('ALGORITHM', 'LATEST'), 'utf-8').trim().replace(/^v/, '');
  } catch {
    return '7.1.1';
  }
}

export function isV8Active(): boolean {
  const major = parseInt(algorithmVersion().split('.')[0] ?? '', 10);
  return Number.isFinite(major) && major >= 8;
}

/** True when the active Algorithm version is >= major.minor. Lets a gate ship ahead of the LATEST bump that turns it on. */
export function algorithmAtLeast(major: number, minor: number): boolean {
  const [ma, mi] = algorithmVersion().split('.').map((n) => parseInt(n, 10));
  if (!Number.isFinite(ma)) return false;
  return ma > major || (ma === major && (Number.isFinite(mi) ? mi : 0) >= minor);
}

// ── Executing model detection ──

/** Last assistant `model` in the transcript, or null. Reads only the file tail. */
export function executingModel(transcriptPath: string | undefined): string | null {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;
  try {
    const raw = readFileSync(transcriptPath, 'utf-8');
    const tail = raw.length > 400_000 ? raw.slice(-400_000) : raw;
    const matches = [...tail.matchAll(/"model":"([^"]+)"/g)];
    const last = matches.at(-1)?.[1];
    return last && last !== '<synthetic>' ? last : null;
  } catch {
    return null;
  }
}

// ── Per-model scaffolds ──

interface ScaffoldConfig {
  default_class: string;
  classes: Record<string, { match: string[]; scaffolds: string[] }>;
  scaffolds: Record<string, string>;
}

function loadScaffoldConfig(): ScaffoldConfig | null {
  try {
    const parsed = parseYaml(readFileSync(paiPath('ALGORITHM', 'model-scaffolds.yaml'), 'utf-8'));
    if (!parsed?.classes || !parsed?.scaffolds) return null;
    return parsed as ScaffoldConfig;
  } catch {
    return null;
  }
}

export function modelClass(model: string | null, config: ScaffoldConfig): string {
  if (model) {
    const m = model.toLowerCase();
    for (const [name, cls] of Object.entries(config.classes)) {
      if (cls.match.some((p) => m.includes(p.toLowerCase()))) return name;
    }
  }
  return config.default_class;
}

/** Scaffold lines for the executing model. Empty for frontier models. */
export function scaffoldsFor(model: string | null): { cls: string; lines: string[] } {
  const config = loadScaffoldConfig();
  if (!config) return { cls: 'unknown', lines: [] };
  const cls = modelClass(model, config);
  const keys = config.classes[cls]?.scaffolds ?? [];
  return { cls, lines: keys.map((k) => config.scaffolds[k]).filter((s): s is string => Boolean(s)) };
}

// ── ISA content checks (used by ObserveGate / PhaseTransitionGuard under v8) ──

/** Full file content after the proposed Edit/Write. Null if it can't be reconstructed. */
export function proposedFileContent(
  toolName: string | undefined,
  toolInput: { content?: string; old_string?: string; new_string?: string },
  current: string | null,
): string | null {
  if (toolName === 'Write') return toolInput.content ?? null;
  if (toolName === 'Edit') {
    if (current === null || toolInput.old_string === undefined || !current.includes(toolInput.old_string)) return null;
    return current.replace(toolInput.old_string, toolInput.new_string ?? '');
  }
  return null;
}

export function frontmatterPhase(content: string): string | null {
  const m = content.match(/^phase:\s*(\S+)/m);
  return m ? m[1].trim().toLowerCase() : null;
}

function section(content: string, heading: string): string | null {
  const re = new RegExp(`^## ${heading}\\s*$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm');
  const m = content.match(re);
  return m ? m[1] : null;
}

// Criterion IDs: ISC-12, ISC-12.3, ISC-D1 (lettered), Anti-2.
const ID = String.raw`(?:ISC-[A-Z]*\d+(?:\.\d+)?|Anti-\d+)`;
// Whole line, so both `Anti-1: ...` and v7-style `ISC-5: Anti: ...` count as anti criteria.
const CRITERION_RE = new RegExp(String.raw`^\s*- \[(?: |x|X|DEFERRED-VERIFY)\] (${ID}):.*$`, 'gm');
const PASSED_RE = new RegExp(String.raw`^\s*- \[[xX]\] (${ID}):`, 'gm');

/**
 * Every criterion ID a verification line refers to. Handles the formats real
 * ISAs use: `ISC-1:`, `- ISC-1:`, `**ISC-1:**`, table cells, grouped
 * `ISC-3/4/5`, and ranges `ISC-3–8` / `ISC-3..8` / `ISC-3-8`.
 */
export function idsInLine(line: string): string[] {
  const ids = new Set<string>();
  const re = /\b(ISC|Anti)-([A-Z]*)(\d+)(\.\d+)?((?:\s*\/\s*\d+)+|\s*(?:–|—|\.\.|-)\s*\d+(?!\.\d))?/g;
  for (const m of line.matchAll(re)) {
    const [, kind, letters, num, sub, tail] = m;
    ids.add(`${kind}-${letters}${num}${sub ?? ''}`);
    if (!tail || sub) continue;
    const start = parseInt(num, 10);
    if (tail.includes('/')) {
      for (const n of tail.split('/').slice(1)) ids.add(`${kind}-${letters}${parseInt(n, 10)}`);
    } else {
      const end = parseInt(tail.replace(/[^\d]/g, ''), 10);
      if (end > start && end - start <= 200) for (let n = start + 1; n <= end; n++) ids.add(`${kind}-${letters}${n}`);
    }
  }
  return [...ids];
}

/** All criterion lines (full text) in an ISA. */
export function criteriaLines(content: string): string[] {
  return [...content.matchAll(CRITERION_RE)].map((m) => m[0]);
}

/** Readiness to leave observe: a Goal with text, at least one criterion, at least one Anti criterion. */
export function readinessProblems(content: string): string[] {
  const problems: string[] = [];
  const goal = section(content, 'Goal');
  if (!goal || !goal.replace(/<!--[\s\S]*?-->/g, '').trim()) problems.push('## Goal is missing or empty');
  const criteria = [...content.matchAll(CRITERION_RE)].map((m) => m[0]);
  if (criteria.length === 0) problems.push('no ISC criteria found');
  if (!criteria.some((c) => /Anti[-:]/.test(c))) problems.push('no Anti criterion (what must NOT happen)');
  return problems;
}

/**
 * A checkable claim: the action taken or result seen, quoted so someone can
 * re-run or look it up. A backtick span (`grep -c x f.ts`, `exit 0`) or a
 * double-quoted string ("section present") with real content qualifies.
 * Prose alone ("looks good", "verified") does not.
 */
export function hasCheckableClaim(line: string): boolean {
  const spans = [...line.matchAll(/`([^`]+)`|"([^"]+)"|“([^”]+)”/g)].map((m) => (m[1] ?? m[2] ?? m[3]).trim());
  return spans.some((s) => s.replace(/\b(?:ISC|Anti)-[A-Z]*\d+(?:\.\d+)?/g, '').replace(/\W/g, '').length >= 2);
}

/**
 * IDs marked [x] with no evidence. A line counts as evidence for an ID when it
 * names the ID and contains a checkable claim (see hasCheckableClaim). A bare
 * "36/36 passed" summary is not evidence.
 *
 * Evidence is read from two places: the `## Verification` section (the durable,
 * conventional home) and the `- [x] ISC-N:` criterion line itself. The criterion
 * line only counts when it carries its OWN checkable claim — a backticked probe
 * or quoted output — so the quoted-evidence bar is unchanged; this just credits
 * the inline form that ISAs used before `## Verification` was conventional,
 * instead of forcing a duplicate line. Prose criteria still need a Verification
 * entry. See PAI/DOCUMENTATION/Decisions/phase-guard-inline-criterion-evidence.md.
 */
export function unevidencedPassed(content: string): string[] {
  const evidenced = new Set<string>();
  const credit = (text: string) => {
    for (const line of text.split('\n')) {
      const ids = idsInLine(line);
      if (ids.length === 0 || !hasCheckableClaim(line)) continue;
      ids.forEach((id) => evidenced.add(id));
    }
  };
  credit(section(content, 'Verification') ?? '');

  // Passed criterion lines, credited only when the line itself is checkable.
  const passed: string[] = [];
  for (const m of content.matchAll(CRITERION_RE)) {
    if (!/^\s*- \[[xX]\] /.test(m[0])) continue;
    passed.push(m[1]);
    credit(m[0]);
  }
  return passed.filter((id) => !evidenced.has(id));
}

// ── Branches (work discovered mid-ISA, parked for its own ISA) ──

// A branch entry is a top-level bullet whose label starts with B<n>: `- **B1: Name.** ...`.
// Other bullets in the section (watch items, notes) aren't branches and never block.
const BRANCH_ENTRY_RE = /^- \*{0,2}(B\d+)\b[:.]?\s*(.*)$/;
// Resolution markers: `spawned: <slug>`, `filed: <TODO path>`, `dropped: <reason>`, each with a value.
const BRANCH_RESOLVED_RE = /(?:^|\s|\*\*)(?:spawned|filed|dropped):\s*\S/i;

export interface BranchEntry {
  id: string;        // "B1"
  name: string;      // "KAT-Coder V2.5 as the fast-tier model"
  text: string;      // full entry text, all its lines
  resolved: boolean; // has spawned:/filed:/dropped: with a value
}

/**
 * `B<n>` entries under `## Branches` (heading may carry a suffix). One parser for both the
 * close gate and the ISA skill's spawn tool, so they can't disagree on what a branch is.
 */
export function branchEntries(content: string): BranchEntry[] {
  const m = content.match(/^## Branches\b[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m);
  if (!m) return [];
  const chunks: string[] = [];
  for (const line of m[1].split('\n')) {
    if (line.startsWith('- ')) chunks.push(line);
    else if (chunks.length) chunks[chunks.length - 1] += `\n${line}`;
  }
  return chunks.flatMap((text) => {
    const head = text.split('\n')[0].match(BRANCH_ENTRY_RE);
    if (!head) return [];
    const name = head[2].replace(/\*+/g, '').split(/\.(?:\s|$)/)[0].trim();
    return [{ id: head[1], name, text: text.trimEnd(), resolved: BRANCH_RESOLVED_RE.test(text) }];
  });
}

/** Unresolved branch labels ("B1: Name"). No Branches section → [] (existing ISAs are unaffected). */
export function unresolvedBranches(content: string): string[] {
  return branchEntries(content).filter((b) => !b.resolved).map((b) => (b.name ? `${b.id}: ${b.name}` : b.id));
}

// ── Reflection breadcrumb ──

/**
 * One line per ISA completion under v8: which ISA, when, which Algorithm version.
 * Deliberately minimal. Everything else is recomputed from the ISA itself
 * (see PAI/TOOLS/AlgorithmAB.ts), so the ISA stays the only record.
 */
export function reflectionRow(slug: string): { timestamp: string; prd_id: string; algorithm_version: string } {
  return { timestamp: new Date().toISOString(), prd_id: slug, algorithm_version: algorithmVersion() };
}
