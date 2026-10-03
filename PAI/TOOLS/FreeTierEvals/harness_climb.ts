#!/usr/bin/env bun
/**
 * harness_climb — tune how a local model is asked, not which model answers (ISA 20260929-212331, F3).
 *
 * One climb, on one use case and one local model:
 *   1. Every variant runs on the TRAIN cases × reps. One line per variant goes to climb-log.jsonl.
 *      Only train case ids ever appear in that log.
 *   2. The best non-control variant by train pass rate goes to HELD-OUT, together with the control.
 *      Those rows go to heldout-log.jsonl, a separate file.
 *   3. acceptVariantPaired() decides (since climb 03): the paired per-case bootstrap 95% lower bound
 *      must be above PAIRED_RULE.threshold. Whether it also clears ISC-14's +0.10 is logged.
 *      Climbs 01–02 used the max−min rule (acceptVariant); their verdicts stand.
 *      A winner is written to proposals.jsonl. Nothing here edits routing config, and the run
 *      fails loudly if PAI_CONFIG.yaml or inference-routing.yaml changed while it ran.
 *
 * Grading reuses workload_bench's scorers and judge (Claude Haiku). The judge must come from a
 * different lineage than the contestant (judgeIsIndependent), or the run refuses to start.
 * Before each batch it waits for idle slots, so a climb never queues ahead of live traffic.
 *
 * Usage:
 *   bun harness_climb.ts --make-splits                         # writes/refreshes the split file
 *   bun harness_climb.ts --use-case knowledge-note-synthesis --model kat --variants v.json \
 *       --out <dir> [--reps 3] [--concurrency 4] [--reference qwen3next]
 *   bun harness_climb.ts --confirm <variant-id> --use-case <held-out-only set> --model kat --variants v.json \
 *       --reference qwen3next --out <dir>
 *   --confirm is the one look at a confirmation set: KAT default, the named variant, and the reference
 *   default on every case, paired rule both ways. It refuses to run twice on the same set.
 *   --reference also runs that model's default harness on held-out and applies the paired rule to
 *   candidate vs reference (the euphoric-surprise question: does tuned local beat the bigger model?).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { join } from "path";
import { spawnSync } from "child_process";
import { loadUseCases, grade, type Case, type UseCase } from "./workload_bench";
import { localInferenceOrigin } from "./local_host";
import {
  DEFAULT_VARIANT, PAIRED_RULE, acceptVariantPaired, buildRequestBody, judgeIsIndependent, validateVariant, variantHash,
  waitForIdleSlots, type HarnessVariant,
} from "./harness_variant";

const PAI_DIR = process.env.PAI_DIR ?? join(process.env.HOME ?? "", ".claude", "PAI");
const SPLITS_PATH = join(PAI_DIR, "USER", "Evals", "WorkloadBench", "splits.json");
const JUDGE = "claude-haiku";
const GUARDED_CONFIG = ["PAI/USER/Config/PAI_CONFIG.yaml", "PAI/USER/Config/inference-routing.yaml"];

const MODELS: Record<string, { alias: string; port: string }> = {
  kat: { alias: "kat_coder_v25_apex", port: "11436" },
  qwen3next: { alias: "qwen3_next_80b_a3b", port: "11434" },
};

type Split = Record<string, { train: string[]; heldout: string[] }>;

/** Deterministic half split per use case: order cases by sha256(use_case:id), first half is train.
 * Append-only against `existing`: a case keeps the side it was already on, and only new cases are
 * split. Reshuffling would move cases a climb tuned on into held-out and leak the tuning (ISC-10). */
export function makeSplits(useCases: { name: string; cases: { id: string }[] }[], existing: Split = {}): Split {
  const out: Split = {};
  const h = (uc: string, id: string) => createHash("sha256").update(`${uc}:${id}`).digest("hex");
  for (const uc of useCases) {
    const prev = existing[uc.name] ?? { train: [], heldout: [] };
    const known = new Set([...prev.train, ...prev.heldout]);
    const ids = new Set(uc.cases.map((c) => c.id));
    const fresh = [...ids].filter((id) => !known.has(id)).sort((a, b) => h(uc.name, a).localeCompare(h(uc.name, b)));
    // A confirmation set (name ends in -confirm) is held-out only: nothing in it is ever tuned on.
    const k = uc.name.endsWith("-confirm") ? 0 : Math.ceil(fresh.length / 2);
    out[uc.name] = {
      train: [...prev.train.filter((id) => ids.has(id)), ...fresh.slice(0, k)].sort(),
      heldout: [...prev.heldout.filter((id) => ids.has(id)), ...fresh.slice(k)].sort(),
    };
  }
  return out;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}

interface Gen { text: string; error?: string; outTok: number; ms: number; reasoningChars: number }

async function generate(url: string, v: HarnessVariant, alias: string, uc: UseCase, c: Case): Promise<Gen> {
  const t0 = Date.now();
  const caseMax = Math.min(uc.config.max_output_tokens ?? 4096, 8192);
  try {
    const res = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildRequestBody(v, alias, uc.system, c.input, caseMax)),
      signal: AbortSignal.timeout(600_000),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) return { text: "", error: `HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`, outTok: 0, ms: Date.now() - t0, reasoningChars: 0 };
    const msg = body.choices?.[0]?.message ?? {};
    const text = msg.content ?? "";
    const finish = body.choices?.[0]?.finish_reason;
    // P8: a truncated or empty answer is a failure, never retried locally.
    const error = !text ? "empty content" : finish === "length" ? "truncated (length)" : undefined;
    return { text, error, outTok: body.usage?.completion_tokens ?? 0, ms: Date.now() - t0, reasoningChars: (msg.reasoning_content ?? "").length };
  } catch (e: any) {
    return { text: "", error: String(e?.message ?? e), outTok: 0, ms: Date.now() - t0, reasoningChars: 0 };
  }
}

/** Runs one variant over the given cases × reps. Returns per-rep pass rates plus the raw rows. */
export async function evaluate(opts: {
  v: HarnessVariant; uc: UseCase; cases: Case[]; reps: number; alias: string; port: string; concurrency: number; split: string; logPath: string; runId: string;
}): Promise<{ repRates: number[]; byCase: Record<string, number[]>; meanOutTok: number; p50ms: number }> {
  const { v, uc, cases, reps, alias, port, concurrency, split, logPath, runId } = opts;
  const url = `${localInferenceOrigin(port)}/v1/chat/completions`;
  await waitForIdleSlots(async () => (await (await fetch(`${localInferenceOrigin(port)}/slots`)).json()) as { is_processing: boolean }[],
    { pollMs: 5_000, maxWaitMs: 15 * 60_000 }).catch((e) => { throw new Error(`${port}: ${e.message}`); });
  const jobs = cases.flatMap((c) => Array.from({ length: reps }, (_, r) => ({ c, rep: r + 1 })));
  const passByRep: Record<number, boolean[]> = {};
  const byCase: Record<string, number[]> = {};
  const outToks: number[] = [], mss: number[] = [];
  await pool(jobs, concurrency, async ({ c, rep }) => {
    const g = await generate(url, v, alias, uc, c);
    const { rubric, g: verdict, judgeErr } = await grade(uc, c, g.text, g.error, false);
    (passByRep[rep] ??= []).push(verdict.pass);
    (byCase[c.id] ??= []).push(verdict.pass ? 1 : 0);
    outToks.push(g.outTok); mss.push(g.ms);
    appendFileSync(logPath, JSON.stringify({
      ts: new Date().toISOString(), run_id: runId, split, use_case: uc.name, model: alias, judge: JUDGE,
      variant_id: v.id, variant_hash: variantHash(v), proposer: v.proposer, case_id: c.id, rep,
      pass: verdict.pass, composite: +verdict.composite.toFixed(3), rubric, out_tokens: g.outTok, reasoning_chars: g.reasoningChars,
      ms: g.ms, error: g.error, judge_error: judgeErr, output_head: g.text.slice(0, 120),
    }) + "\n");
  });
  const repRates = Object.keys(passByRep).map(Number).sort((a, b) => a - b).map((r) => passByRep[r].filter(Boolean).length / passByRep[r].length);
  const sorted = [...mss].sort((a, b) => a - b);
  return { repRates, byCase, meanOutTok: Math.round(outToks.reduce((a, b) => a + b, 0) / Math.max(1, outToks.length)), p50ms: sorted[Math.floor((sorted.length - 1) / 2)] ?? 0 };
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

function configSnapshot(): string {
  const r = spawnSync("git", ["-C", join(PAI_DIR, ".."), "hash-object", ...GUARDED_CONFIG], { encoding: "utf-8", stdio: "pipe" });
  if (r.status !== 0) throw new Error(`git hash-object failed: ${r.stderr}`);
  return r.stdout.trim();
}

async function main() {
  if (process.argv.includes("--make-splits")) {
    const splits = makeSplits(loadUseCases(null, null), existsSync(SPLITS_PATH) ? JSON.parse(readFileSync(SPLITS_PATH, "utf-8")) : {});
    writeFileSync(SPLITS_PATH, JSON.stringify(splits, null, 2) + "\n");
    console.log(`Wrote ${SPLITS_PATH}: ${Object.entries(splits).map(([k, s]) => `${k} ${s.train.length}/${s.heldout.length}`).join(", ")}`);
    return;
  }

  const ucName = arg("--use-case"), modelKey = arg("--model"), variantsPath = arg("--variants"), outDir = arg("--out");
  if (!ucName || !modelKey || !variantsPath || !outDir || !MODELS[modelKey]) {
    console.error("Usage: bun harness_climb.ts --use-case <name> --model kat|qwen3next --variants <file> --out <dir> [--reps 3] [--concurrency 4]");
    process.exit(2);
  }
  const reps = Number(arg("--reps") ?? 3), concurrency = Number(arg("--concurrency") ?? 4);
  const refKey = arg("--reference");
  if (refKey && !MODELS[refKey]) throw new Error(`unknown --reference ${refKey}`);
  const { alias, port } = MODELS[modelKey];
  if (!judgeIsIndependent(JUDGE, alias)) throw new Error(`judge ${JUDGE} shares a lineage with ${alias}; refusing to run (ISC-19)`);
  if (!existsSync(SPLITS_PATH)) throw new Error(`no split file at ${SPLITS_PATH}; run --make-splits and commit it first`);
  const split = (JSON.parse(readFileSync(SPLITS_PATH, "utf-8")) as Split)[ucName];
  if (!split) throw new Error(`${ucName} has no split in ${SPLITS_PATH}`);

  const proposed = JSON.parse(readFileSync(variantsPath, "utf-8")) as HarnessVariant[];
  const variants = [DEFAULT_VARIANT, ...proposed.filter((v) => v.id !== DEFAULT_VARIANT.id)];
  for (const v of variants) {
    const errs = validateVariant(v);
    if (errs.length) throw new Error(`variant ${v.id}: ${errs.join("; ")}`);
    if (v.few_shot_k > 0 || v.self_consistency_n > 1 || v.decompose || v.context_compression !== "none")
      throw new Error(`variant ${v.id} uses a field this runner doesn't execute yet (few_shot_k, self_consistency_n, decompose, context_compression)`);
  }

  const [uc] = loadUseCases([ucName], null);
  const confirmId = arg("--confirm");
  if (confirmId) { await confirm({ uc, split, confirmId, variants, alias, port, reps, concurrency, outDir, refKey }); return; }
  if (split.train.length === 0) throw new Error(`${ucName} has no train cases: it is a confirmation set; use --confirm`);
  const byId = new Map(uc.cases.map((c) => [c.id, c]));
  const train = split.train.map((id) => byId.get(id)!), heldout = split.heldout.map((id) => byId.get(id)!);
  mkdirSync(outDir, { recursive: true });
  const runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const climbLog = join(outDir, "climb-log.jsonl"), heldoutLog = join(outDir, "heldout-log.jsonl"), summaryLog = join(outDir, "climb-summary.jsonl");
  const cfgBefore = configSnapshot();
  console.log(`Climb ${runId}: ${ucName} on ${alias}, ${variants.length} variants × ${train.length} train cases × ${reps} reps (judge ${JUDGE})`);

  // 1. Train.
  const trainResults: { v: HarnessVariant; repRates: number[]; byCase: Record<string, number[]>; meanOutTok: number; p50ms: number }[] = [];
  for (const v of variants) {
    const r = await evaluate({ v, uc, cases: train, reps, alias, port, concurrency, split: "train", logPath: climbLog, runId });
    trainResults.push({ v, ...r });
    const line = { ts: new Date().toISOString(), run_id: runId, split: "train", use_case: ucName, model: alias, judge: JUDGE,
      variant_id: v.id, variant_hash: variantHash(v), proposer: v.proposer, rep_rates: r.repRates, mean: +mean(r.repRates).toFixed(3),
      mean_out_tokens: r.meanOutTok, p50_ms: r.p50ms };
    appendFileSync(summaryLog, JSON.stringify(line) + "\n");
    console.log(`  train ${v.id.padEnd(28)} mean ${line.mean.toFixed(2)} reps [${r.repRates.map((x) => x.toFixed(2)).join(" ")}]  out ~${r.meanOutTok} tok  p50 ${r.p50ms} ms`);
  }

  // 2. Held-out: control vs the best challenger on train (ties → fewer output tokens).
  const challengers = trainResults.filter((t) => t.v.id !== DEFAULT_VARIANT.id)
    .sort((a, b) => mean(b.repRates) - mean(a.repRates) || a.meanOutTok - b.meanOutTok);
  const best = challengers[0];
  const control = await evaluate({ v: DEFAULT_VARIANT, uc, cases: heldout, reps, alias, port, concurrency, split: "heldout", logPath: heldoutLog, runId });
  const cand = await evaluate({ v: best.v, uc, cases: heldout, reps, alias, port, concurrency, split: "heldout", logPath: heldoutLog, runId });
  const verdict = acceptVariantPaired(control.byCase, cand.byCase);
  const isc14 = acceptVariantPaired(control.byCase, cand.byCase, { ...PAIRED_RULE, threshold: PAIRED_RULE.isc14Threshold });
  const result = { ts: new Date().toISOString(), run_id: runId, split: "heldout", use_case: ucName, model: alias, judge: JUDGE,
    control: { rep_rates: control.repRates, mean_out_tokens: control.meanOutTok, p50_ms: control.p50ms },
    candidate: { variant_id: best.v.id, variant_hash: variantHash(best.v), proposer: best.v.proposer, rep_rates: cand.repRates, mean_out_tokens: cand.meanOutTok, p50_ms: cand.p50ms },
    rule: "paired-bootstrap", rule_params: PAIRED_RULE, ...verdict, clears_isc14: isc14.accept };
  appendFileSync(summaryLog, JSON.stringify(result) + "\n");
  console.log(`  held-out control  [${control.repRates.map((x) => x.toFixed(2)).join(" ")}]  ~${control.meanOutTok} tok  p50 ${control.p50ms} ms`);
  console.log(`  held-out ${best.v.id} [${cand.repRates.map((x) => x.toFixed(2)).join(" ")}]  ~${cand.meanOutTok} tok  p50 ${cand.p50ms} ms`);
  console.log(`  ${verdict.accept ? "ACCEPT" : "reject"}: ${verdict.reason}${isc14.accept ? "; also clears ISC-14 (+0.10)" : ""}`);
  if (verdict.accept) appendFileSync(join(outDir, "proposals.jsonl"), JSON.stringify({ ...result, variant: best.v }) + "\n");

  if (refKey) {
    const ref = MODELS[refKey];
    if (!judgeIsIndependent(JUDGE, ref.alias)) throw new Error(`judge shares a lineage with reference ${ref.alias}`);
    const r = await evaluate({ v: DEFAULT_VARIANT, uc, cases: heldout, reps, alias: ref.alias, port: ref.port, concurrency: 1, split: "heldout", logPath: heldoutLog, runId });
    const vsRef = acceptVariantPaired(r.byCase, cand.byCase);
    appendFileSync(summaryLog, JSON.stringify({ ts: new Date().toISOString(), run_id: runId, split: "heldout", use_case: ucName, judge: JUDGE,
      comparison: `${best.v.id}@${alias} vs default@${ref.alias}`, reference: { model: ref.alias, rep_rates: r.repRates, mean_out_tokens: r.meanOutTok, p50_ms: r.p50ms },
      rule: "paired-bootstrap", rule_params: PAIRED_RULE, ...vsRef }) + "\n");
    console.log(`  held-out reference ${ref.alias} [${r.repRates.map((x) => x.toFixed(2)).join(" ")}]  ~${r.meanOutTok} tok  p50 ${r.p50ms} ms`);
    console.log(`  vs reference: ${vsRef.accept ? "BEATS" : "does not beat"} ${ref.alias}: ${vsRef.reason}`);
  }

  // 3. Anti-check: routing config untouched (ISC-18).
  if (configSnapshot() !== cfgBefore) { console.error(`ROUTING CONFIG CHANGED during the climb: ${GUARDED_CONFIG.join(", ")}`); process.exit(3); }
}

/** One look at a held-out-only confirmation set (see header). */
async function confirm(o: { uc: UseCase; split: { train: string[]; heldout: string[] }; confirmId: string; variants: HarnessVariant[]; alias: string; port: string;
  reps: number; concurrency: number; outDir: string; refKey?: string }) {
  const { uc, split, confirmId, variants, alias, port, reps, concurrency, outDir, refKey } = o;
  if (split.train.length) throw new Error(`${uc.name} has train cases; --confirm is only for held-out-only sets`);
  if (!refKey) throw new Error("--confirm needs --reference");
  const v = variants.find((x) => x.id === confirmId);
  if (!v) throw new Error(`variant ${confirmId} not in --variants`);
  mkdirSync(outDir, { recursive: true });
  const summary = join(outDir, "confirm-summary.jsonl");
  if (existsSync(summary) && readFileSync(summary, "utf-8").includes(`"use_case":"${uc.name}"`))
    throw new Error(`${uc.name} was already confirmed in ${summary}; a confirmation set gets one look`);
  const ref = MODELS[refKey];
  if (!judgeIsIndependent(JUDGE, ref.alias)) throw new Error(`judge shares a lineage with ${ref.alias}`);
  const cases = split.heldout.map((id) => uc.cases.find((c) => c.id === id)!);
  const runId = "confirm-" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const log = join(outDir, "confirm-log.jsonl");
  console.log(`Confirm ${runId}: ${v.id} on ${uc.name} (${cases.length} cases × ${reps} reps) vs KAT default and ${ref.alias} default`);
  const base = await evaluate({ v: DEFAULT_VARIANT, uc, cases, reps, alias, port, concurrency, split: "confirm", logPath: log, runId });
  const cand = await evaluate({ v, uc, cases, reps, alias, port, concurrency, split: "confirm", logPath: log, runId });
  const refR = await evaluate({ v: DEFAULT_VARIANT, uc, cases, reps, alias: ref.alias, port: ref.port, concurrency: 1, split: "confirm", logPath: log, runId });
  const vsBase = acceptVariantPaired(base.byCase, cand.byCase);
  const vsBaseIsc14 = acceptVariantPaired(base.byCase, cand.byCase, { ...PAIRED_RULE, threshold: PAIRED_RULE.isc14Threshold });
  const vsRef = acceptVariantPaired(refR.byCase, cand.byCase);
  const fmt = (r: { repRates: number[]; meanOutTok: number; p50ms: number }) => `[${r.repRates.map((x) => x.toFixed(2)).join(" ")}] ~${r.meanOutTok} tok p50 ${r.p50ms} ms`;
  console.log(`  KAT default     ${fmt(base)}`);
  console.log(`  ${v.id} ${fmt(cand)}`);
  console.log(`  ${ref.alias} default ${fmt(refR)}`);
  console.log(`  vs KAT default: ${vsBase.accept ? "CONFIRMED" : "not confirmed"}: ${vsBase.reason}; ISC-14 (+0.10): ${vsBaseIsc14.accept ? "CLEARS" : "does not clear"}`);
  console.log(`  vs ${ref.alias}: ${vsRef.accept ? "BEATS" : "does not beat"}: ${vsRef.reason}`);
  appendFileSync(summary, JSON.stringify({ ts: new Date().toISOString(), run_id: runId, use_case: uc.name, judge: JUDGE, variant_id: v.id, variant_hash: variantHash(v),
    rule: "paired-bootstrap", rule_params: PAIRED_RULE,
    kat_default: { rep_rates: base.repRates, mean_out_tokens: base.meanOutTok, p50_ms: base.p50ms },
    candidate: { rep_rates: cand.repRates, mean_out_tokens: cand.meanOutTok, p50_ms: cand.p50ms },
    reference: { model: ref.alias, rep_rates: refR.repRates, mean_out_tokens: refR.meanOutTok, p50_ms: refR.p50ms },
    vs_kat_default: vsBase, clears_isc14: vsBaseIsc14.accept, vs_reference: vsRef }) + "\n");
}

if (import.meta.main) main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(2); });
