#!/usr/bin/env bun
/**
 * analyze-latency.ts — P5 data-driven tier re-assignment tool
 *
 * Reads latency-per-invocation.jsonl, filters out test artifacts (model_selected
 * values not in inference-routing.yaml), computes per-model statistics, detects
 * tier mismatches against assigned tiers, and proposes corrected tier assignments.
 *
 * Usage:
 *   bun TOOLS/analyze-latency.ts --dry-run    print proposals, write nothing
 *   bun TOOLS/analyze-latency.ts --apply      backup + write inference-routing.yaml
 *
 * Tier boundaries (ms):
 *   fast:     mean <  150
 *   standard: 150 <= mean < 5000
 *   smart:    mean >= 5000
 *
 * Confidence (count = N samples, CV = stddev/mean):
 *   high:   N >= 10 AND CV < 1.0
 *   medium: 3 <= N <= 9 AND CV < 2.0
 *   low:    everything else (skipped, never auto-applied)
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
// yaml is loaded lazily inside loadRoutingConfig/writeRoutingConfig so that
// importing this module from `bun test` (which has stricter package resolution
// than direct `bun script.ts` runs) does not require the auto-installed `yaml`
// package to be on the resolution path. Pure analysis helpers (tested in
// __tests__/latency-analysis.test.ts) never touch YAML.
type YamlModule = {
  parse: (s: string) => unknown;
  stringify: (v: unknown, opts?: { lineWidth?: number }) => string;
};
let _yaml: YamlModule | null = null;
async function getYaml(): Promise<YamlModule> {
  if (_yaml) return _yaml;
  _yaml = (await import("yaml")) as unknown as YamlModule;
  return _yaml;
}

// ─── Paths ─────────────────────────────────────────────────────────────────────

const PAI_DIR = process.env.PAI_DIR ?? join(homedir(), ".claude", "PAI");
const ROUTING_YAML = join(PAI_DIR, "USER", "Config", "inference-routing.yaml");
const LATENCY_JSONL = join(
  PAI_DIR,
  "MEMORY",
  "OBSERVABILITY",
  "latency-per-invocation.jsonl",
);

// ─── Types ─────────────────────────────────────────────────────────────────────

export type Tier = "fast" | "standard" | "smart";
export type Confidence = "high" | "medium" | "low";

export interface LatencyEntry {
  timestamp: string;
  model_selected: string;
  tier_used: string;
  backend: string;
  latency_ms: number;
  status: string;
  skill_name?: string;
  error?: string;
}

export interface ModelStats {
  model: string;
  count: number;
  mean: number;
  stddev: number;
  min: number;
  max: number;
  cv: number;
}

export interface RoutingConfig {
  version: number;
  decision_date?: string;
  decision_logic?: string;
  models: Record<string, { tier: Tier; cold_start_ms?: number; warm_p50_ms?: number }>;
}

export interface Proposal {
  model: string;
  currentTier: Tier;
  observedMean: number;
  proposedTier: Tier;
  confidence: Confidence;
  count: number;
  cv: number;
  changed: boolean;
  baselineP50?: number;
  driftPct?: number;
  driftFlagged: boolean;
}

export interface AnalysisResult {
  totalEntries: number;
  artifactEntries: number;
  validEntries: number;
  malformed: number;
  perModelStats: ModelStats[];
  proposals: Proposal[];
}

// ─── Statistics ────────────────────────────────────────────────────────────────

export function computeMean(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

export function computeStddev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = computeMean(values);
  let sumSq = 0;
  for (const v of values) {
    const d = v - mean;
    sumSq += d * d;
  }
  // Sample stddev (N-1) is more honest given small sample sizes here.
  return Math.sqrt(sumSq / (values.length - 1));
}

export function computeCV(values: number[]): number {
  const mean = computeMean(values);
  if (mean === 0) return 0;
  return computeStddev(values) / mean;
}

// ─── Tier logic ────────────────────────────────────────────────────────────────

/**
 * Map an observed mean latency to its proposed tier.
 *
 * Note: the spec's tier ranges nominally overlap (fast 0–150, standard 50–5000),
 * but the operative rule is non-overlapping: <150 → fast, <5000 → standard,
 * else smart. CV is used for confidence, not boundary classification.
 */
export function tierFromMean(meanMs: number): Tier {
  if (meanMs < 150) return "fast";
  if (meanMs < 5000) return "standard";
  return "smart";
}

export function detectTierMismatch(currentTier: Tier, meanMs: number): {
  mismatched: boolean;
  proposedTier: Tier;
} {
  const proposedTier = tierFromMean(meanMs);
  return { mismatched: proposedTier !== currentTier, proposedTier };
}

export function confidenceScore(count: number, cv: number): Confidence {
  if (count >= 10 && cv < 1.0) return "high";
  if (count >= 3 && count <= 9 && cv < 2.0) return "medium";
  return "low";
}

// ─── JSONL parsing ─────────────────────────────────────────────────────────────

export function parseJsonlLines(content: string): {
  entries: LatencyEntry[];
  malformed: number;
} {
  const entries: LatencyEntry[] = [];
  let malformed = 0;
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line) as Partial<LatencyEntry>;
      if (
        typeof obj.model_selected !== "string" ||
        typeof obj.latency_ms !== "number" ||
        typeof obj.tier_used !== "string"
      ) {
        malformed++;
        continue;
      }
      entries.push(obj as LatencyEntry);
    } catch {
      malformed++;
    }
  }
  return { entries, malformed };
}

// ─── Filtering ─────────────────────────────────────────────────────────────────

/**
 * Remove entries whose model_selected isn't a real model in routing config.
 * These are test artifacts (haiku, sonnet, x, __latency_test_*, "standard")
 * that would otherwise skew per-tier statistics.
 */
export function filterArtifacts(
  entries: LatencyEntry[],
  routingModels: Set<string>,
): { kept: LatencyEntry[]; filtered: number } {
  const kept: LatencyEntry[] = [];
  let filtered = 0;
  for (const e of entries) {
    if (routingModels.has(e.model_selected)) {
      kept.push(e);
    } else {
      filtered++;
    }
  }
  return { kept, filtered };
}

// ─── Per-model aggregation ─────────────────────────────────────────────────────

export function computePerModelStats(entries: LatencyEntry[]): ModelStats[] {
  const byModel: Record<string, number[]> = {};
  for (const e of entries) {
    if (e.status !== "success") continue; // exclude timeouts/errors from stats
    byModel[e.model_selected] = byModel[e.model_selected] ?? [];
    byModel[e.model_selected].push(e.latency_ms);
  }
  const out: ModelStats[] = [];
  for (const [model, values] of Object.entries(byModel)) {
    if (values.length === 0) continue;
    const mean = computeMean(values);
    const stddev = computeStddev(values);
    out.push({
      model,
      count: values.length,
      mean: Math.round(mean * 100) / 100,
      stddev: Math.round(stddev * 100) / 100,
      min: Math.min(...values),
      max: Math.max(...values),
      cv: mean === 0 ? 0 : Math.round((stddev / mean) * 1000) / 1000,
    });
  }
  // Deterministic sort: model name asc.
  out.sort((a, b) => a.model.localeCompare(b.model));
  return out;
}

// ─── Proposal generation ───────────────────────────────────────────────────────

export function generateProposal(
  stat: ModelStats,
  currentTier: Tier,
  baselineP50?: number,
): Proposal {
  const { proposedTier } = detectTierMismatch(currentTier, stat.mean);
  const confidence = confidenceScore(stat.count, stat.cv);
  const changed = proposedTier !== currentTier && confidence !== "low";

  let driftPct: number | undefined;
  let driftFlagged = false;
  if (baselineP50 !== undefined && baselineP50 > 0) {
    driftPct = Math.round(((stat.mean - baselineP50) / baselineP50) * 100 * 10) / 10;
    driftFlagged = Math.abs(driftPct) > 20;
  }

  return {
    model: stat.model,
    currentTier,
    observedMean: stat.mean,
    proposedTier,
    confidence,
    count: stat.count,
    cv: stat.cv,
    changed,
    baselineP50,
    driftPct,
    driftFlagged,
  };
}

// ─── End-to-end analysis ───────────────────────────────────────────────────────

export function analyze(
  jsonlContent: string,
  config: RoutingConfig,
): AnalysisResult {
  const { entries, malformed } = parseJsonlLines(jsonlContent);
  const routingModels = new Set(Object.keys(config.models));
  const { kept, filtered } = filterArtifacts(entries, routingModels);
  const perModelStats = computePerModelStats(kept);

  const proposals: Proposal[] = [];
  for (const s of perModelStats) {
    const entry = config.models[s.model];
    if (!entry) continue;
    proposals.push(generateProposal(s, entry.tier, entry.warm_p50_ms));
  }
  // Deterministic: sort by model name.
  proposals.sort((a, b) => a.model.localeCompare(b.model));

  return {
    totalEntries: entries.length,
    artifactEntries: filtered,
    validEntries: kept.length,
    malformed,
    perModelStats,
    proposals,
  };
}

// ─── Markdown rendering ────────────────────────────────────────────────────────

function renderTable(result: AnalysisResult): string {
  const lines: string[] = [];
  lines.push("| model | current_tier | observed_mean_ms | baseline_p50_ms | drift_pct | proposed_tier | confidence | n | cv |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const p of result.proposals) {
    const tierFlag = p.changed ? " **CHANGE**" : "";
    const driftStr = p.driftPct !== undefined ? `${p.driftPct > 0 ? "+" : ""}${p.driftPct}%${p.driftFlagged ? " **DRIFT**" : ""}` : "—";
    const baselineStr = p.baselineP50 !== undefined ? String(p.baselineP50) : "—";
    lines.push(
      `| ${p.model} | ${p.currentTier} | ${p.observedMean} | ${baselineStr} | ${driftStr} | ${p.proposedTier}${tierFlag} | ${p.confidence} | ${p.count} | ${p.cv} |`,
    );
  }
  return lines.join("\n");
}

function renderSummary(result: AnalysisResult): string {
  const changes = result.proposals.filter((p) => p.changed).length;
  const lows = result.proposals.filter((p) => p.confidence === "low").length;
  const drifts = result.proposals.filter((p) => p.driftFlagged).length;
  return [
    `Total JSONL entries:    ${result.totalEntries}`,
    `Malformed lines:        ${result.malformed}`,
    `Artifact entries:       ${result.artifactEntries} (filtered, not in routing config)`,
    `Valid entries:          ${result.validEntries}`,
    `Models with stats:      ${result.perModelStats.length}`,
    `Proposed changes:       ${changes}`,
    `Low-confidence (skip):  ${lows}`,
    `Drift flagged (>20%):   ${drifts}`,
  ].join("\n");
}

// ─── YAML I/O ──────────────────────────────────────────────────────────────────

export async function loadRoutingConfig(path: string): Promise<RoutingConfig> {
  if (!existsSync(path)) {
    throw new Error(`Routing config not found: ${path}`);
  }
  const raw = readFileSync(path, "utf8");
  const yaml = await getYaml();
  const parsed = yaml.parse(raw) as RoutingConfig;
  if (!parsed || typeof parsed !== "object" || !parsed.models) {
    throw new Error(`Invalid routing config at ${path}: missing 'models'`);
  }
  return parsed;
}

function applyProposals(config: RoutingConfig, proposals: Proposal[]): RoutingConfig {
  const next: RoutingConfig = {
    ...config,
    models: { ...config.models },
  };
  for (const p of proposals) {
    if (!p.changed) continue;
    const existing = next.models[p.model];
    if (!existing) continue;
    next.models[p.model] = { ...existing, tier: p.proposedTier };
  }
  return next;
}

async function writeRoutingConfig(path: string, config: RoutingConfig): Promise<void> {
  const yaml = await getYaml();
  const out = yaml.stringify(config, { lineWidth: 0 });
  writeFileSync(path, out, "utf8");
  // Round-trip validation.
  const back = yaml.parse(readFileSync(path, "utf8")) as RoutingConfig;
  if (!back || !back.models) {
    throw new Error(`YAML round-trip validation failed for ${path}`);
  }
}

// ─── CLI ───────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "dry-run": { type: "boolean", default: false },
      apply: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(
      "Usage: bun TOOLS/analyze-latency.ts [--dry-run | --apply]\n" +
        "  --dry-run  print proposals, write nothing (default behavior)\n" +
        "  --apply    backup configs (.bak) and write corrected inference-routing.yaml",
    );
    return 0;
  }

  const dryRun = values["dry-run"] || !values.apply;
  const apply = !!values.apply;

  let config: RoutingConfig;
  try {
    config = await loadRoutingConfig(ROUTING_YAML);
  } catch (e) {
    console.error(`[analyze-latency] ERROR loading routing config: ${(e as Error).message}`);
    return 1;
  }

  if (!existsSync(LATENCY_JSONL)) {
    console.error(`[analyze-latency] ERROR: latency log not found at ${LATENCY_JSONL}`);
    return 1;
  }

  const jsonlContent = readFileSync(LATENCY_JSONL, "utf8");
  const result = analyze(jsonlContent, config);

  console.log("# P5 Latency Analysis Proposal\n");
  console.log("## Summary\n");
  console.log("```");
  console.log(renderSummary(result));
  console.log("```\n");
  console.log("## Per-Model Tier Proposals\n");
  console.log(renderTable(result));
  console.log("");

  if (apply) {
    const changes = result.proposals.filter((p) => p.changed);
    if (changes.length === 0) {
      console.log("No high/medium-confidence changes — nothing to apply.");
      return 0;
    }
    const backup = `${ROUTING_YAML}.bak`;
    try {
      copyFileSync(ROUTING_YAML, backup);
      console.log(`Backup written: ${backup}`);
      const next = applyProposals(config, result.proposals);
      await writeRoutingConfig(ROUTING_YAML, next);
      console.log(`Applied ${changes.length} tier change(s) to ${ROUTING_YAML}`);
    } catch (e) {
      console.error(`[analyze-latency] ERROR applying changes: ${(e as Error).message}`);
      return 1;
    }
  } else if (dryRun) {
    console.log("(dry-run — no files modified. Re-run with --apply to write changes.)");
  }

  return 0;
}

if (import.meta.main) {
  main().then((code) => process.exit(code)).catch((e) => {
    console.error(`[analyze-latency] FATAL: ${(e as Error).message}`);
    process.exit(1);
  });
}
