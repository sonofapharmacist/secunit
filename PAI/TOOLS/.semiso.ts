import { buildGraph } from "./KnowledgeGraphLib.js";
const g = buildGraph();
const nodes = [...g.nodes.keys()];
const sem = new Set(["related", "wikilink", "typed-wikilink"]);
const deg = new Map<string, number>();
let semCount = 0;
for (const e of g.edges) {
  if (!sem.has(e.edgeType)) continue;
  semCount++;
  deg.set(e.from, (deg.get(e.from) ?? 0) + 1);
  deg.set(e.to, (deg.get(e.to) ?? 0) + 1);
}
const total = nodes.length;
const withSem = [...deg.keys()].filter(k => g.nodes.has(k)).length;
console.log("total nodes:", total);
console.log("semantic edges (related+wikilink+typed):", semCount);
console.log("nodes with >=1 semantic edge:", withSem);
console.log("SEMANTICALLY ISOLATED:", total - withSem, `(${(((total - withSem) / total) * 100).toFixed(1)}%)`);
const hist = new Map<number, number>();
for (const [k, d] of deg) if (g.nodes.has(k)) hist.set(d, (hist.get(d) ?? 0) + 1);
console.log("semantic degree dist:", [...hist.entries()].sort((a, b) => a[0] - b[0]).slice(0, 14).map(([d, c]) => `${d}:${c}`).join("  "));
