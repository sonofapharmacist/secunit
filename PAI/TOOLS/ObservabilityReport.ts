#!/usr/bin/env bun
/**
 * ObservabilityReport.ts — PAI JSONL metrics + tripwire checker
 *
 * Usage:
 *   bun ObservabilityReport.ts [--mode quick|full] [--since <ISO-date>] [--notify] [--out <path>]
 *   bun ObservabilityReport.ts --help
 *
 * Exports: parsePromptProcessing, parseInferenceCalls, parseSessionCosts,
 *          evaluateTripwires, computeReport
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { parseArgs } from "node:util";

// ─── Path resolution ───────────────────────────────────────────────────────────

const PAI_DIR = process.env.PAI_DIR ?? join(homedir(), ".claude", "PAI");
const OBS_DIR = join(PAI_DIR, "MEMORY", "OBSERVABILITY");
const DEFAULT_OUT = join(OBS_DIR, "weekly-summary.json");

// ─── Tripwire names (stable — downstream consumers key on these) ───────────────

export const TRIPWIRE = {
  FAIL_SAFE_RATE: "FAIL_SAFE_RATE",
  FAIL_SAFE_SESSION: "FAIL_SAFE_SESSION",
  CLASSIFIER_P95: "CLASSIFIER_P95",
  LOCAL_ESCALATION: "LOCAL_ESCALATION",
  SKILL_LOG_ABSENT: "SKILL_LOG_ABSENT",
} as const;

// ─── Interfaces ────────────────────────────────────────────────────────────────

interface DateRange {
  start: string;
  end: string;
}

interface ModeCount {
  count: number;
  pct: number;
}

interface ModeDist {
  ALGORITHM: ModeCount;
  NATIVE: ModeCount;
  MINIMAL: ModeCount;
}

interface TierDist {
  [tier: string]: ModeCount;
}

interface FailSafeMetrics {
  count: number;
  rate: number;
  maxPerSession: number;
}

interface LatencyMetrics {
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  p99: number;
  over15sCount: number;
  over15sPct: number;
}

export interface PromptProcessingMetrics {
  n: number;
  badLines: number;
  dateRange: DateRange;
  modeDist: ModeDist;
  tierDist: TierDist;
  failSafe: FailSafeMetrics;
  latency: LatencyMetrics | null;
  classifierPromptTokens: { mean: number; max: number; n: number } | null;
}

interface BackendCount {
  count: number;
  pct: number;
}

interface BackendDist {
  local: BackendCount;
  claude: BackendCount;
}

interface LevelDist {
  fast: BackendCount;
  standard: BackendCount;
  smart: BackendCount;
}

interface EscalationMetrics {
  attempted: number;
  stayedLocal: number;
  escalated: number;
  localSuccessRate: number;
}

interface LatencyP50 {
  local: number;
  claude: number;
}

export interface InferenceMetrics {
  n: number;
  badLines: number;
  dateRange: DateRange;
  backendDist: BackendDist;
  claudeLevelDist: LevelDist;
  localModels: Record<string, number>;
  fallbackRate: { count: number; pct: number };
  fallbackByTier: Record<string, { count: number; pct: number }>;
  escalation: EscalationMetrics;
  latencyP50: LatencyP50 | null;
}

interface ProjectSpend {
  project: string;
  sessionCount: number;
  totalCost: number;
}

interface ModelDist {
  count: number;
  pct: number;
  totalCost: number;
}

export interface SessionCostMetrics {
  n: number;
  badLines: number;
  dateRange: DateRange;
  modelDist: Record<string, ModelDist>;
  totalSpend: number;
  avgSessionCost: number;
  cacheHitRate: number;
  topProjects: ProjectSpend[];
}

interface TripwireResult {
  name: string;
  status: "WARN" | "INFO" | "OK";
  value: number | string;
  threshold: number | string;
  message: string;
}

interface ReportWindow {
  start: string;
  end: string;
  sinceFilter: string | null;
}

export interface Report {
  schemaVersion: 1;
  generatedAt: string;
  mode: "quick" | "full";
  window: ReportWindow;
  tripwires: TripwireResult[];
  promptProcessing: PromptProcessingMetrics | { status: string };
  inferenceCalls: InferenceMetrics | { status: string };
  sessionCosts: SessionCostMetrics | { status: string };
  latencyPerInvocation: LatencyPerInvocationMetrics | { status: string };
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function readJsonl(filepath: string): {
  lines: Record<string, unknown>[];
  badLines: number;
  found: boolean;
} {
  if (!existsSync(filepath)) return { lines: [], badLines: 0, found: false };
  const content = readFileSync(filepath, "utf8");
  const rawLines = content.split("\n").filter((l) => l.trim().length > 0);
  let badLines = 0;
  const lines: Record<string, unknown>[] = [];
  for (const raw of rawLines) {
    try {
      lines.push(JSON.parse(raw) as Record<string, unknown>);
    } catch {
      badLines++;
    }
  }
  return { lines, badLines, found: true };
}

function filterSince(
  lines: Record<string, unknown>[],
  since: Date | null,
  tsField: string
): Record<string, unknown>[] {
  if (!since) return lines;
  return lines.filter((l) => {
    const ts = l[tsField];
    if (typeof ts !== "string") return true;
    return new Date(ts) >= since;
  });
}

function computeDateRange(
  lines: Record<string, unknown>[],
  tsField: string
): DateRange {
  const times = lines
    .map((l) => l[tsField])
    .filter((t): t is string => typeof t === "string")
    .sort();
  return {
    start: times[0] ?? "unknown",
    end: times[times.length - 1] ?? "unknown",
  };
}

function pct(count: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((count / total) * 1000) / 10;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)];
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// ─── Parsers ───────────────────────────────────────────────────────────────────

export function parsePromptProcessing(
  obsDir: string,
  since: Date | null,
  quick: boolean
): PromptProcessingMetrics | { status: string } {
  const { lines: raw, badLines, found } = readJsonl(
    join(obsDir, "prompt-processing.jsonl")
  );
  if (!found) return { status: "file-not-found" };

  const lines = filterSince(raw, since, "timestamp");
  const n = lines.length;
  if (n === 0) return { status: "empty", n: 0 } as { status: string };

  let algo = 0, native = 0, minimal = 0;
  for (const l of lines) {
    const m = l["mode"];
    if (m === "ALGORITHM") algo++;
    else if (m === "NATIVE") native++;
    else if (m === "MINIMAL") minimal++;
  }

  const algoLines = lines.filter((l) => l["mode"] === "ALGORITHM");
  const tierCounts: Record<string, number> = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
  for (const l of algoLines) {
    const t = l["tier"];
    if (typeof t === "number" && t >= 1 && t <= 5) {
      tierCounts[String(t)]++;
    }
  }
  const tierDist: TierDist = {};
  for (const [k, v] of Object.entries(tierCounts)) {
    tierDist[k] = { count: v, pct: pct(v, algoLines.length) };
  }

  const failSafeLines = lines.filter((l) => l["source"] === "fail-safe");
  const sessionFailCounts: Record<string, number> = {};
  for (const l of failSafeLines) {
    const sid =
      typeof l["session_id"] === "string" ? l["session_id"] : "unknown";
    sessionFailCounts[sid] = (sessionFailCounts[sid] ?? 0) + 1;
  }
  const maxPerSession = Math.max(0, ...Object.values(sessionFailCounts));

  let latency: LatencyMetrics | null = null;
  if (!quick) {
    const latMs = lines
      .map((l) => l["latency_ms"])
      .filter((v): v is number => typeof v === "number" && !isNaN(v))
      .sort((a, b) => a - b);
    const over15 = latMs.filter((v) => v > 15000).length;
    latency = {
      p50: percentile(latMs, 0.5),
      p75: percentile(latMs, 0.75),
      p90: percentile(latMs, 0.9),
      p95: percentile(latMs, 0.95),
      p99: percentile(latMs, 0.99),
      over15sCount: over15,
      over15sPct: pct(over15, latMs.length),
    };
  }

  const cptRaw = lines
    .map((l) => l["classifier_prompt_tokens"])
    .filter((v): v is number => typeof v === "number" && v > 0);
  const classifierPromptTokens = cptRaw.length > 0
    ? { mean: Math.round(cptRaw.reduce((a, b) => a + b, 0) / cptRaw.length), max: Math.max(...cptRaw), n: cptRaw.length }
    : null;

  return {
    n,
    badLines,
    dateRange: computeDateRange(lines, "timestamp"),
    modeDist: {
      ALGORITHM: { count: algo, pct: pct(algo, n) },
      NATIVE: { count: native, pct: pct(native, n) },
      MINIMAL: { count: minimal, pct: pct(minimal, n) },
    },
    tierDist,
    failSafe: {
      count: failSafeLines.length,
      rate: n > 0 ? failSafeLines.length / n : 0,
      maxPerSession,
    },
    latency,
    classifierPromptTokens,
  };
}

export function parseInferenceCalls(
  obsDir: string,
  since: Date | null,
  quick: boolean
): InferenceMetrics | { status: string } {
  const { lines: raw, badLines, found } = readJsonl(
    join(obsDir, "inference-calls.jsonl")
  );
  if (!found) return { status: "file-not-found" };

  const lines = filterSince(raw, since, "timestamp");
  const n = lines.length;
  if (n === 0) return { status: "empty", n: 0 } as { status: string };

  let localCount = 0, claudeCount = 0;
  let fastCount = 0, standardCount = 0, smartCount = 0;
  const localModels: Record<string, number> = {};
  let fallbackCount = 0, stayedLocal = 0, escalated = 0;
  const localLat: number[] = [];
  const claudeLat: number[] = [];
  const fallbackByLevel: Record<string, number> = {};
  const totalByLevel: Record<string, number> = {};

  for (const l of lines) {
    const backend = l["backend"];
    const latRaw = l["latency_ms"];
    const latNum =
      typeof latRaw === "number" && !isNaN(latRaw) ? latRaw : null;
    const level = typeof l["level"] === "string" ? l["level"] : null;

    if (level) totalByLevel[level] = (totalByLevel[level] ?? 0) + 1;

    if (backend === "local") {
      localCount++;
      stayedLocal++;
      if (latNum !== null) localLat.push(latNum);
      const model =
        typeof l["model"] === "string" ? l["model"] : "unknown";
      localModels[model] = (localModels[model] ?? 0) + 1;
    } else if (backend === "claude") {
      claudeCount++;
      if (latNum !== null) claudeLat.push(latNum);
      if (level === "fast") fastCount++;
      else if (level === "standard") standardCount++;
      else if (level === "smart") smartCount++;
      if (l["escalated_from_local"] === true) escalated++;
    }
    if (l["fallback_used"] === true) {
      fallbackCount++;
      if (level) fallbackByLevel[level] = (fallbackByLevel[level] ?? 0) + 1;
    }
  }

  const attempted = stayedLocal + escalated;

  let latencyP50: LatencyP50 | null = null;
  if (!quick) {
    localLat.sort((a, b) => a - b);
    claudeLat.sort((a, b) => a - b);
    latencyP50 = {
      local: percentile(localLat, 0.5),
      claude: percentile(claudeLat, 0.5),
    };
  }

  return {
    n,
    badLines,
    dateRange: computeDateRange(lines, "timestamp"),
    backendDist: {
      local: { count: localCount, pct: pct(localCount, n) },
      claude: { count: claudeCount, pct: pct(claudeCount, n) },
    },
    claudeLevelDist: {
      fast: { count: fastCount, pct: pct(fastCount, claudeCount) },
      standard: { count: standardCount, pct: pct(standardCount, claudeCount) },
      smart: { count: smartCount, pct: pct(smartCount, claudeCount) },
    },
    localModels,
    fallbackRate: { count: fallbackCount, pct: pct(fallbackCount, n) },
    fallbackByTier: Object.fromEntries(
      Object.entries(fallbackByLevel).map(([lvl, cnt]) => [
        lvl,
        { count: cnt, pct: pct(cnt, totalByLevel[lvl] ?? 0) },
      ])
    ),
    escalation: {
      attempted,
      stayedLocal,
      escalated,
      localSuccessRate: attempted > 0 ? stayedLocal / attempted : 1,
    },
    latencyP50,
  };
}

export function parseSessionCosts(
  obsDir: string,
  since: Date | null
): SessionCostMetrics | { status: string } {
  const { lines: raw, badLines, found } = readJsonl(
    join(obsDir, "session-costs.jsonl")
  );
  if (!found) return { status: "file-not-found" };

  const lines = filterSince(raw, since, "firstTimestamp");
  const n = lines.length;
  if (n === 0) return { status: "empty", n: 0 } as { status: string };

  const modelData: Record<string, { count: number; totalCost: number }> = {};
  const projectData: Record<string, { count: number; totalCost: number }> = {};
  let totalSpend = 0, totalCacheRead = 0, totalTokens = 0;

  for (const l of lines) {
    const model =
      typeof l["primaryModel"] === "string" ? l["primaryModel"] : "unknown";
    const cost = typeof l["costTotal"] === "number" ? l["costTotal"] : 0;
    const project =
      typeof l["project"] === "string" ? l["project"] : "unknown";
    const cacheRead =
      typeof l["cacheReadTokens"] === "number" ? l["cacheReadTokens"] : 0;
    const tokens =
      typeof l["totalTokens"] === "number" ? l["totalTokens"] : 0;

    modelData[model] = modelData[model] ?? { count: 0, totalCost: 0 };
    modelData[model].count++;
    modelData[model].totalCost += cost;

    projectData[project] = projectData[project] ?? { count: 0, totalCost: 0 };
    projectData[project].count++;
    projectData[project].totalCost += cost;

    totalSpend += cost;
    totalCacheRead += cacheRead;
    totalTokens += tokens;
  }

  const modelDist: Record<string, ModelDist> = {};
  for (const [model, data] of Object.entries(modelData)) {
    modelDist[model] = {
      count: data.count,
      pct: pct(data.count, n),
      totalCost: round4(data.totalCost),
    };
  }

  const topProjects: ProjectSpend[] = Object.entries(projectData)
    .map(([project, data]) => ({
      project,
      sessionCount: data.count,
      totalCost: round4(data.totalCost),
    }))
    .sort((a, b) => b.totalCost - a.totalCost)
    .slice(0, 5);

  return {
    n,
    badLines,
    dateRange: computeDateRange(lines, "firstTimestamp"),
    modelDist,
    totalSpend: round4(totalSpend),
    avgSessionCost: n > 0 ? round4(totalSpend / n) : 0,
    cacheHitRate: totalTokens > 0 ? pct(totalCacheRead, totalTokens) : 0,
    topProjects,
  };
}

// ─── P4: per-invocation latency (latency-per-invocation.jsonl) ────────────────

interface SkillLatencyRow {
  skill: string;
  count: number;
  meanLatencyMs: number;
  tier: string;
}

export interface LatencyPerInvocationMetrics {
  n: number;
  badLines: number;
  dateRange: DateRange;
  perSkill: SkillLatencyRow[];
  tierMeanMs: Record<string, number>;
}

export function parseLatencyPerInvocation(
  obsDir: string,
  since: Date | null,
): LatencyPerInvocationMetrics | { status: string } {
  const { lines: raw, badLines, found } = readJsonl(
    join(obsDir, "latency-per-invocation.jsonl"),
  );
  if (!found) return { status: "file-not-found" };

  const lines = filterSince(raw, since, "timestamp");
  const n = lines.length;
  if (n === 0) return { status: "empty", n: 0 } as { status: string };

  const skillAgg: Record<string, { sum: number; count: number; tier: string }> = {};
  const tierAgg: Record<string, { sum: number; count: number }> = {};

  for (const l of lines) {
    const skill = typeof l["skill_name"] === "string" ? l["skill_name"] : "unnamed";
    const tier = typeof l["tier_used"] === "string" ? l["tier_used"] : "unknown";
    const lat = typeof l["latency_ms"] === "number" ? l["latency_ms"] : 0;

    skillAgg[skill] = skillAgg[skill] ?? { sum: 0, count: 0, tier };
    skillAgg[skill].sum += lat;
    skillAgg[skill].count++;
    // Record the most recent tier for the skill (ties go to last seen).
    skillAgg[skill].tier = tier;

    tierAgg[tier] = tierAgg[tier] ?? { sum: 0, count: 0 };
    tierAgg[tier].sum += lat;
    tierAgg[tier].count++;
  }

  const perSkill: SkillLatencyRow[] = Object.entries(skillAgg)
    .map(([skill, d]) => ({
      skill,
      count: d.count,
      meanLatencyMs: Math.round(d.sum / d.count),
      tier: d.tier,
    }))
    .sort((a, b) => b.meanLatencyMs - a.meanLatencyMs);

  const tierMeanMs: Record<string, number> = {};
  for (const [tier, d] of Object.entries(tierAgg)) {
    tierMeanMs[tier] = Math.round(d.sum / d.count);
  }

  return {
    n,
    badLines,
    dateRange: computeDateRange(lines, "timestamp"),
    perSkill,
    tierMeanMs,
  };
}

// ─── Tier compliance (artifact-filtered per-tier latency) ─────────────────────

interface TierComplianceRow {
  calls: number;
  meanMs: number;
}
interface TierCompliance {
  byTier: { fast: TierComplianceRow; standard: TierComplianceRow; smart: TierComplianceRow };
  artifactEntries: number;
}

/**
 * Re-scan latency-per-invocation.jsonl, dropping rows whose model_selected
 * isn't a real model in inference-routing.yaml, then compute per-tier means
 * using the model's *configured* tier (not the tier_used field, which can be
 * a test artifact). Returns null if the routing config is missing.
 */
function computeTierCompliance(): TierCompliance | null {
  const routingPath = join(PAI_DIR, "USER", "Config", "inference-routing.yaml");
  if (!existsSync(routingPath)) return null;
  const yamlRaw = readFileSync(routingPath, "utf8");
  // Line-based reader: model names contain ':' (e.g. qwen2.5-coder:7b), so we
  // anchor on the inline-flow-map ': {' boundary instead of bare ':'. Keys are
  // hand-edited one-per-line; this stays robust without pulling in the `yaml`
  // package (which has resolution differences under bun test).
  const modelTier: Record<string, "fast" | "standard" | "smart"> = {};
  let inModels = false;
  for (const rawLine of yamlRaw.split("\n")) {
    const line = rawLine.trimEnd();
    if (line.startsWith("models:")) { inModels = true; continue; }
    if (!inModels) continue;
    if (line.length === 0) continue;
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) continue;
    // Match "<name>: { ... tier: <fast|standard|smart> ... }" — name may
    // contain colons, so we look for the literal ': {' before the flow map.
    const idx = line.indexOf(": {");
    if (idx === -1) continue;
    const name = line.slice(0, idx).trim();
    const rest = line.slice(idx);
    const tm = rest.match(/\btier:\s*(fast|standard|smart)\b/);
    if (name && tm) modelTier[name] = tm[1] as "fast" | "standard" | "smart";
  }
  const known = new Set(Object.keys(modelTier));

  const latPath = join(PAI_DIR, "MEMORY", "OBSERVABILITY", "latency-per-invocation.jsonl");
  if (!existsSync(latPath)) return null;
  const sums = { fast: 0, standard: 0, smart: 0 };
  const counts = { fast: 0, standard: 0, smart: 0 };
  let artifactEntries = 0;
  for (const line of readFileSync(latPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as { model_selected?: string; latency_ms?: number; status?: string };
      const m = typeof o.model_selected === "string" ? o.model_selected : "";
      const lat = typeof o.latency_ms === "number" ? o.latency_ms : 0;
      if (!known.has(m)) { artifactEntries++; continue; }
      if (o.status !== "success") continue;
      const tier = modelTier[m];
      sums[tier] += lat;
      counts[tier] += 1;
    } catch {
      artifactEntries++;
    }
  }
  const mk = (tier: "fast" | "standard" | "smart"): TierComplianceRow => ({
    calls: counts[tier],
    meanMs: counts[tier] === 0 ? 0 : Math.round(sums[tier] / counts[tier]),
  });
  return {
    byTier: { fast: mk("fast"), standard: mk("standard"), smart: mk("smart") },
    artifactEntries,
  };
}

interface ContextSessionsResult {
  n: number
  sysPromptMean: number
  sysPromptMin: number
  sysPromptMax: number
  compactCount: number
  compactPctMean: number | null
  compactPctMin: number | null
  compactPctMax: number | null
}

function parseContextSessions(): ContextSessionsResult | null {
  const path = join(PAI_DIR, "MEMORY", "OBSERVABILITY", "context-sessions.jsonl");
  if (!existsSync(path)) return null;

  let sessionCount = 0;
  let sumSysPct = 0;
  let minSys = Infinity;
  let maxSys = -Infinity;

  let compactCount = 0;
  let sumCompactPct = 0;
  let minCompact = Infinity;
  let maxCompact = -Infinity;

  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const o = JSON.parse(t) as {
          event?: string;
          system_prompt_tokens?: number;
          context_pct?: number | null;
        };
        if (o.event === "session_start" && typeof o.system_prompt_tokens === "number") {
          sessionCount++;
          sumSysPct += o.system_prompt_tokens;
          if (o.system_prompt_tokens < minSys) minSys = o.system_prompt_tokens;
          if (o.system_prompt_tokens > maxSys) maxSys = o.system_prompt_tokens;
        }
        if (o.event === "pre_compact" && typeof o.context_pct === "number") {
          compactCount++;
          sumCompactPct += o.context_pct;
          if (o.context_pct < minCompact) minCompact = o.context_pct;
          if (o.context_pct > maxCompact) maxCompact = o.context_pct;
        }
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    return null;
  }

  if (sessionCount === 0) return null;

  return {
    n: sessionCount,
    sysPromptMean: Math.round(sumSysPct / sessionCount),
    sysPromptMin: minSys === Infinity ? 0 : minSys,
    sysPromptMax: maxSys === -Infinity ? 0 : maxSys,
    compactCount,
    compactPctMean: compactCount > 0 ? Math.round(sumCompactPct / compactCount) : null,
    compactPctMin: compactCount > 0 && minCompact !== Infinity ? minCompact : null,
    compactPctMax: compactCount > 0 && maxCompact !== -Infinity ? maxCompact : null,
  };
}

// ─── Tripwire evaluation ───────────────────────────────────────────────────────

export function evaluateTripwires(
  pp: PromptProcessingMetrics | { status: string },
  ic: InferenceMetrics | { status: string },
  obsDir: string
): TripwireResult[] {
  const results: TripwireResult[] = [];

  if ("failSafe" in pp) {
    const rate = pp.failSafe.rate;
    results.push({
      name: TRIPWIRE.FAIL_SAFE_RATE,
      status: rate > 0.05 ? "WARN" : "OK",
      value: `${(rate * 100).toFixed(1)}%`,
      threshold: "5%",
      message:
        rate > 0.05
          ? `Fail-safe rate ${(rate * 100).toFixed(1)}% exceeds 5% threshold`
          : `Fail-safe rate ${(rate * 100).toFixed(1)}% within threshold`,
    });

    const maxPs = pp.failSafe.maxPerSession;
    results.push({
      name: TRIPWIRE.FAIL_SAFE_SESSION,
      status: maxPs > 3 ? "WARN" : "OK",
      value: maxPs,
      threshold: 3,
      message:
        maxPs > 3
          ? `Max ${maxPs} fail-safes in a single session (threshold: 3)`
          : `Max ${maxPs} fail-safes per session within threshold`,
    });

    if (pp.latency) {
      const p95 = pp.latency.p95;
      results.push({
        name: TRIPWIRE.CLASSIFIER_P95,
        status: p95 > 30000 ? "WARN" : "OK",
        value: `${(p95 / 1000).toFixed(1)}s`,
        threshold: "30s",
        message:
          p95 > 30000
            ? `Classifier P95 ${(p95 / 1000).toFixed(1)}s exceeds 30s threshold`
            : `Classifier P95 ${(p95 / 1000).toFixed(1)}s within threshold`,
      });
    }
  }

  if ("escalation" in ic) {
    const localRate = ic.escalation.localSuccessRate;
    results.push({
      name: TRIPWIRE.LOCAL_ESCALATION,
      status: localRate < 0.6 ? "WARN" : "OK",
      value: `${((1 - localRate) * 100).toFixed(1)}% escalation`,
      threshold: "<40% escalation",
      message:
        localRate < 0.6
          ? `Local escalation rate ${((1 - localRate) * 100).toFixed(1)}% exceeds 40% threshold`
          : `Local inference success rate ${(localRate * 100).toFixed(1)}% within threshold`,
    });
  }

  const skillLogPath = join(obsDir, "skill-triggers.jsonl");
  results.push({
    name: TRIPWIRE.SKILL_LOG_ABSENT,
    status: existsSync(skillLogPath) ? "OK" : "INFO",
    value: existsSync(skillLogPath) ? "present" : "absent",
    threshold: "present",
    message: existsSync(skillLogPath)
      ? "skill-triggers.jsonl found"
      : "No skill-triggers.jsonl — skill trigger rates unobservable",
  });

  return results;
}

// ─── Report assembly ───────────────────────────────────────────────────────────

export function computeReport(opts: {
  obsDir: string;
  mode: "quick" | "full";
  since: Date | null;
}): Report {
  const { obsDir, mode, since } = opts;
  const quick = mode === "quick";

  const pp = parsePromptProcessing(obsDir, since, quick);
  const ic = parseInferenceCalls(obsDir, since, quick);
  const sc = parseSessionCosts(obsDir, since);
  const lat = parseLatencyPerInvocation(obsDir, since);
  const tripwires = evaluateTripwires(pp, ic, obsDir);

  const allStarts: string[] = [];
  const allEnds: string[] = [];
  for (const m of [pp, ic, sc]) {
    if ("dateRange" in m) {
      if (m.dateRange.start !== "unknown") allStarts.push(m.dateRange.start);
      if (m.dateRange.end !== "unknown") allEnds.push(m.dateRange.end);
    }
  }
  allStarts.sort();
  allEnds.sort();

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode,
    window: {
      start: allStarts[0] ?? "unknown",
      end: allEnds[allEnds.length - 1] ?? "unknown",
      sinceFilter: since ? since.toISOString() : null,
    },
    tripwires,
    promptProcessing: pp,
    inferenceCalls: ic,
    sessionCosts: sc,
    latencyPerInvocation: lat,
  };
}

// ─── Stdout formatting ─────────────────────────────────────────────────────────

function printReport(report: Report): void {
  const date = report.generatedAt.slice(0, 10);
  const div = "━".repeat(53);
  const windowLabel = report.window.sinceFilter
    ? `since ${report.window.sinceFilter.slice(0, 10)}`
    : "rolling 7 days (default)";
  console.log(`\nPAI Observability Report — ${date} (${report.mode} mode)`);
  console.log(`Window: ${windowLabel} | use --all-time or --since <ISO> to change`);
  console.log(div);

  const pp = report.promptProcessing;
  if ("n" in pp) {
    const dr = `${pp.dateRange.start.slice(0, 10)}→${pp.dateRange.end.slice(0, 10)}`;
    console.log(`Prompts (N=${pp.n}, ${dr})`);
    const md = pp.modeDist;
    console.log(
      `  Mode:      ALGORITHM ${md.ALGORITHM.pct}%  NATIVE ${md.NATIVE.pct}%  MINIMAL ${md.MINIMAL.pct}%`
    );
    console.log(
      `  Fail-safe: ${(pp.failSafe.rate * 100).toFixed(1)}% (${pp.failSafe.count}/${pp.n})  max/session: ${pp.failSafe.maxPerSession}`
    );
    if (pp.latency) {
      const l = pp.latency;
      console.log(
        `  Latency:   P50=${(l.p50 / 1000).toFixed(1)}s  P95=${(l.p95 / 1000).toFixed(1)}s  over-15s: ${l.over15sPct}%`
      );
    }
    if (pp.classifierPromptTokens) {
      const cpt = pp.classifierPromptTokens;
      console.log(
        `  Classifier prompt: mean=${cpt.mean}tok  max=${cpt.max}tok  (N=${cpt.n} measured)`
      );
    }
  } else {
    console.log(`Prompts: ${(pp as { status: string }).status}`);
  }

  console.log();

  const ic = report.inferenceCalls;
  if ("n" in ic) {
    console.log(`Inference (N=${ic.n})`);
    console.log(
      `  Backend:   claude ${ic.backendDist.claude.pct}%  local ${ic.backendDist.local.pct}%`
    );
    const esc = ic.escalation;
    console.log(
      `  Escalation: ${((1 - esc.localSuccessRate) * 100).toFixed(1)}% of local attempts → claude`
    );
    if (ic.latencyP50) {
      console.log(
        `  Latency:   local P50=${(ic.latencyP50.local / 1000).toFixed(1)}s  claude P50=${(ic.latencyP50.claude / 1000).toFixed(1)}s`
      );
    }
    const fbEntries = Object.entries(ic.fallbackByTier)
      .filter(([, d]) => d.count > 0)
      .sort(([a], [b]) => a.localeCompare(b));
    if (fbEntries.length > 0) {
      const fbLine = fbEntries.map(([lvl, d]) => `${lvl} ${d.pct}% (${d.count})`).join("  ");
      console.log(`  Fallback:  ${fbLine}`);
    } else {
      console.log(`  Fallback:  0 (no fallbacks in window)`);
    }
  } else {
    console.log(`Inference: ${(ic as { status: string }).status}`);
  }

  console.log();

  const sc = report.sessionCosts;
  if ("n" in sc) {
    console.log(`Sessions (N=${sc.n})`);
    const modelLine = Object.entries(sc.modelDist)
      .sort((a, b) => b[1].count - a[1].count)
      .map(([m, d]) => {
        const short = m
          .replace("claude-", "")
          .replace(/-\d{8}$/, "")
          .replace(/-\d+\.\d+$/, "");
        return `${short} ${d.pct}% ($${d.totalCost.toFixed(2)})`;
      })
      .join("  ");
    console.log(`  Models:  ${modelLine}`);
    console.log(
      `  Total:   $${sc.totalSpend.toFixed(2)}  Avg: $${sc.avgSessionCost.toFixed(4)}/session  Cache: ${sc.cacheHitRate}%`
    );
  } else {
    console.log(`Sessions: ${(sc as { status: string }).status}`);
  }

  const lat = report.latencyPerInvocation;
  if ("n" in lat) {
    console.log(`Latency (N=${lat.n} calls)`);
    const top = lat.perSkill.slice(0, 5);
    if (top.length > 0) {
      console.log(`  Per-skill average latency:`);
      for (const row of top) {
        console.log(
          `    ${row.skill}: ${row.meanLatencyMs}ms (${row.count} calls, tier=${row.tier})`,
        );
      }
    }
    const tiers = Object.entries(lat.tierMeanMs).sort();
    if (tiers.length > 0) {
      console.log(`  Tier mean latency:`);
      for (const [tier, mean] of tiers) {
        console.log(`    ${tier}: ${mean}ms`);
      }
    }

    // Tier Compliance — cross-checks observed tier averages against the
    // canonical model set in inference-routing.yaml. Entries whose
    // model_selected isn't in the routing config (test artifacts: haiku,
    // sonnet, "x", __latency_test_*) are reported as filtered so the per-tier
    // means reflect real ollama-routed traffic only.
    try {
      const tierCompliance = computeTierCompliance();
      if (tierCompliance) {
        console.log(`  Tier Compliance:`);
        const order: Array<keyof typeof tierCompliance.byTier> = ["fast", "standard", "smart"];
        for (const t of order) {
          const row = tierCompliance.byTier[t];
          console.log(`    ${t}: ${row.calls} calls, mean ${row.meanMs}ms`);
        }
        console.log(`    Artifact entries filtered: ${tierCompliance.artifactEntries} (not in routing config)`);
      }
    } catch (e) {
      // Non-fatal: routing config missing or unparseable shouldn't break the report.
      console.log(`  Tier Compliance: unavailable (${(e as Error).message})`);
    }

    console.log();
  } else {
    console.log(`Latency: ${(lat as { status: string }).status}`);
    console.log();
  }

  // Context section — baseline token usage trends
  const ctx = parseContextSessions();
  if (ctx && ctx.n > 0) {
    console.log(`Context (N=${ctx.n} sessions measured)`);
    console.log(`  System prompt: ${ctx.sysPromptMean.toLocaleString()} tok mean  (${ctx.sysPromptMin.toLocaleString()}→${ctx.sysPromptMax.toLocaleString()} range)`);
    if (ctx.compactPctMean !== null) {
      console.log(`  At compaction: ${ctx.compactPctMean}% mean  (${ctx.compactPctMin}%→${ctx.compactPctMax}% range)`);
    }
    console.log(`  Compaction rate: ${ctx.compactCount}/${ctx.n} sessions compacted`);
    console.log();
  }

  console.log("Tripwires");

  let anyWarn = false;
  for (const t of report.tripwires) {
    if (t.status === "WARN") {
      console.log(`⚠️  WARN: ${t.name} — ${t.message}`);
      anyWarn = true;
    } else if (t.status === "INFO") {
      console.log(`ℹ️  INFO: ${t.name} — ${t.message}`);
    } else {
      console.log(`✅ OK:   ${t.name} — ${t.message}`);
    }
  }

  if (!anyWarn) console.log("✅ All WARN tripwires clear");
  console.log(div);
}

// ─── CLI entry point ───────────────────────────────────────────────────────────

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      mode: { type: "string", default: "full" },
      since: { type: "string" },
      "all-time": { type: "boolean", default: false },
      notify: { type: "boolean", default: false },
      out: { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`
ObservabilityReport.ts — PAI JSONL metrics + tripwire checker

Usage:
  bun ObservabilityReport.ts [options]

Options:
  --mode quick|full   quick=counts+tripwires, no percentiles (default: full)
  --since <ISO-date>  filter to entries >= this date (e.g. 2026-05-01); default: 7 days ago
  --all-time          override default 7-day window and read all historical data
  --notify            POST to Pulse (localhost:31337/notify) on any WARN
  --out <path>        override JSON output path
  --help              show this help

Tripwire IDs (stable, downstream consumers key on these):
  FAIL_SAFE_RATE      fail-safe rate > 5%
  FAIL_SAFE_SESSION   max fail-safes in one session > 3
  CLASSIFIER_P95      classifier P95 latency > 30s (full mode only)
  LOCAL_ESCALATION    Local inference success rate < 60%
  SKILL_LOG_ABSENT    no skill-triggers.jsonl found (INFO only, not WARN)

Exit codes:
  0  no WARN tripwires
  1  one or more WARN tripwires fired

Environment:
  PAI_DIR  PAI root directory (default: ~/.claude/PAI)
`);
    process.exit(0);
  }

  const mode =
    values.mode === "quick" || values.mode === "full" ? values.mode : "full";
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const since = values["all-time"] ? null : values.since ? new Date(values.since) : sevenDaysAgo;
  const outPath = values.out ?? DEFAULT_OUT;

  const report = computeReport({ obsDir: OBS_DIR, mode, since });

  printReport(report);

  try {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
    console.log(`\nWrote: ${outPath}\n`);
  } catch (err) {
    console.error(`Failed to write report: ${err}`);
  }

  const warns = report.tripwires.filter((t) => t.status === "WARN");
  if (values.notify && warns.length > 0) {
    const msg = `PAI tripwires blown: ${warns.map((t) => t.name).join(", ")}`;
    fetch("http://localhost:31337/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: msg, voice_enabled: false }),
    }).catch(() => {
      /* Pulse may be down — silent */
    });
  }

  process.exit(warns.length > 0 ? 1 : 0);
}
