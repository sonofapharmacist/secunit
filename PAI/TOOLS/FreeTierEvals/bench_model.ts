#!/usr/bin/env bun
/**
 * bench_model.ts — the default path for benching a new model: unified (53 pts)
 * then threat (0-10), one scoreboard row per run.
 *
 * Cloud vs local is inferred from which harness defines the key:
 *   - key in or_unified_bench.py ENDPOINTS → cloud (OpenRouter), threat via OR slot
 *   - key in llamacpp_eval.py MODELS       → local (your-inference-host), threat via llamacpp slot
 * The same key must exist as a threat_model_bench.ts ROSTER slot.
 *
 * Usage:
 *   bun bench_model.ts or_solar_pro4
 *   bun bench_model.ts laguna_xs21 --sampler "--temperature 0.6 --top-p 0.95 --top-k 20"
 *   bun bench_model.ts or_grok47 --skip-threat
 *   bun bench_model.ts or_grok47 --threat-runs 1     # one threat run (a band, not a rank)
 *
 * Threat runs 3× by default. One threat run places a model in a band (~5.6 / ~6.9 / ~8.1 / 9+,
 * set by the integer pai_specific term); routing decisions need the mean and the min of 3.
 * threat_total is the mean over runs that produced a grade (>0); failed runs are counted apart.
 *
 * Local runs assume the model is already being served on your-inference-host under alias == key
 * (the swap is the caller's job — see reference_ubullm.md).
 *
 * Output: unified JSON + threat JSON under --out-dir, one row appended to
 * model_scoreboard.jsonl next to this file.
 */

import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, appendFileSync } from "fs";
import { join } from "path";
import { SCOREBOARD_DOC, writeDoc } from "./scoreboard_report";
import { localInferenceOrigin } from "./local_host";

const HERE = import.meta.dir;
const SCOREBOARD = join(HERE, "model_scoreboard.jsonl");
const THREAT_DIR = join(HERE, "threat_model_bench_results");
const UBULLM_URL = process.env.UBULLM_URL ?? `${localInferenceOrigin()}/v1`;

interface Args {
  key: string;
  sampler: string[];
  outDir: string;
  skipUnified: boolean;
  skipThreat: boolean;
  threatRuns: number;
}

function usage(code: number): never {
  console.log(`bench_model.ts <key> [--sampler "<llamacpp_eval sampler flags>"] [--out-dir DIR] [--skip-unified] [--skip-threat] [--threat-runs N]

Runs unified (53-pt) then threat (0-10, 3 runs by default) for one model and appends to model_scoreboard.jsonl.
--threat-runs N   threat repetitions (default 3). The row carries threat_mean, threat_min and threat_runs.
Cloud/local is inferred from which harness defines <key>.`);
  process.exit(code);
}

function parseArgs(argv: string[]): Args {
  if (argv.includes("-h") || argv.includes("--help")) usage(0);
  const a: Args = {
    key: "",
    sampler: [],
    outDir: join(HERE, "sweep_results", new Date().toISOString().slice(0, 10)),
    skipUnified: false,
    skipThreat: false,
    threatRuns: 3,
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--sampler") a.sampler = (argv[++i] ?? "").split(/\s+/).filter(Boolean);
    else if (v === "--out-dir") a.outDir = argv[++i];
    else if (v === "--skip-unified") a.skipUnified = true;
    else if (v === "--skip-threat") a.skipThreat = true;
    else if (v === "--threat-runs") {
      a.threatRuns = Number(argv[++i]);
      if (!Number.isInteger(a.threatRuns) || a.threatRuns < 1) { console.error(`--threat-runs must be a positive integer, got ${argv[i]}`); process.exit(1); }
    }
    else if (!v.startsWith("--") && !a.key) a.key = v;
    else throw new Error(`unknown arg: ${v}`);
  }
  if (!a.key) usage(1);
  return a;
}

function definesKey(file: string, key: string): boolean {
  return readFileSync(join(HERE, file), "utf-8").includes(`"${key}": {`);
}

function run(cmd: string[], env: Record<string, string> = {}): number {
  console.log(`\n$ ${cmd.join(" ")}`);
  const p = Bun.spawnSync(cmd, {
    cwd: HERE,
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, PYTHONUNBUFFERED: "1", ...env },
  });
  return p.exitCode ?? 1;
}

/** "8/9" → [8, 9] */
function frac(s: unknown): [number, number] | null {
  const m = String(s ?? "").match(/(\d+)\s*\/\s*(\d+)/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

interface Unified {
  total: number | null;
  max: number | null;
  t: number | null;
  r: number | null;
  c: number | null;
  json: string;
}

function readUnifiedCloud(outDir: string, key: string): Unified {
  const f = join(outDir, `or_unified_${key}.json`);
  if (!existsSync(f)) return { total: null, max: null, t: null, r: null, c: null, json: f };
  const j = JSON.parse(readFileSync(f, "utf-8"));
  return { total: j.total, max: j.total_max, t: j.t_score, r: j.r_score, c: j.c_score, json: f };
}

function readUnifiedLocal(outDir: string, key: string): Unified {
  const f = join(outDir, `llamacpp-bench-${key}.json`);
  const empty = { total: null, max: null, t: null, r: null, c: null, json: f };
  if (!existsSync(f)) return empty;
  const batteries: { battery: string; score: string }[] = JSON.parse(readFileSync(f, "utf-8")).batteries ?? [];
  const by: Record<string, [number, number] | null> = {};
  for (const b of batteries) by[b.battery] = frac(b.score);
  if (!by.T || !by.R || !by.C) return { ...empty, t: by.T?.[0] ?? null, r: by.R?.[0] ?? null, c: by.C?.[0] ?? null };
  return {
    total: by.T[0] + by.R[0] + by.C[0],
    max: by.T[1] + by.R[1] + by.C[1],
    t: by.T[0], r: by.R[0], c: by.C[0],
    json: f,
  };
}

interface Threat {
  total: number | null;
  cost: number | null;
  json: string | null;
}

function readThreat(key: string, since: number): Threat {
  if (!existsSync(THREAT_DIR)) return { total: null, cost: null, json: null };
  const hits = readdirSync(THREAT_DIR)
    .filter((f) => f.endsWith(`_${key}.json`))
    .map((f) => join(THREAT_DIR, f))
    .filter((f) => statSync(f).mtimeMs >= since)
    .sort((x, y) => statSync(y).mtimeMs - statSync(x).mtimeMs);
  if (!hits.length) return { total: null, cost: null, json: null };
  const j = JSON.parse(readFileSync(hits[0], "utf-8"));
  return { total: j.grader?.total ?? null, cost: j.cost_total_usd ?? null, json: hits[0] };
}

/** Live OR $/MTok for a cloud key's model id, read from or_unified_bench.py. Null if offline. */
async function livePrice(key: string): Promise<{ id: string; in: number; out: number } | null> {
  const src = readFileSync(join(HERE, "or_unified_bench.py"), "utf-8");
  const block = src.slice(src.indexOf(`"${key}": {`));
  const id = block.match(/"model":\s*"([^"]+)"/)?.[1];
  if (!id) return null;
  try {
    const r = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(8000) });
    const m = ((await r.json()) as { data: { id: string; pricing: { prompt: string; completion: string } }[] }).data.find((d) => d.id === id);
    return m ? { id, in: Number(m.pricing.prompt) * 1e6, out: Number(m.pricing.completion) * 1e6 } : null;
  } catch {
    return null;
  }
}

const args = parseArgs(process.argv.slice(2));
const isCloud = definesKey("or_unified_bench.py", args.key);
const isLocal = definesKey("llamacpp_eval.py", args.key);
if (isCloud === isLocal) {
  console.error(`key "${args.key}" must be defined in exactly one of or_unified_bench.py / llamacpp_eval.py (cloud=${isCloud}, local=${isLocal})`);
  process.exit(1);
}
if (!args.skipThreat && !readFileSync(join(HERE, "threat_model_bench.ts"), "utf-8").includes(`key: "${args.key}"`)) {
  console.error(`key "${args.key}" has no threat_model_bench.ts ROSTER slot — add one or pass --skip-threat`);
  process.exit(1);
}
mkdirSync(args.outDir, { recursive: true });
const started = Date.now();

let unified: Unified = { total: null, max: null, t: null, r: null, c: null, json: "" };
if (!args.skipUnified) {
  if (isCloud) {
    run(["python3", "or_unified_bench.py", "--model", args.key, "--out-dir", args.outDir]);
    unified = readUnifiedCloud(args.outDir, args.key);
  } else {
    run(
      ["python3", "llamacpp_eval.py", "--target", args.key, "--battery", "all", "--out-dir", args.outDir, ...args.sampler],
      { LLAMACPP_BASE_URL: `${UBULLM_URL}/chat/completions` },
    );
    unified = readUnifiedLocal(args.outDir, args.key);
  }
}

const threats: Threat[] = [];
if (!args.skipThreat) {
  for (let n = 1; n <= args.threatRuns; n++) {
    console.log(`\n--- threat run ${n}/${args.threatRuns}`);
    const threatStart = Date.now();
    run(["bun", "threat_model_bench.ts", "--slot", args.key], isLocal ? { UBULLM_URL } : {});
    threats.push(readThreat(args.key, threatStart));
  }
}
const round2 = (x: number) => Math.round(x * 100) / 100;
// A grade of 0 or a missing result is a harness failure (starved, parse error), not a score.
const graded = threats.map((t) => t.total).filter((x): x is number => x !== null && x > 0);
const threatMean = graded.length ? round2(graded.reduce((s, x) => s + x, 0) / graded.length) : null;
const threatMin = graded.length ? Math.min(...graded) : null;
const threatCost = threats.some((t) => t.cost !== null) ? Math.round(threats.reduce((s, t) => s + (t.cost ?? 0), 0) * 1000) / 1000 : null;

const price = isCloud ? await livePrice(args.key) : null;
const row = {
  timestamp: new Date().toISOString(),
  key: args.key,
  kind: isCloud ? "cloud" : "local",
  model_id: price?.id ?? null,
  price_in_per_mtok: price?.in ?? null,
  price_out_per_mtok: price?.out ?? null,
  sampler: args.sampler.length ? args.sampler.join(" ") : null,
  unified_total: unified.total,
  unified_max: unified.max,
  t: unified.t,
  r: unified.r,
  c: unified.c,
  threat_total: threatMean,
  threat_mean: threatMean,
  threat_min: threatMin,
  threat_runs: threats.map((t) => t.total),
  threat_failed_runs: threats.length - graded.length,
  threat_cost_usd: threatCost,
  wall_s: Math.round((Date.now() - started) / 1000),
  unified_json: unified.json || null,
  threat_json: threats.find((t) => t.json)?.json ?? null,
  threat_jsons: threats.map((t) => t.json),
};
appendFileSync(SCOREBOARD, JSON.stringify(row) + "\n");
// Keep the one generated score table current. A missing doc (fresh install) is fine; a failed render is not silent.
try {
  if (existsSync(SCOREBOARD_DOC)) {
    if (writeDoc(SCOREBOARD_DOC)) console.log(`scoreboard table refreshed → ${SCOREBOARD_DOC}`);
    else console.error(`scoreboard table NOT refreshed: no generated-block markers in ${SCOREBOARD_DOC}`);
  }
} catch (e) {
  console.error(`scoreboard table NOT refreshed: ${(e as Error).message}`);
}
console.log(`\n=== ${args.key}: unified ${row.unified_total ?? "—"}/${row.unified_max ?? 53}  threat ${row.threat_mean ?? "—"}/10 (min ${row.threat_min ?? "—"}, runs [${row.threat_runs.join(", ")}])  → ${SCOREBOARD}`);
process.exit(row.unified_total === null && !args.skipUnified || row.threat_total === null && !args.skipThreat ? 2 : 0);
