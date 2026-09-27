#!/usr/bin/env bun
/**
 * scoreboard_report.ts — render the model score tables from model_scoreboard.jsonl, the one
 * canonical source for bench_model.ts results (2026-09-26+).
 *
 * Scores come only from the scoreboard. Labels, ids, prices and notes come from
 * scoreboard_meta.json, as do documented exclusions (harness-failure rows, by key + timestamp).
 *
 * Usage:
 *   bun scoreboard_report.ts                 print the tables
 *   bun scoreboard_report.ts --write [doc]   replace the generated block (default: SCOREBOARD_DOC)
 *   bun scoreboard_report.ts --check [doc]   exit 1 if the generated block is stale
 *
 * The block sits between BEGIN and END markers; everything outside them is hand-written narrative.
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const DIR = import.meta.dir;
/** The one doc that hosts the generated tables; bench_model.ts refreshes it after every run. */
export const SCOREBOARD_DOC = join(DIR, "../../MEMORY/KNOWLEDGE/Research/model-sweep-unified-threat-2026-09-26.md");
const BEGIN = "<!-- scoreboard:generated:begin -->";
const END = "<!-- scoreboard:generated:end -->";

interface Row {
  timestamp: string; key: string; kind: "cloud" | "local";
  unified_total: number | null; t: number | null; r: number | null; c: number | null;
  threat_total: number | null; threat_total_rescored?: number; threat_runs?: (number | null)[];
}
interface Meta { label?: string; id?: string; price?: string; size?: string; note?: string }
interface Exclusion { key: string; ts: string; part: "row" | "unified" | "threat"; reason: string }

// Loaded on first use: a fresh install has no scoreboard yet, and bench_model.ts imports this module.
let rows: Row[] = [];
let meta: { models: Record<string, Meta>; exclusions: Exclusion[] } = { models: {}, exclusions: [] };
function load(): void {
  const sb = join(DIR, "model_scoreboard.jsonl"), mf = join(DIR, "scoreboard_meta.json");
  rows = existsSync(sb) ? readFileSync(sb, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  // Meta is checked in; if it is missing, the documented exclusions vanish and failed rows reappear. Fail loudly.
  if (!existsSync(mf)) throw new Error(`${mf} missing: exclusions would be silently dropped`);
  meta = JSON.parse(readFileSync(mf, "utf8"));
  for (const e of meta.exclusions) {
    if (!rows.some((r) => r.key === e.key && r.timestamp.startsWith(e.ts))) console.error(`[scoreboard] exclusion matches no row: ${e.key} ${e.ts}`);
  }
}

const excluded = (row: Row, part: "unified" | "threat") =>
  meta.exclusions.some((e) => e.key === row.key && row.timestamp.startsWith(e.ts) && (e.part === "row" || e.part === part));

// A multi-run row (bench_model.ts --threat-runs) carries every run; older rows carry one rescored total.
// Failed runs are null or 0, the same filter bench_model.ts applies to threat_mean.
const threatValues = (row: Row): number[] =>
  (row.threat_runs?.length ? row.threat_runs
    : [row.threat_total_rescored ?? row.threat_total]).filter((x): x is number => x != null && x > 0);

const fmt = (n: number) => (Math.round(n * 100) / 100).toFixed(2).replace(/\.?0+$/, (m) => (m.startsWith(".") ? "" : m));

interface Agg { key: string; kind: string; unified: number[]; threat: number[] }
function aggregate(): Map<string, Agg> {
  const byKey = new Map<string, Agg>();
  for (const row of [...rows].sort((a, b) => a.timestamp.localeCompare(b.timestamp))) {
    const agg = byKey.get(row.key) ?? { key: row.key, kind: row.kind, unified: [], threat: [] };
    // 0/53 is an unreachable host or a harness failure, not a score (same rule as threat 0).
    if (row.unified_total != null && row.unified_total > 0 && !excluded(row, "unified")) agg.unified.push(row.unified_total);
    if (!excluded(row, "threat")) agg.threat.push(...threatValues(row));
    byKey.set(row.key, agg);
  }
  return byKey;
}

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
const threatCell = (xs: number[]) =>
  !xs.length ? "—" : xs.length === 1 ? `${fmt(xs[0])} (1 run)` : `${fmt(mean(xs))} (${xs.map(fmt).join(", ")})`;
const unifiedCell = (xs: number[]) => (xs.length ? xs.join(", ") : "—");
const rank = (a: Agg, b: Agg) =>
  Math.max(0, ...b.unified) - Math.max(0, ...a.unified) || (b.threat.length ? mean(b.threat) : 0) - (a.threat.length ? mean(a.threat) : 0);

function table(byKey: Map<string, Agg>, kind: "cloud" | "local"): string {
  const aggs = [...byKey.values()].filter((a) => a.kind === kind).sort(rank);
  const head = kind === "cloud"
    ? "| Model | OR id | Unified | Threat mean (runs) | Price |\n|---|---|---|---|---|"
    : "| Model | Quant / size | Unified | Threat mean (runs) | Notes |\n|---|---|---|---|---|";
  const lines = aggs.map((a) => {
    const m = meta.models[a.key] ?? {};
    const second = kind === "cloud" ? (m.id ? `\`${m.id}\`` : "—") : (m.size ?? "—");
    const last = kind === "cloud" ? (m.price ?? "—") : (m.note ?? "");
    return `| ${m.label ?? `\`${a.key}\``} | ${second} | ${unifiedCell(a.unified)} | ${threatCell(a.threat)} | ${last} |`;
  });
  return [head, ...lines].join("\n");
}

/** Rewrite the generated block in doc. Returns false when the doc has no markers. */
export function writeDoc(doc: string): boolean {
  const text = readFileSync(doc, "utf8");
  load();
  if (rows.length === 0) throw new Error("scoreboard has no rows; refusing to overwrite the table");
  if (!text.includes(BEGIN)) return false;
  writeFileSync(doc, splice(text, render()));
  return true;
}

export function render(): string {
  load();
  const byKey = aggregate();
  const latest = rows.map((r) => r.timestamp).sort().at(-1)?.slice(0, 10) ?? "—";
  const excl = meta.exclusions.map((e) => `- \`${e.key}\` ${e.ts} (${e.part}): ${e.reason}`).join("\n");
  return [
    BEGIN,
    `*Generated by \`PAI/TOOLS/FreeTierEvals/scoreboard_report.ts\` from \`model_scoreboard.jsonl\` (${rows.length} rows, latest ${latest}). Do not edit inside this block; run \`bun scoreboard_report.ts --write\`. Unified is /53, every valid run oldest first. Threat is /10 under the 2026-09-26 parser. One run is a band, not a rank.*`,
    "",
    "#### Cloud",
    "",
    table(byKey, "cloud"),
    "",
    "#### Local",
    "",
    table(byKey, "local"),
    "",
    "Excluded rows (harness failures, kept in the scoreboard for audit):",
    "",
    excl,
    END,
  ].join("\n");
}

function splice(doc: string, block: string): string {
  const b = doc.indexOf(BEGIN), e = doc.indexOf(END);
  if (b < 0 || e < b) throw new Error(`markers not found — add ${BEGIN} and ${END} where the tables belong`);
  return doc.slice(0, b) + block + doc.slice(e + END.length);
}

if (import.meta.main) {
  const [mode, arg] = process.argv.slice(2);
  const file = arg ?? SCOREBOARD_DOC;
  const block = render();
  if (!mode) { console.log(block); process.exit(0); }
  if (mode !== "--write" && mode !== "--check") {
    console.error("usage: bun scoreboard_report.ts [--write|--check [doc]]  (doc defaults to the sweep research note)");
    process.exit(2);
  }
  const doc = readFileSync(file, "utf8");
  if (mode === "--write" && rows.length === 0) { console.error("scoreboard has no rows; refusing to overwrite the table"); process.exit(1); }
  const next = splice(doc, block);
  if (mode === "--check") {
    if (next !== doc) { console.error(`${file}: generated scoreboard block is stale — run --write`); process.exit(1); }
    console.log(`${file}: scoreboard block current`);
  } else {
    writeFileSync(file, next);
    console.log(`${file}: scoreboard block written`);
  }
}
