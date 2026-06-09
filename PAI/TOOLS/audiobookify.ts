#!/usr/bin/env bun

import { accessSync, constants as fsConstants, mkdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { KokoroTTS, TextSplitterStream } from "kokoro-js";

const DEFAULT_VOICE_ID = "af_heart"; // Kokoro Grade-A American English voice
const DEFAULT_OUTPUT_DIR = process.env.AUDIOBOOKSHELF_DIR ?? "/mnt/unraid-audiobooks";
const KOKORO_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const FETCH_TIMEOUT_MS = 30_000;
const LOCAL_LLM_URL = "http://localhost:11434/v1/chat/completions";
const LOCAL_LLM_MODEL = "qwen3:30b-a3b-q4_K_M";
const LLM_TIMEOUT_MS = 300_000;
// your-inference-host n_ctx=8192 (-np 1): system prompt ~160 tokens + output reserve ~500 tokens ≈ 7532 tokens left = ~28000 chars.
const MAX_ARTICLE_CHARS = 28_000;

const AUDIO_COPYWRITER_SYSTEM_PROMPT = `You are an expert audio copywriter specializing in translating articles into fluid spoken-word scripts for AI voice synthesis.

Execute your task in two steps:

## Step 1: The Scrub
Strip out hyperlinks, markdown syntax, image captions, tables, footnote markers, and visual references (e.g. "see Figure 2"). Remove ads, navigation text, and boilerplate.

## Step 2: The Script
Rewrite into audiobook format:
- Break long paragraphs into 2-3 sentence chunks
- Add verbal transitions where headings were: "Let's move on to...", "The next point is..."
- Spell out all numbers and symbols: "ten percent" not "10%", "fifty million dollars" not "$50M"
- Hyphenate acronyms meant to be spelled letter-by-letter: "I-A-M", "S-I-E-M", "C-V-E"
- Use ellipses (...) for natural dramatic pauses before major topic shifts

Output only the final script. No commentary, no headers, no "## Final Audiobook Script" label.`;

interface CliArgs {
  help: boolean;
  outputDir: string;
  title?: string;
  url: string | null;
  voiceId: string;
}

function printUsage(): void {
  process.stdout.write(
    "Usage: bun audiobookify.ts <url> [options]\n\n" +
    "Options:\n" +
    "  --title <title>     Override output filename (default: derived from page title or URL)\n" +
    `  --voice <voice_id>  Override Kokoro voice (default: ${DEFAULT_VOICE_ID}, use af_bella/am_fenrir/bf_emma etc.)\n` +
    `  --out <dir>         Override output directory (default: ${DEFAULT_OUTPUT_DIR})\n` +
    "  --help              Print usage and exit 0\n"
  );
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    help: false,
    outputDir: DEFAULT_OUTPUT_DIR,
    title: undefined,
    url: null,
    voiceId: DEFAULT_VOICE_ID,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help") {
      args.help = true;
      continue;
    }

    if (arg === "--title" || arg === "--voice" || arg === "--out") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${arg}`);
      }

      if (arg === "--title") {
        args.title = value;
      } else if (arg === "--voice") {
        args.voiceId = value;
      } else if (arg === "--out") {
        args.outputDir = value;
      } else {
        // Intentionally unreachable because the outer condition enumerates all supported value flags.
      }

      index += 1;
      continue;
    }

    if (arg.startsWith("--")) {
      throw new Error(`Unknown flag: ${arg}`);
    }

    if (args.url === null) {
      args.url = arg;
      continue;
    }

    throw new Error(`Unexpected argument: ${arg}`);
  }

  if (!args.help && args.url === null) {
    throw new Error("missing URL");
  }

  return args;
}

async function fetchArticleHtml(url: string): Promise<string> {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let response: Response;

  try {
    response = await fetch(url, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal,
    });
  } catch (error) {
    throw new Error(`Failed to fetch article URL: ${formatError(error)}`);
  }

  if (response.status !== 200) {
    throw new Error(`Failed to fetch article URL: HTTP ${response.status} ${response.statusText}`.trim());
  }

  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
    throw new Error(`Failed to fetch article URL: unexpected content-type "${contentType || "unknown"}"`);
  }

  try {
    return await response.text();
  } catch (error) {
    throw new Error(`Failed to read article response body: ${formatError(error)}`);
  }
}

function extractArticle(html: string, url: string): { text: string; title?: string } {
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();
  if (article?.textContent) {
    return {
      text: article.textContent.replace(/\s+/g, " ").trim(),
      title: article.title || undefined,
    };
  }
  // Fallback: strip noise elements and return body text
  const doc = dom.window.document;
  for (const sel of ["script", "style", "nav", "header", "footer", "aside"]) {
    for (const el of doc.querySelectorAll(sel)) {
      el.remove();
    }
  }
  return { text: doc.body?.textContent?.replace(/\s+/g, " ").trim() ?? "" };
}

function deriveTitle(html: string, url: string, overrideTitle?: string, extractedTitle?: string): string {
  if (overrideTitle?.trim()) {
    return overrideTitle.trim();
  }

  if (extractedTitle?.trim()) {
    return extractedTitle.trim();
  }

  const dom = new JSDOM(html);
  const pageTitle = dom.window.document.querySelector("title")?.textContent?.replace(/\s+/g, " ").trim();
  if (pageTitle) {
    return pageTitle;
  }

  const articleUrl = new URL(url);
  const lastSegment = articleUrl.pathname.split("/").filter(Boolean).pop();
  if (lastSegment) {
    try {
      const decodedSegment = decodeURIComponent(lastSegment).trim();
      if (decodedSegment) {
        return decodedSegment;
      }
    } catch {
      return lastSegment;
    }
  }

  return "audiobook";
}

async function runLocalLLM(articleText: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(LOCAL_LLM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: LOCAL_LLM_MODEL,
        messages: [
          { role: "system", content: AUDIO_COPYWRITER_SYSTEM_PROMPT },
          { role: "user", content: `${articleText}\n\n/no_think` },
        ],
        stream: false,
      }),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`Local LLM request failed: ${formatError(error)}`);
  }

  if (!response.ok) {
    throw new Error(`Local LLM error: HTTP ${response.status} ${response.statusText}`.trim());
  }

  let data: { choices: Array<{ message: { content: string } }> };
  try {
    data = await response.json() as { choices: Array<{ message: { content: string } }> };
  } catch (error) {
    throw new Error(`Failed to parse local LLM response: ${formatError(error)}`);
  }

  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("Local LLM returned empty response");
  }

  return content;
}


function sanitizeSlug(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9\s-]/g, "").replace(/\s+/g, "-").slice(0, 80).toLowerCase();
}

async function generateKokoroAudio(script: string, voiceId: string, outputPath: string): Promise<void> {
  console.error("Loading Kokoro model…");
  const tts = await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
    dtype: "q8",
    device: "cpu",
  });

  // tts.generate() silently truncates at ~512 tokens. Use stream() with TextSplitterStream
  // so each sentence is synthesized independently and concatenated into a single WAV.
  const splitter = new TextSplitterStream();
  splitter.push(script);
  splitter.close();

  const SAMPLE_RATE = 24_000;
  const chunks: Float32Array[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for await (const { audio } of tts.stream(splitter, { voice: voiceId as any })) {
    chunks.push(audio.audio);
  }

  if (chunks.length === 0) {
    throw new Error("Kokoro produced no audio output");
  }

  const totalSamples = chunks.reduce((sum, c) => sum + c.length, 0);
  const combined = new Float32Array(totalSamples);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }

  const dataBytes = combined.length * 4; // float32 = 4 bytes/sample
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(3, 20);            // IEEE_FLOAT
  buf.writeUInt16LE(1, 22);            // mono
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(32, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataBytes, 40);
  new Float32Array(buf.buffer, 44).set(combined);
  await Bun.write(outputPath, buf);
}

function ensureOutputDirectoryAccessible(outputDir: string): void {
  let stats;
  try {
    stats = statSync(outputDir);
  } catch (error) {
    throw new Error(`Output directory not accessible: ${outputDir}: ${formatError(error)}`);
  }

  if (!stats.isDirectory()) {
    throw new Error(`Output directory not accessible: ${outputDir}: not a directory`);
  }

  try {
    accessSync(outputDir, fsConstants.R_OK | fsConstants.W_OK);
  } catch (error) {
    throw new Error(`Output directory not accessible: ${outputDir}: ${formatError(error)}`);
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}


async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));

  if (args.help) {
    printUsage();
    return;
  }

  if (args.url === null) {
    throw new Error("missing URL");
  }

  try {
    new URL(args.url);
  } catch (error) {
    throw new Error(`Invalid URL: ${formatError(error)}`);
  }

  const outputDir = resolve(args.outputDir);
  ensureOutputDirectoryAccessible(outputDir);

  console.error("Fetching article…");
  const html = await fetchArticleHtml(args.url);
  const { text: articleText, title: extractedTitle } = extractArticle(html, args.url);
  if (!articleText) {
    throw new Error("Article text was empty after stripping HTML");
  }

  const outputTitle = deriveTitle(html, args.url, args.title, extractedTitle);

  let llmInput = articleText;
  if (llmInput.length > MAX_ARTICLE_CHARS) {
    console.error(`Article truncated from ${llmInput.length} to ${MAX_ARTICLE_CHARS} chars (your-inference-host n_ctx=2048; increase server n_ctx for full articles)`);
    llmInput = llmInput.slice(0, MAX_ARTICLE_CHARS);
  }

  console.error("Scripting…");
  const script = await runLocalLLM(llmInput);
  if (!script) {
    throw new Error("Scripting produced empty output");
  }

  // Audiobookshelf requires each title in its own subdirectory
  const slug = sanitizeSlug(outputTitle);
  const bookDir = resolve(outputDir, slug);
  mkdirSync(bookDir, { recursive: true });
  const outputPath = resolve(bookDir, `${slug}.wav`);
  console.error("Synthesizing…");
  await generateKokoroAudio(script, args.voiceId, outputPath);
  console.error(`Saved to ${outputPath}`);
}

if (import.meta.main) {
  try {
    await main();
    process.exit(0);
  } catch (error) {
    console.error(formatError(error));
    process.exit(1);
  }
}
