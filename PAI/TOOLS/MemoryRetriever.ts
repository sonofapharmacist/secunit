#!/usr/bin/env bun
/**
 * ============================================================================
 * MemoryRetriever — Compressed context retrieval over PAI's knowledge archive
 * ============================================================================
 *
 * PURPOSE:
 * Given a query string, searches all markdown files in MEMORY/KNOWLEDGE/
 * (People/, Companies/, Ideas/, Research/, Library/), ranks by BM25-lite
 * relevance, and returns compressed summaries of the top matches within a
 * token budget.
 *
 * USAGE:
 *   bun MemoryRetriever.ts "query string"                    # Search, return compressed results
 *   bun MemoryRetriever.ts "query string" --top 5            # Return top 5 (default: 3)
 *   bun MemoryRetriever.ts "query string" --raw              # Skip compression, return raw excerpts
 *   bun MemoryRetriever.ts "query string" --budget 800       # Token budget for output (default: 500)
 *   bun MemoryRetriever.ts "query string" --domains Library  # Search only Library domain
 *   bun MemoryRetriever.ts "query string" --graph            # Expand results with 1-hop graph neighbors
 *   bun MemoryRetriever.ts --help                            # Show usage
 *
 * SEARCH:
 *   BM25-style keyword matching + tag co-occurrence scoring.
 *   No embeddings, no vector DB — pure markdown + YAML frontmatter.
 *
 * GRAPH EXPANSION (--graph):
 *   For each BM25 hit, walks 1-hop graph neighbors (typed-wikilink, related,
 *   wikilink, tag) via KnowledgeGraphLib and merges them into results with a
 *   small edge-weight boost on top of their own BM25 score.
 *
 * COMPRESSION:
 *   Uses Inference.ts fast level for optional LLM compression of matched content.
 *   --raw flag skips compression and returns raw excerpts.
 *
 * STORAGE:
 *   Reads MEMORY/KNOWLEDGE/{People,Companies,Ideas,Research,Library}/*.md
 *   NEVER writes or modifies files — read-only tool.
 * ============================================================================
 */

import { parseArgs } from "util";
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { buildGraph, type KnowledgeGraph } from "./KnowledgeGraphLib.js";

// ============================================================================
// Configuration
// ============================================================================

const HOME = process.env.HOME!;
const PAI_DIR = process.env.PAI_DIR || path.join(HOME, ".claude", "PAI");
const KNOWLEDGE_DIR = path.join(PAI_DIR, "MEMORY", "KNOWLEDGE");
const DOMAINS = ["People", "Companies", "Ideas", "Research", "Library", "Projects", "Architecture"];

// BM25 parameters
const BM25_K1 = 1.5;
const BM25_B = 0.75;

// Scoring weights
const TITLE_MATCH_WEIGHT = 10;
const TAG_MATCH_WEIGHT = 5;
const RELATED_MATCH_WEIGHT = 3;

// Defaults
const DEFAULT_TOP = 3;
const DEFAULT_BUDGET = 500;
const MAX_EXCERPT_CHARS = 2000;

// Graph expansion knobs
const GRAPH_NEIGHBORS_PER_ANCHOR = 3;
const GRAPH_EXPANSION_TOP = 5;
const GRAPH_EDGE_BOOST = 0.5;

// ============================================================================
// Types
// ============================================================================

interface Frontmatter {
  title?: string;
  type?: string;
  domain?: string;
  tags?: string[];
  related?: string[];
  [key: string]: unknown;
}

interface KnowledgeNote {
  filePath: string;
  frontmatter: Frontmatter;
  body: string;
  wordCount: number;
}

interface ScoredNote {
  note: KnowledgeNote;
  score: number;
}

interface ResultEntry {
  note: KnowledgeNote;
  score: number;
  isGraph: boolean;
  graphEdgeLabel?: string;
}

// ============================================================================
// Frontmatter Parsing
// ============================================================================

function parseFrontmatter(content: string): { frontmatter: Frontmatter; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { frontmatter: {}, body: content };

  const result: Frontmatter = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const key = line.substring(0, colonIdx).trim();
      let value: string | string[] = line.substring(colonIdx + 1).trim();
      if (typeof value === "string" && value.startsWith("[") && value.endsWith("]")) {
        value = value.slice(1, -1).split(",").map((s: string) => s.trim().replace(/['"]/g, ""));
      }
      result[key] = value;
    }
  }

  const body = content.substring(match[0].length).trim();
  return { frontmatter: result, body };
}

// ============================================================================
// File Discovery
// ============================================================================

function discoverNotes(domains: string[] = DOMAINS): KnowledgeNote[] {
  const notes: KnowledgeNote[] = [];

  for (const domain of domains) {
    const domainDir = path.join(KNOWLEDGE_DIR, domain);
    if (!fs.existsSync(domainDir)) continue;

    const files = fs.readdirSync(domainDir).filter(
      (f) => f.endsWith(".md") && !f.startsWith("_")
    );

    for (const file of files) {
      const filePath = path.join(domainDir, file);
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const { frontmatter, body } = parseFrontmatter(content);
        const wordCount = body.split(/\s+/).filter(Boolean).length;
        notes.push({ filePath, frontmatter, body, wordCount });
      } catch {
        // Skip unreadable files
      }
    }
  }

  return notes;
}

// ============================================================================
// BM25-lite Scoring
// ============================================================================

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

function computeBM25(
  termFreq: number,
  docLength: number,
  avgDocLength: number
): number {
  const tf = termFreq;
  const numerator = tf * (BM25_K1 + 1);
  const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * (docLength / avgDocLength));
  return numerator / denominator;
}

function scoreNote(
  note: KnowledgeNote,
  queryTerms: string[],
  avgDocLength: number
): number {
  let score = 0;
  const titleLower = (note.frontmatter.title || "").toLowerCase();
  const bodyLower = note.body.toLowerCase();

  const tags: string[] = Array.isArray(note.frontmatter.tags)
    ? note.frontmatter.tags.map((t: string) => t.toLowerCase())
    : typeof note.frontmatter.tags === "string"
      ? [note.frontmatter.tags.toLowerCase()]
      : [];

  const related: string[] = Array.isArray(note.frontmatter.related)
    ? note.frontmatter.related.map((r: string) => r.toLowerCase())
    : typeof note.frontmatter.related === "string"
      ? [note.frontmatter.related.toLowerCase()]
      : [];

  const wikiLinks = note.body.match(/\[\[([^\]]+)\]\]/g) || [];
  const relatedSlugs = [
    ...related,
    ...wikiLinks.map((l) => l.replace(/\[\[|\]\]/g, "").toLowerCase()),
  ];

  for (const term of queryTerms) {
    if (titleLower.includes(term)) score += TITLE_MATCH_WEIGHT;

    for (const tag of tags) {
      if (tag.includes(term) || term.includes(tag)) {
        score += TAG_MATCH_WEIGHT;
        break;
      }
    }

    for (const slug of relatedSlugs) {
      if (slug.includes(term)) {
        score += RELATED_MATCH_WEIGHT;
        break;
      }
    }

    const termRegex = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    const matches = bodyLower.match(termRegex);
    const tf = matches ? matches.length : 0;
    if (tf > 0) {
      score += computeBM25(tf, note.wordCount, avgDocLength);
    }
  }

  return score;
}

// ============================================================================
// Excerpt Extraction
// ============================================================================

function extractExcerpt(note: KnowledgeNote, queryTerms: string[]): string {
  const body = note.body;

  const sectionPriority = ["## Thesis", "## Background", "## Key Findings", "## Key Facts", "## Context", "## Evidence", "## Summary"];

  for (const header of sectionPriority) {
    const idx = body.indexOf(header);
    if (idx === -1) continue;

    const afterHeader = body.substring(idx + header.length);
    const nextHeader = afterHeader.search(/\n## /);
    const section = nextHeader > -1
      ? afterHeader.substring(0, nextHeader).trim()
      : afterHeader.substring(0, MAX_EXCERPT_CHARS).trim();

    if (section.length > 20) {
      return section.substring(0, MAX_EXCERPT_CHARS);
    }
  }

  const paragraphs = body.split(/\n\n+/).filter((p) => p.trim().length > 30);
  if (paragraphs.length === 0) return body.substring(0, MAX_EXCERPT_CHARS);

  let bestParagraph = paragraphs[0];
  let bestDensity = 0;

  for (const para of paragraphs) {
    const paraLower = para.toLowerCase();
    let hits = 0;
    for (const term of queryTerms) {
      const regex = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      const matches = paraLower.match(regex);
      if (matches) hits += matches.length;
    }
    const density = hits / para.split(/\s+/).length;
    if (density > bestDensity) {
      bestDensity = density;
      bestParagraph = para;
    }
  }

  return bestParagraph.substring(0, MAX_EXCERPT_CHARS);
}

// ============================================================================
// LLM Compression via Inference.ts
// ============================================================================

function compress(text: string, budget: number): string {
  const inferPath = path.join(PAI_DIR, "TOOLS", "Inference.ts");

  if (!fs.existsSync(inferPath)) {
    return text.substring(0, budget * 4);
  }

  const systemPrompt = `Compress the following knowledge note into a dense summary under ${budget} tokens. Preserve key facts, names, dates, and relationships. No filler. No preamble.`;
  const userPrompt = text.substring(0, MAX_EXCERPT_CHARS);

  const result = spawnSync(
    "bun",
    [inferPath, "--level", "fast", systemPrompt, userPrompt],
    { encoding: "utf-8", timeout: 15000, stdio: "pipe" }
  );

  if (result.status === 0 && result.stdout && result.stdout.trim()) {
    return result.stdout.trim();
  }

  return text.substring(0, budget * 4);
}

// ============================================================================
// Graph Expansion
// ============================================================================

function expandWithGraph(
  scored: ScoredNote[],
  notes: KnowledgeNote[],
  activeDomains: string[],
  avgDocLength: number,
  queryTerms: string[]
): ResultEntry[] {
  const graph: KnowledgeGraph = buildGraph(activeDomains);

  // Index notes by slug (basename without .md)
  const noteBySlug = new Map<string, KnowledgeNote>();
  for (const n of notes) {
    const slug = path.basename(n.filePath, ".md");
    noteBySlug.set(slug, n);
  }

  const bm25Slugs = new Set<string>(
    scored.map((s) => path.basename(s.note.filePath, ".md"))
  );

  // Collect graph candidates: slug -> { entry, score }
  const graphCandidates = new Map<string, ResultEntry>();

  for (const hit of scored) {
    const anchorSlug = path.basename(hit.note.filePath, ".md");

    // Gather neighbors: outgoing from anchor + inbound edges where to === anchorSlug
    const outgoing = graph.adjacency.get(anchorSlug) || [];
    const inbound = graph.edges.filter((e) => e.to === anchorSlug);
    const neighborhood = [...outgoing, ...inbound];

    // Best edge per neighbor (highest weight wins)
    const bestEdgePerNeighbor = new Map<string, { neighborSlug: string; edge: typeof neighborhood[number] }>();
    for (const edge of neighborhood) {
      const neighborSlug = edge.from === anchorSlug ? edge.to : edge.from;
      if (neighborSlug === anchorSlug) continue;
      if (bm25Slugs.has(neighborSlug)) continue;
      const existing = bestEdgePerNeighbor.get(neighborSlug);
      if (!existing || edge.weight > existing.edge.weight) {
        bestEdgePerNeighbor.set(neighborSlug, { neighborSlug, edge });
      }
    }

    // Sort by edge weight desc, take top N per anchor
    const ranked = [...bestEdgePerNeighbor.values()].sort(
      (a, b) => b.edge.weight - a.edge.weight
    );

    let added = 0;
    for (const { neighborSlug, edge } of ranked) {
      if (added >= GRAPH_NEIGHBORS_PER_ANCHOR) break;
      const neighborNote = noteBySlug.get(neighborSlug);
      if (!neighborNote) continue;

      const bm25 = scoreNote(neighborNote, queryTerms, avgDocLength);
      const finalScore = bm25 + edge.weight * GRAPH_EDGE_BOOST;
      const edgeLabel = edge.label ?? edge.edgeType;

      const existing = graphCandidates.get(neighborSlug);
      if (!existing || finalScore > existing.score) {
        graphCandidates.set(neighborSlug, {
          note: neighborNote,
          score: finalScore,
          isGraph: true,
          graphEdgeLabel: edgeLabel,
        });
      }
      added += 1;
    }
  }

  // Cap graph candidates at top GRAPH_EXPANSION_TOP by score
  const topGraph = [...graphCandidates.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, GRAPH_EXPANSION_TOP);

  // Compose final list: BM25 hits + graph candidates, sorted by score desc
  const bm25Entries: ResultEntry[] = scored.map((s) => ({
    note: s.note,
    score: s.score,
    isGraph: false,
  }));

  return [...bm25Entries, ...topGraph].sort((a, b) => b.score - a.score);
}

// ============================================================================
// Output Formatting
// ============================================================================

function formatResults(
  query: string,
  results: ResultEntry[],
  summaries: string[],
  totalSearched: number,
  domains: string[]
): string {
  const lines: string[] = [];

  lines.push(`\n  Memory Retrieval: "${query}"`);
  lines.push("  " + "-".repeat(45));

  if (results.length === 0) {
    lines.push("  No matching memories found.");
    lines.push("  " + "-".repeat(45));
    lines.push(`  Searched ${totalSearched} notes across ${domains.join(", ")}.`);
    return lines.join("\n");
  }

  for (let i = 0; i < results.length; i++) {
    const { note, score, isGraph, graphEdgeLabel } = results[i];
    const title = note.frontmatter.title || path.basename(note.filePath, ".md");
    const type = note.frontmatter.type || "unknown";
    const summary = summaries[i];
    const graphTag = isGraph ? ` [graph: ${graphEdgeLabel || "related"}]` : "";

    lines.push("");
    lines.push(`  [${title}] (type: ${type}, score: ${score.toFixed(1)})${graphTag}`);

    const summaryLines = summary.split("\n");
    for (const sl of summaryLines) {
      lines.push(`     ${sl}`);
    }
  }

  lines.push("");
  lines.push("  " + "-".repeat(45));
  lines.push(`  Retrieved ${results.length} results from ${totalSearched} notes searched (domains: ${domains.join(", ")}).`);

  return lines.join("\n");
}

// ============================================================================
// Help
// ============================================================================

function printHelp(): void {
  console.log(`
MemoryRetriever — Compressed context retrieval over PAI's knowledge archive

USAGE:
  bun MemoryRetriever.ts "query string"                    Search, return compressed results
  bun MemoryRetriever.ts "query string" --top 5            Return top 5 (default: 3)
  bun MemoryRetriever.ts "query string" --raw              Skip compression, return raw excerpts
  bun MemoryRetriever.ts "query string" --budget 800       Token budget for output (default: 500)
  bun MemoryRetriever.ts "query string" --domains Library  Search only Library domain
  bun MemoryRetriever.ts "query string" --graph            Expand results with 1-hop graph neighbors
  bun MemoryRetriever.ts --help                            Show this help

OPTIONS:
  --top <N>          Number of results to return (default: ${DEFAULT_TOP})
  --raw              Skip LLM compression, return raw excerpts
  --budget <N>       Token budget for compressed output (default: ${DEFAULT_BUDGET})
  --domains <D,...>  Comma-separated domains to search (default: all)
                     Valid: ${DOMAINS.join(", ")}
  --graph, -g        Expand results with 1-hop graph neighbors
  --help             Show this help message

SEARCH:
  BM25-style keyword matching + tag co-occurrence scoring.
  Searches MEMORY/KNOWLEDGE/{People,Companies,Ideas,Research,Library}/*.md

COMPRESSION:
  Uses Inference.ts (fast level) for LLM-powered compression.
  --raw skips this step and returns raw excerpt text.

EXAMPLES:
  bun MemoryRetriever.ts "security policy stanford"
  bun MemoryRetriever.ts "agent architecture" --top 5 --raw
  bun MemoryRetriever.ts "ai consciousness" --budget 1000
  bun MemoryRetriever.ts "memory retrieval" --graph --raw
`);
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      top: { type: "string", short: "t" },
      raw: { type: "boolean", short: "r", default: false },
      budget: { type: "string", short: "b" },
      domains: { type: "string", short: "d" },
      graph: { type: "boolean", short: "g", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    strict: true,
  });

  if (values.help) {
    printHelp();
    process.exit(0);
  }

  const query = positionals.join(" ").trim();
  if (!query) {
    console.error("Error: Query string required.\n");
    printHelp();
    process.exit(1);
  }

  const topN = values.top ? parseInt(values.top, 10) : DEFAULT_TOP;
  const raw = values.raw || false;
  const budget = values.budget ? parseInt(values.budget, 10) : DEFAULT_BUDGET;
  const useGraph = values.graph || false;

  let activeDomains = DOMAINS;
  if (values.domains) {
    const requested = values.domains.split(",").map((d) => d.trim());
    const invalid = requested.filter((d) => !DOMAINS.includes(d));
    if (invalid.length > 0) {
      console.error(`Error: Unknown domain(s): ${invalid.join(", ")}. Valid: ${DOMAINS.join(", ")}`);
      process.exit(1);
    }
    activeDomains = requested;
  }

  if (isNaN(topN) || topN < 1) {
    console.error("Error: --top must be a positive integer.");
    process.exit(1);
  }
  if (isNaN(budget) || budget < 50) {
    console.error("Error: --budget must be at least 50.");
    process.exit(1);
  }

  if (!fs.existsSync(KNOWLEDGE_DIR)) {
    console.error(`Error: Knowledge directory not found: ${KNOWLEDGE_DIR}`);
    process.exit(1);
  }

  const notes = discoverNotes(activeDomains);
  if (notes.length === 0) {
    console.log(`\n  Memory Retrieval: "${query}"`);
    console.log("  " + "-".repeat(45));
    console.log("  No knowledge notes found in archive.");
    process.exit(0);
  }

  const avgDocLength = notes.reduce((sum, n) => sum + n.wordCount, 0) / notes.length;

  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) {
    console.error("Error: Query produced no searchable terms after tokenization.");
    process.exit(1);
  }

  // Score all notes (BM25)
  const scored: ScoredNote[] = notes
    .map((note) => ({ note, score: scoreNote(note, queryTerms, avgDocLength) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);

  // Build final result set: BM25 only, or BM25 + graph expansion
  const entries: ResultEntry[] = useGraph
    ? expandWithGraph(scored, notes, activeDomains, avgDocLength, queryTerms)
    : scored.map((s) => ({ note: s.note, score: s.score, isGraph: false }));

  // Extract excerpts for every entry (BM25 + graph alike)
  const excerpts = entries.map((e) => extractExcerpt(e.note, queryTerms));

  // Compress or use raw excerpts
  let summaries: string[];
  if (raw) {
    summaries = excerpts;
  } else {
    const perNoteBudget = Math.max(50, Math.floor(budget / Math.max(entries.length, 1)));
    summaries = entries.map((_, i) => compress(excerpts[i], perNoteBudget));
  }

  const output = formatResults(query, entries, summaries, notes.length, activeDomains);
  console.log(output);
}

// ============================================================================
// Entry Point
// ============================================================================

if (import.meta.main) {
  main().catch((err) => {
    console.error(`Fatal error: ${err.message}`);
    process.exit(1);
  });
}
