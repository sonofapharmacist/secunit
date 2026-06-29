#!/usr/bin/env bun
/**
 * PAI Unified Test Bench — 9-battery + 17-pt reasoning + coding battery = 53 pts.
 *
 * Wraps the existing Python eval scripts (mistral_eval.py, anthropic_compat_eval.py,
 * anthropic_compat_reasoning_probe.py, coding_battery.py) with:
 *   - Auto fence-stripping for NIM (fixes Nemotron-30B-R 8/34 → expected ~17/17)
 *   - Auto type-filter for thinking models (Magistral, Cohere North, GLM thinking modes)
 *   - Per-model max_tokens + temperature config
 *   - Aggregated JSON output for the unified-bench doc
 *
 * Usage:
 *   bun unified_bench.ts --model m3 --full          # all 53 pts
 *   bun unified_bench.ts --model m3                # T1-T9 + R1-R6 only (26 pts)
 *   bun unified_bench.ts --all --full              # every model, full bench
 *   bun unified_bench.ts --top=10 --full           # top 10 routing candidates
 *
 * Per §6 of unified-bench-2026-06-16.md, expected wall time:
 *   - Lite (26 pts): 1-3 min/model
 *   - Full (53 pts): 7-12 min/model
 *   - Full sweep (52+ models): ~2 hours
 */

import { spawn } from "bun";
import { writeFileSync, appendFileSync, existsSync } from "fs";
import { join } from "path";

// ── Provider config ───────────────────────────────────────────────────────────

type Provider = "anthropic" | "zai" | "minimax" | "mistral" | "nim" | "cohere" | "llamacpp";

interface ModelSpec {
  /** Short CLI key */
  key: string;
  /** Display name */
  name: string;
  /** Model slug (provider-specific) */
  model: string;
  /** Provider adapter */
  provider: Provider;
  /** Anthropic-compat? (Z.ai, MiniMax) */
  anthropicCompat: boolean;
  /** Auto fence-strip on JSON output? */
  fenceStrip: boolean;
  /** Auto type-filter for thinking-model list responses? */
  typeFilter: boolean;
  /** Max tokens for this model */
  maxTokens: number;
  /** Temperature (1.0 for reasoning models) */
  temperature: number;
  /** Passage key for `passage show` (or empty for env var) */
  passageKey: string;
  /** Tier for routing decisions */
  tier: 0 | 1 | 2 | 3 | 4 | 5;
}

const MODELS: ModelSpec[] = [
  // Tier 0 frontier (Anthropic family)
  { key: "sonnet", name: "Claude Sonnet 4.6", model: "claude-sonnet-4-6", provider: "anthropic", anthropicCompat: false, fenceStrip: false, typeFilter: false, maxTokens: 4096, temperature: 0, passageKey: "api/anthropic", tier: 0 },
  { key: "opus", name: "Claude Opus 4.8", model: "claude-opus-4-8", provider: "anthropic", anthropicCompat: false, fenceStrip: false, typeFilter: false, maxTokens: 4096, temperature: 0, passageKey: "api/anthropic", tier: 0 },
  { key: "m3", name: "MiniMax M3 (512K)", model: "MiniMax-M3", provider: "minimax", anthropicCompat: true, fenceStrip: true, typeFilter: false, maxTokens: 4096, temperature: 0, passageKey: "api/minimax", tier: 0 },
  { key: "glm52-1m", name: "Z.ai GLM-5.2 (1M ctx, 3x quota — emergency-only)", model: "glm-5.2", provider: "zai", anthropicCompat: true, fenceStrip: true, typeFilter: true, maxTokens: 8192, temperature: 1, passageKey: "api/glm", tier: 0 },
  { key: "glm51", name: "Z.ai GLM-5.1 (top of Z.ai catalog)", model: "glm-5.1", provider: "zai", anthropicCompat: true, fenceStrip: true, typeFilter: true, maxTokens: 4096, temperature: 0, passageKey: "api/glm", tier: 0 },
  { key: "glm47", name: "Z.ai GLM-4.7 (Sonnet slot)", model: "glm-4.7", provider: "zai", anthropicCompat: true, fenceStrip: true, typeFilter: true, maxTokens: 4096, temperature: 0, passageKey: "api/glm", tier: 0 },
  { key: "glm45air", name: "Z.ai GLM-4.5-air (Haiku slot)", model: "glm-4.5-air", provider: "zai", anthropicCompat: true, fenceStrip: true, typeFilter: true, maxTokens: 4096, temperature: 0, passageKey: "api/glm", tier: 0 },
  // Tier 1 cloud workhorses
  { key: "small4", name: "Mistral Small 4", model: "mistral-small-latest", provider: "mistral", anthropicCompat: false, fenceStrip: true, typeFilter: false, maxTokens: 4096, temperature: 0, passageKey: "api/mistral", tier: 1 },
  { key: "codestral", name: "Mistral Codestral (Tier 4 STRIDE)", model: "codestral-latest", provider: "mistral", anthropicCompat: false, fenceStrip: true, typeFilter: false, maxTokens: 4096, temperature: 0, passageKey: "api/mistral", tier: 4 },
  { key: "medium35", name: "Mistral Medium 3.5 (SOTA)", model: "mistral-medium-latest", provider: "mistral", anthropicCompat: false, fenceStrip: true, typeFilter: false, maxTokens: 4096, temperature: 0, passageKey: "api/mistral", tier: 1 },
  { key: "magistralS", name: "Mistral Magistral S (reasoning)", model: "magistral-small-latest", provider: "mistral", anthropicCompat: false, fenceStrip: true, typeFilter: true, maxTokens: 4096, temperature: 0, passageKey: "api/mistral", tier: 4 },
  { key: "devstralMed", name: "Mistral Devstral Med (coding leader)", model: "devstral-medium-latest", provider: "mistral", anthropicCompat: false, fenceStrip: true, typeFilter: false, maxTokens: 4096, temperature: 0, passageKey: "api/mistral", tier: 4 },
  { key: "devstralSmall2", name: "Mistral Devstral Small 2 (devstral-latest)", model: "devstral-latest", provider: "mistral", anthropicCompat: false, fenceStrip: true, typeFilter: false, maxTokens: 4096, temperature: 0, passageKey: "api/mistral", tier: 4 },
  { key: "ministral8b", name: "Mistral Ministral 8B (edge tier)", model: "ministral-8b-latest", provider: "mistral", anthropicCompat: false, fenceStrip: true, typeFilter: false, maxTokens: 4096, temperature: 0, passageKey: "api/mistral", tier: 1 },
  { key: "ministral14b", name: "Mistral Ministral 14B (edge tier)", model: "ministral-14b-latest", provider: "mistral", anthropicCompat: false, fenceStrip: true, typeFilter: false, maxTokens: 4096, temperature: 0, passageKey: "api/mistral", tier: 1 },
  // Tier 1 NIM
  { key: "gptOss120b", name: "OpenAI GPT-OSS-120B (NIM reasoning)", model: "openai/gpt-oss-120b", provider: "nim", anthropicCompat: false, fenceStrip: true, typeFilter: true, maxTokens: 8192, temperature: 1, passageKey: "api/nvidia", tier: 1 },
  { key: "deepseekV4", name: "DeepSeek-V4-Flash (NIM, endpoint may be dead)", model: "deepseek-ai/deepseek-v4-flash", provider: "nim", anthropicCompat: false, fenceStrip: true, typeFilter: true, maxTokens: 4096, temperature: 0, passageKey: "api/nvidia", tier: 1 },
  { key: "llama4Maverick", name: "Llama-4-Maverick-17B-128E (NIM)", model: "meta/llama-4-maverick-17b-128e-instruct", provider: "nim", anthropicCompat: false, fenceStrip: true, typeFilter: true, maxTokens: 4096, temperature: 0, passageKey: "api/nvidia", tier: 1 },
  { key: "nemotronSuper", name: "Nemotron-3-Super-120B-A12B (NIM)", model: "nvidia/nemotron-3-super-120b-a12b", provider: "nim", anthropicCompat: false, fenceStrip: true, typeFilter: true, maxTokens: 4096, temperature: 0, passageKey: "api/nvidia", tier: 1 },
  { key: "nemotron30bR", name: "Nemotron-3-Nano-Omni-30B-A3B-R (NIM reasoning)", model: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning", provider: "nim", anthropicCompat: false, fenceStrip: true, typeFilter: true, maxTokens: 8192, temperature: 1, passageKey: "api/nvidia", tier: 1 },
  { key: "qwen35-122b", name: "Qwen3.5-122B-A10B (NIM)", model: "qwen/qwen3.5-122b-a10b", provider: "nim", anthropicCompat: false, fenceStrip: true, typeFilter: true, maxTokens: 4096, temperature: 0, passageKey: "api/nvidia", tier: 1 },
  { key: "kimiK26", name: "Kimi-K2.6 (NIM MoE, Anvil-only)", model: "moonshotai/kimi-k2.6", provider: "nim", anthropicCompat: false, fenceStrip: true, typeFilter: true, maxTokens: 4096, temperature: 1, passageKey: "api/nvidia", tier: 4 },
  { key: "step37Flash", name: "Step-3.7-Flash (NIM reasoning, needs 8K tokens)", model: "stepfun-ai/step-3.7-flash", provider: "nim", anthropicCompat: false, fenceStrip: true, typeFilter: true, maxTokens: 8192, temperature: 1, passageKey: "api/nvidia", tier: 4 },
  // Tier 4 Cohere
  { key: "northMiniCode", name: "Cohere North Mini Code 1.0 (Apache 2, thinking)", model: "north-mini-code", provider: "cohere", anthropicCompat: false, fenceStrip: true, typeFilter: true, maxTokens: 16000, temperature: 0, passageKey: "api/cohere", tier: 4 },
  // Local llama-server roster (your-inference-host, V100 32GB HBM2, OpenAI-compat :11434, no auth)
  // Keys here MUST match the MODELS dict in llamacpp_eval.py. Run order per ISA Decision 2026-06-23 14:31.
  { key: "gptOss20b", name: "OpenAI GPT-OSS-20B (your-inference-host MXFP4)", model: "gpt-oss-20b", provider: "llamacpp", anthropicCompat: false, fenceStrip: true, typeFilter: true, maxTokens: 8192, temperature: 0, passageKey: "", tier: 1 },
  { key: "qwen36_27b", name: "Qwen3.6-27B (your-inference-host, MTP)", model: "qwen36:27b", provider: "llamacpp", anthropicCompat: false, fenceStrip: true, typeFilter: true, maxTokens: 8192, temperature: 0, passageKey: "", tier: 1 },
  { key: "gemma4_26b_a4b", name: "gemma-4-26B-A4B (your-inference-host, experts-llama.cpp)", model: "gemma4-26b-a4b", provider: "llamacpp", anthropicCompat: false, fenceStrip: true, typeFilter: false, maxTokens: 4096, temperature: 0, passageKey: "", tier: 2 },
  { key: "qwen36_35b_a3b", name: "Qwen3.6-35B-A3B (your-inference-host production, gated on -c 16384 fix)", model: "qwen36:35b-a3b", provider: "llamacpp", anthropicCompat: false, fenceStrip: true, typeFilter: true, maxTokens: 8192, temperature: 0, passageKey: "", tier: 2 },
  // Optional — only if wall budget allows (ISC-23/24)
  { key: "gemma4_31b", name: "gemma-4-31B (your-inference-host mainline)", model: "gemma4-31b", provider: "llamacpp", anthropicCompat: false, fenceStrip: true, typeFilter: false, maxTokens: 4096, temperature: 0, passageKey: "", tier: 3 },
  { key: "qwen35_9b_deepseek_v4_flash", name: "qwen3.5-9b-DeepSeek-V4-Flash (your-inference-host)", model: "qwen35-9b-v4-flash", provider: "llamacpp", anthropicCompat: false, fenceStrip: true, typeFilter: false, maxTokens: 4096, temperature: 0, passageKey: "", tier: 4 },
  // Added 2026-06-23 — rerun of Tier 2/3 local models never put through the 53-pt unified suite.
  { key: "qwen3_30b_a3b", name: "Qwen3-30B-A3B-Instruct-2507 (your-inference-host, IQ4_XS)", model: "qwen3:30b-a3b", provider: "llamacpp", anthropicCompat: false, fenceStrip: true, typeFilter: false, maxTokens: 4096, temperature: 0, passageKey: "", tier: 2 },
  { key: "mellum2_12b", name: "Mellum2-12B-A2.5B-Instruct (your-inference-host)", model: "mellum2:12b", provider: "llamacpp", anthropicCompat: false, fenceStrip: true, typeFilter: false, maxTokens: 4096, temperature: 0, passageKey: "", tier: 2 },
  { key: "mellum2_12b_thinking", name: "Mellum2-12B-A2.5B-Thinking (your-inference-host)", model: "mellum2-thinking:12b", provider: "llamacpp", anthropicCompat: false, fenceStrip: true, typeFilter: false, maxTokens: 4096, temperature: 0, passageKey: "", tier: 2 },
  { key: "nemotron3_nano_4b", name: "Nemotron3-Nano-4B (your-inference-host)", model: "nemotron3-nano:4b", provider: "llamacpp", anthropicCompat: false, fenceStrip: true, typeFilter: false, maxTokens: 4096, temperature: 0, passageKey: "", tier: 2 },
  { key: "qwen3_30b_a3b_udq4kxl", name: "Qwen3-30B-A3B-Instruct-2507 (your-inference-host, UD-Q4_K_XL)", model: "qwen3-udq4kxl:30b-a3b", provider: "llamacpp", anthropicCompat: false, fenceStrip: true, typeFilter: false, maxTokens: 4096, temperature: 0, passageKey: "", tier: 2 },
  { key: "lfm2_24b", name: "LFM2-24B (your-inference-host, Ollama blob via llama-server)", model: "lfm2:24b", provider: "llamacpp", anthropicCompat: false, fenceStrip: true, typeFilter: false, maxTokens: 4096, temperature: 0, passageKey: "", tier: 2 },
  // Added 2026-06-26 — QAT (Quantization-Aware Training) run. Does QAT beat post-hoc
  // quantization on the T9/R5/C4 ceilings? Dense 12B, UD-Q4_K_XL (~7-8GB), MTP drafter.
  // Note: Gemma 4 family is thinking-capable; benchmarked WITHOUT forced think mode
  // (is_reasoning False) to match how the Qwen3-30B-A3B production slot is used.
  { key: "gemma4_12b_qat", name: "gemma-4-12B-it-qat (your-inference-host, UD-Q4_K_XL, MTP)", model: "gemma4-12b-qat", provider: "llamacpp", anthropicCompat: false, fenceStrip: true, typeFilter: false, maxTokens: 4096, temperature: 0, passageKey: "", tier: 2 },
  // Added 2026-06-28 — local gap-fill run.
  // nousCoder14b: code-specialized variant on disk since May; tests C-battery ceiling.
  // nemotronNano9bV2: 6.1GB dense, unbenched on 53-pt; tiny and fast.
  // qwen3Coder30bA3b: explicit code-fine-tuned Qwen variant; primary gap from 2026-06-28 gap list.
  { key: "nousCoder14b", name: "NousCoder-14B (your-inference-host, Q4_K_M)", model: "nouscoder:14b", provider: "llamacpp", anthropicCompat: false, fenceStrip: true, typeFilter: false, maxTokens: 4096, temperature: 0, passageKey: "", tier: 2 },
  { key: "nemotronNano9bV2", name: "nemotron-nano-9b-v2 (your-inference-host, Q4_K_M)", model: "nemotron-nano:9b-v2", provider: "llamacpp", anthropicCompat: false, fenceStrip: true, typeFilter: false, maxTokens: 4096, temperature: 0, passageKey: "", tier: 2 },
  { key: "qwen3Coder30bA3b", name: "Qwen3-Coder-30B-A3B-Instruct (your-inference-host, IQ4_XS)", model: "qwen3-coder:30b-a3b", provider: "llamacpp", anthropicCompat: false, fenceStrip: true, typeFilter: false, maxTokens: 4096, temperature: 0, passageKey: "", tier: 2 },
];

// ── Test battery registry ────────────────────────────────────────────────────

const MAX_T9 = 9;
const MAX_R6 = 17;
const MAX_C8 = 27;
const MAX_TOTAL = MAX_T9 + MAX_R6 + MAX_C8; // 53

interface TestResult {
  part: "T" | "R" | "C";
  id: string;
  score: number;
  max: number;
  wall: number;
  err?: string;
}

interface BenchResult {
  model: ModelSpec;
  timestamp: string;
  tests: TestResult[];
  t_score: number;
  r_score: number;
  c_score: number;
  total: number;
  total_max: number;
  wall_total: number;
  status: "complete" | "lite" | "error";
}

// ── Subprocess runner ─────────────────────────────────────────────────────────

const SCRIPT_DIR_ABS = join(import.meta.dir);

async function runPythonScript(script: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = spawn({
    cmd: ["python3", join(SCRIPT_DIR_ABS, script), ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

function resolveScriptForT(model: ModelSpec): string {
  if (model.provider === "llamacpp") return "llamacpp_eval.py";
  if (model.provider === "mistral") return "mistral_eval.py";
  if (model.anthropicCompat) {
    // Use the work-dir copy of anthropic_compat_eval.py
    return "../MEMORY/WORK/2026-06-15-shell-fallback-deeper-tests/anthropic_compat_eval.py";
  }
  if (model.provider === "nim") return "nim_eval.py"; // nim has T1-T9 in its suite
  return "mistral_eval.py"; // fallback
}

function resolveScriptForR(model: ModelSpec): string {
  if (model.provider === "llamacpp") return "llamacpp_eval.py";
  if (model.provider === "nim") return "reasoning_eval.py";
  if (model.anthropicCompat) {
    return "../MEMORY/WORK/2026-06-15-shell-fallback-deeper-tests/anthropic_compat_reasoning_probe.py";
  }
  if (model.provider === "mistral") {
    return "../MEMORY/WORK/2026-06-15-shell-fallback-deeper-tests/mistral_reasoning_probe.py";
  }
  if (model.provider === "cohere") {
    return "../MEMORY/WORK/2026-06-15-shell-fallback-deeper-tests/cohere_reasoning_probe.py";
  }
  return "reasoning_eval.py";
}

function resolveScriptForC(model: ModelSpec): string {
  if (model.provider === "llamacpp") return "llamacpp_eval.py";
  return "../MEMORY/WORK/2026-06-15-shell-fallback-deeper-tests/coding_battery.py";
}

function targetKeyFor(model: ModelSpec): string {
  // Map our key to the python script's --target argument
  const map: Record<string, string> = {
    m3: "m3", glm52: "glm52-1m", glm52_1m: "glm52-1m", glm51: "glm52",
    glm47: "glm47", glm45air: "glm", glm: "glm",
    small4: "small4", codestral: "codestral", medium35: "medium35",
    magistralS: "magistral_s", devstralMed: "devstral_med", devstralSmall2: "devstral_small2",
    ministral8b: "ministral_8b", ministral14b: "ministral_14b",
    northMiniCode: "north_mini_code",
  };
  return map[model.key] ?? model.key;
}

// ── Per-part runners ──────────────────────────────────────────────────────────

async function runT(model: ModelSpec): Promise<TestResult[]> {
  const script = resolveScriptForT(model);
  const target = targetKeyFor(model);
  const args = ["--target", target];
  // llamacpp_eval.py supports per-battery invocation via --battery t|r|c|all
  if (model.provider === "llamacpp") args.push("--battery", "t");
  const r = await runPythonScript(script, args);
  if (r.exitCode !== 0) {
    return [{ part: "T", id: "T1-T9", score: 0, max: MAX_T9, wall: 0, err: r.stderr.slice(0, 200) }];
  }
  // Parse score from output: "SCORE: 9/9  (100%)" or JSON "score": "9/9"
  const scoreMatch = r.stdout.match(/SCORE:\s*(\d+)\/(\d+)/);
  if (scoreMatch) {
    return [{
      part: "T", id: "T1-T9", score: parseInt(scoreMatch[1]), max: parseInt(scoreMatch[2]), wall: 0,
    }];
  }
  // JSON output fallback
  const jsonMatch = r.stdout.match(/"score":\s*"?(\d+)\/(\d+)"?/);
  if (jsonMatch) {
    return [{
      part: "T", id: "T1-T9", score: parseInt(jsonMatch[1]), max: parseInt(jsonMatch[2]), wall: 0,
    }];
  }
  return [{ part: "T", id: "T1-T9", score: 0, max: MAX_T9, wall: 0, err: "could not parse score" }];
}

async function runR(model: ModelSpec): Promise<TestResult[]> {
  const script = resolveScriptForR(model);
  const target = targetKeyFor(model);
  const args = ["--target", target];
  if (model.provider === "llamacpp") args.push("--battery", "r");
  const r = await runPythonScript(script, args);
  if (r.exitCode !== 0) {
    return [{ part: "R", id: "R1-R6", score: 0, max: MAX_R6, wall: 0, err: r.stderr.slice(0, 200) }];
  }
  const scoreMatch = r.stdout.match(/SCORE:\s*(\d+)\/(\d+)/);
  if (scoreMatch) {
    return [{
      part: "R", id: "R1-R6", score: parseInt(scoreMatch[1]), max: parseInt(scoreMatch[2]), wall: 0,
    }];
  }
  const jsonMatch = r.stdout.match(/"score":\s*"?(\d+)\/(\d+)"?/);
  if (jsonMatch) {
    return [{
      part: "R", id: "R1-R6", score: parseInt(jsonMatch[1]), max: parseInt(jsonMatch[2]), wall: 0,
    }];
  }
  return [{ part: "R", id: "R1-R6", score: 0, max: MAX_R6, wall: 0, err: "could not parse score" }];
}

async function runC(model: ModelSpec): Promise<TestResult[]> {
  const script = resolveScriptForC(model);
  const target = targetKeyFor(model);
  const args = ["--target", target];
  if (model.provider === "llamacpp") {
    args.push("--battery", "c", "--skip-c8");
  }
  const r = await runPythonScript(script, args);
  if (r.exitCode !== 0) {
    return [{ part: "C", id: "C1-C6+C8", score: 0, max: MAX_C8, wall: 0, err: r.stderr.slice(0, 200) }];
  }
  const scoreMatch = r.stdout.match(/SCORE:\s*(\d+)\/(\d+)/);
  if (scoreMatch) {
    return [{
      part: "C", id: "C1-C6+C8", score: parseInt(scoreMatch[1]), max: parseInt(scoreMatch[2]), wall: 0,
    }];
  }
  return [{ part: "C", id: "C1-C6+C8", score: 0, max: MAX_C8, wall: 0, err: "could not parse score" }];
}

// ── Bench runner ──────────────────────────────────────────────────────────────

export async function runUnifiedBench(
  model: ModelSpec,
  opts: { full?: boolean } = {},
): Promise<BenchResult> {
  const started = Date.now();
  const tests: TestResult[] = [];

  console.log(`\n${"═".repeat(80)}`);
  console.log(`UNIFIED BENCH — ${model.name}  (${model.key})`);
  console.log(`  Provider: ${model.provider}${model.anthropicCompat ? " (Anthropic-compat)" : ""}`);
  console.log(`  Config: max_tokens=${model.maxTokens}  temp=${model.temperature}  typeFilter=${model.typeFilter}  fenceStrip=${model.fenceStrip}`);
  console.log(`  Mode: ${opts.full ? "FULL (53 pts)" : "LITE (26 pts, T1-T9 + R1-R6)"}`);
  console.log(`${"═".repeat(80)}`);

  // T1-T9
  const t0 = Date.now();
  const t = await runT(model);
  const tWall = (Date.now() - t0) / 1000;
  t[0].wall = tWall;
  tests.push(...t);
  console.log(`  T1-T9: ${t[0].score}/${t[0].max}  (${tWall.toFixed(1)}s)${t[0].err ? `  ERR: ${t[0].err}` : ""}`);

  // R1-R6
  const r0 = Date.now();
  const r = await runR(model);
  const rWall = (Date.now() - r0) / 1000;
  r[0].wall = rWall;
  tests.push(...r);
  console.log(`  R1-R6: ${r[0].score}/${r[0].max}  (${rWall.toFixed(1)}s)${r[0].err ? `  ERR: ${r[0].err}` : ""}`);

  // C1-C6+C8 (only if --full)
  let cWall = 0;
  if (opts.full) {
    const c0 = Date.now();
    const c = await runC(model);
    cWall = (Date.now() - c0) / 1000;
    c[0].wall = cWall;
    tests.push(...c);
    console.log(`  C1-C6+C8: ${c[0].score}/${c[0].max}  (${cWall.toFixed(1)}s)${c[0].err ? `  ERR: ${c[0].err}` : ""}`);
  }

  const t_score = t.reduce((a, b) => a + b.score, 0);
  const r_score = r.reduce((a, b) => a + b.score, 0);
  const c_score = tests.filter(x => x.part === "C").reduce((a, b) => a + b.score, 0);
  const total = t_score + r_score + c_score;
  const total_max = opts.full ? MAX_TOTAL : (MAX_T9 + MAX_R6);

  const result: BenchResult = {
    model,
    timestamp: new Date().toISOString(),
    tests,
    t_score, r_score, c_score,
    total, total_max,
    wall_total: (Date.now() - started) / 1000,
    status: opts.full ? "complete" : "lite",
  };

  console.log(`${"─".repeat(80)}`);
  console.log(`  TOTAL: ${total}/${total_max}  (${((total / total_max) * 100).toFixed(1)}%)  wall: ${result.wall_total.toFixed(1)}s`);
  console.log(`${"═".repeat(80)}`);

  // Append to results log
  const logPath = join(SCRIPT_DIR_ABS, "unified_bench_results.jsonl");
  appendFileSync(logPath, JSON.stringify(result) + "\n");

  return result;
}

// ── Output formatting ─────────────────────────────────────────────────────────

export function formatUnifiedTable(results: BenchResult[]): string {
  // Sort by total score (desc)
  const sorted = [...results].sort((a, b) => b.total - a.total);
  const lines: string[] = [];
  lines.push(`| # | Model | 9-batt | 17-pt | Coding | Total (${MAX_TOTAL}) | Wall |`);
  lines.push(`|---|-------|--------|-------|--------|${"-".repeat(15)}|------|`);
  sorted.forEach((r, i) => {
    const t = r.tests.find(x => x.part === "T")!;
    const rs = r.tests.find(x => x.part === "R")!;
    const c = r.tests.find(x => x.part === "C");
    lines.push(
      `| ${i + 1} | ${r.model.name} | ${t.score}/${t.max} | ${rs.score}/${rs.max} | ${c ? `${c.score}/${c.max}` : "—"} | ${r.status === "complete" ? `**${r.total}/${r.total_max}**` : `${r.total}/${r.total_max}`} | ${r.wall_total.toFixed(1)}s |`,
    );
  });
  return lines.join("\n");
}

// ── CLI ──────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);
  const full = args.includes("--full");
  const all = args.includes("--all");
  const topArg = args.find(a => a.startsWith("--top="));
  const topN = topArg ? parseInt(topArg.split("=")[1]) : null;
  const modelArg = args.find(a => a.startsWith("--model="))?.split("=")[1];

  let targets: ModelSpec[];

  if (modelArg) {
    const m = MODELS.find(m => m.key === modelArg);
    if (!m) {
      console.error(`Unknown model: ${modelArg}. Available: ${MODELS.map(m => m.key).join(", ")}`);
      process.exit(1);
    }
    targets = [m];
  } else if (all) {
    targets = MODELS;
  } else if (topN) {
    // Top N routing candidates: tier 0 + tier 1 + key tier 4 specialists
    targets = MODELS
      .filter(m => m.tier <= 1 || ["codestral", "devstralMed", "devstralSmall2", "northMiniCode"].includes(m.key))
      .slice(0, topN);
  } else {
    console.error(`Usage:
  bun unified_bench.ts --model=<key> [--full]
  bun unified_bench.ts --all [--full]
  bun unified_bench.ts --top=<N> [--full]

Models: ${MODELS.map(m => m.key).join(", ")}`);
    process.exit(1);
  }

  const results: BenchResult[] = [];
  for (const m of targets) {
    try {
      const r = await runUnifiedBench(m, { full });
      results.push(r);
    } catch (e) {
      console.error(`FAIL: ${m.key}: ${(e as Error).message}`);
    }
  }

  console.log("\n" + "═".repeat(80));
  console.log("UNIFIED TABLE");
  console.log("═".repeat(80));
  console.log(formatUnifiedTable(results));

  // Save CSV for routing decisions
  const csvPath = join(SCRIPT_DIR_ABS, `unified_bench_${new Date().toISOString().slice(0, 10)}.csv`);
  const csv = ["model,provider,tier,t_score,r_score,c_score,total,total_max,wall_s,status"]
    .concat(results.map(r => `${r.model.key},${r.model.provider},${r.model.tier},${r.t_score},${r.r_score},${r.c_score},${r.total},${r.total_max},${r.wall_total.toFixed(1)},${r.status}`))
    .join("\n");
  writeFileSync(csvPath, csv);
  console.log(`\nCSV saved: ${csvPath}`);
}
