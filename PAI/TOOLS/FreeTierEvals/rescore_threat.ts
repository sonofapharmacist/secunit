#!/usr/bin/env bun
/**
 * rescore_threat.ts — re-derive every stored threat score from the grader's raw_text,
 * using the current parseGraderJson. No API calls, no re-grading.
 *
 * Written 2026-09-26 after two parser bugs surfaced: declared coverage overrode a 4/4
 * breakdown, and 1-5 scale specificity hit the x*3 cap for full marks.
 *
 * Usage: bun rescore_threat.ts [--write]   (--write updates model_scoreboard.jsonl rows in place,
 *        adding threat_total_rescored and keeping threat_total; a .bak copy is written first)
 * Output: one TSV line per changed result, then threat_rescored.jsonl with every result.
 */
import { readdirSync, readFileSync, writeFileSync, copyFileSync } from "fs";
import { join } from "path";
import { parseGraderJson } from "./threat_model_bench";

const DIR = join(import.meta.dir, "threat_model_bench_results");
const SCOREBOARD = join(import.meta.dir, "model_scoreboard.jsonl");
const round2 = (n: number) => Math.round(n * 100) / 100;

const rows: { file: string; slot: string; ts: string; old: number; new: number }[] = [];
for (const name of readdirSync(DIR).filter((n) => n.endsWith(".json")).sort()) {
  let j: any;
  try { j = JSON.parse(readFileSync(join(DIR, name), "utf8")); } catch { continue; }
  if (Array.isArray(j) || typeof j?.grader?.raw_text !== "string") continue;
  const fresh = parseGraderJson(j.grader.raw_text);
  rows.push({ file: name, slot: j.slot, ts: j.timestamp, old: round2(j.grader.total ?? 0), new: round2(fresh.total) });
}

const changed = rows.filter((r) => r.old !== r.new);
console.log(`${rows.length} results rescored, ${changed.length} changed`);
for (const r of changed) console.log(`${r.ts?.slice(0, 16)}\t${r.slot}\t${r.old} → ${r.new}\t${(r.new - r.old > 0 ? "+" : "") + round2(r.new - r.old)}`);
writeFileSync(join(import.meta.dir, "threat_rescored.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

if (process.argv.includes("--write")) {
  copyFileSync(SCOREBOARD, SCOREBOARD + ".bak");
  const byFile = new Map(rows.map((r) => [r.file, r.new]));
  const out = readFileSync(SCOREBOARD, "utf8").trim().split("\n").map((line) => {
    const row = JSON.parse(line);
    // Multi-run rows (bench_model.ts --threat-runs, 2026-09-26+) rescore to the mean of their graded runs.
    const files: string[] = (Array.isArray(row.threat_jsons) ? row.threat_jsons : [row.threat_json])
      .filter(Boolean).map((p: string) => p.split("/").pop()!);
    const scores = files.filter((f) => byFile.has(f)).map((f) => byFile.get(f)!).filter((x) => x > 0);
    if (scores.length) row.threat_total_rescored = round2(scores.reduce((s, x) => s + x, 0) / scores.length);
    return JSON.stringify(row);
  });
  writeFileSync(SCOREBOARD, out.join("\n") + "\n");
  console.log(`scoreboard updated (backup: ${SCOREBOARD}.bak)`);
}
