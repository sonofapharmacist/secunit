#!/usr/bin/env bun
/**
 * ArchitectureSummaryGenerator — Generate PAI_ARCHITECTURE_SUMMARY.md from source docs
 *
 * Commands:
 *   generate    Generate/regenerate the architecture summary
 *   check       Check if summary is stale (exit 1 if stale, 0 if fresh)
 *
 * Examples:
 *   bun ArchitectureSummaryGenerator.ts generate
 *   bun ArchitectureSummaryGenerator.ts check
 */

import { parseArgs } from "util";
import * as fs from "fs";
import * as path from "path";

// ============================================================================
// Configuration
// ============================================================================

const HOME = process.env.HOME!;
const PAI_DIR = process.env.PAI_DIR || path.join(HOME, ".claude", "PAI");
const ARCH_SOURCE = path.join(PAI_DIR, "DOCUMENTATION", "PAISystemArchitecture.md");
const SUMMARY_OUTPUT = path.join(PAI_DIR, "DOCUMENTATION", "ARCHITECTURE_SUMMARY.md");
const ALGORITHM_DIR = path.join(PAI_DIR, "ALGORITHM");
const MEMORY_SYSTEM_DOC = path.join(PAI_DIR, "DOCUMENTATION", "Memory", "MemorySystem.md");
const CLAUDE_MD = path.join(HOME, ".claude", "CLAUDE.md");

// ============================================================================
// Version detection (source-of-truth lookups — no hardcoded versions)
// ============================================================================

/** Compare semver strings: returns positive if a > b, negative if a < b */
function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Detect the current Algorithm version by finding the highest vX.Y.Z.md in ALGORITHM/ */
function detectAlgorithmVersion(): string {
  // v6.2.0+: LATEST is the single source of truth. Defensive fallback to
  // highest-semver spec file only if LATEST is missing.
  const latestPath = path.join(ALGORITHM_DIR, "LATEST");
  if (fs.existsSync(latestPath)) {
    const v = fs.readFileSync(latestPath, "utf-8").trim();
    if (/^\d+\.\d+\.\d+$/.test(v)) return v;
  }
  if (!fs.existsSync(ALGORITHM_DIR)) return "unknown";
  const versions = fs
    .readdirSync(ALGORITHM_DIR)
    .map(f => f.match(/^v(\d+\.\d+\.\d+)\.md$/)?.[1])
    .filter((v): v is string => Boolean(v))
    .sort(compareSemver);
  return versions[versions.length - 1] ?? "unknown";
}

/** Detect current Memory version from `**Version:** X.Y` in MemorySystem.md */
function detectMemoryVersion(): string {
  if (!fs.existsSync(MEMORY_SYSTEM_DOC)) return "unknown";
  const content = fs.readFileSync(MEMORY_SYSTEM_DOC, "utf-8");
  const match = content.match(/\*\*Version:\*\*\s*([\d.]+)/);
  return match?.[1] ?? "unknown";
}

/** Detect PAI version from the first `# PAI X.Y.Z` heading in global CLAUDE.md */
function detectPaiVersion(): string {
  if (!fs.existsSync(CLAUDE_MD)) return "unknown";
  const content = fs.readFileSync(CLAUDE_MD, "utf-8");
  const match = content.match(/^#\s*PAI\s+([\d.]+)/m);
  return match?.[1] ?? "unknown";
}

// ============================================================================
// Parsing
// ============================================================================

/** Extract H2/H3 sections and their content from the architecture doc */
function extractSections(content: string): Array<{ heading: string; level: number; body: string }> {
  const sections: Array<{ heading: string; level: number; body: string }> = [];
  const lines = content.split("\n");
  let currentHeading = "";
  let currentLevel = 0;
  let currentBody: string[] = [];

  for (const line of lines) {
    const h2Match = line.match(/^## (.+)$/);
    const h3Match = line.match(/^### (.+)$/);

    if (h2Match || h3Match) {
      if (currentHeading) {
        sections.push({ heading: currentHeading, level: currentLevel, body: currentBody.join("\n").trim() });
      }
      currentHeading = (h2Match || h3Match)![1];
      currentLevel = h2Match ? 2 : 3;
      currentBody = [];
    } else {
      currentBody.push(line);
    }
  }
  if (currentHeading) {
    sections.push({ heading: currentHeading, level: currentLevel, body: currentBody.join("\n").trim() });
  }

  return sections;
}

/** Extract subsystem entries from CLAUDE.md routing — supports legacy table and current bullet-list formats.
 *
 * Section-aware: tracks the current `## ...` heading so bullets under `{{PRINCIPAL_NAME}} — ...`
 * sections (which document personal identity/voice files) resolve to PAI/USER/, not
 * PAI/DOCUMENTATION/. The downstream `USER/` filter then correctly drops them.
 */
function extractSubsystems(): Array<{ name: string; description: string; docPath: string }> {
  const claudeMdPath = path.join(HOME, ".claude", "CLAUDE.md");
  if (!fs.existsSync(claudeMdPath)) return [];

  const content = fs.readFileSync(claudeMdPath, "utf-8");
  const entries: Array<{ name: string; description: string; docPath: string; sectionRoot: string }> = [];

  const tableLegacy1 = /^\| \*\*(.+?)\*\* \| `(.+?)` .*/;
  const tableLegacy2 = /^\| (.+?) \| `(.+?)`/;
  const bulletLine = /^\s*-\s+(?:\*\*([^*]+?)\*\*|([A-Za-z][^—–\-`\n]*?))\s*[—–-]\s*`([^`]+?\.md)`/;
  // Section heading: `## {{PRINCIPAL_NAME}} — Identity & Voice (paths under PAI/USER/)` etc.
  // Captures the optional "paths under <X>" hint to override the default section root.
  const headingPathHint = /paths under\s+`?([A-Za-z_/.0-9-]+?)`?(?:\s|\)|$)/;

  let currentSectionRoot = "PAI/DOCUMENTATION/";

  const push = (rawName: string, docPath: string) => {
    const name = rawName.replace(/\*\*/g, "").trim();
    if (!name || !docPath) return;
    if (!entries.find(e => e.name === name && e.docPath === docPath)) {
      entries.push({ name, description: name, docPath, sectionRoot: currentSectionRoot });
    }
  };

  for (const line of content.split("\n")) {
    const h2 = line.match(/^##\s+(.+)$/);
    if (h2) {
      const heading = h2[1];
      const hint = heading.match(headingPathHint);
      if (hint) {
        let root = hint[1];
        if (!root.endsWith("/")) root += "/";
        currentSectionRoot = root;
      } else {
        currentSectionRoot = "PAI/DOCUMENTATION/";
      }
      continue;
    }

    let m = line.match(tableLegacy1);
    if (m) { push(m[1], m[2]); continue; }
    m = line.match(tableLegacy2);
    if (m) { push(m[1], m[2]); continue; }
    m = line.match(bulletLine);
    if (m) { push(m[1] ?? m[2] ?? "", m[3]); continue; }
  }

  return entries
    .map(e => {
      let p = e.docPath;
      if (!p.startsWith("PAI/") && !p.startsWith("~") && !p.startsWith("/") && p.endsWith(".md")) {
        p = e.sectionRoot + p;
      }
      return { name: e.name, description: e.description, docPath: p };
    })
    .filter(e =>
      e.docPath.includes("PAI/") &&
      !e.docPath.includes("USER/") &&
      !e.docPath.includes("DA_") &&
      e.docPath.endsWith(".md")
    );
}

/** Extract founding principles from architecture doc */
function extractPrinciples(content: string): string[] {
  const principles: string[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    // Match "### N. Principle Name" pattern
    const match = line.match(/^### \d+\. (.+)$/);
    if (match) {
      principles.push(match[1]);
    }
  }

  return principles;
}

/** Extract the Pipeline Topology section from the architecture doc */
function extractTopology(content: string): string | null {
  const startMarker = "## Pipeline Topology";
  const startIdx = content.indexOf(startMarker);
  if (startIdx === -1) return null;

  // Find the next ## heading after the topology section
  const afterStart = content.indexOf("\n## ", startIdx + startMarker.length);
  const section = afterStart === -1
    ? content.slice(startIdx)
    : content.slice(startIdx, afterStart);

  return section.trim();
}

/** Get modification time of a file, or 0 if missing */
function getMtime(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

// ============================================================================
// Generation
// ============================================================================

function generate(): string {
  if (!fs.existsSync(ARCH_SOURCE)) {
    console.error(`ERROR: Architecture source not found: ${ARCH_SOURCE}`);
    process.exit(1);
  }

  const archContent = fs.readFileSync(ARCH_SOURCE, "utf-8");
  const subsystems = extractSubsystems();
  const principles = extractPrinciples(archContent);
  const topology = extractTopology(archContent);
  const paiVersion = detectPaiVersion();
  const algorithmVersion = detectAlgorithmVersion();
  const memoryVersion = detectMemoryVersion();

  // Build subsystem table — single row per subsystem, no "Exists" column
  // (existence is asserted by inclusion; missing files would fail the regen, not silently render "N")
  const tableRows: string[] = [];
  const missing: string[] = [];
  for (const sub of subsystems) {
    const resolved = sub.docPath.startsWith("/")
      ? sub.docPath
      : sub.docPath.startsWith("~")
        ? sub.docPath.replace(/^~/, HOME)
        : path.join(HOME, ".claude", sub.docPath);
    const shortPath = sub.docPath.replace("~/.claude/", "");
    if (!fs.existsSync(resolved)) missing.push(shortPath);
    tableRows.push(`| ${sub.name} | ${shortPath} |`);
  }

  // Extract key architecture sections — emitted inline (compressed from bullet list)
  const sections = extractSections(archContent);
  const majorSections = sections
    .filter(s => s.level === 2 && !s.heading.includes("Changelog") && !s.heading.includes("Updates"))
    .map(s => s.heading);

  // Build the summary
  const lines: string[] = [
    "# PAI Architecture Summary",
    "",
    "> Auto-generated by ArchitectureSummaryGenerator.ts. Do not edit manually.",
    `> Generated: ${new Date().toISOString()} | Source: DOCUMENTATION/PAISystemArchitecture.md`,
    "",
    "## Overview",
    "",
    "PAI (Personal AI Infrastructure) is scaffolding for AI — architectural framework that makes",
    "AI assistance dependable, maintainable, and effective. Built around a universal algorithm for",
    "accomplishing any task: Current State to Ideal State via verifiable iteration (ISC).",
    "",
    `**Current versions:** PAI ${paiVersion} | Algorithm v${algorithmVersion} | Memory v${memoryVersion}`,
    "",
    "## Subsystem Reference",
    "",
    "| Subsystem | Doc Path |",
    "|-----------|----------|",
    ...tableRows,
    ...(missing.length > 0 ? ["", `> Missing: ${missing.join(", ")}`] : []),
    "",
    `**Sections in source doc:** ${majorSections.join(" · ")}`,
    "",
    "## Founding Principles",
    "",
    ...principles.slice(0, 17).map((p, i) => `${i + 1}. ${p}`),
    "",
    "## Instruction Hierarchy",
    "",
    "1. **System Prompt** — PAI_SYSTEM_PROMPT.md, constitutional, survives compaction",
    "2. **CLAUDE.md** — operational procedures, format templates, context routing",
    "3. **@Imported files** — PRINCIPAL_IDENTITY, DA_IDENTITY, PROJECTS, PRINCIPAL_TELOS, this file",
    "4. **Dynamic context** — LoadContext hook output, ephemeral",
    "",
    "## Key Design Decisions",
    "",
    "- Algorithm is the gravitational center — everything else feeds it",
    "- ISA is the single source of truth per Algorithm run",
    "- Skills = self-activating composable domain units",
    "- Hooks provide SessionStart→SessionEnd lifecycle integration",
    "- Memory compounds across sessions: WORK → LEARNING → KNOWLEDGE",
    "- System/user config separation enables public releases without personal data",
    "",
    ...(topology ? [topology, ""] : []),
    "## Cross-References",
    "",
    "- Full architecture: `PAI/DOCUMENTATION/PAISystemArchitecture.md`",
    `- Algorithm spec: \`PAI/ALGORITHM/v${algorithmVersion}.md\``,
    "- ISA format: `PAI/DOCUMENTATION/IsaFormat.md`",
    "- Config system: `PAI/DOCUMENTATION/Config/ConfigSystem.md`",
    "",
  ];

  return lines.join("\n");
}

// ============================================================================
// ADR threshold detection
// ============================================================================

const DECISIONS_DIR = path.join(PAI_DIR, "DOCUMENTATION", "Decisions");
const ARCH_STATE_FILE = path.join(DECISIONS_DIR, "_arch-state.json");

interface ArchState {
  version: number;
  lastUpdated: string;
  algorithmVersion: string;
  subsystems: string[];
  pipelineDomains: string[];
}

function loadArchState(): ArchState | null {
  if (!fs.existsSync(ARCH_STATE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(ARCH_STATE_FILE, "utf-8")) as ArchState;
  } catch {
    return null;
  }
}

function saveArchState(state: ArchState): void {
  fs.mkdirSync(DECISIONS_DIR, { recursive: true });
  fs.writeFileSync(ARCH_STATE_FILE, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

/** Extract pipeline domain names from the architecture doc's Pipeline Topology table */
function extractPipelineDomains(content: string): string[] {
  const domains: string[] = [];
  const inTopology = /## Pipeline Topology[\s\S]*?(?=\n## |\n$)/;
  const section = content.match(inTopology)?.[0] ?? "";
  for (const line of section.split("\n")) {
    const m = line.match(/^\|\s*\*\*([^*]+)\*\*/);
    if (m) domains.push(m[1].trim());
  }
  return domains;
}

/** Extract subsystem names from the CLAUDE.md routing table (same as extractSubsystems but name-only) */
function extractSubsystemNames(): string[] {
  return extractSubsystems().map(s => s.name);
}

/** Slugify a change description to a filename-safe string */
function toSlug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** Write a single ADR stub. Returns true if written, false if already exists (idempotent). */
function writeStub(name: string, title: string, detected: string, change: string): boolean {
  fs.mkdirSync(DECISIONS_DIR, { recursive: true });
  const filePath = path.join(DECISIONS_DIR, `${name}.md`);
  if (fs.existsSync(filePath)) return false;

  const date = new Date().toISOString().slice(0, 10);
  const content = [
    "---",
    `name: ${name}`,
    `title: "${title}"`,
    `date: ${date}`,
    `status: stub`,
    `detected: ${detected}`,
    `change: "${change}"`,
    "---",
    "",
    "## Decision",
    "",
    "<!-- fill before release -->",
    "",
    "## Alternatives Rejected",
    "",
    "<!-- fill before release -->",
    "",
    "## Evidence",
    "",
    "<!-- fill before release -->",
    "",
    "## Consequences",
    "",
    "<!-- fill before release -->",
    "",
  ].join("\n");

  fs.writeFileSync(filePath, content, "utf-8");
  return true;
}

/** Detect threshold changes and write stubs. Returns count of new stubs created. */
function detectAndStub(archContent: string): number {
  const current: Omit<ArchState, "version" | "lastUpdated"> = {
    algorithmVersion: detectAlgorithmVersion(),
    subsystems: extractSubsystemNames(),
    pipelineDomains: extractPipelineDomains(archContent),
  };

  const prev = loadArchState();
  let stubsCreated = 0;

  if (prev) {
    // (a) Algorithm version bump
    if (current.algorithmVersion !== prev.algorithmVersion &&
        current.algorithmVersion !== "unknown") {
      const name = `algorithm-version-v${current.algorithmVersion}`;
      const written = writeStub(
        name,
        `Algorithm version bumped to v${current.algorithmVersion}`,
        "algorithm-version",
        `Algorithm version changed from v${prev.algorithmVersion} to v${current.algorithmVersion}`,
      );
      if (written) {
        console.log(`  📝 ADR stub: ${name}.md (algorithm version bump)`);
        stubsCreated++;
      }
    }

    // (b) New subsystem rows
    const prevSubs = new Set(prev.subsystems);
    for (const sub of current.subsystems) {
      if (!prevSubs.has(sub)) {
        const name = `new-subsystem-${toSlug(sub)}`;
        const written = writeStub(
          name,
          `Added subsystem: ${sub}`,
          "new-subsystem",
          `New subsystem "${sub}" added to Subsystem Reference`,
        );
        if (written) {
          console.log(`  📝 ADR stub: ${name}.md (new subsystem)`);
          stubsCreated++;
        }
      }
    }

    // (c) New pipeline domains
    const prevDomains = new Set(prev.pipelineDomains);
    for (const domain of current.pipelineDomains) {
      if (!prevDomains.has(domain)) {
        const name = `new-pipeline-domain-${toSlug(domain)}`;
        const written = writeStub(
          name,
          `Added pipeline domain: ${domain}`,
          "new-pipeline-domain",
          `New pipeline domain "${domain}" added to Pipeline Topology`,
        );
        if (written) {
          console.log(`  📝 ADR stub: ${name}.md (new pipeline domain)`);
          stubsCreated++;
        }
      }
    }
  }

  // Save current state as new baseline
  saveArchState({
    version: 1,
    lastUpdated: new Date().toISOString(),
    ...current,
  });

  return stubsCreated;
}

// ============================================================================
// Commands
// ============================================================================

function cmdGenerate(): void {
  const archContent = fs.existsSync(ARCH_SOURCE)
    ? fs.readFileSync(ARCH_SOURCE, "utf-8")
    : "";
  const stubsCreated = detectAndStub(archContent);
  const summary = generate();
  fs.writeFileSync(SUMMARY_OUTPUT, summary);
  console.log(`Generated ${SUMMARY_OUTPUT}`);
  console.log(`  ${summary.split("\n").length} lines`);
  if (stubsCreated > 0) {
    console.log(`  ${stubsCreated} ADR stub(s) written to DOCUMENTATION/Decisions/`);
  }
}

function cmdCheck(): void {
  if (!fs.existsSync(SUMMARY_OUTPUT)) {
    console.log("STALE: Summary does not exist");
    process.exit(1);
  }

  const sourceMtime = getMtime(ARCH_SOURCE);
  const summaryMtime = getMtime(SUMMARY_OUTPUT);
  const claudeMdMtime = getMtime(path.join(HOME, ".claude", "CLAUDE.md"));

  if (sourceMtime > summaryMtime || claudeMdMtime > summaryMtime) {
    console.log("STALE: Source files are newer than summary");
    process.exit(1);
  }

  // Version drift check: the master doc shouldn't mention an older Algorithm version than ALGORITHM/
  const archContent = fs.readFileSync(ARCH_SOURCE, "utf-8");
  const current = detectAlgorithmVersion();
  const cited = [...archContent.matchAll(/v(\d+\.\d+\.\d+)/g)].map(m => m[1]);
  const stale = cited.filter(v => compareSemver(v, current) < 0);
  if (stale.length > 0) {
    console.log(`STALE: PAISystemArchitecture.md references older Algorithm version(s) ${[...new Set(stale)].join(", ")} — current is v${current}`);
    process.exit(1);
  }

  console.log("FRESH: Summary is up to date");
  process.exit(0);
}

// ============================================================================
// CLI Entry
// ============================================================================

const { positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  strict: false,
});

const command = positionals[0];

switch (command) {
  case "generate":
    cmdGenerate();
    break;
  case "check":
    cmdCheck();
    break;
  default:
    console.log(`Usage: bun ArchitectureSummaryGenerator.ts <command>

Commands:
  generate    Generate/regenerate PAI_ARCHITECTURE_SUMMARY.md
  check       Check if summary is stale (exit 1 if stale)`);
    process.exit(command ? 1 : 0);
}
