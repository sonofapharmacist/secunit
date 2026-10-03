/**
 * Harness variants for local models: a variant is data, not code (ISA 20260929-212331, F3).
 *
 * A variant changes how a job is asked, never which model answers. The climber proposes variants,
 * scores them on train cases, and only a held-out gain larger than rep-to-rep noise gets accepted
 * (acceptVariant). Winners go to a proposals file; nothing here touches routing config.
 *
 * `thinking: "off"` sends chat_template_kwargs.enable_thinking=false. KAT (a Qwen3.6 hybrid) thinks by
 * default: 133 completion tokens and a fenced answer vs 8 tokens and a bare one with it off (2026-09-30).
 * A GBNF grammar on a thinking model constrains the reasoning, not the answer, so pair grammar with off.
 *
 * Fields map to patterns.md: sampler (P9), grammar (P12), max_tokens (P8), context_compression (P3),
 * decompose (P1), few_shot_k (P15). self_consistency_n, few_shot_k and decompose are executed by the
 * runner (they need the case pool or several calls); buildRequestBody covers the single-call fields.
 */
import { createHash } from "crypto";

export type Proposer = "default" | "cloud" | "local";

export interface Sampler {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  repeat_penalty?: number;
}

export interface HarnessVariant {
  id: string;
  parent?: string;
  proposer: Proposer;
  template: { system_prefix?: string; system_suffix?: string; user_suffix?: string };
  sampler: "server-default" | Sampler;
  thinking: "server-default" | "off";
  grammar: "none" | { json_schema: Record<string, unknown> } | { gbnf: string };
  few_shot_k: number;
  self_consistency_n: number;
  decompose: boolean;
  max_tokens: "case" | number;
  context_compression: "none" | { bm25_top_k: number };
}

/** The frozen control arm (P7): server sampler, case prompt untouched, case output cap. */
export const DEFAULT_VARIANT: HarnessVariant = {
  id: "default",
  proposer: "default",
  template: {},
  sampler: "server-default",
  thinking: "server-default",
  grammar: "none",
  few_shot_k: 0,
  self_consistency_n: 1,
  decompose: false,
  max_tokens: "case",
  context_compression: "none",
};

const SAMPLER_RANGES: Record<keyof Sampler, [number, number]> = {
  temperature: [0, 2],
  top_p: [0, 1],
  top_k: [0, 200],
  min_p: [0, 1],
  repeat_penalty: [0.5, 2],
};

/** Every problem with a variant, as messages. Empty means valid. */
export function validateVariant(v: unknown): string[] {
  const errs: string[] = [];
  if (!v || typeof v !== "object") return ["variant is not an object"];
  const x = v as Record<string, any>;
  if (typeof x.id !== "string" || !x.id) errs.push("id must be a non-empty string");
  if (!["default", "cloud", "local"].includes(x.proposer)) errs.push("proposer must be default | cloud | local");
  if (!x.template || typeof x.template !== "object") errs.push("template must be an object");
  else for (const [k, s] of Object.entries(x.template))
    if (!["system_prefix", "system_suffix", "user_suffix"].includes(k)) errs.push(`template.${k} is not a known field`);
    else if (typeof s !== "string") errs.push(`template.${k} must be a string`);
  if (x.sampler !== "server-default") {
    if (!x.sampler || typeof x.sampler !== "object") errs.push("sampler must be 'server-default' or an object");
    else for (const [k, n] of Object.entries(x.sampler)) {
      const range = SAMPLER_RANGES[k as keyof Sampler];
      if (!range) errs.push(`sampler.${k} is not a known field`);
      else if (typeof n !== "number" || n < range[0] || n > range[1]) errs.push(`sampler.${k} must be a number in [${range[0]}, ${range[1]}]`);
    }
  }
  if (x.thinking !== "server-default" && x.thinking !== "off") errs.push("thinking must be 'server-default' or 'off'");
  const jsonOk = x.grammar && typeof x.grammar.json_schema === "object" && x.grammar.json_schema;
  const gbnfOk = x.grammar && typeof x.grammar.gbnf === "string" && /\broot\s*::=/.test(x.grammar.gbnf);
  if (x.grammar !== "none" && !jsonOk && !gbnfOk)
    errs.push("grammar must be 'none', { json_schema: {...} }, or { gbnf: 'root ::= ...' }");
  if (!Number.isInteger(x.few_shot_k) || x.few_shot_k < 0 || x.few_shot_k > 8) errs.push("few_shot_k must be an integer 0..8");
  if (!Number.isInteger(x.self_consistency_n) || x.self_consistency_n < 1 || x.self_consistency_n > 9 || x.self_consistency_n % 2 === 0)
    errs.push("self_consistency_n must be an odd integer 1..9 (odd, so a majority vote can't tie)");
  if (typeof x.decompose !== "boolean") errs.push("decompose must be a boolean");
  if (x.max_tokens !== "case" && !(Number.isInteger(x.max_tokens) && x.max_tokens >= 16 && x.max_tokens <= 32768))
    errs.push("max_tokens must be 'case' or an integer 16..32768");
  if (x.context_compression !== "none" &&
      !(x.context_compression && Number.isInteger(x.context_compression.bm25_top_k) && x.context_compression.bm25_top_k >= 1))
    errs.push("context_compression must be 'none' or { bm25_top_k: >=1 }");
  return errs;
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object")
    return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canonical((v as any)[k])]));
  return v;
}

/** Content hash of what the variant does. id, parent and proposer are labels, so they're excluded:
 *  two proposers arriving at the same harness get the same hash. */
export function variantHash(v: HarnessVariant): string {
  const { id: _i, parent: _p, proposer: _pr, ...behavior } = v;
  return createHash("sha256").update(JSON.stringify(canonical(behavior))).digest("hex").slice(0, 12);
}

/** llama.cpp /v1/chat/completions body for one call under this variant. */
export function buildRequestBody(v: HarnessVariant, model: string, system: string, user: string, caseMaxTokens: number) {
  const sys = `${v.template.system_prefix ?? ""}${system}${v.template.system_suffix ?? ""}`;
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: "system", content: sys }, { role: "user", content: `${user}${v.template.user_suffix ?? ""}` }],
    max_tokens: v.max_tokens === "case" ? caseMaxTokens : v.max_tokens,
  };
  if (v.sampler !== "server-default") Object.assign(body, v.sampler);
  if (v.thinking === "off") body.chat_template_kwargs = { enable_thinking: false };
  if (v.grammar !== "none" && "json_schema" in v.grammar)
    body.response_format = { type: "json_schema", json_schema: { name: "output", schema: v.grammar.json_schema } };
  else if (v.grammar !== "none") body.grammar = v.grammar.gbnf;
  return body;
}

/** Per-rep pass rates on held-out cases, one number per rep. */
export type RepScores = number[];

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);

/**
 * ISC-13: accept a candidate only if its held-out gain over the control beats the noise.
 * Noise = the larger within-variant spread (max-min across reps) of the two. Both arms need at
 * least 3 reps; with fewer, spread says nothing and the answer is no.
 */
export function acceptVariant(control: RepScores, candidate: RepScores): { accept: boolean; gain: number; noise: number; reason: string } {
  if (control.length < 3 || candidate.length < 3)
    return { accept: false, gain: 0, noise: 0, reason: "fewer than 3 reps in an arm" };
  const gain = mean(candidate) - mean(control);
  const noise = Math.max(spread(control), spread(candidate));
  if (gain <= 0) return { accept: false, gain, noise, reason: "no held-out gain" };
  if (gain <= noise) return { accept: false, gain, noise, reason: `gain ${gain.toFixed(3)} within rep spread ${noise.toFixed(3)}` };
  return { accept: true, gain, noise, reason: `gain ${gain.toFixed(3)} exceeds rep spread ${noise.toFixed(3)}` };
}

/** Pass results per held-out case: one 0/1 entry per rep. */
export type CaseScores = Record<string, number[]>;

/** Pre-registered acceptance thresholds for the paired rule, fixed before climb 03 ran (2026-10-01). */
export const PAIRED_RULE = { threshold: 0, isc14Threshold: 0.1, resamples: 10_000, seed: 20261001, minCases: 5 } as const;

/**
 * ISC-13, current rule since climb 03: a paired per-case bootstrap. Each held-out case contributes
 * one difference (candidate pass rate − control pass rate over its reps); resampling cases gives a
 * 95% interval for the mean gain. Accept when the lower bound is above `threshold`.
 *
 * It replaced acceptVariant's max−min rule, which compared three per-rep aggregates, threw away the
 * case pairing, and rejected two gains (climbs 01–02) whose case-level evidence was strong.
 * The RNG is seeded, so the same data always gives the same verdict.
 */
export function acceptVariantPaired(
  control: CaseScores, candidate: CaseScores,
  opts: { threshold: number; resamples: number; seed: number; minCases: number } = PAIRED_RULE,
): { accept: boolean; gain: number; lower: number; upper: number; cases: number; better: number; worse: number; reason: string } {
  const ids = Object.keys(control).filter((id) => candidate[id]?.length && control[id].length).sort();
  const none = { gain: 0, lower: 0, upper: 0, cases: ids.length, better: 0, worse: 0 };
  if (ids.length < opts.minCases) return { accept: false, ...none, reason: `only ${ids.length} paired cases (need ${opts.minCases})` };
  const diffs = ids.map((id) => mean(candidate[id]) - mean(control[id]));
  let s = opts.seed >>> 0;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const boot: number[] = [];
  for (let b = 0; b < opts.resamples; b++) {
    let t = 0;
    for (let i = 0; i < diffs.length; i++) t += diffs[Math.floor(rnd() * diffs.length)];
    boot.push(t / diffs.length);
  }
  boot.sort((a, b) => a - b);
  const lower = boot[Math.floor(0.025 * opts.resamples)], upper = boot[Math.ceil(0.975 * opts.resamples) - 1];
  const gain = mean(diffs);
  const better = diffs.filter((d) => d > 0).length, worse = diffs.filter((d) => d < 0).length;
  const stats = { gain, lower, upper, cases: ids.length, better, worse };
  const ci = `95% CI [${lower.toFixed(3)}, ${upper.toFixed(3)}] over ${ids.length} cases (${better} better, ${worse} worse)`;
  // Compare at 1e-9: gains move in exact steps (1/(reps·cases)), and float summation turned an
  // exact tie at +0.10 into 0.10000000000000005 and a pass (confirm-01, 2026-10-02). A tie is not above.
  return Math.round(lower * 1e9) / 1e9 > opts.threshold
    ? { accept: true, ...stats, reason: `gain ${gain.toFixed(3)}, ${ci}: lower bound above ${opts.threshold}` }
    : { accept: false, ...stats, reason: `gain ${gain.toFixed(3)}, ${ci}: lower bound not above ${opts.threshold}` };
}

/**
 * ISC-17: batch work yields to live traffic. Before each eval batch, wait until no slot on the
 * server is processing. Throws after maxWaitMs so a stuck server stops the climb instead of
 * queuing behind it forever. getSlots is injected so tests can stub the server.
 */
export async function waitForIdleSlots(
  getSlots: () => Promise<{ is_processing: boolean }[]>,
  opts: { pollMs: number; maxWaitMs: number; sleep?: (ms: number) => Promise<void> },
): Promise<{ waitedMs: number; polls: number }> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let waited = 0, polls = 0;
  for (;;) {
    polls++;
    const slots = await getSlots();
    if (!slots.some((s) => s.is_processing)) return { waitedMs: waited, polls };
    if (waited >= opts.maxWaitMs) throw new Error(`slots still busy after ${waited} ms`);
    await sleep(opts.pollMs);
    waited += opts.pollMs;
  }
}

/** Model lineage for ISC-19: the judge is never the contestant or a model from its family. Lineage is by
 *  base weights, not publisher: KAT-Coder V2.5 is a Qwen3.6-35B-A3B fine-tune (GGUF general.base_model,
 *  arch qwen35moe), so it shares a family with the Qwen3-Next 80B and neither may judge the other. */
export function modelFamily(model: string): string {
  const m = model.toLowerCase();
  if (/claude|haiku|sonnet|opus|fable/.test(m)) return "anthropic";
  if (/qwen|qwq|kat[-_]|kat_coder|jackrong/.test(m)) return "qwen";
  if (/gemini|gemma|flash38|agy/.test(m)) return "google";
  if (/gpt|openai|o[34]-|luna|sol|astra/.test(m)) return "openai";
  if (/deepseek/.test(m)) return "deepseek";
  if (/glm|zai/.test(m)) return "zhipu";
  if (/mistral|devstral|codestral/.test(m)) return "mistral";
  return `unknown:${m}`;
}

export function judgeIsIndependent(judgeModel: string, contestantModel: string): boolean {
  const j = modelFamily(judgeModel), c = modelFamily(contestantModel);
  return !j.startsWith("unknown:") && !c.startsWith("unknown:") && j !== c;
}
