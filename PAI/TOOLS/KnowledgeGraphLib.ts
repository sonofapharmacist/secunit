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
  // higher priority than the existing one. Phase 3 tag edges are appended
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
  }

  // Phase 3: Tag co-occurrence edges (bidirectional, weight 1)
  const tagIndex = new Map<string, string[]>();
  for (const [slug, node] of nodes) {
    for (const tag of node.tags) {
      if (!tagIndex.has(tag)) tagIndex.set(tag, []);
      tagIndex.get(tag)!.push(slug);
    }
  }

  const TAG_GROUP_CAP = 50;
  const tagEdgeSet = new Set<string>();

  for (const [tag, slugs] of tagIndex) {
    if (slugs.length < 2) continue;
    const group = slugs.length > TAG_GROUP_CAP ? slugs.slice(0, TAG_GROUP_CAP) : slugs;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        const keyAB = `${a}|${b}|${tag}`;
        if (tagEdgeSet.has(keyAB)) continue;
        tagEdgeSet.add(keyAB);
        tagEdgeSet.add(`${b}|${a}|${tag}`);

        const edgeAB: GraphEdge = { from: a, to: b, weight: 1, edgeType: "tag", label: tag };
        const edgeBA: GraphEdge = { from: b, to: a, weight: 1, edgeType: "tag", label: tag };
        edges.push(edgeAB, edgeBA);
        if (!adjacency.has(a)) adjacency.set(a, []);
        if (!adjacency.has(b)) adjacency.set(b, []);
        adjacency.get(a)!.push(edgeAB);
        adjacency.get(b)!.push(edgeBA);
      }
    }
  }

  return { nodes, edges, adjacency };
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
