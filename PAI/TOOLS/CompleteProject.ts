#!/usr/bin/env bun

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import * as readline from 'readline';

const HOME = process.env.HOME!;
const PROJECTS_DIR = join(HOME, '.claude', 'PAI', 'USER', 'PROJECTS');
const PROJECTS_MD = join(PROJECTS_DIR, 'PROJECTS.md');
const PROJECTS_TODO_MD = join(PROJECTS_DIR, 'PROJECTS_TODO.md');
const PROJECTS_ARCHIVE_MD = join(PROJECTS_DIR, 'PROJECTS_ARCHIVE.md');

// ─── CLI args ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');
const projectName = args.find(a => !a.startsWith('--'));

if (!projectName) {
  console.log('Usage: bun CompleteProject.ts "<project-name>" [--dry-run] [--force]');
  console.log('');
  console.log('Archives a completed project from PROJECTS.md to PROJECTS_ARCHIVE.md.');
  console.log('  --dry-run   Preview what would be archived without making changes');
  console.log('  --force     Skip the archive confirmation prompt');
  process.exit(1);
}

// ─── File guard ────────────────────────────────────────────────────────────

for (const f of [PROJECTS_MD, PROJECTS_TODO_MD]) {
  if (!existsSync(f)) {
    console.error(`Error: ${f} not found`);
    process.exit(1);
  }
}

const projectsContent = readFileSync(PROJECTS_MD, 'utf-8');
const todoContent = readFileSync(PROJECTS_TODO_MD, 'utf-8');
const archiveContent = existsSync(PROJECTS_ARCHIVE_MD)
  ? readFileSync(PROJECTS_ARCHIVE_MD, 'utf-8')
  : '---\ncategory: domain\nkind: reference\npublish: false\n---\n\n# Projects — Recently Completed\n\n> Archive of completed work extracted from PROJECTS.md (not @-imported; load on-demand for reference).\n> For active projects, see PROJECTS.md. For working TODOs, see PROJECTS_TODO.md.\n';

// ─── Parsers ───────────────────────────────────────────────────────────────

interface ProjectRow {
  name: string;
  goal: string;
  status: string;
  raw: string;
}

function parseProjectsTable(content: string): ProjectRow[] {
  const rows: ProjectRow[] = [];
  const lines = content.split('\n');
  let inTable = false;
  let pastSeparator = false;

  for (const line of lines) {
    if (!inTable && line.startsWith('| Project')) {
      inTable = true;
      continue;
    }
    if (inTable && !pastSeparator) {
      if (/^\|[-\s|]+\|$/.test(line)) { pastSeparator = true; continue; }
    }
    if (inTable && pastSeparator) {
      if (!line.startsWith('|')) break;
      const cols = line.split('|').slice(1, -1).map(c => c.trim());
      if (cols.length >= 2) {
        rows.push({ name: cols[0], goal: cols[1], status: cols[2] ?? '', raw: line });
      }
    }
  }
  return rows;
}

interface TodoSection {
  heading: string;
  lines: string[];
  startIdx: number;
  endIdx: number; // exclusive
}

function parseTodoSections(content: string): TodoSection[] {
  const sections: TodoSection[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) {
      const heading = lines[i].slice(3).trim();
      let j = i + 1;
      while (j < lines.length && !lines[j].startsWith('## ')) j++;
      sections.push({ heading, lines: lines.slice(i, j), startIdx: i, endIdx: j });
    }
  }
  return sections;
}

// ─── Lookup ────────────────────────────────────────────────────────────────

const projectRows = parseProjectsTable(projectsContent);
const matchedRow = projectRows.find(r => r.name.toLowerCase() === projectName.toLowerCase());

if (!matchedRow) {
  console.error(`Error: "${projectName}" not found in PROJECTS.md`);
  if (projectRows.length) console.error(`Active projects: ${projectRows.map(r => r.name).join(', ')}`);
  process.exit(1);
}

const todoSections = parseTodoSections(todoContent);

// ─── Preview ───────────────────────────────────────────────────────────────

console.log('');
console.log('━━━ ARCHIVE PREVIEW ━━━━━━━━━━━━━━━━━━━━━');
console.log('');
console.log('From PROJECTS.md:');
console.log(`  ${matchedRow.raw}`);
console.log('');
if (todoSections.length > 0) {
  console.log(`PROJECTS_TODO.md has ${todoSections.length} section(s) — you'll choose which to archive after confirming.`);
} else {
  console.log('No TODO sections found in PROJECTS_TODO.md.');
}
console.log('');

if (dryRun) {
  if (todoSections.length > 0) {
    console.log('Available TODO sections:');
    todoSections.forEach((s, i) => console.log(`  ${i + 1}. ${s.heading}`));
    console.log('');
  }
  console.log('(dry-run — no changes made)');
  process.exit(0);
}

// ─── TTY guard ─────────────────────────────────────────────────────────────

if (!process.stdin.isTTY) {
  console.error('Error: Run interactively (stdin is not a TTY)');
  process.exit(1);
}

// ─── Interactive prompts ───────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question: string): Promise<string> {
  return new Promise(resolve => {
    process.stdout.write(question);
    rl.once('line', line => resolve(line.trim()));
  });
}

// Confirm gate
if (!force) {
  const confirm = await ask('Archive this project? [y/N]: ');
  if (confirm.toLowerCase() !== 'y') {
    console.log('Aborted.');
    rl.close();
    process.exit(0);
  }
}

// TODO section selection
let selectedSections: TodoSection[] = [];
if (todoSections.length > 0) {
  console.log('');
  console.log('TODO sections (select which belong to this project):');
  todoSections.forEach((s, i) => console.log(`  ${i + 1}. ${s.heading}`));
  const todoAnswer = await ask('Which TODO sections to archive? (comma-separated numbers, or Enter to skip): ');

  if (todoAnswer.trim()) {
    const nums = [...new Set(
      todoAnswer.split(',')
        .map(n => parseInt(n.trim(), 10))
        .filter(n => !isNaN(n) && n >= 1 && n <= todoSections.length)
    )];
    selectedSections = nums.map(n => todoSections[n - 1]);
    if (selectedSections.length > 0) {
      console.log(`Will archive: ${selectedSections.map(s => s.heading).join(', ')}`);
    }
  }
}

rl.close();

// ─── Compute changes ────────────────────────────────────────────────────────

const today = new Date().toISOString().slice(0, 10);

// Build archive entry
let archiveEntry = `- **${matchedRow.name}** — ${matchedRow.goal}`;
if (matchedRow.status) archiveEntry += `. Status: ${matchedRow.status}`;
archiveEntry += '.';

if (selectedSections.length > 0) {
  for (const sec of selectedSections) {
    const bodyLines = [...sec.lines.slice(1)];
    while (bodyLines.length && bodyLines[bodyLines.length - 1].trim() === '') bodyLines.pop();
    archiveEntry += `\n\n  **${sec.heading}**`;
    if (bodyLines.length > 0) {
      archiveEntry += '\n' + bodyLines.map(l => (l ? '  ' + l : '')).join('\n');
    }
  }
}

// New PROJECTS_ARCHIVE.md
function buildArchiveContent(existing: string, entry: string, dateStr: string): string {
  const header = `## ${dateStr}`;
  const lines = existing.split('\n');
  const headerIdx = lines.findIndex(l => l === header);

  if (headerIdx !== -1) {
    let insertAt = headerIdx + 1;
    if (insertAt < lines.length && lines[insertAt].trim() === '') insertAt++;
    lines.splice(insertAt, 0, entry, '');
    return lines.join('\n');
  }
  return existing.trimEnd() + '\n\n' + header + '\n\n' + entry + '\n';
}

const newArchiveContent = buildArchiveContent(archiveContent, archiveEntry, today);

// New PROJECTS_TODO.md
let newTodoContent = todoContent;
if (selectedSections.length > 0) {
  const lines = todoContent.split('\n');
  const ranges = [...selectedSections].sort((a, b) => b.startIdx - a.startIdx);
  for (const sec of ranges) {
    lines.splice(sec.startIdx, sec.endIdx - sec.startIdx);
  }
  // Collapse consecutive blank lines
  const collapsed: string[] = [];
  let prevBlank = false;
  for (const line of lines) {
    const blank = line.trim() === '';
    if (blank && prevBlank) continue;
    collapsed.push(line);
    prevBlank = blank;
  }
  newTodoContent = collapsed.join('\n');
}

// New PROJECTS.md
const projectsLines = projectsContent.split('\n');
const rowIdx = projectsLines.findIndex(l => l.trim() === matchedRow.raw.trim());
const newProjectsContent = rowIdx !== -1
  ? [...projectsLines.slice(0, rowIdx), ...projectsLines.slice(rowIdx + 1)].join('\n')
  : projectsContent;

// ─── Write (archive first — append-only, safest) ───────────────────────────

writeFileSync(PROJECTS_ARCHIVE_MD, newArchiveContent, 'utf-8');
if (selectedSections.length > 0) writeFileSync(PROJECTS_TODO_MD, newTodoContent, 'utf-8');
writeFileSync(PROJECTS_MD, newProjectsContent, 'utf-8');

// ─── Report ────────────────────────────────────────────────────────────────

console.log('');
console.log(`✓ Archived "${matchedRow.name}" to PROJECTS_ARCHIVE.md`);
if (selectedSections.length > 0) console.log(`✓ Removed ${selectedSections.length} TODO section(s) from PROJECTS_TODO.md`);
console.log('✓ Removed from PROJECTS.md');
console.log('');
console.log('Done. Run `git diff` to review changes.');
