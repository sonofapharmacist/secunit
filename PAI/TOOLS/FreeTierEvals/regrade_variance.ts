#!/usr/bin/env bun
/**
 * regrade_variance.ts — grade the SAME stored plan N times to measure grader-side variance.
 *
 * Written 2026-09-27 for B3 (threat bench v2). If a fixed plan's score moves as much as a
 * model's run-to-run spread, the spread is grader noise and no rubric change on the stored
 * output can rank models inside a band.
 *
 * Usage: bun regrade_variance.ts <result.json> [...] [--n 3]
 */
import { readFileSync } from "fs";
import { callGrader, getAnthropicKey, EMBEDDED_MANIFEST } from "./threat_model_bench";

const argv = process.argv.slice(2);
const nIdx = argv.indexOf("--n");
const N = nIdx >= 0 ? Number(argv[nIdx + 1]) : 3;
if (!Number.isInteger(N) || N < 1) { console.error("--n must be a positive integer"); process.exit(1); }
const files = argv.filter((a, i) => a.endsWith(".json") && !(nIdx >= 0 && i === nIdx + 1));
if (!files.length) { console.error("usage: bun regrade_variance.ts <result.json> [...] [--n 3]"); process.exit(1); }
const manifestJson = JSON.stringify(EMBEDDED_MANIFEST, null, 2);
const key = await getAnthropicKey();

for (const file of files) {
  const run = JSON.parse(readFileSync(file, "utf8"));
  const plan: string = run.plan_or_audit?.text ?? "";
  if (!plan) { console.error(`${file}: no stored plan text`); continue; }
  const graded = await Promise.all(Array.from({ length: N }, () => callGrader(plan, manifestJson, key)));
  const totals = graded.map((g) => Math.round(g.total * 100) / 100);
  const cost = graded.reduce((s, g) => s + g.meta.cost_estimate_usd, 0);
  console.log(JSON.stringify({
    slot: run.slot, file: file.split("/").pop(), original: run.grader?.total,
    regrades: totals, range: Math.round((Math.max(...totals) - Math.min(...totals)) * 100) / 100,
    findings: graded.map((g) => g.findings.length), pai: graded.map((g) => g.pai_specific),
    coverage: graded.map((g) => g.coverage), cost_usd: Math.round(cost * 1000) / 1000,
  }));
}
