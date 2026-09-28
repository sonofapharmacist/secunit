#!/usr/bin/env bun
/**
 * IsaLint — frontmatter integrity check for ISA.md files.
 *
 * Catches the class of bug found 2026-09-28 on the audiobookify ISA: an append
 * (rather than an edit) left TWO `phase:` keys in the frontmatter, so the ISA
 * showed as open in every `grep "^phase:"` sweep while its second line said
 * complete. PhaseTransitionGuard reads the FIRST match, so a duplicate key is a
 * silent state-lie. This lints for that and related frontmatter drift.
 *
 * Checks per ISA:
 *   - frontmatter present and closed (opening + closing `---`)
 *   - exactly one `phase:` key (duplicate = the audiobookify bug)
 *   - phase value in the known set
 *   - at most one `progress:` key
 *   - progress shape `N/M` with N <= M when present
 *
 * Usage:
 *   bun PAI/TOOLS/IsaLint.ts                 # lint all ISAs under MEMORY/WORK
 *   bun PAI/TOOLS/IsaLint.ts <file...>       # lint specific files
 *   bun PAI/TOOLS/IsaLint.ts --quiet         # exit code only (0 clean, 1 issues)
 * Exit 0 = clean, 1 = at least one issue.
 */
import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const PAI_DIR = process.env.PAI_DIR ?? join(homedir(), ".claude", "PAI");
const WORK_DIR = join(PAI_DIR, "MEMORY", "WORK");

const VALID_PHASES = new Set([
  "observe", "think", "plan", "build", "execute", "verify", "learn", // workflow
  "complete", "abandoned", "superseded", "paused",                    // terminal / held
]);

interface Issue { file: string; msg: string; note?: boolean }

function frontmatter(content: string): { body: string | null; lines: string[] } {
  if (!content.startsWith("---")) return { body: null, lines: [] };
  const end = content.indexOf("\n---", 3);
  if (end === -1) return { body: null, lines: [] };
  const body = content.slice(content.indexOf("\n") + 1, end);
  return { body, lines: body.split("\n") };
}

function keyValues(lines: string[], key: string): string[] {
  const re = new RegExp(`^${key}:\\s*(.*)$`);
  return lines.map((l) => l.match(re)).filter(Boolean).map((m) => m![1].trim());
}

function lintOne(file: string): Issue[] {
  const issues: Issue[] = [];
  let content: string;
  try { content = readFileSync(file, "utf8"); }
  catch (e) { return [{ file, msg: `unreadable: ${e}` }]; }

  // A file that never declares frontmatter is a legacy/ad-hoc ISA format, not a
  // corruption — note it (untracked by phase sweeps) but don't fail on it. A file
  // that OPENS `---` but never closes it IS malformed and fails.
  const { body, lines } = frontmatter(content);
  if (body === null) {
    return content.startsWith("---")
      ? [{ file, msg: "opens `---` but never closes the frontmatter block" }]
      : [{ file, msg: "no frontmatter — untracked by phase sweeps (legacy format)", note: true }];
  }

  const phases = keyValues(lines, "phase");
  if (phases.length === 0) issues.push({ file, msg: "no `phase:` key in frontmatter" });
  else if (phases.length > 1) issues.push({ file, msg: `duplicate \`phase:\` keys (${phases.length}): ${phases.join(" , ")} — the audiobookify bug` });
  for (const p of phases) {
    const bare = p.replace(/^["']|["']$/g, "");
    if (!VALID_PHASES.has(bare)) issues.push({ file, msg: `unknown phase value: "${p}"` });
  }

  const progress = keyValues(lines, "progress");
  if (progress.length > 1) issues.push({ file, msg: `duplicate \`progress:\` keys (${progress.length})` });
  for (const raw of progress) {
    const m = raw.replace(/^["']|["']$/g, "").match(/^(\d+)\s*\/\s*(\d+)$/);
    if (!m) { if (raw.replace(/^["']|["']$/g, "") !== "") issues.push({ file, msg: `progress not N/M: "${raw}"` }); continue; }
    if (parseInt(m[1], 10) > parseInt(m[2], 10)) issues.push({ file, msg: `progress N>M: "${raw}"` });
  }

  return issues;
}

function discover(): string[] {
  if (!existsSync(WORK_DIR)) return [];
  return readdirSync(WORK_DIR)
    .map((d) => join(WORK_DIR, d, "ISA.md"))
    .filter((f) => existsSync(f));
}

const args = process.argv.slice(2);
const quiet = args.includes("--quiet");
const files = args.filter((a) => !a.startsWith("--"));
const targets = files.length ? files : discover();

const all = targets.flatMap(lintOne);
const fails = all.filter((i) => !i.note);
const notes = all.filter((i) => i.note);
if (!quiet) {
  for (const i of fails) console.log(`FAIL ${i.file.replace(PAI_DIR + "/", "")}\n     ${i.msg}`);
  for (const i of notes) console.log(`note ${i.file.replace(PAI_DIR + "/", "")} — ${i.msg}`);
  console.log(
    fails.length === 0
      ? `\nIsaLint: ${targets.length} ISA(s), 0 failures${notes.length ? `, ${notes.length} note(s)` : ""}.`
      : `\nIsaLint: ${fails.length} failure(s), ${notes.length} note(s) across ${targets.length} ISA(s).`
  );
}
process.exit(fails.length === 0 ? 0 : 1);
