#!/usr/bin/env bun

import { access, unlink } from "fs/promises";
import { readFileSync, existsSync } from "fs";
import { join, basename, extname } from "path";
import { spawnSync } from "child_process";

const HOME = process.env.HOME!;
const PAI_DIR = process.env.PAI_DIR || join(HOME, ".claude", "PAI");
const LIBRARY_DIR = join(PAI_DIR, "MEMORY", "KNOWLEDGE", "Library");
const MANIFEST_PATH = join(LIBRARY_DIR, ".library-manifest.json");
const INFERENCE_PATH = join(PAI_DIR, "TOOLS", "Inference.ts");
const DEFAULT_MOUNT_PATH = "/mnt/unraid-books";
const DEFAULT_BUDGET = 2000;
const EXTRACTION_CAP = 200_000;

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
}

interface Manifest {
  generated: string;
  source_host: string;
  mount_path: string;
  total_files: number;
  manifest_version: number;
  books: Record<string, BookEntry>;
}

interface CliArgs {
  slug?: string;
  mountPath: string;
  budget: number;
  pages?: number;
  raw: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    slug: undefined,
    mountPath: DEFAULT_MOUNT_PATH,
    budget: DEFAULT_BUDGET,
    pages: undefined,
    raw: false,
    help: argv.length === 0,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--help") {
      args.help = true;
      continue;
    }

    if (arg === "--raw") {
      args.raw = true;
      continue;
    }

    if (arg === "--mount") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("Missing value for --mount");
      }
      args.mountPath = value;
      i += 1;
      continue;
    }

    if (arg === "--budget") {
      const value = argv[i + 1];
      const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
      if (!value || !Number.isInteger(parsed) || parsed <= 0) {
        throw new Error("Invalid value for --budget");
      }
      args.budget = parsed;
      i += 1;
      continue;
    }

    if (arg === "--pages") {
      const value = argv[i + 1];
      const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
      if (!value || !Number.isInteger(parsed) || parsed <= 0) {
        throw new Error("Invalid value for --pages");
      }
      args.pages = parsed;
      i += 1;
      continue;
    }

    if (arg.startsWith("--")) {
      throw new Error(`Unknown flag: ${arg}`);
    }

    if (!args.slug) {
      args.slug = arg;
      continue;
    }

    throw new Error(`Unexpected argument: ${arg}`);
  }

  return args;
}

function printUsage(): void {
  process.stdout.write(
    "Usage: bun LibraryFetch.ts <slug> [--mount <path>] [--budget <n>] [--pages <n>] [--raw] [--help]\n" +
    "Defaults: --mount /mnt/unraid-books, --budget 2000, --pages all\n"
  );
}

function loadManifest(): Manifest {
  if (!existsSync(MANIFEST_PATH)) {
    throw new Error(`Manifest not found at ${MANIFEST_PATH}`);
  }

  try {
    const raw: string = readFileSync(MANIFEST_PATH, "utf-8");
    return JSON.parse(raw) as Manifest;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to parse manifest at ${MANIFEST_PATH}: ${error.message}`);
    }
    throw new Error(`Failed to parse manifest at ${MANIFEST_PATH}: ${String(error)}`);
  }
}

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
  // source_path is the Unraid NAS path; strip the NAS prefix and prepend the SSHFS mount
  const relative = entry.source_path.replace(/^\/mnt\/user\/books/, "");
  return `${mountPath}${relative}`;
}

async function extractPDF(filePath: string, pages?: number): Promise<string> {
  const args: string[] = pages === undefined
    ? [filePath, "-"]
    : ["-l", String(pages), filePath, "-"];
  const result = spawnSync(
    "pdftotext",
    args,
    { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, timeout: 30_000, stdio: "pipe" }
  );

  if (result.error) {
    throw new Error(`pdftotext failed for ${filePath}: ${result.error.message}`);
  }

  return (result.stdout || "").trim();
}

async function extractEbook(filePath: string): Promise<string> {
  const tmpPath = `/tmp/libfetch-${process.pid}-${Date.now()}.txt`;

  try {
    const result = spawnSync(
      "ebook-convert",
      [filePath, tmpPath],
      { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, timeout: 60_000, stdio: "pipe" }
    );

    if (result.error) {
      throw new Error(`ebook-convert failed for ${filePath}: ${result.error.message}`);
    }

    if (result.status !== 0 || !existsSync(tmpPath)) {
      return "";
    }

    return readFileSync(tmpPath, "utf-8").trim();
  } finally {
    try {
      await unlink(tmpPath);
    } catch (error) {
      if (error instanceof Error && !error.message.includes("ENOENT")) {
        process.stderr.write(`Warning: failed to remove temp file ${tmpPath}: ${error.message}\n`);
      } else if (!(error instanceof Error)) {
        process.stderr.write(`Warning: failed to remove temp file ${tmpPath}: ${String(error)}\n`);
      }
    }
  }
}

function compressViaInference(
  title: string,
  author: string,
  entry: BookEntry,
  budget: number,
  rawText: string
): string {
  const systemPrompt = [
    `You compress book text into a faithful markdown briefing.`,
    `Target approximately ${budget} tokens.`,
    `Preserve key arguments, structure, terminology, and examples.`,
    `Do not invent content or omit crucial caveats.`
  ].join(" ");

  const userPrompt = [
    `Title: ${title}`,
    `Author: ${author || "Unknown"}`,
    `Format: ${entry.format}`,
    `Tier: ${entry.tier}`,
    "",
    rawText,
  ].join("\n");

  const result = spawnSync(
    "bun",
    [INFERENCE_PATH, "--prefer-local", "--task-type", "general", systemPrompt, userPrompt],
    { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, timeout: 60_000, stdio: "pipe" }
  );
  const output = (result.stdout || "").trim();

  if (result.status !== 0 || output.length === 0) {
    const status = result.status ?? -1;
    process.stderr.write(`Warning: Inference.ts failed (status=${status}); falling back to raw text\n`);
    return rawText;
  }

  return output;
}

async function main(): Promise<number> {
  try {
    const args = parseArgs(process.argv.slice(2));

    if (args.help || !args.slug) {
      printUsage();
      return 1;
    }

    const manifest = loadManifest();
    const entry = manifest.books[args.slug];

    if (!entry) {
      process.stderr.write(`Error: slug '${args.slug}' not found in manifest\n`);
      return 1;
    }

    try {
      await access(args.mountPath);
    } catch (error) {
      if (error instanceof Error) {
        process.stderr.write(`Error: Mount not accessible at ${args.mountPath}\nHint: systemctl status mnt-unraid\\x2dbooks.automount\n`);
      } else {
        process.stderr.write(`Error: Mount not accessible at ${args.mountPath}\nHint: systemctl status mnt-unraid\\x2dbooks.automount\n`);
      }
      return 1;
    }

    const filePath = localPath(entry, args.mountPath);

    let extractedText = "";
    if (entry.format === "pdf") {
      extractedText = await extractPDF(filePath, args.pages);
    } else if (entry.format === "epub" || entry.format === "mobi" || entry.format === "azw3" || entry.format === "azw") {
      extractedText = await extractEbook(filePath);
    } else if (entry.format === "cbz" || entry.format === "cbr" || entry.format === "unknown") {
      process.stderr.write(`Error: No extractable text for slug '${args.slug}' (format: ${entry.format})\n`);
      return 1;
    }

    if (extractedText.length <= 100) {
      process.stderr.write(`Error: No extractable text for slug '${args.slug}' (scanned/image-only)\n`);
      return 1;
    }

    if (extractedText.length > EXTRACTION_CAP) {
      process.stderr.write(
        `[LibraryFetch] truncated ${extractedText.length.toLocaleString()} → ${EXTRACTION_CAP.toLocaleString()} chars before compression. Use --pages or --raw for full extraction.\n`
      );
    }
    const cappedText = extractedText.slice(0, EXTRACTION_CAP);
    const meta = cleanMeta(entry.source_path);
    const title = meta.title || args.slug;
    const content = args.raw
      ? cappedText
      : compressViaInference(title, meta.author, entry, args.budget, cappedText);

    process.stdout.write(`# LibraryFetch: ${title} (${args.slug})\n\n${content}\n`);
    return 0;
  } catch (error) {
    if (error instanceof Error) {
      process.stderr.write(`Error: ${error.message}\n`);
    } else {
      process.stderr.write(`Error: ${String(error)}\n`);
    }
    return 1;
  }
}

const exitCode: number = await main();
process.exit(exitCode);
