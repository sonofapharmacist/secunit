#!/usr/bin/env bun
/**
 * KnowledgeGraph -- Associative graph navigation over PAI's knowledge archive
 *
 * Builds an in-memory graph from KNOWLEDGE/ markdown files (via KnowledgeGraphLib)
 * using frontmatter tags, wikilinks (plain + typed), and `related:` fields.
 * Enables BFS traversal, related-note queries, and multi-source concept search.
 * NO persistent storage -- computed fresh from files at query time.
 *
 * Commands:
 *   traverse <slug>              BFS from slug, show connected notes (default: 2 hops)
 *   traverse <slug> --hops 3     BFS with configurable depth
 *   related <slug>               Show directly connected notes (1 hop)
 *   stats                        Graph summary: nodes, edges, clusters, hubs
 *   hubs                         Top 10 most-connected notes
 *   find <tag>                   Find all notes with a specific tag
 *   concept-search <query>       Multi-source BFS from query-matched seeds
 *
 * Examples:
 *   bun KnowledgeGraph.ts traverse karpathy
 *   bun KnowledgeGraph.ts related andrej-karpathy
 *   bun KnowledgeGraph.ts stats
 *   bun KnowledgeGraph.ts hubs
 *   bun KnowledgeGraph.ts find architecture
 *   bun KnowledgeGraph.ts concept-search "memory retrieval"
 */

import { parseArgs } from "util";
import {
  buildGraph,
  resolveSlug,
  traverse,
  type GraphNode,
  type GraphEdge,
  type KnowledgeGraph,
  type TraversalNode,
  type TypedEdgeType,
} from "./KnowledgeGraphLib.js";

// ============================================================================
// Local constants (for stats display only -- domain scan happens in the lib)
// ============================================================================

const KNOWN_DOMAINS = ["People", "Companies", "Ideas", "Research", "Library", "Projects", "Architecture"];

// Stable display order for typed-wikilink groups in `related` output
const TYPED_EDGE_ORDER: TypedEdgeType[] = [
  "REINFORCES",
  "CONTRADICTS",
  "EXTENDS",
  "APPLIES_TO",
  "IMPLEMENTS",
  "VALIDATES",
  "REFERENCES",
];

// ============================================================================
// Output Helpers
// ============================================================================

function edgeDescription(edge: GraphEdge): string {
  switch (edge.edgeType) {
    case "tag":
      return `tag:${edge.label}`;
    case "wikilink":
      return "wikilink";
    case "typed-wikilink":
      return `typed:${edge.label}`;
    case "related":
      return `related:${edge.label || "related"}`;
  }
}

// ============================================================================
// Commands
// ============================================================================

function cmdTraverse(query: string, maxHops: number): void {
  const graph = buildGraph();
  const slug = resolveSlug(graph, query);

  if (!slug) {
    console.error(`Slug not found: "${query}"`);
    const suggestions: string[] = [];
    const q = query.toLowerCase();
    for (const s of graph.nodes.keys()) {
      if (s.includes(q.substring(0, Math.min(q.length, 5)))) {
        suggestions.push(s);
      }
    }
    if (suggestions.length > 0) {
      console.error(`\n  Did you mean:`);
      for (const s of suggestions.slice(0, 5)) {
        const node = graph.nodes.get(s)!;
        console.error(`    ${s} -- "${node.title}"`);
      }
    }
    process.exit(1);
  }

  const startNode = graph.nodes.get(slug)!;
  const results = traverse(graph, slug, maxHops);

  console.log(`\n\u{1F5FA}️  Knowledge Graph Traversal: "${slug}"`);
  console.log("─".repeat(50));
  console.log(`\n\u{1F4CD} START: ${slug} -- "${startNode.title}" (${startNode.type})`);

  const byHop = new Map<number, TraversalNode[]>();
  for (const r of results) {
    if (r.hop === 0) continue;
    if (!byHop.has(r.hop)) byHop.set(r.hop, []);
    byHop.get(r.hop)!.push(r);
  }

  for (const [hop, nodes] of [...byHop.entries()].sort((a, b) => a[0] - b[0])) {
    const label = hop === 1 ? "Hop 1 (direct connections)" : `Hop ${hop}`;
    console.log(`\n  ${label}:`);
    nodes.sort((a, b) => b.cumulativeWeight - a.cumulativeWeight);
    for (const r of nodes) {
      const via = r.viaEdge ? ` via ${edgeDescription(r.viaEdge)}` : "";
      console.log(
        `    -> ${r.node.slug} (${r.node.type})${via} [weight: ${r.viaEdge?.weight || 0}]`
      );
    }
  }

  const totalTraversed = results.length;
  const maxHopReached = byHop.size > 0 ? Math.max(...byHop.keys()) : 0;
  console.log("\n" + "─".repeat(50));
  console.log(
    `Traversed ${totalTraversed} nodes across ${maxHopReached} hops from ${graph.nodes.size} total nodes.`
  );
}

function cmdRelated(query: string): void {
  const graph = buildGraph();
  const slug = resolveSlug(graph, query);

  if (!slug) {
    console.error(`Slug not found: "${query}"`);
    process.exit(1);
  }

  const startNode = graph.nodes.get(slug)!;
  const results = traverse(graph, slug, 1);

  console.log(`\n\u{1F517} Related Notes: "${slug}"`);
  console.log("─".repeat(50));
  console.log(`\n  Source: ${startNode.title} (${startNode.domain}/${startNode.type})`);
  console.log(`  Tags: [${startNode.tags.join(", ")}]\n`);

  const directConnections = results.filter((r) => r.hop === 1);

  if (directConnections.length === 0) {
    console.log("  No direct connections found.");
    console.log("─".repeat(50));
    return;
  }

  // Group by edge type
  const byType = new Map<string, TraversalNode[]>();
  for (const r of directConnections) {
    const type = r.viaEdge?.edgeType || "unknown";
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type)!.push(r);
  }

  // Typed wikilinks first, grouped by TypedEdgeType label
  const typedGroup = byType.get("typed-wikilink") || [];
  if (typedGroup.length > 0) {
    const byTypedLabel = new Map<TypedEdgeType, TraversalNode[]>();
    for (const r of typedGroup) {
      const label = (r.viaEdge?.label as TypedEdgeType) || "REFERENCES";
      if (!byTypedLabel.has(label)) byTypedLabel.set(label, []);
      byTypedLabel.get(label)!.push(r);
    }
    for (const typedType of TYPED_EDGE_ORDER) {
      const group = byTypedLabel.get(typedType);
      if (!group || group.length === 0) continue;
      console.log(`  Typed wikilink references (${typedType}):`);
      group.sort((a, b) => b.cumulativeWeight - a.cumulativeWeight);
      for (const r of group) {
        console.log(`    -> ${r.node.domain}/${r.node.slug} -- "${r.node.title}"`);
      }
      console.log();
    }
  }

  // Then the existing groups in their original order
  const typeOrder: Array<"related" | "wikilink" | "tag"> = ["related", "wikilink", "tag"];
  for (const type of typeOrder) {
    const group = byType.get(type);
    if (!group || group.length === 0) continue;

    const header =
      type === "related"
        ? "Typed relationships"
        : type === "wikilink"
          ? "Wikilink references"
          : "Tag co-occurrence";

    console.log(`  ${header}:`);
    group.sort((a, b) => b.cumulativeWeight - a.cumulativeWeight);
    for (const r of group) {
      const label = r.viaEdge?.label ? ` (${r.viaEdge.label})` : "";
      console.log(`    -> ${r.node.domain}/${r.node.slug} -- "${r.node.title}"${label}`);
    }
    console.log();
  }

  console.log("─".repeat(50));
  console.log(`${directConnections.length} direct connections.`);
}

function cmdStats(): void {
  const graph = buildGraph();

  // Domain counts
  const domainCounts: Record<string, number> = {};
  for (const node of graph.nodes.values()) {
    domainCounts[node.domain] = (domainCounts[node.domain] || 0) + 1;
  }

  // Edge type counts
  const edgeTypeCounts: Record<string, number> = {};
  for (const edge of graph.edges) {
    edgeTypeCounts[edge.edgeType] = (edgeTypeCounts[edge.edgeType] || 0) + 1;
  }

  // Connections per node
  const totalConnections = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    if (!totalConnections.has(edge.from)) totalConnections.set(edge.from, new Set());
    totalConnections.get(edge.from)!.add(edge.to);
    if (!totalConnections.has(edge.to)) totalConnections.set(edge.to, new Set());
    totalConnections.get(edge.to)!.add(edge.from);
  }

  const connectedNodes = [...totalConnections.entries()].filter(([, s]) => s.size > 0);
  const avgConnections =
    connectedNodes.length > 0
      ? (
          connectedNodes.reduce((acc, [, s]) => acc + s.size, 0) / graph.nodes.size
        ).toFixed(1)
      : "0.0";

  // Most connected node
  let mostConnectedSlug = "";
  let mostConnectedCount = 0;
  for (const [slug, conns] of totalConnections) {
    if (conns.size > mostConnectedCount) {
      mostConnectedCount = conns.size;
      mostConnectedSlug = slug;
    }
  }

  // Isolated nodes
  const isolatedNodes: string[] = [];
  for (const slug of graph.nodes.keys()) {
    if (!totalConnections.has(slug) || totalConnections.get(slug)!.size === 0) {
      isolatedNodes.push(slug);
    }
  }

  // Tag clusters
  const tagIndex = new Map<string, number>();
  for (const node of graph.nodes.values()) {
    for (const tag of node.tags) {
      tagIndex.set(tag, (tagIndex.get(tag) || 0) + 1);
    }
  }
  const tagClusters = [...tagIndex.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1]);

  console.log("\n\u{1F4CA} Knowledge Graph Statistics");
  console.log("─".repeat(50));

  const domainStr = KNOWN_DOMAINS.map((d) => `${d}: ${domainCounts[d] || 0}`).join(", ");
  console.log(`  Nodes: ${graph.nodes.size} (${domainStr})`);

  const edgeStr = ["tag", "wikilink", "typed-wikilink", "related"]
    .map((t) => `${t}: ${edgeTypeCounts[t] || 0}`)
    .join(", ");
  console.log(`  Edges: ${graph.edges.length} (${edgeStr})`);

  console.log(`  Avg connections per node: ${avgConnections}`);

  if (mostConnectedSlug) {
    console.log(
      `  Most connected: "${mostConnectedSlug}" (${mostConnectedCount} edges)`
    );
  }

  console.log(`  Isolated nodes: ${isolatedNodes.length} (no connections)`);

  if (tagClusters.length > 0) {
    const clusterStr = tagClusters
      .slice(0, 10)
      .map(([tag, count]) => `${tag} (${count} notes)`)
      .join(", ");
    console.log(`  Tag clusters: ${clusterStr}`);
  }

  console.log("─".repeat(50));
}

function cmdHubs(): void {
  const graph = buildGraph();

  const connectionMap = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    if (!connectionMap.has(edge.from)) connectionMap.set(edge.from, new Set());
    connectionMap.get(edge.from)!.add(edge.to);
    if (!connectionMap.has(edge.to)) connectionMap.set(edge.to, new Set());
    connectionMap.get(edge.to)!.add(edge.from);
  }

  const ranked = [...connectionMap.entries()]
    .map(([slug, conns]) => ({ slug, count: conns.size }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  console.log("\n\u{1F517} Top Knowledge Hubs");
  console.log("─".repeat(50));

  if (ranked.length === 0) {
    console.log("  No connected nodes found.");
    console.log("─".repeat(50));
    return;
  }

  for (let i = 0; i < ranked.length; i++) {
    const { slug, count } = ranked[i];
    const node = graph.nodes.get(slug);
    const domain = node ? node.domain : "unknown";
    const title = node ? node.title : slug;
    console.log(
      `  ${(i + 1).toString().padStart(2)}. ${slug} (${count} connections) -- ${domain}`
    );
    console.log(`      "${title}"`);
  }

  console.log("─".repeat(50));
}

function cmdFind(tag: string): void {
  const graph = buildGraph();
  const normalizedTag = tag.toLowerCase().trim();

  const matches: GraphNode[] = [];
  for (const node of graph.nodes.values()) {
    if (node.tags.includes(normalizedTag)) matches.push(node);
  }

  matches.sort((a, b) => {
    if (a.domain !== b.domain) return a.domain.localeCompare(b.domain);
    return a.slug.localeCompare(b.slug);
  });

  console.log(`\n\u{1F3F7}️  Notes tagged "${normalizedTag}"`);
  console.log("─".repeat(50));

  if (matches.length === 0) {
    console.log(`  No notes found with tag "${normalizedTag}"`);
    const allTags = new Set<string>();
    for (const node of graph.nodes.values()) {
      for (const t of node.tags) allTags.add(t);
    }
    const suggestions = [...allTags]
      .filter((t) => t.includes(normalizedTag) || normalizedTag.includes(t))
      .slice(0, 5);
    if (suggestions.length > 0) {
      console.log(`\n  Similar tags: ${suggestions.join(", ")}`);
    }
    console.log("─".repeat(50));
    return;
  }

  for (const node of matches) {
    console.log(`  ${node.domain}/${node.slug} -- "${node.title}"`);
  }

  console.log("─".repeat(50));
  console.log(
    `${matches.length} note${matches.length !== 1 ? "s" : ""} found with tag "${normalizedTag}"`
  );
}

// ============================================================================
// concept-search: multi-source BFS from query-matched seeds
// ============================================================================

function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

function scoreNodeForQuery(node: GraphNode, tokens: string[]): number {
  const slugLower = node.slug.toLowerCase();
  const titleLower = node.title.toLowerCase();
  const tagsLower = node.tags.map((t) => t.toLowerCase());
  let score = 0;
  for (const token of tokens) {
    if (slugLower.includes(token) || titleLower.includes(token)) {
      score += 1;
      continue;
    }
    if (tagsLower.some((tag) => tag.includes(token))) {
      score += 1;
    }
  }
  return score;
}

interface ConceptResult {
  node: GraphNode;
  hop: number;
  cumulativeWeight: number;
  viaEdge?: GraphEdge;
  seedSlug: string;
}

function cmdConceptSearch(query: string, maxHops: number): void {
  const graph = buildGraph();
  const tokens = tokenizeQuery(query);

  if (tokens.length === 0) {
    console.error("Error: query produced no searchable terms after tokenization.");
    process.exit(1);
  }

  // Score every node, take top-5 seeds with score > 0
  const scored: Array<{ slug: string; node: GraphNode; score: number }> = [];
  for (const [slug, node] of graph.nodes) {
    const score = scoreNodeForQuery(node, tokens);
    if (score > 0) scored.push({ slug, node, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const seeds = scored.slice(0, 5);

  console.log(`\n\u{1F50D} Concept Search: "${query}"`);
  console.log("─".repeat(50));

  if (seeds.length === 0) {
    console.log("  No seeds matched the query.");
    console.log("─".repeat(50));
    return;
  }

  console.log(`\n  Seeds (${seeds.length}):`);
  for (const s of seeds) {
    console.log(`    - ${s.slug} (score: ${s.score}) -- "${s.node.title}"`);
  }

  // Multi-source BFS with a shared visited set
  const visited = new Set<string>(seeds.map((s) => s.slug));
  const cluster: ConceptResult[] = [];

  // Queue entries: [slug, hop, cumulativeWeight, viaEdge, seedSlug]
  const queue: Array<[string, number, number, GraphEdge | undefined, string]> = [];
  for (const s of seeds) queue.push([s.slug, 0, 0, undefined, s.slug]);

  while (queue.length > 0) {
    const [currentSlug, hop, cumWeight, viaEdge, seedSlug] = queue.shift()!;
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
      const node = graph.nodes.get(target);
      if (!node) continue;
      const result: ConceptResult = {
        node,
        hop: hop + 1,
        cumulativeWeight: cumWeight + edge.weight,
        viaEdge: edge,
        seedSlug,
      };
      cluster.push(result);
      queue.push([target, hop + 1, cumWeight + edge.weight, edge, seedSlug]);
    }
  }

  // Sort cluster: hop ascending, then cumulativeWeight descending
  cluster.sort((a, b) => {
    if (a.hop !== b.hop) return a.hop - b.hop;
    return b.cumulativeWeight - a.cumulativeWeight;
  });

  // Cap total displayed nodes (seeds + cluster) at 20
  const remaining = Math.max(0, 20 - seeds.length);
  const displayCluster = cluster.slice(0, remaining);

  if (displayCluster.length === 0) {
    console.log("\n  Connected cluster: (none reachable within hop limit)");
  } else {
    console.log("\n  Connected cluster:");
    for (const r of displayCluster) {
      const via = r.viaEdge ? edgeDescription(r.viaEdge) : "?";
      console.log(
        `    -> hop ${r.hop}: ${r.node.slug} via ${via} [from seed: ${r.seedSlug}, weight: ${r.cumulativeWeight}]`
      );
    }
  }

  console.log("\n" + "─".repeat(50));
  console.log(
    `${seeds.length} seed(s), ${cluster.length} cluster node(s) reachable; showing ${seeds.length + displayCluster.length} of ${seeds.length + cluster.length} (cap 20).`
  );
}

// ============================================================================
// Help & CLI Entry
// ============================================================================

function showHelp(): void {
  console.log(`
KnowledgeGraph -- Associative graph navigation over PAI's knowledge archive

Commands:
  traverse <slug>              BFS from slug, show connected notes (default: 2 hops)
  traverse <slug> --hops 3     BFS with configurable depth
  related <slug>               Show directly connected notes (1 hop)
  stats                        Graph summary: nodes, edges, clusters, hubs
  hubs                         Top 10 most-connected notes
  find <tag>                   Find all notes with a specific tag
  concept-search <query>       Multi-source BFS from query-matched seeds

Examples:
  bun KnowledgeGraph.ts traverse karpathy
  bun KnowledgeGraph.ts traverse mempalace --hops 3
  bun KnowledgeGraph.ts related andrej-karpathy
  bun KnowledgeGraph.ts stats
  bun KnowledgeGraph.ts hubs
  bun KnowledgeGraph.ts find architecture
  bun KnowledgeGraph.ts concept-search "memory retrieval"
`);
}

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    hops: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: true,
  strict: false,
});

if (values.help) {
  showHelp();
  process.exit(0);
}

const command = positionals[0];

if (!command) {
  showHelp();
  process.exit(0);
}

switch (command) {
  case "traverse": {
    const slug = positionals[1];
    if (!slug) {
      console.error("Usage: bun KnowledgeGraph.ts traverse <slug> [--hops N]");
      process.exit(1);
    }
    const hops = values.hops ? parseInt(values.hops as string) : 2;
    if (isNaN(hops) || hops < 1) {
      console.error("--hops must be a positive integer");
      process.exit(1);
    }
    cmdTraverse(slug, hops);
    break;
  }
  case "related": {
    const slug = positionals[1];
    if (!slug) {
      console.error("Usage: bun KnowledgeGraph.ts related <slug>");
      process.exit(1);
    }
    cmdRelated(slug);
    break;
  }
  case "stats":
    cmdStats();
    break;
  case "hubs":
    cmdHubs();
    break;
  case "find": {
    const tag = positionals[1];
    if (!tag) {
      console.error("Usage: bun KnowledgeGraph.ts find <tag>");
      process.exit(1);
    }
    cmdFind(tag);
    break;
  }
  case "concept-search": {
    const query = positionals.slice(1).join(" ").trim();
    if (!query) {
      console.error("Usage: bun KnowledgeGraph.ts concept-search <query> [--hops N]");
      process.exit(1);
    }
    const hops = values.hops ? parseInt(values.hops as string) : 2;
    if (isNaN(hops) || hops < 1) {
      console.error("--hops must be a positive integer");
      process.exit(1);
    }
    cmdConceptSearch(query, hops);
    break;
  }
  default:
    console.error(`Unknown command: ${command}. Use --help for usage.`);
    process.exit(1);
}
