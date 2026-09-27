#!/usr/bin/env bun
/**
 * KnowledgeValidator — Deterministic write-time validation for the
 *                       PAI Knowledge Archive.
 *
 * PURPOSE
 *   Catch missing edges and broken edges. Do NOT grade relationship quality.
 *   Density-as-metric is Goodhart's law — if this validator rewards density,
 *   agents will pad `related:` to make it pass and the archive gets worse.
 *
 * CATCHES
 *   FAIL   Schema              Missing required frontmatter fields.
 *   FAIL   TargetResolution    related: slug does not resolve to a note.
 *   FAIL   DuplicateEdge       Same {from, to, type} pair appears twice.
 *   FAIL   SelfLink            related: references its own slug.
 *   FAIL   MaxFour             related: array has more than 4 entries.
 *   WARN   BareRelated         Entry is missing `type:` — defaults silently.
 *   WARN   NoSemanticEdges     Zero wikilinks + zero valid related targets.
 *
 * USAGE
 *   bun KnowledgeValidator.ts                          # validate all domains
 *   bun KnowledgeValidator.ts path/to/note.md          # one file
 *   bun KnowledgeValidator.ts path/to/dir/             # one directory
 *   bun KnowledgeValidator.ts --strict                 # WARNs fail the run
 *   bun KnowledgeValidator.ts --json                   # structured output only
 *
 * EXIT
 *   0 if no FAILs (or with --strict, no FAILs and no WARNs)
 *   1 otherwise
 */

import * as fs from "fs";
import * as path from "path";

const HOME = process.env.HOME!;
const PAI_DIR = process.env.PAI_DIR || path.join(HOME, ".claude", "PAI");
const KNOWLEDGE_DIR = path.join(PAI_DIR, "MEMORY", "KNOWLEDGE");
const DEFAULT_DOMAINS = ["People", "Companies", "Ideas", "Research", "Library", "Projects", "Architecture"];

const REQUIRED_FIELDS = ["title", "type", "tags", "created", "updated", "quality"] as const;
// 0-4 ceiling per the Knowledge skill's Canonical Linking Requirement
// (skills/Knowledge/SKILL.md). The validator is the floor; doctrine is the
// ceiling above it.
const MAX_RELATED_ENTRIES = 4;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Severity = "FAIL" | "WARN";

interface Finding {
  severity: Severity;
  code:
    | "Schema"
    | "TargetResolution"
    | "DuplicateEdge"
    | "SelfLink"
    | "MaxFour"
    | "BareRelated"
    | "NoSemanticEdges";
  message: string;
  field?: string; // related slug, when applicable
}

interface FileReport {
  file: string;
  slug: string;
  findings: Finding[];
}

interface ValidatorResult {
  filesChecked: number;
  filesClean: number;
  failCount: number;
  warnCount: number;
  reports: FileReport[];
}

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

function parseFrontmatter(content: string): { fm: Record<string, any> | null; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { fm: null, body: content };
  const lines = match[1].split("\n");
  const result: Record<string, any> = {};
  for (const line of lines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0 && !line.startsWith(" ") && !line.startsWith("\t")) {
      const key = line.substring(0, colonIdx).trim();
      let value: any = line.substring(colonIdx + 1).trim();
      if (value.startsWith("[") && value.endsWith("]")) {
        value = value
          .slice(1, -1)
          .split(",")
          .map((s: string) => s.trim().replace(/['"]/g, ""))
          .filter((s: string) => s.length > 0);
      } else if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      }
      result[key] = value;
    }
  }
  return { fm: result, body: content.slice(match[0].length) };
}

interface RelatedEntry {
  slug: string;
  type: string;
  hasType: boolean; // distinguishes "bare" entries from explicit types
}

function extractRelated(content: string): RelatedEntry[] {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return [];
  const lines = fmMatch[1].split("\n");
  let inRelated = false;
  const entries: RelatedEntry[] = [];
  let current: { slug: string; type: string | null } | null = null;

  for (const line of lines) {
    if (line.match(/^related\s*:/)) {
      inRelated = true;
      continue;
    }
    if (inRelated) {
      if (
        !line.startsWith("  ") &&
        !line.startsWith("\t") &&
        !line.startsWith("-") &&
        line.trim().length > 0
      ) {
        inRelated = false;
        continue;
      }
      const slugMatch = line.match(/^\s*-?\s*slug:\s*(.+)/);
      if (slugMatch) {
        if (current) {
          entries.push({
            slug: current.slug,
            type: current.type ?? "related",
            hasType: current.type !== null,
          });
        }
        current = { slug: slugMatch[1].trim().replace(/['"]/g, ""), type: null };
        continue;
      }
      const typeMatch = line.match(/^\s*type:\s*(.+)/);
      if (typeMatch && current) {
        current.type = typeMatch[1].trim().replace(/['"]/g, "");
      }
    }
  }
  if (current) {
    entries.push({
      slug: current.slug,
      type: current.type ?? "related",
      hasType: current.type !== null,
    });
  }
  return entries;
}

function extractWikilinkSlugs(body: string): string[] {
  const slugs: string[] = [];
  const regex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  let match;
  while ((match = regex.exec(body)) !== null) {
    const raw = match[1].trim();
    const slug = raw.includes("/") ? raw.split("/").pop()! : raw;
    if (slug && !slug.startsWith("_")) slugs.push(slug);
  }
  return slugs;
}

// ---------------------------------------------------------------------------
// Per-file validation
// ---------------------------------------------------------------------------

interface ArchiveIndex {
  // slug -> set of valid target slugs (computed once)
  knownSlugs: Set<string>;
}

function buildArchiveIndex(): ArchiveIndex {
  const knownSlugs = new Set<string>();
  for (const domain of DEFAULT_DOMAINS) {
    const domainDir = path.join(KNOWLEDGE_DIR, domain);
    if (!fs.existsSync(domainDir)) continue;
    for (const entry of fs.readdirSync(domainDir)) {
      if (!entry.endsWith(".md")) continue;
      if (entry.startsWith("_")) continue;
      knownSlugs.add(entry.replace(/\.md$/, ""));
    }
  }
  return { knownSlugs };
}

function validateFile(filePath: string, index: ArchiveIndex): FileReport {
  const slug = path.basename(filePath, ".md");
  const findings: Finding[] = [];

  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return { file: filePath, slug, findings: [{ severity: "FAIL", code: "Schema", message: "Could not read file" }] };
  }

  const { fm, body } = parseFrontmatter(content);

  if (!fm) {
    return {
      file: filePath,
      slug,
      findings: [{ severity: "FAIL", code: "Schema", message: "Missing or malformed frontmatter (no `---` block)" }],
    };
  }

  // Schema check
  for (const field of REQUIRED_FIELDS) {
    if (fm[field] === undefined || fm[field] === null || fm[field] === "") {
      findings.push({
        severity: "FAIL",
        code: "Schema",
        message: `Missing required frontmatter field: ${field}`,
        field,
      });
    }
  }
  // tags must have at least one entry
  if (Array.isArray(fm.tags) && fm.tags.length === 0) {
    findings.push({
      severity: "FAIL",
      code: "Schema",
      message: "Required field `tags` must have at least one entry",
      field: "tags",
    });
  }
  // quality must be 0-10
  if (fm.quality !== undefined) {
    const q = Number(fm.quality);
    if (isNaN(q) || q < 0 || q > 10) {
      findings.push({
        severity: "FAIL",
        code: "Schema",
        message: `Field 'quality' must be a number in [0,10], got: ${fm.quality}`,
        field: "quality",
      });
    }
  }

  // related: checks
  const related = extractRelated(content);

  if (related.length > MAX_RELATED_ENTRIES) {
    findings.push({
      severity: "FAIL",
      code: "MaxFour",
      message: `related: array has ${related.length} entries; max is ${MAX_RELATED_ENTRIES}`,
    });
  }

  const seenPairs = new Set<string>();
  let resolvedTargets = 0;

  for (const entry of related) {
    // Self-link
    if (entry.slug === slug) {
      findings.push({
        severity: "FAIL",
        code: "SelfLink",
        message: `related: entry references its own slug "${entry.slug}"`,
        field: entry.slug,
      });
      continue;
    }

    // Target resolution
    if (!index.knownSlugs.has(entry.slug)) {
      findings.push({
        severity: "FAIL",
        code: "TargetResolution",
        message: `related: target slug "${entry.slug}" does not resolve to a note in any domain`,
        field: entry.slug,
      });
    } else {
      resolvedTargets += 1;
    }

    // Duplicate edge detection within the same file
    const pairKey = `${entry.slug}|${entry.type}`;
    if (seenPairs.has(pairKey)) {
      findings.push({
        severity: "FAIL",
        code: "DuplicateEdge",
        message: `Duplicate edge to "${entry.slug}" with type "${entry.type}"`,
        field: entry.slug,
      });
    } else {
      seenPairs.add(pairKey);
    }

    // Bare related: warning — `type:` line absent
    if (!entry.hasType) {
      findings.push({
        severity: "WARN",
        code: "BareRelated",
        message: `related: entry to "${entry.slug}" has no explicit type — defaults to "related"`,
        field: entry.slug,
      });
    }
  }

  // No-semantic-edges — surfaced as an invitation, not a deficiency.
  // Tags do NOT count (they would re-create the coverage-mask problem this
  // layer split removed). If this warning feels like pressure to add a
  // relation, suppress it for this file: a deliberate orphan is more
  // honest than a padded one.
  const bodyWikilinks = extractWikilinkSlugs(body);
  const anyResolved = resolvedTargets > 0 || bodyWikilinks.length > 0;
  if (!anyResolved) {
    findings.push({
      severity: "WARN",
      code: "NoSemanticEdges",
      message: "No resolved related: targets and no body wikilinks — the note will appear isolated in graph traversal; consider a real relation, or leave it as a deliberate orphan",
    });
  }

  return { file: filePath, slug, findings };
}

// ---------------------------------------------------------------------------
// Filesystem walk
// ---------------------------------------------------------------------------

function* walkMarkdown(root: string): Generator<string> {
  const stat = fs.statSync(root);
  if (stat.isFile()) {
    if (root.endsWith(".md")) yield root;
    return;
  }
  for (const entry of fs.readdirSync(root)) {
    const full = path.join(root, entry);
    let s;
    try {
      s = fs.statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      if (entry.startsWith("_")) continue;
      yield* walkMarkdown(full);
    } else if (s.isFile() && full.endsWith(".md")) {
      yield full;
    }
  }
}

function resolveTargets(targets: string[]): string[] {
  if (targets.length === 0) {
    const all: string[] = [];
    for (const d of DEFAULT_DOMAINS) {
      const dir = path.join(KNOWLEDGE_DIR, d);
      if (fs.existsSync(dir)) all.push(dir);
    }
    return all;
  }
  return targets;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs() {
  const { values, positionals } = (() => {
    const out: { values: Record<string, any>; positionals: string[] } = {
      values: {},
      positionals: [],
    };
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === "--strict") out.values.strict = true;
      else if (a === "--json") out.values.json = true;
      else if (a === "--help" || a === "-h") out.values.help = true;
      else out.positionals.push(a);
    }
    return out;
  })();

  const strict = !!values.strict;
  const jsonOnly = !!values.json;

  if (values.help) {
    console.log(`KnowledgeValidator — write-time validation for the PAI Knowledge Archive.

Usage:
  bun KnowledgeValidator.ts                              # all domains
  bun KnowledgeValidator.ts <path.md>                    # one file
  bun KnowledgeValidator.ts <dir>                        # one directory
  bun KnowledgeValidator.ts --strict                     # WARNs fail the run
  bun KnowledgeValidator.ts --json                       # JSON output only

Exit codes:
  0  no FAILs (with --strict: no FAILs and no WARNs)
  1  any FAIL (or, with --strict, any WARN)`);
    process.exit(0);
  }

  return { strict, jsonOnly, positionals };
}

function main() {
  const { strict, jsonOnly, positionals } = parseArgs();
  const index = buildArchiveIndex();
  const targets = resolveTargets(positionals);

  const reports: FileReport[] = [];
  for (const root of targets) {
    for (const file of walkMarkdown(root)) {
      reports.push(validateFile(file, index));
    }
  }

  const failCount = reports.reduce((acc, r) => acc + r.findings.filter((f) => f.severity === "FAIL").length, 0);
  const warnCount = reports.reduce((acc, r) => acc + r.findings.filter((f) => f.severity === "WARN").length, 0);
  const filesChecked = reports.length;
  const filesClean = reports.filter((r) => r.findings.length === 0).length;

  const result: ValidatorResult = { filesChecked, filesClean, failCount, warnCount, reports };

  if (jsonOnly) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\n\u{1F50D} Knowledge Validator`);
    console.log("─".repeat(50));
    console.log(`  Files: ${filesChecked} checked, ${filesClean} clean`);
    console.log(`  Findings: ${failCount} FAIL, ${warnCount} WARN`);
    console.log("─".repeat(50));

    const dirty = reports.filter((r) => r.findings.length > 0);
    if (dirty.length === 0) {
      console.log("  No issues found.");
    } else {
      for (const r of dirty) {
        const fails = r.findings.filter((f) => f.severity === "FAIL").length;
        const warns = r.findings.filter((f) => f.severity === "WARN").length;
        console.log(`\n  ${r.slug} (${path.relative(KNOWLEDGE_DIR, r.file)}): ${fails} FAIL, ${warns} WARN`);
        for (const f of r.findings) {
          console.log(`    [${f.severity}] ${f.code}: ${f.message}`);
        }
      }
    }
    console.log("\n" + "─".repeat(50));
  }

  const exitCode = strict ? failCount + warnCount > 0 ? 1 : 0 : failCount > 0 ? 1 : 0;
  process.exit(exitCode);
}

main();
