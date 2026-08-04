#!/usr/bin/env bun
/**
 * KnowledgeGraphLib — Shared graph construction for PAI knowledge archive
 *
 * Pure library — no top-level execution, no CLI parsing, no stdout side effects.
 * Builds an in-memory typed graph from KNOWLEDGE/ markdown files using frontmatter
 * tags, wikilinks (plain and typed), and `related:` fields.
 *
 * Consumed by:
 *   - KnowledgeGraph.ts (CLI traversal/stats/concept-search)
 *   - MemoryRetriever.ts (--graph 1-hop expansion of BM25 hits)
 */

import * as fs from "fs";
import * as path from "path";

// ============================================================================
// Configuration
// ============================================================================

const HOME = process.env.HOME!;
const PAI_DIR = process.env.PAI_DIR || path.join(HOME, ".claude", "PAI");
const KNOWLEDGE_DIR = path.join(PAI_DIR, "MEMORY", "KNOWLEDGE");
const DEFAULT_DOMAINS = ["People", "Companies", "Ideas", "Research", "Library", "Projects", "Architecture"];
const SKIP_FILES = new Set(["_index.md", "_schema.md", "_log.md"]);
const SKIP_DIRS = new Set(["_archive", "_embeddings", "_harvest-queue"]);

// ============================================================================
// Types
// ============================================================================

export type TypedEdgeType =
  | "REINFORCES"
  | "CONTRADICTS"
  | "EXTENDS"
  | "APPLIES_TO"
  | "IMPLEMENTS"
  | "VALIDATES"
  | "REFERENCES";

export interface GraphNode {
  slug: string;
  domain: string;
  title: string;
  type: string;
  tags: string[];
  path: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  weight: number;
  edgeType: "tag" | "wikilink" | "related" | "typed-wikilink";
  label?: string;
}

export interface KnowledgeGraph {
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
  adjacency: Map<string, GraphEdge[]>;
  // Inverse of `adjacency`: target -> incoming edges. Built in the same pass
  // that populates `adjacency` so consumers that need inbound neighbors
  // (e.g., `MemoryRetriever.expandWithGraph`) don't have to do an O(E) scan
  // of `edges` per anchor. Pre-indexing turns per-anchor inbound lookup from
  // O(E) into O(deg_in).
  incomingEdges: Map<string, GraphEdge[]>;
  // Tag co-occurrence lives outside the traversable edge stream.
  // tagIndex maps slug -> slug[] (deduplicated neighbors sharing any tag).
  // It is queryable via `find <tag>` and `tagNeighbors()` only — it does NOT
  // contribute to traversal weight, BFS adjacency, or retrieval candidate
  // generation. The previous design put tag co-occurrence into `edges` and
  // `adjacency`, which masked coverage gaps: a node surrounded by tag
  // co-occurrences looked connected even when it had zero curated semantic
  // edges, hiding the archive's true isolation (79.5% of nodes were masked
  // by tag pollution under the old design).
  tagIndex: Map<string, string[]>;
}

export interface TraversalNode {
  node: GraphNode;
  hop: number;
  cumulativeWeight: number;
  viaEdge?: GraphEdge;
}

// ============================================================================
// Frontmatter & Content Parsing (private helpers)
// ============================================================================

function parseFrontmatter(content: string): Record<string, any> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result: Record<string, any> = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      // Skip indented continuation lines — handled by extractRelated
      if (line.startsWith("  ") || line.startsWith("\t")) continue;
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
  return result;
}

function extractRelated(content: string): Array<{ slug: string; type: string }> {
  const related: Array<{ slug: string; type: string }> = [];
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return related;

  const lines = fmMatch[1].split("\n");
  let inRelated = false;
  let currentSlug: string | null = null;

  for (const line of lines) {
    if (line.match(/^related\s*:/)) {
      inRelated = true;
      continue;
    }
    if (inRelated) {
      // End of block: non-indented, non-empty, non-list-item line
      if (
        !line.startsWith("  ") &&
        !line.startsWith("\t") &&
        !line.startsWith("-") &&
        line.trim().length > 0
      ) {
        inRelated = false;
        continue;
      }
      if (line.trim().startsWith("- slug:") || line.trim().startsWith("slug:")) {
        const slugMatch = line.match(/slug:\s*(.+)/);
        if (slugMatch) {
          if (currentSlug) related.push({ slug: currentSlug, type: "related" });
          currentSlug = slugMatch[1].trim().replace(/['"]/g, "");
        }
        continue;
      }
      const typeMatch = line.match(/type:\s*(.+)/);
      if (typeMatch && currentSlug) {
        related.push({
          slug: currentSlug,
          type: typeMatch[1].trim().replace(/['"]/g, ""),
        });
        currentSlug = null;
        continue;
      }
    }
  }
  if (currentSlug) related.push({ slug: currentSlug, type: "related" });
  return related;
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n*/, "");
}

function extractWikilinks(content: string): string[] {
  const body = stripFrontmatter(content);
  const links: string[] = [];
  const regex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  let match;
  while ((match = regex.exec(body)) !== null) {
    const raw = match[1].trim();
    const slug = raw.includes("/") ? raw.split("/").pop()! : raw;
    if (slug && !slug.startsWith("_")) links.push(slug);
  }
  return links;
}

// ============================================================================
// Typed Wikilink Classification
// ============================================================================

// Priority-ordered: first match wins. VALIDATES before REINFORCES because
// "validates this" would otherwise be caught by the REINFORCES "validates?" pattern.
const TYPED_EDGE_PATTERNS: Array<{ type: TypedEdgeType; pattern: RegExp }> = [
  { type: "VALIDATES",   pattern: /(validated by|proven by|proves|validates this|backs this up)/i },
  { type: "REINFORCES",  pattern: /(complement|confirms?|reinforc|supports?|consistent with|aligns? with|demonstrates?|supply.side|demand.side|corroborat|backing)/i },
  { type: "CONTRADICTS", pattern: /(challeng|contradict|conflict|against|disput)/i },
  { type: "EXTENDS",     pattern: /(builds? on|based on|extend|expanding|application of|derives? from)/i },
  { type: "APPLIES_TO",  pattern: /(applies? to|relevant to|use case|requirement for|positioning|context for)/i },
  { type: "IMPLEMENTS",  pattern: /(implement|pattern from|follows? this|uses? this pattern)/i },
];

function classifyDescription(description: string): TypedEdgeType {
  for (const { type, pattern } of TYPED_EDGE_PATTERNS) {
    if (pattern.test(description)) return type;
  }
  return "REFERENCES";
}

export function extractTypedWikilinks(
  content: string,
  nodes: Map<string, GraphNode>
): Array<{ target: string; edgeType: TypedEdgeType; description: string }> {
  const body = stripFrontmatter(content);
  const results: Array<{ target: string; edgeType: TypedEdgeType; description: string }> = [];

  // Match: [[slug]] <delim> description-up-to-end-of-line
  // Delim is em dash (—), en dash (–), or hyphen (-), each with surrounding spaces.
  const regex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]\s*[—–-]\s*([^\n]+)/g;
  let match;
  while ((match = regex.exec(body)) !== null) {
    const raw = match[1].trim();
    const target = raw.includes("/") ? raw.split("/").pop()!.trim() : raw.trim();
    if (!target || target.startsWith("_")) continue;
    if (!nodes.has(target)) continue;

    const description = match[2].trim();
    const edgeType = classifyDescription(description);
    results.push({ target, edgeType, description });
  }

  return results;
}

// ============================================================================
// Graph Construction
// ============================================================================

export function buildGraph(domains?: string[]): KnowledgeGraph {
  const activeDomains = domains ?? DEFAULT_DOMAINS;
  const nodes = new Map<string, GraphNode>();
  const adjacency = new Map<string, GraphEdge[]>();
  const incomingEdges = new Map<string, GraphEdge[]>();
  const tagIndex = new Map<string, string[]>();

  // Phase 1: Collect all nodes
  for (const domain of activeDomains) {
    const domainDir = path.join(KNOWLEDGE_DIR, domain);
    if (!fs.existsSync(domainDir)) continue;

    for (const entry of fs.readdirSync(domainDir)) {
      if (SKIP_FILES.has(entry)) continue;
      if (SKIP_DIRS.has(entry)) continue;
      if (!entry.endsWith(".md")) continue;

      const fullPath = path.join(domainDir, entry);
      try {
        if (!fs.statSync(fullPath).isFile()) continue;
      } catch {
        continue;
      }

      const slug = entry.replace(/\.md$/, "");
      let content: string;
      try {
        content = fs.readFileSync(fullPath, "utf-8");
      } catch {
        continue;
      }
      const fm = parseFrontmatter(content);

      const tags: string[] = Array.isArray(fm.tags)
        ? fm.tags.map((t: string) => String(t).trim().toLowerCase())
        : typeof fm.tags === "string"
          ? fm.tags
              .split(",")
              .map((t: string) => t.trim().replace(/['"]/g, "").toLowerCase())
              .filter((t: string) => t.length > 0)
          : [];

      nodes.set(slug, {
        slug,
        domain,
        title: fm.title || slug,
        type: fm.type || "unknown",
        tags,
        path: fullPath,
      });
    }
  }

  // Phase 2: Build edges (wikilink, typed-wikilink, related)
  //
  // Dedup priority: typed-wikilink > related > wikilink. We collect into a
  // Map<"from|to", GraphEdge> and only overwrite if the incoming edge has
  // higher priority than the existing one. Phase 3 populates `tagIndex`
  // only — no tag edges are produced (2026-07-29 layer split).
  // separately and not deduped against phase 2.

  const PRIORITY: Record<string, number> = {
    "typed-wikilink": 3,
    "related": 2,
    "wikilink": 1,
    "tag": 0,
  };
  const phase2: Map<string, GraphEdge> = new Map();

  const upsert = (edge: GraphEdge): void => {
    const key = `${edge.from}|${edge.to}`;
    const existing = phase2.get(key);
    if (!existing || PRIORITY[edge.edgeType] > PRIORITY[existing.edgeType]) {
      phase2.set(key, edge);
    }
  };

  for (const [slug, node] of nodes) {
    let content: string;
    try {
      content = fs.readFileSync(node.path, "utf-8");
    } catch {
      continue;
    }

    // 2a: Typed wikilinks (highest priority)
    const typed = extractTypedWikilinks(content, nodes);
    const typedTargets = new Set<string>();
    for (const t of typed) {
      if (t.target === slug) continue; // no self-loops
      typedTargets.add(t.target);
      upsert({
        from: slug,
        to: t.target,
        weight: 5,
        edgeType: "typed-wikilink",
        label: t.edgeType,
      });
    }

    // 2b: Plain wikilinks (skip those already counted as typed)
    const wikilinks = extractWikilinks(content);
    for (const target of wikilinks) {
      if (!nodes.has(target)) continue;
      if (target === slug) continue;
      if (typedTargets.has(target)) continue;
      upsert({
        from: slug,
        to: target,
        weight: 3,
        edgeType: "wikilink",
      });
    }

    // 2c: related: frontmatter
    const related = extractRelated(content);
    for (const rel of related) {
      if (!nodes.has(rel.slug)) continue;
      if (rel.slug === slug) continue;
      upsert({
        from: slug,
        to: rel.slug,
        weight: 5,
        edgeType: "related",
        label: rel.type,
      });
    }
  }

  // Materialize phase 2 edges
  const edges: GraphEdge[] = [];
  for (const edge of phase2.values()) {
    edges.push(edge);
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    adjacency.get(edge.from)!.push(edge);
    if (!incomingEdges.has(edge.to)) incomingEdges.set(edge.to, []);
    incomingEdges.get(edge.to)!.push(edge);
  }

  // Phase 3: Build the tag co-occurrence index. Critically, these slugs DO
  // NOT become edges — they live in `tagIndex`, which is queryable via
  // `tagNeighbors(slug)` but never contributes to traversal weight, BFS
  // adjacency, or retrieval candidate generation. This is the layer split:
  // tag co-occurrence is a candidate-generation / search signal, not a
  // traversable relationship.
  //
  // Index shape: tag -> Set<slug>. Inverted from the previous per-slug map,
  // which listed the slug redundantly under each of its own tags. Inverted
  // form makes `tagNeighbors(slug)` an O(tags-on-slug) lookup over a
  // precomputed inverse rather than a per-tag merge across slugs.
  //
  // No cap anymore: the previous TAG_GROUP_CAP was a defense against O(n^2)
  // edge blowup in popular tags. Once tags stop producing edges, the cap
  // is moot.
  const tagToSlugs = new Map<string, Set<string>>();
  for (const [slug, node] of nodes) {
    for (const tag of node.tags) {
      if (!tagToSlugs.has(tag)) tagToSlugs.set(tag, new Set());
      tagToSlugs.get(tag)!.add(slug);
    }
  }
  for (const [slug, node] of nodes) {
    if (node.tags.length === 0) {
      tagIndex.set(slug, []);
      continue;
    }
    const neighbors = new Set<string>();
    for (const tag of node.tags) {
      const slugs = tagToSlugs.get(tag);
      if (!slugs) continue;
      for (const s of slugs) {
        if (s !== slug) neighbors.add(s);
      }
    }
    tagIndex.set(slug, [...neighbors]);
  }

  return { nodes, edges, adjacency, incomingEdges, tagIndex };
}

/**
 * Return slugs that share at least one tag with the input slug.
 *
 * Explicit opt-in for consumers that want tag-driven candidate generation
 * (e.g., suggestion lists). Does NOT participate in traversal or retrieval
 * scoring; callers must apply their own dedup, ranking, and ranking limits.
 *
 * `tagIndex` is the source of truth here — this helper is a thin reader.
 */
export function tagNeighbors(
  graph: KnowledgeGraph,
  slug: string
): string[] {
  return graph.tagIndex.get(slug) ?? [];
}

// ============================================================================
// Slug Resolution
// ============================================================================

export function resolveSlug(graph: KnowledgeGraph, query: string): string | null {
  const q = query.toLowerCase();
  if (graph.nodes.has(q)) return q;

  const candidates: string[] = [];
  for (const slug of graph.nodes.keys()) {
    if (slug.includes(q)) candidates.push(slug);
  }

  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    candidates.sort((a, b) => a.length - b.length);
    return candidates[0];
  }
  return null;
}

// ============================================================================
// BFS Traversal
// ============================================================================

export function traverse(
  graph: KnowledgeGraph,
  startSlug: string,
  maxHops: number
): TraversalNode[] {
  const visited = new Set<string>();
  const result: TraversalNode[] = [];
  const startNode = graph.nodes.get(startSlug);
  if (!startNode) return result;

  const queue: Array<[string, number, number, GraphEdge | undefined]> = [
    [startSlug, 0, 0, undefined],
  ];
  visited.add(startSlug);

  while (queue.length > 0) {
    const [currentSlug, hop, cumWeight, viaEdge] = queue.shift()!;
    const currentNode = graph.nodes.get(currentSlug);
    if (!currentNode) continue;

    result.push({ node: currentNode, hop, cumulativeWeight: cumWeight, viaEdge });

    if (hop >= maxHops) continue;

    const outgoing = graph.adjacency.get(currentSlug) || [];
    const bestEdgePerTarget = new Map<string, GraphEdge>();
    for (const edge of outgoing) {
      if (visited.has(edge.to)) continue;
      const existing = bestEdgePerTarget.get(edge.to);
      if (!existing || edge.weight > existing.weight) {
        bestEdgePerTarget.set(edge.to, edge);
      }
    }

    const sorted = [...bestEdgePerTarget.entries()].sort(
      (a, b) => b[1].weight - a[1].weight
    );

    for (const [target, edge] of sorted) {
      if (visited.has(target)) continue;
      visited.add(target);
      queue.push([target, hop + 1, cumWeight + edge.weight, edge]);
    }
  }

  return result;
}
