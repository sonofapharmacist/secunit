#!/usr/bin/env bun
/**
 * LibraryIngest.ts — extract text from classified ebooks and write to KNOWLEDGE/Library/
 *
 * Incremental is the default — only processes books without an existing .md file.
 * Use --full to force re-ingest everything (e.g. after schema/logic changes).
 *
 * Usage:
 *   bun LibraryIngest.ts                          # incremental (default)
 *   bun LibraryIngest.ts --tier priority          # incremental, priority tier only
 *   bun LibraryIngest.ts --full                   # re-ingest all books
 *   bun LibraryIngest.ts --tier priority --limit 5 --dry-run
 *   bun LibraryIngest.ts --preflight
 */

import { mkdir, writeFile, access, stat as fsStat, unlink } from "fs/promises";
import { readFileSync, existsSync } from "fs";
import { join, basename, extname } from "path";
import { spawnSync } from "child_process";

const HOME = process.env.HOME!;
const PAI_DIR = process.env.PAI_DIR || join(HOME, ".claude", "PAI");
const LIBRARY_DIR = join(PAI_DIR, "MEMORY", "KNOWLEDGE", "Library");
const MANIFEST_PATH = join(LIBRARY_DIR, ".library-manifest.json");

// Char limits per tier (≈ chars per word × target words)
const TIER_CHAR_LIMITS: Record<string, number> = {
  priority: 40_000,
  professional: 25_000,
  nonfiction: 2_500,
};

// PDF page limits per tier
const TIER_PAGE_LIMITS: Record<string, number> = {
  priority: 50,
  professional: 30,
  nonfiction: 2,
};

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

// ── Meta parsing ────────────────────────────────────────────────────────────

function cleanMeta(sourcePath: string): { title: string; author: string } {
  let s = basename(sourcePath, extname(sourcePath));

  // Strip ISBN-like numbers in parentheses
  s = s.replace(/\(\d{9,13}\)/g, "");
  // Strip year prefix (realistic years only: 19xx or 20xx)
  s = s.replace(/^(19|20)\d{2}\s+/, "");
  // Strip publisher suffixes like _Rebll _Rsvl _Rsbl
  s = s.replace(/_[A-Z][a-z]{2,5}$/, "");
  // Strip edition markers like [3rdEd] [4th Edition]
  s = s.replace(/\[[^\]]+\]/g, "");
  // Normalize underscores to spaces
  s = s.replace(/_/g, " ").replace(/\s+/g, " ").trim();

  // Try to split on " - " to detect "Author - Title" or "Title - Author"
  const parts = s.split(/\s+-\s+/);
  if (parts.length >= 2) {
    const first = parts[0].trim();
    const second = parts.slice(1).join(" - ").trim();
    // If first part is 2-3 words with no numbers, treat as author
    const firstWords = first.split(/\s+/);
    if (firstWords.length <= 3 && !/\d/.test(first) && firstWords.length < second.split(/\s+/).length) {
      return { author: first, title: second };
    }
    // Check reverse: "A Brief History of Time - Stephen Hawking"
    const secondWords = second.split(/\s+/);
    if (secondWords.length <= 3 && !/\d/.test(second)) {
      return { author: second, title: first };
    }
  }

  return { author: "", title: s };
}

function localPath(entry: BookEntry, mountPath: string): string {
  if (entry.ocr_path) return entry.ocr_path;
  const relative = entry.source_path.replace(/^\/mnt\/user\/books/, "");
  return `${mountPath}${relative}`;
}

function tierTags(tier: Tier): string[] {
  const map: Record<Tier, string[]> = {
    priority: ["security"],
    professional: ["technology"],
    nonfiction: [],
    skip: [],
  };
  return map[tier];
}

// ── Text Extraction ──────────────────────────────────────────────────────────

async function extractPDF(filePath: string, maxPages: number): Promise<{ text: string; pages: number }> {
  const result = spawnSync(
    "pdftotext",
    ["-l", String(maxPages), filePath, "-"],
    { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, timeout: 30_000 }
  );
  const text = (result.stdout || "").trim();
  return { text, pages: maxPages };
}

async function extractEbook(filePath: string): Promise<{ text: string }> {
  const ext = extname(filePath).toLowerCase();
  // CBZ/CBR are image archives — no text
  if (ext === ".cbz" || ext === ".cbr") return { text: "" };

  const tmpPath = `/tmp/libingest-${process.pid}-${Date.now()}.txt`;
  try {
    const result = spawnSync(
      "ebook-convert",
      [filePath, tmpPath],
      { encoding: "utf-8", maxBuffer: 2 * 1024 * 1024, timeout: 60_000, stdio: "pipe" }
    );

    if (result.status !== 0 || !existsSync(tmpPath)) {
      return { text: "" };
    }
    const text = readFileSync(tmpPath, "utf-8").trim();
    return { text };
  } finally {
    try { await unlink(tmpPath); } catch { /* already gone */ }
  }
}

// ── Markdown Generation ──────────────────────────────────────────────────────

function buildMarkdown(
  slug: string,
  meta: { title: string; author: string },
  entry: BookEntry,
  text: string
): string {
  const tags = tierTags(entry.tier);
  const tagsYaml = tags.length > 0 ? `[${tags.map((t) => `"${t}"`).join(", ")}]` : "[]";
  const charLimit = TIER_CHAR_LIMITS[entry.tier] ?? 2_500;
  const excerpt = text.slice(0, charLimit).trim();

  const frontmatter = [
    "---",
    `name: "${meta.title.replace(/"/g, '\\"')}"`,
    `title: "${meta.title.replace(/"/g, '\\"')}"`,
    meta.author ? `author: "${meta.author.replace(/"/g, '\\"')}"` : `author: ""`,
    `tags: ${tagsYaml}`,
    `type: book`,
    `domain: Library`,
    `tier: ${entry.tier}`,
    `format: ${entry.format}`,
    `source_path: "${entry.source_path}"`,
    `source_host: "<NAS_HOST>"`,
    `ingested_at: "${new Date().toISOString()}"`,
    `pages_ingested: ${entry.pages_ingested ?? null}`,
    `text_extractable: ${entry.text_extractable ?? false}`,
    "---",
  ].join("\n");

  const authorLine = meta.author ? ` | **Author:** ${meta.author}` : "";
  const tierLabel = entry.tier.charAt(0).toUpperCase() + entry.tier.slice(1);
  const formatLabel = entry.format.toUpperCase();

  const body = [
    `## ${meta.title}`,
    ``,
    `**Format:** ${formatLabel} | **Tier:** ${tierLabel}${authorLine}`,
    ``,
    excerpt
      ? `### Excerpt\n\n${excerpt}`
      : `### Excerpt\n\n*(text not extractable — scanned PDF or image-only file)*`,
  ].join("\n");

  return `${frontmatter}\n\n${body}\n`;
}

// ── Preflight ────────────────────────────────────────────────────────────────

async function preflight(mountPath: string): Promise<void> {
  let ok = true;

  const checks: Array<{ label: string; pass: boolean; note?: string }> = [];

  // Mount accessible
  let mountOk = false;
  try {
    await access(mountPath);
    mountOk = true;
  } catch { /* noop */ }
  checks.push({ label: `Mount ${mountPath}`, pass: mountOk });

  // pdftotext
  const pt = spawnSync("which", ["pdftotext"], { encoding: "utf-8" });
  checks.push({ label: "pdftotext (poppler-utils)", pass: pt.status === 0 });

  // ebook-convert
  const ec = spawnSync("which", ["ebook-convert"], { encoding: "utf-8" });
  checks.push({ label: "ebook-convert (calibre)", pass: ec.status === 0 });

  // Manifest exists
  const manifestOk = existsSync(MANIFEST_PATH);
  checks.push({ label: "Manifest (.library-manifest.json)", pass: manifestOk, note: manifestOk ? "" : "run LibraryClassify.ts first" });

  // Library dir writable
  try {
    await mkdir(LIBRARY_DIR, { recursive: true });
    checks.push({ label: "KNOWLEDGE/Library/ (writable)", pass: true });
  } catch (e) {
    checks.push({ label: "KNOWLEDGE/Library/ (writable)", pass: false, note: String(e) });
  }

  console.log("\nPreflight checks:");
  for (const c of checks) {
    const icon = c.pass ? "✅" : "❌";
    const note = c.note ? `  (${c.note})` : "";
    console.log(`  ${icon} ${c.label}${note}`);
    if (!c.pass) ok = false;
  }

  console.log(ok ? "\n  All checks passed. Ready to ingest." : "\n  Fix failing checks before ingesting.");
  process.exit(ok ? 0 : 1);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  const mountIdx = args.indexOf("--mount");
  const mountPath = mountIdx !== -1 ? args[mountIdx + 1] : "/mnt/unraid-books";

  if (args.includes("--preflight")) {
    await preflight(mountPath);
    return;
  }

  const tierIdx = args.indexOf("--tier");
  const tierArg = tierIdx !== -1 ? args[tierIdx + 1] : "all";
  const incremental = !args.includes("--full");
  const dryRun = args.includes("--dry-run");
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : Infinity;

  const validTiers = ["priority", "professional", "nonfiction", "all"];
  if (!validTiers.includes(tierArg)) {
    console.error(`Error: --tier must be one of: ${validTiers.join(", ")}`);
    process.exit(1);
  }

  // Check mount accessible before doing anything
  try {
    await access(mountPath);
  } catch {
    console.error(`Error: Mount path not accessible: ${mountPath}`);
    console.error(`       Is the SSHFS mount active? (systemctl status mnt-unraid\\x2dbooks.automount)`);
    console.error(`       Search (MemoryRetriever --domains Library) works without the mount.`);
    process.exit(1);
  }

  // Always re-classify first so the manifest reflects any new books on the NAS
  const classifyScript = join(import.meta.dir, "LibraryClassify.ts");
  const classify = spawnSync("bun", [classifyScript, "--mount", mountPath], {
    encoding: "utf-8",
    stdio: "pipe",
  });
  if (classify.status !== 0) {
    console.error("Error: LibraryClassify failed:\n" + (classify.stderr || classify.stdout));
    process.exit(1);
  }
  // Print last line of classify output (the summary)
  const classifyLines = (classify.stdout || "").trim().split("\n");
  console.log(`Classify: ${classifyLines[classifyLines.length - 1]}`);

  // Load manifest
  if (!existsSync(MANIFEST_PATH)) {
    console.error(`Error: Manifest not found after classify — unexpected.`);
    process.exit(1);
  }
  const manifest: Manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
  await mkdir(LIBRARY_DIR, { recursive: true });

  // Build work list
  const activeTiers: Tier[] = tierArg === "all"
    ? ["priority", "professional", "nonfiction"]
    : [tierArg as Tier];

  const workList = Object.entries(manifest.books).filter(([slug, entry]) => {
    if (!activeTiers.includes(entry.tier)) return false;
    if (incremental) {
      const mdPath = join(LIBRARY_DIR, `${slug}.md`);
      if (existsSync(mdPath)) return false;
    }
    return true;
  });

  const capped = workList.slice(0, isFinite(limit) ? limit : workList.length);

  console.log(`\nLibraryIngest: ${capped.length} books to process (tier: ${tierArg}${incremental ? ", incremental" : ""}${dryRun ? ", dry-run" : ""})`);
  if (capped.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  const stats = { ok: 0, scanned: 0, failed: 0, skipped: 0 };

  for (let i = 0; i < capped.length; i++) {
    const [slug, entry] = capped[i];
    const { title, author } = cleanMeta(entry.source_path);
    const lp = localPath(entry, mountPath);
    const mdPath = join(LIBRARY_DIR, `${slug}.md`);
    const label = `[${i + 1}/${capped.length}] ${slug} (${entry.tier})`;

    if (dryRun) {
      console.log(`${label} → would write ${mdPath}`);
      continue;
    }

    let text = "";
    let textExtractable = false;
    let pagesIngested: number | null = null;

    try {
      // Check local file accessible
      await access(lp);

      if (entry.format === "pdf") {
        const maxPages = TIER_PAGE_LIMITS[entry.tier] ?? 2;
        const { text: extracted, pages } = await extractPDF(lp, maxPages);
        text = extracted;
        pagesIngested = pages;
        textExtractable = text.length > 100;
      } else if (["epub", "mobi", "azw3", "azw"].includes(entry.format)) {
        const { text: extracted } = await extractEbook(lp);
        text = extracted;
        textExtractable = text.length > 100;
      } else {
        // cbz/cbr — image only
        textExtractable = false;
      }
    } catch (err) {
      console.log(`${label} → ❌ access error: ${err}`);
      stats.failed++;
      continue;
    }

    if (!textExtractable) {
      console.log(`${label} → ⚠️ scanned/image-only (${text.length} chars extracted)`);
      stats.scanned++;
    } else {
      const words = text.split(/\s+/).filter(Boolean).length;
      const charLimit = TIER_CHAR_LIMITS[entry.tier] ?? 2_500;
      const stored = Math.min(text.length, charLimit);
      console.log(`${label} → ✅ ${words.toLocaleString()} words (storing ${stored.toLocaleString()} chars)`);
      stats.ok++;
    }

    // Update manifest entry in memory
    entry.text_extractable = textExtractable;
    entry.ingested_at = new Date().toISOString();
    entry.pages_ingested = pagesIngested;

    // Write markdown
    const md = buildMarkdown(slug, { title, author }, entry, text);
    await writeFile(mdPath, md, "utf-8");
  }

  // Save updated manifest
  if (!dryRun) {
    manifest.generated = new Date().toISOString();
    await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2), "utf-8");
  }

  console.log(`\nDone: ${stats.ok} extracted, ${stats.scanned} scanned/image-only, ${stats.failed} failed`);
  const mdCount = existsSync(LIBRARY_DIR)
    ? (await import("fs")).readdirSync(LIBRARY_DIR).filter((f: string) => f.endsWith(".md")).length
    : 0;
  console.log(`Library notes: ${mdCount} files in ${LIBRARY_DIR}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
