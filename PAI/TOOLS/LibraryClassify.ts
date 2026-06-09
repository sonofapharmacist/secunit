#!/usr/bin/env bun
/**
 * LibraryClassify.ts — scan SSHFS-mounted books directory, classify by tier, write manifest
 *
 * Usage:
 *   bun LibraryClassify.ts --mount /mnt/unraid-books
 *   bun LibraryClassify.ts --mount /mnt/unraid-books --dry-run
 */

import { readdir, stat, mkdir } from "fs/promises";
import { join, extname, basename, relative } from "path";
import { writeFileSync, existsSync, readFileSync } from "fs";

const MANIFEST_PATH = `${process.env.HOME}/.claude/PAI/MEMORY/KNOWLEDGE/Library/.library-manifest.json`;
const SUPPORTED_FORMATS = new Set([".pdf", ".epub", ".mobi", ".azw3", ".azw", ".cbz", ".cbr"]);

// Skip hidden dirs and MoonReader internals
const SKIP_DIRS = new Set([".sync", ".MoonReader", "MoonReader"]);

// T4 wins on any match — explicit exclusion (D&D, fiction, gaming)
const T4_KEYWORDS = [
  "dungeons", "dragons", "pathfinder", "warhammer", "starfinder", "tolkien",
  "fantasy", "fiction", "novel", "manga", "comics", "roleplaying", "d&d",
  " rpg", "tabletop", "rulebook", "sourcebook", "campaign", "adventure module",
  "dnd", "dmsguild", "humble bundle", "tiamat", "mordenkainen", "monster manual",
  "player's handbook", "dungeon master", "players handbook",
];

// T1 — security, pentest, offensive, defensive, compliance
const T1_KEYWORDS = [
  "security", "pentest", "hacking", "appsec", "oscp", "malware", "reverse engineering",
  "reverse engineer", "exploit", "threat", "vulnerability", "burp", "nmap", "owasp",
  "ctf", "red team", "blue team", "dfir", "forensics", "compliance", "siem",
  "incident", "penetration", "offensive", "defensive", "cissp", "cism", "ccsp", "cysa",
  "ethical hack", "metasploit", "kali", "backdoor", "rootkit", "phishing",
  "social engineering", "network attack", "privilege escalation", "injection",
  "authentication", "zero day", "zero-day", "cve", "nvd", "mitre", "attack surface",
  "bug bounty", "recon", "enumeration", "payload", "shellcode", "buffer overflow",
  "2600", "hacker", "infosec", "cybersecurity", "cyber security",
  "gray hat", "black hat", "white hat", "cracking", "reversing", "binary analysis",
  "malware analysis", "threat intel", "threat hunting", "decompil", "disassembl",
];

// T2 — AI/ML, engineering, programming, architecture, cloud, devops
const T2_KEYWORDS = [
  "machine learning", "neural", "gpt", "transformers", "llm", "artificial intelligence",
  "deep learning", "python", "typescript", "golang", " rust", "javascript",
  "programming", "software engineering", "system design", "design patterns",
  "devops", "kubernetes", "docker", "aws", "azure", "cloud", "microservices",
  "database", "sql", "nosql", "api", "rest", "graphql", "architecture",
  "algorithms", "data structures", "compiler", "operating system", "linux",
  "networking", "tcp", "protocol", "infrastructure", "site reliability",
  "machine intelligence", "reinforcement learning", "nlp", "computer vision",
  "statistics", "data science", "analytics", "visualization", "modeling",
];

type Tier = "priority" | "professional" | "nonfiction" | "skip";
type Format = "pdf" | "epub" | "mobi" | "azw3" | "azw" | "cbz" | "cbr" | "unknown";

interface BookEntry {
  source_path: string;
  tier: Tier;
  format: Format;
  text_extractable: boolean | null;
  ingested_at: string | null;
  source_mtime: number;
  pages_ingested?: number | null;
  ocr_path?: string | null;
  ocr_at?: string | null;
}

interface Manifest {
  generated: string;
  source_host: string;
  mount_path: string;
  total_files: number;
  manifest_version: number;
  books: Record<string, BookEntry>;
}

function slugify(filePath: string, mountPath: string): string {
  const rel = relative(mountPath, filePath);
  // Use basename without extension for slug
  const name = basename(rel, extname(rel));
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

function classifyTier(filePath: string, mountPath: string): Tier {
  const rel = relative(mountPath, filePath).toLowerCase();

  // T4 wins on any keyword match
  for (const kw of T4_KEYWORDS) {
    if (rel.includes(kw)) return "skip";
  }

  // Score T1 and T2
  let t1Score = 0;
  let t2Score = 0;

  for (const kw of T1_KEYWORDS) {
    if (rel.includes(kw)) t1Score++;
  }
  for (const kw of T2_KEYWORDS) {
    if (rel.includes(kw)) t2Score++;
  }

  if (t1Score > 0 && t1Score >= t2Score) return "priority";
  if (t2Score > 0) return "professional";
  return "nonfiction";
}

function parseFormat(filePath: string): Format {
  const ext = extname(filePath).toLowerCase();
  const formats: Record<string, Format> = {
    ".pdf": "pdf",
    ".epub": "epub",
    ".mobi": "mobi",
    ".azw3": "azw3",
    ".azw": "azw",
    ".cbz": "cbz",
    ".cbr": "cbr",
  };
  return formats[ext] ?? "unknown";
}

async function walkDir(dir: string, files: string[]): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.startsWith(".") || SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let s;
    try {
      s = await stat(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      await walkDir(full, files);
    } else if (s.isFile() && SUPPORTED_FORMATS.has(extname(entry).toLowerCase())) {
      files.push(full);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const mountIdx = args.indexOf("--mount");
  const dryRun = args.includes("--dry-run");

  if (mountIdx === -1) {
    console.error("Usage: bun LibraryClassify.ts --mount <path> [--dry-run]");
    process.exit(1);
  }

  const mountPath = args[mountIdx + 1];
  if (!mountPath) {
    console.error("Error: --mount requires a path argument");
    process.exit(1);
  }

  try {
    await import("fs/promises").then(m => m.access(mountPath));
  } catch {
    console.error(`Error: Mount path not accessible: ${mountPath}`);
    console.error(`       Is the SSHFS mount active? (systemctl status mnt-unraid\\x2dbooks.automount)`);
    process.exit(1);
  }

  console.log(`Scanning ${mountPath}...`);
  const startTime = Date.now();

  const files: string[] = [];
  await walkDir(mountPath, files);

  console.log(`Found ${files.length} ebook files. Classifying...`);

  const tierCounts: Record<Tier, number> = {
    priority: 0,
    professional: 0,
    nonfiction: 0,
    skip: 0,
  };

  // Load existing manifest to preserve durable fields (text_extractable, ingested_at, ocr_path, ocr_at)
  let existingBooks: Record<string, BookEntry> = {};
  if (existsSync(MANIFEST_PATH)) {
    try {
      existingBooks = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8")).books ?? {};
    } catch { /* corrupt manifest — start fresh */ }
  }

  const books: Record<string, BookEntry> = {};
  const seenSlugs = new Map<string, number>();

  for (const file of files) {
    const tier = classifyTier(file, mountPath);
    const format = parseFormat(file);
    tierCounts[tier]++;

    let slug = slugify(file, mountPath);

    // Handle duplicate slugs by appending a counter
    const count = seenSlugs.get(slug) ?? 0;
    seenSlugs.set(slug, count + 1);
    if (count > 0) slug = `${slug}-${count}`;

    let mtime = 0;
    try {
      const s = await stat(file);
      mtime = Math.floor(s.mtimeMs / 1000);
    } catch {
      // leave as 0
    }

    // source_path is the Unraid path (strip mount prefix, add /mnt/user/books prefix)
    const unraidPath = "/mnt/user/books" + file.slice(mountPath.length);

    const prior = existingBooks[slug];
    books[slug] = {
      source_path: unraidPath,
      tier,
      format,
      text_extractable: prior?.text_extractable ?? null,
      ingested_at: prior?.ingested_at ?? null,
      source_mtime: mtime,
      pages_ingested: prior?.pages_ingested ?? null,
      ocr_path: prior?.ocr_path ?? null,
      ocr_at: prior?.ocr_at ?? null,
    };
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`\nClassification complete in ${elapsed}s:`);
  console.log(`  T1 priority:     ${tierCounts.priority}`);
  console.log(`  T2 professional: ${tierCounts.professional}`);
  console.log(`  T3 nonfiction:   ${tierCounts.nonfiction}`);
  console.log(`  T4 skip:         ${tierCounts.skip}`);
  console.log(`  Total:           ${files.length}`);

  const manifest: Manifest = {
    generated: new Date().toISOString(),
    source_host: "<NAS_HOST>",
    mount_path: mountPath,
    total_files: files.length,
    manifest_version: 2,
    books,
  };

  if (dryRun) {
    console.log(`\n[dry-run] Would write manifest to: ${MANIFEST_PATH}`);
    // Print sample of each tier
    for (const tier of ["priority", "professional", "nonfiction", "skip"] as Tier[]) {
      const sample = Object.entries(books)
        .filter(([, v]) => v.tier === tier)
        .slice(0, 3)
        .map(([slug, v]) => `  ${slug} (${v.format})`);
      if (sample.length) {
        console.log(`\nSample ${tier}:`);
        sample.forEach((s) => console.log(s));
      }
    }
    return;
  }

  await mkdir(
    `${process.env.HOME}/.claude/PAI/MEMORY/KNOWLEDGE/Library`,
    { recursive: true }
  );

  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  console.log(`\nManifest written to: ${MANIFEST_PATH}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
