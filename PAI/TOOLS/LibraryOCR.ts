#!/usr/bin/env bun
/**
 * LibraryOCR.ts — detect thin PDF ingests and stage OCRed copies for re-ingest
 *
 * Usage:
 *   bun LibraryOCR.ts
 *   bun LibraryOCR.ts --tier all
 *   bun LibraryOCR.ts --slug some-book-slug
 *   bun LibraryOCR.ts --dry-run --tier priority
 *   bun LibraryOCR.ts --force
 *   bun LibraryOCR.ts --help
 */

import { access, mkdir, readFile, unlink, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";

const HOME = process.env.HOME!;
const PAI_DIR = process.env.PAI_DIR || join(HOME, ".claude", "PAI");
const LIBRARY_DIR = join(PAI_DIR, "MEMORY", "KNOWLEDGE", "Library");
const MANIFEST_PATH = join(LIBRARY_DIR, ".library-manifest.json");

const OCR_CACHE_DIR = join(LIBRARY_DIR, ".ocr-cache");
const DEFAULT_MOUNT_PATH = "/mnt/unraid-books";
const OCR_TIMEOUT_MS = 300_000;
const EXCERPT_WORD_THRESHOLD = 80;
const NAS_SOURCE_PREFIX = "/mnt/user/books";

type Tier = "priority" | "professional" | "nonfiction" | "skip";
type Format = "pdf" | "epub" | "mobi" | "azw3" | "azw" | "cbz" | "cbr" | "unknown";
type TierFilter = "priority" | "professional" | "nonfiction" | "all";

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

interface CliOptions {
  dryRun: boolean;
  force: boolean;
  help: boolean;
  mountPath: string;
  slug: string | null;
  tier: TierFilter;
}

interface OcrCandidate {
  slug: string;
  entry: BookEntry;
  excerptWords: number;
  mdPath: string;
  ocrCachePath: string;
  sourceLocalPath: string;
}

interface ExcerptScanResult {
  kind: "missing-file" | "missing-section" | "empty-body" | "ok";
  wordCount: number;
}

function printHelp(): void {
  console.log(`LibraryOCR.ts

Usage:
  bun LibraryOCR.ts [options]

Options:
  --dry-run        List OCR candidates without invoking ocrmypdf
  --force          Re-run OCR even when ocr_at is already set
  --slug <slug>    Target exactly one manifest entry and bypass tier filtering
  --tier <tier>    priority (default), professional, nonfiction, or all
  --mount <path>   SSHFS mount path (default: ${DEFAULT_MOUNT_PATH})
  --help           Show this help text
`);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    dryRun: false,
    force: false,
    help: false,
    mountPath: DEFAULT_MOUNT_PATH,
    slug: null,
    tier: "priority",
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--force") {
      options.force = true;
      continue;
    }
    if (arg === "--help") {
      options.help = true;
      continue;
    }
    if (arg === "--mount") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("Error: --mount requires a path argument");
      }
      options.mountPath = value;
      i++;
      continue;
    }
    if (arg === "--slug") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("Error: --slug requires a slug argument");
      }
      options.slug = value;
      i++;
      continue;
    }
    if (arg === "--tier") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("Error: --tier requires a tier argument");
      }
      if (value !== "priority" && value !== "professional" && value !== "nonfiction" && value !== "all") {
        throw new Error("Error: --tier must be one of: priority, professional, nonfiction, all");
      }
      options.tier = value;
      i++;
      continue;
    }

    throw new Error(`Error: unknown argument: ${arg}`);
  }

  return options;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && ("message" in error || "code" in error);
}

function formatError(error: unknown): string {
  if (isNodeError(error)) {
    const code = error.code ? `${error.code}: ` : "";
    return `${code}${error.message}`;
  }
  return String(error);
}

function sanitizeProcessOutput(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact || "(no stderr)";
}

function localSourcePath(sourcePath: string, mountPath: string): string {
  if (!sourcePath.startsWith(NAS_SOURCE_PREFIX)) {
    throw new Error(`Unexpected NAS source path: ${sourcePath}`);
  }

  const relativeSource = sourcePath.slice(NAS_SOURCE_PREFIX.length).replace(/^\/+/, "");
  return join(mountPath, relativeSource);
}

async function loadManifest(): Promise<Manifest> {
  if (!existsSync(MANIFEST_PATH)) {
    throw new Error(`Manifest not found: ${MANIFEST_PATH}`);
  }

  let raw: string;
  try {
    raw = await readFile(MANIFEST_PATH, "utf-8");
  } catch (error) {
    throw new Error(`Failed to read manifest: ${formatError(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse manifest JSON: ${formatError(error)}`);
  }

  if (!parsed || typeof parsed !== "object" || !("books" in parsed)) {
    throw new Error(`Manifest is missing a books object: ${MANIFEST_PATH}`);
  }

  const manifest = parsed as Manifest;
  if (!manifest.books || typeof manifest.books !== "object") {
    throw new Error(`Manifest books field is invalid: ${MANIFEST_PATH}`);
  }

  return manifest;
}

async function saveManifest(manifest: Manifest): Promise<void> {
  manifest.generated = new Date().toISOString();

  try {
    await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
  } catch (error) {
    throw new Error(`Failed to write manifest: ${formatError(error)}`);
  }
}

async function excerptWordCount(mdPath: string): Promise<ExcerptScanResult> {
  let content: string;

  try {
    content = await readFile(mdPath, "utf-8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { kind: "missing-file", wordCount: 0 };
    }
    throw new Error(`Failed to read markdown file ${mdPath}: ${formatError(error)}`);
  }

  const excerptMatch = content.match(/(?:^|\r?\n)### Excerpt[ \t]*\r?\n/);
  if (!excerptMatch || excerptMatch.index === undefined) {
    return { kind: "missing-section", wordCount: 0 };
  }

  const excerptStart = excerptMatch.index + excerptMatch[0].length;
  const excerptBody = content.slice(excerptStart).replace(/^(?:[ \t]*\r?\n)+/, "");

  if (!excerptBody.trim()) {
    return { kind: "empty-body", wordCount: 0 };
  }

  const wordCount = excerptBody.trim().split(/\s+/).filter(Boolean).length;
  return { kind: "ok", wordCount };
}

function activeTiers(tier: TierFilter): Tier[] {
  if (tier === "all") {
    return ["priority", "professional", "nonfiction"];
  }
  return [tier];
}

async function findOcrCandidates(manifest: Manifest, options: CliOptions): Promise<OcrCandidate[]> {
  const candidates: OcrCandidate[] = [];

  if (options.slug !== null && !manifest.books[options.slug]) {
    throw new Error(`Slug not found in manifest: ${options.slug}`);
  }

  const tiers = activeTiers(options.tier);
  const slugs = options.slug !== null ? [options.slug] : Object.keys(manifest.books);

  for (const slug of slugs) {
    const entry = manifest.books[slug];
    if (!entry) {
      continue;
    }
    if (entry.format !== "pdf") {
      continue;
    }
    if (options.slug === null && !tiers.includes(entry.tier)) {
      continue;
    }
    if (!options.force && entry.ocr_at) {
      continue;
    }

    const mdPath = join(LIBRARY_DIR, `${slug}.md`);
    const excerpt = await excerptWordCount(mdPath);

    if (excerpt.kind === "missing-file") {
      // Missing markdown means this book has not been ingested yet, so there is no thin ingest to evaluate.
      continue;
    }
    if (excerpt.wordCount >= EXCERPT_WORD_THRESHOLD) {
      continue;
    }

    candidates.push({
      slug,
      entry,
      excerptWords: excerpt.wordCount,
      mdPath,
      ocrCachePath: join(OCR_CACHE_DIR, `${slug}.pdf`),
      sourceLocalPath: localSourcePath(entry.source_path, options.mountPath),
    });
  }

  return candidates;
}

async function ensureMountAccessible(mountPath: string): Promise<void> {
  try {
    await access(mountPath);
  } catch (error) {
    throw new Error(`Mount path not accessible: ${mountPath} (${formatError(error)})`);
  }
}

async function ensureOcrCacheDir(): Promise<void> {
  try {
    await mkdir(OCR_CACHE_DIR, { recursive: true });
  } catch (error) {
    throw new Error(`Failed to create OCR cache directory ${OCR_CACHE_DIR}: ${formatError(error)}`);
  }
}

async function removeExistingCacheFile(ocrCachePath: string): Promise<void> {
  try {
    await unlink(ocrCachePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }
    throw new Error(`Failed to remove existing OCR cache file ${ocrCachePath}: ${formatError(error)}`);
  }
}

function runOcr(sourceLocalPath: string, ocrCachePath: string): ReturnType<typeof spawnSync> {
  return spawnSync("ocrmypdf", ["--skip-text", sourceLocalPath, ocrCachePath], {
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
    stdio: "pipe",
    timeout: OCR_TIMEOUT_MS,
  });
}

async function removeStaleMarkdown(mdPath: string): Promise<void> {
  try {
    await unlink(mdPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }
    throw new Error(`Failed to remove stale markdown ${mdPath}: ${formatError(error)}`);
  }
}

async function persistSuccessfulOcr(manifest: Manifest, candidate: OcrCandidate): Promise<void> {
  const entry = manifest.books[candidate.slug];
  const previousOcrPath = entry.ocr_path ?? null;
  const previousOcrAt = entry.ocr_at ?? null;

  entry.ocr_path = candidate.ocrCachePath;
  entry.ocr_at = new Date().toISOString();

  try {
    await saveManifest(manifest);
  } catch (error) {
    entry.ocr_path = previousOcrPath;
    entry.ocr_at = previousOcrAt;
    throw error;
  }

  try {
    await removeStaleMarkdown(candidate.mdPath);
  } catch (error) {
    entry.ocr_path = previousOcrPath;
    entry.ocr_at = previousOcrAt;

    try {
      await saveManifest(manifest);
    } catch (revertError) {
      throw new Error(
        `Failed after OCR for ${candidate.slug}: ${formatError(error)}; also failed to revert manifest: ${formatError(revertError)}`
      );
    }

    throw error;
  }
}

function processFailure(result: ReturnType<typeof spawnSync>): Error {
  if (result.error) {
    if (isNodeError(result.error) && result.error.code === "ETIMEDOUT") {
      return new Error(`stderr: ocrmypdf timed out after ${OCR_TIMEOUT_MS}ms`);
    }
    return new Error(`stderr: ${sanitizeProcessOutput(formatError(result.error))}`);
  }

  const stderr = sanitizeProcessOutput(result.stderr || result.stdout || "");
  return new Error(`stderr: ${stderr}`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const manifest = await loadManifest();
  const candidates = await findOcrCandidates(manifest, options);
  const scopeLabel = options.slug ? `slug:${options.slug}` : options.tier;

  console.log(`LibraryOCR: ${candidates.length} candidates (tier: ${scopeLabel}, dry-run: ${options.dryRun})`);

  if (options.dryRun) {
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      console.log(`  [${i + 1}/${candidates.length}] ${candidate.slug} -> would OCR (${candidate.excerptWords} words)`);
    }
    console.log("Done: 0 OCR'd, 0 failed");
    return;
  }

  if (candidates.length === 0) {
    console.log("Done: 0 OCR'd, 0 failed");
    return;
  }

  await ensureMountAccessible(options.mountPath);
  await ensureOcrCacheDir();

  let okCount = 0;
  let failedCount = 0;

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const label = `  [${i + 1}/${candidates.length}] ${candidate.slug} -> OCR...`;
    const startedAt = Date.now();

    try {
      if (candidate.entry.format !== "pdf") {
        throw new Error("error: refusing to OCR a non-PDF entry");
      }

      await access(candidate.sourceLocalPath);
      await removeExistingCacheFile(candidate.ocrCachePath);

      const result = runOcr(candidate.sourceLocalPath, candidate.ocrCachePath);
      if (result.status !== 0) {
        throw processFailure(result);
      }

      await persistSuccessfulOcr(manifest, candidate);

      const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(`${label} OK (${elapsedSeconds}s)`);
      okCount++;
    } catch (error) {
      console.log(`${label} FAIL ${formatError(error)}`);
      failedCount++;
    }
  }

  console.log(`Done: ${okCount} OCR'd, ${failedCount} failed`);
}

main().catch((error) => {
  console.error(formatError(error));
  process.exit(1);
});
