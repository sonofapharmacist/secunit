#!/usr/bin/env bun

import * as fs from "node:fs";
import * as path from "node:path";

// Sync fs is intentional here: this is a deterministic one-shot migration CLI.
const MEMORY_DIR = "${HOME}/.claude/projects/-home-<username>/memory";
const RESEARCH_DIR = "${HOME}/.claude/PAI/MEMORY/KNOWLEDGE/Research";
const MEMORY_MD = path.join(MEMORY_DIR, "MEMORY.md");

const KNOWLEDGE_BASENAME_RE = /^knowledge_.*\.md$/;
const LEADING_FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---(?=\r?\n|$)/;

type Action = "MIGRATE" | "DELETE" | "SKIP" | "ALREADY_DONE";
type Mode = "help" | "dry-run" | "test" | "bulk";

type Candidate = {
  slug: string;
  sourcePath: string;
  destPath: string;
  sourceExists: boolean;
  destExists: boolean;
};

type PlannedOperation = {
  action: Action;
  candidate: Candidate;
};

type FrontmatterResult = {
  frontmatter: string | null;
  body: string;
};

type MemoryCleanupPlan = {
  content: string;
  removed: number;
  tightened: number;
};

type Summary = {
  migrated: number;
  deleted: number;
  alreadyDone: number;
  skipped: number;
  total: number;
};

function main(): void {
  const mode: Mode = resolveMode(process.argv.slice(2));

  if (mode === "help") {
    printUsage();
    return;
  }

  const operations: PlannedOperation[] = planOperations(mode);
  const summary: Summary = {
    migrated: 0,
    deleted: 0,
    alreadyDone: 0,
    skipped: 0,
    total: operations.length,
  };

  if (mode === "bulk" || mode === "test") {
    ensureDirectory(RESEARCH_DIR);
  }

  for (const operation of operations) {
    const action: Action = mode === "dry-run" ? operation.action : executeOperation(operation);
    printAction(mode, action, operation.candidate.slug);
    updateSummary(summary, action);
  }

  if (mode === "bulk" || mode === "dry-run") {
    const cleanupPlan: MemoryCleanupPlan = cleanMemoryIndex(readTextFile(MEMORY_MD));
    if (mode === "bulk") {
      writeTextFile(MEMORY_MD, cleanupPlan.content);
    }

    const prefix: string = mode === "dry-run" ? "[DRY-RUN] " : "";
    console.log(`${prefix}MEMORY.md: removed ${cleanupPlan.removed} knowledge_* entries`);
    console.log(`${prefix}MEMORY.md: tightened ${cleanupPlan.tightened} entries to <=150 chars`);
  }

  printSummary(mode, summary);
}

function resolveMode(args: string[]): Mode {
  if (args.length === 0) {
    return "bulk";
  }

  if (args.length !== 1) {
    return "help";
  }

  const [flag] = args;
  if (flag === "--dry-run") {
    return "dry-run";
  }
  if (flag === "--test") {
    return "test";
  }
  if (flag === "--help" || flag === "-h") {
    return "help";
  }
  return "help";
}

function printUsage(): void {
  console.log("Usage:");
  console.log("  bun ${HOME}/.claude/PAI/TOOLS/MigrateKnowledgeToArchive.ts [--dry-run|--test]");
  console.log("");
  console.log("Modes:");
  console.log("  --dry-run  Preview file actions and MEMORY.md cleanup counts without writing anything.");
  console.log("  --test     Migrate the first 5 non-collision files in sorted order and delete collisions encountered.");
  console.log("  --help     Show this help.");
  console.log("  no flag    Migrate all knowledge_*.md files, delete redundant sources, then clean MEMORY.md.");
  console.log("");
  console.log("Safety:");
  console.log("  Only knowledge_*.md files in MEMORY_DIR are migrated or deleted.");
  console.log("  MEMORY.md cleanup only removes lines that start with '- [' and contain '](knowledge_'.");
  console.log("  --dry-run and --test never modify MEMORY.md.");
}

function planOperations(mode: Mode): PlannedOperation[] {
  const candidates: Candidate[] = buildCandidates();
  const operations: PlannedOperation[] = [];
  let plannedTestMigrations: number = 0;

  for (const candidate of candidates) {
    let action: Action;

    if (candidate.destExists && !candidate.sourceExists) {
      action = "ALREADY_DONE";
    } else if (!candidate.sourceExists) {
      action = "SKIP";
    } else if (candidate.destExists) {
      action = "DELETE";
    } else if (mode === "test" && plannedTestMigrations >= 5) {
      action = "SKIP";
    } else {
      action = "MIGRATE";
      if (mode === "test") {
        plannedTestMigrations += 1;
      }
    }

    operations.push({ action, candidate });
  }

  return operations;
}

function buildCandidates(): Candidate[] {
  const basenames: string[] = Array.from(new Set<string>([
    ...listKnowledgeBasenames(),
    ...listKnowledgeBasenamesFromMemoryIndex(),
  ])).sort();

  return basenames.map((basename: string): Candidate => {
    const slug: string = slugFromFilename(basename);
    const sourcePath: string = knowledgePathFromBasename(basename);
    const destPath: string = researchPathFromSlug(slug);

    return {
      slug,
      sourcePath,
      destPath,
      sourceExists: pathExists(sourcePath),
      destExists: pathExists(destPath),
    };
  });
}

function listKnowledgeBasenames(): string[] {
  const entries: fs.Dirent[] = readDirectoryEntries(MEMORY_DIR);
  const basenames: string[] = [];

  for (const entry of entries) {
    if (entry.isFile() && KNOWLEDGE_BASENAME_RE.test(entry.name)) {
      basenames.push(entry.name);
    }
  }

  basenames.sort();
  return basenames;
}

function listKnowledgeBasenamesFromMemoryIndex(): string[] {
  const content: string = readTextFile(MEMORY_MD);
  const lines: string[] = splitLines(content);
  const basenames: string[] = [];

  for (const line of lines) {
    if (!shouldRemoveKnowledgeLine(line)) {
      continue;
    }

    const match: RegExpMatchArray | null = line.match(/\]\((knowledge_.*\.md)\)/);
    if (match !== null) {
      assertKnowledgeBasename(match[1]);
      basenames.push(match[1]);
    }
  }

  basenames.sort();
  return basenames;
}

function executeOperation(operation: PlannedOperation): Action {
  const plannedAction: Action = operation.action;
  const { sourcePath, destPath, slug } = operation.candidate;

  if (plannedAction === "SKIP" || plannedAction === "ALREADY_DONE") {
    return plannedAction;
  }

  const sourceExists: boolean = pathExists(sourcePath);
  const destExists: boolean = pathExists(destPath);

  if (!sourceExists) {
    return destExists ? "ALREADY_DONE" : "SKIP";
  }

  if (plannedAction === "DELETE" || destExists) {
    deleteFile(sourcePath);
    return "DELETE";
  }

  const sourceContent: string = readTextFile(sourcePath);
  const nextContent: string = buildMigratedContent(sourceContent, slug);
  writeTextFile(destPath, nextContent);
  deleteFile(sourcePath);
  return "MIGRATE";
}

function buildMigratedContent(sourceContent: string, slug: string): string {
  const frontmatterResult: FrontmatterResult = stripFrontmatter(sourceContent);
  const description: string | null = extractDescription(frontmatterResult.frontmatter);
  const tags: string[] = extractTags(description);
  const frontmatter: string = buildFrontmatter(slug, tags);
  const separator: string = frontmatterResult.body.length > 0 && !startsWithLineBreak(frontmatterResult.body) ? "\n" : "";
  return `${frontmatter}${separator}${frontmatterResult.body}`;
}

function stripFrontmatter(content: string): FrontmatterResult {
  if (!content.startsWith("---")) {
    return { frontmatter: null, body: content };
  }

  const match: RegExpMatchArray | null = content.match(LEADING_FRONTMATTER_RE);
  if (match === null) {
    return { frontmatter: null, body: content };
  }

  const frontmatter: string = match[0];
  const body: string = content.slice(frontmatter.length);
  return { frontmatter, body };
}

function extractDescription(frontmatter: string | null): string | null {
  if (frontmatter === null) {
    return null;
  }

  const match: RegExpMatchArray | null = frontmatter.match(/^description:\s*(.+)$/m);
  if (match === null) {
    return null;
  }

  const value: string = match[1].trim();
  if (value.length === 0) {
    return null;
  }

  return stripOuterDoubleQuotes(value);
}

function extractTags(description: string | null): string[] {
  if (description === null) {
    return [];
  }

  const fragments: string[] = description.split(/[;,+]/);
  const tags: string[] = [];
  const seen: Set<string> = new Set<string>();

  for (const fragment of fragments) {
    const tag: string = normalizeTag(fragment);
    if (!looksLikeTopicTag(tag)) {
      continue;
    }

    const key: string = tag.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    tags.push(tag);
    if (tags.length >= 5) {
      break;
    }
  }

  return tags;
}

function normalizeTag(value: string): string {
  return value
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\([^)]*(?:\)|$)/g, " ")
    .replace(/\[[^\]]*(?:\]|$)/g, " ")
    .replace(/\{[^}]*(?:\}|$)/g, " ")
    .replace(/[()[\]{}]/g, " ")
    .replace(/^[\s"'`]+/, "")
    .replace(/[\s"'`.,;:!?]+$/g, "")
    .replace(/\s+/g, " ");
}

function looksLikeTopicTag(value: string): boolean {
  const words: string[] = value.split(/\s+/).filter((word: string): boolean => word.length > 0);
  if (value.length === 0 || value.length > 32 || words.length === 0 || words.length > 4) {
    return false;
  }

  return words.length >= 2 || /\d/.test(value) || /\b[A-Z]{2,}\b/.test(value) || value.includes("-");
}

function buildFrontmatter(slug: string, tags: string[]): string {
  return [
    "---",
    `title: "${escapeDoubleQuotes(titleCaseSlug(slug))}"`,
    "type: knowledge",
    "domain: Research",
    `tags: ${formatTags(tags)}`,
    "status: evergreen",
    "---",
  ].join("\n");
}

function titleCaseSlug(slug: string): string {
  return slug
    .split("-")
    .filter((part: string): boolean => part.length > 0)
    .map((part: string): string => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatTags(tags: string[]): string {
  if (tags.length === 0) {
    return "[]";
  }

  const rendered: string[] = tags.map((tag: string): string => renderYamlTag(tag));
  return `[${rendered.join(", ")}]`;
}

function renderYamlTag(tag: string): string {
  return `"${escapeDoubleQuotes(tag)}"`;
}

function cleanMemoryIndex(content: string): MemoryCleanupPlan {
  const lines: string[] = splitLines(content);
  const keptLines: string[] = [];
  let removed: number = 0;
  let tightened: number = 0;

  for (const line of lines) {
    if (shouldRemoveKnowledgeLine(line)) {
      removed += 1;
      continue;
    }

    if (line.startsWith("- [") && line.length > 150) {
      keptLines.push(`${line.slice(0, 147)}...`);
      tightened += 1;
      continue;
    }

    keptLines.push(line);
  }

  return {
    content: joinLines(keptLines, content),
    removed,
    tightened,
  };
}

function shouldRemoveKnowledgeLine(line: string): boolean {
  return line.startsWith("- [") && line.includes("](knowledge_");
}

function printAction(mode: Mode, action: Action, slug: string): void {
  const prefix: string = mode === "dry-run" ? "[DRY-RUN] " : "";
  console.log(`${prefix}[${action}] ${slug}`);
}

function printSummary(mode: Mode, summary: Summary): void {
  const prefix: string = mode === "dry-run" ? "[DRY-RUN] " : "";
  console.log(
    `${prefix}Summary: migrated=${summary.migrated}, deleted=${summary.deleted}, already-done=${summary.alreadyDone}, skipped=${summary.skipped}, total=${summary.total}`,
  );

  if (summary.total === 0 || (summary.migrated === 0 && summary.deleted === 0 && summary.alreadyDone === summary.total)) {
    console.log(`${prefix}Summary: nothing to do`);
  }
}

function updateSummary(summary: Summary, action: Action): void {
  if (action === "MIGRATE") {
    summary.migrated += 1;
  } else if (action === "DELETE") {
    summary.deleted += 1;
  } else if (action === "ALREADY_DONE") {
    summary.alreadyDone += 1;
  } else {
    summary.skipped += 1;
  }
}

function slugFromFilename(filename: string): string {
  assertKnowledgeBasename(filename);
  return filename
    .replace(/^knowledge_/, "")
    .replace(/\.md$/, "")
    .replace(/_/g, "-")
    .toLowerCase();
}

function knowledgePathFromBasename(basename: string): string {
  assertKnowledgeBasename(basename);
  return path.join(MEMORY_DIR, basename);
}

function researchPathFromSlug(slug: string): string {
  return path.join(RESEARCH_DIR, `${slug}.md`);
}

function assertKnowledgeBasename(basename: string): void {
  if (!KNOWLEDGE_BASENAME_RE.test(basename)) {
    throw new Error(`Refusing to touch non-knowledge basename: ${basename}`);
  }
}

function readDirectoryEntries(dirPath: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (error: unknown) {
    throw new Error(`Failed to read directory ${dirPath}: ${errorMessage(error)}`);
  }
}

function pathExists(targetPath: string): boolean {
  try {
    return fs.existsSync(targetPath);
  } catch (error: unknown) {
    throw new Error(`Failed to stat path ${targetPath}: ${errorMessage(error)}`);
  }
}

function readTextFile(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error: unknown) {
    throw new Error(`Failed to read file ${filePath}: ${errorMessage(error)}`);
  }
}

function writeTextFile(filePath: string, content: string): void {
  try {
    // Sync fs keeps this one-shot migration deterministic and easy to audit.
    fs.writeFileSync(filePath, content, "utf8");
  } catch (error: unknown) {
    throw new Error(`Failed to write file ${filePath}: ${errorMessage(error)}`);
  }
}

function deleteFile(filePath: string): void {
  const basename: string = path.basename(filePath);
  assertKnowledgeBasename(basename);
  if (path.dirname(filePath) !== MEMORY_DIR) {
    throw new Error(`Refusing to delete outside MEMORY_DIR: ${filePath}`);
  }

  try {
    fs.unlinkSync(filePath);
  } catch (error: unknown) {
    throw new Error(`Failed to delete file ${filePath}: ${errorMessage(error)}`);
  }
}

function ensureDirectory(dirPath: string): void {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch (error: unknown) {
    throw new Error(`Failed to ensure directory ${dirPath}: ${errorMessage(error)}`);
  }
}

function splitLines(content: string): string[] {
  return content.split(/\r?\n/);
}

function joinLines(lines: string[], originalContent: string): string {
  const eol: string = originalContent.includes("\r\n") ? "\r\n" : "\n";
  const joined: string = lines.join(eol);
  const endedWithLineBreak: boolean = originalContent.endsWith("\n") || originalContent.endsWith("\r\n");
  return endedWithLineBreak ? `${joined}${eol}` : joined;
}

function stripOuterDoubleQuotes(value: string): string {
  const trimmed: string = value.trim();
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"") && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function escapeDoubleQuotes(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function startsWithLineBreak(value: string): boolean {
  return value.startsWith("\n") || value.startsWith("\r\n");
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

try {
  main();
} catch (error: unknown) {
  console.error(errorMessage(error));
  process.exit(1);
}
