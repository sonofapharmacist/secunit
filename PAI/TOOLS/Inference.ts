#!/usr/bin/env bun
/**
 * ============================================================================
 * INFERENCE - Unified inference tool with three run levels + advisor escalation
 * ============================================================================
 *
 * PURPOSE:
 * Single inference tool with configurable speed/capability trade-offs:
 * - Fast: Haiku - quick tasks, simple generation, basic classification
 * - Standard: Sonnet - balanced reasoning, typical analysis
 * - Smart: Opus - deep reasoning, strategic decisions, complex analysis
 * - Advisor: Smart-tier escalation for commitment-boundary review (Algorithm v3.23+ VERIFY doctrine)
 *
 * USAGE:
 *   bun Inference.ts --level fast <system_prompt> <user_prompt>
 *   bun Inference.ts --level standard <system_prompt> <user_prompt>
 *   bun Inference.ts --level smart <system_prompt> <user_prompt>
 *   bun Inference.ts --mode advisor <task> <state> <question>
 *   bun Inference.ts --mode advisor --auto-state <task> <question>   (v3.24 P5)
 *   bun Inference.ts --json --level fast <system_prompt> <user_prompt>
 *   bun Inference.ts --backend ollama <system_prompt> <user_prompt>
 *   bun Inference.ts --backend ollama --model qwen2.5-coder:14b <system_prompt> <user_prompt>
 *   bun Inference.ts --backend ollama --task-type general <system_prompt> <user_prompt>
 *   bun Inference.ts --backend antigravity-api <system_prompt> <user_prompt>
 *   bun Inference.ts --prefer-local --level fast <system_prompt> <user_prompt>
 *   bun Inference.ts --prefer-local --task-type general <system_prompt> <user_prompt>
 *   bun Inference.ts --cloud-first --level fast <system_prompt> <user_prompt>
 *
 * OPTIONS:
 *   --level <fast|standard|smart>  Run level (default: standard) — Claude only
 *   --backend <claude|ollama|antigravity|antigravity-api>  Backend to use (default: claude)
 *   --model <name>                 Ollama model name (overrides task-type selection)
 *   --task-type <code|general>     Ollama model selection: code→default_model, general→general_model
 *   --prefer-local                 Try Ollama first; escalate to Claude on failure (overrides config)
 *   --cloud-first                  Always use Claude first even if level is in prefer_local_for_levels
 *   --mode advisor                 Advisor escalation mode — 3 positional args: task, state, question
 *   --auto-state                   v3.24 P5: Auto-synthesize state from current ISA + recent activity (advisor mode only, 2 positional args: task, question)
 *   --json                         Expect and parse JSON response
 *   --timeout <ms>                 Custom timeout (default varies by level/backend)
 *
 * DEFAULTS BY LEVEL:
 *   fast:     model=haiku,   timeout=15s
 *   standard: model=sonnet,  timeout=30s
 *   smart:    model=opus,    timeout=90s
 *   advisor:  model=opus,    timeout=120s
 *
 * BILLING: Uses Claude CLI with subscription (not API key)
 * CACHE: Uses --exclude-dynamic-system-prompt-sections for cross-invocation prompt cache hits
 *
 * ADVISOR PATTERN (v3.24 Verification Doctrine — see PAI/ALGORITHM/v3.24.0.md):
 *   The advisor() function implements the Sonnet→Opus escalation checkpoint rule
 *   from R Amjad's Anthropic Advisor tool writeup. Call at commitment boundaries:
 *   - Before committing to an approach
 *   - When stuck or diverging
 *   - Once after a durable deliverable, before declaring done
 *   Skip for short reactive tasks (measured: <4 min AND <2 files — v3.24 P2).
 *   On Extended+ ISAs, phase:complete transition = MANDATORY advisor call (v3.24 P4).
 *
 *   Unlike Anthropic's native Advisor which receives the full CC session, this
 *   function takes explicit (task, state, question) parameters. The caller may
 *   supply state manually OR set autoSynthesize: true to have the helper read
 *   the current ISA + recent activity automatically (v3.24 P5 — closes the
 *   state-gaming escape hatch where the caller cherry-picks what the reviewer sees).
 *
 *   Conflict-surfacing rule: if empirical results contradict advisor output,
 *   re-call advisor with the conflict surfaced — do NOT silently switch. Max 2
 *   re-calls on the same conflict; after that, escalate to user (v3.24 P1).
 *
 * ============================================================================
 */

import { spawn } from "child_process";
import { appendFile, appendFileSync, mkdir, mkdirSync, readFileSync } from "fs";
import { hostname } from "os";
import { join } from "path";

import {
  getSkillRoutingPreference,
  inferTierFromLatency,
  loadRoutingManifest,
  resolveRoutingManifestPath,
  type Tier,
} from "./lib/tier-inference";

const AGY_BIN = join(
  process.env.HOME || process.env.USERPROFILE || '',
  '.local', 'bin', 'agy'
);

const LOCAL_AUTH_HEADERS: Record<string, string> = process.env.PAI_INFERENCE_TOKEN
  ? { Authorization: `Bearer ${process.env.PAI_INFERENCE_TOKEN}` }
  : {};

const OBSERVABILITY_DIR = join(
  process.env.HOME || process.env.USERPROFILE || '',
  '.claude', 'PAI', 'MEMORY', 'OBSERVABILITY'
);

const INFERENCE_LOG = join(
  OBSERVABILITY_DIR,
  'inference-calls.jsonl'
);

const LATENCY_BASELINE_LOG = join(OBSERVABILITY_DIR, 'latency-baseline.jsonl');

// P4: per-invocation latency log. Every inference() call appends one entry
// (success or error). Schema is append-only; consumers (ObservabilityReport,
// jq queries) key on stable field names.
export const LATENCY_PER_INVOCATION_LOG = join(
  OBSERVABILITY_DIR,
  'latency-per-invocation.jsonl',
);

export interface LatencyPerInvocationEntry {
  timestamp: string;
  model_selected: string;
  tier_used: Tier;
  backend: 'claude' | 'ollama' | 'antigravity' | 'local';
  latency_ms: number;
  status: 'success' | 'error';
  /** Resolved Ollama base URL (e.g. http://127.0.0.1:11434). Only present for ollama backend. */
  host?: string;
  /** Only present when caller passed options.skillName. */
  skill_name?: string;
  /** Only present on status === 'error'. */
  error?: string;
}

/**
 * Fire-and-forget JSONL append for per-invocation latency telemetry.
 *
 * Non-blocking by design (no await on fs.appendFile callback). Logging
 * failures (disk full, permission denied) are swallowed silently — telemetry
 * must never crash inference. Concurrent appendFile calls are atomic at the
 * line level on POSIX filesystems for writes < PIPE_BUF (4096 bytes), which
 * comfortably covers our schema.
 */
export function logLatencyPerInvocation(
  entry: LatencyPerInvocationEntry,
): void {
  try {
    mkdirSync(OBSERVABILITY_DIR, { recursive: true });
    appendFileSync(LATENCY_PER_INVOCATION_LOG, JSON.stringify(entry) + '\n', 'utf-8');
  } catch {
    // Logging failure must not surface to caller.
  }
}

export type InferenceLevel = Tier;

const ROUTING_MANIFEST_PATH = resolveRoutingManifestPath();
const UNKNOWN_ROUTING_WARNING_MODELS = new Set<string>();

const ROUTING_MODEL_TIERS: Map<string, Tier> = (() => {
  try {
    return loadRoutingManifest(ROUTING_MANIFEST_PATH);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Inference] Failed to load routing manifest at ${ROUTING_MANIFEST_PATH}: ${message}`);
    return new Map<string, Tier>();
  }
})();

export function getTierForModel(model: string, defaultTier: Tier = 'standard'): Tier {
  const manifestTier = ROUTING_MODEL_TIERS.get(model);
  if (manifestTier) {
    return manifestTier;
  }

  if (!UNKNOWN_ROUTING_WARNING_MODELS.has(model)) {
    UNKNOWN_ROUTING_WARNING_MODELS.add(model);
    // Stderr only: preserve stdout for JSON consumers and CLI piping.
    console.error(
      `[Inference] Unknown routing tier for model "${model}" in ${ROUTING_MANIFEST_PATH}; using fallback "${defaultTier}"`,
    );
  }

  return defaultTier;
}

export interface InferenceOptions {
  systemPrompt: string;
  userPrompt: string;
  level?: InferenceLevel;
  /** Route to Ollama HTTP API instead of claude subprocess. Default: 'claude'. */
  backend?: 'claude' | 'ollama' | 'antigravity' | 'antigravity-api' | 'hermes' | 'nous' | 'openrouter';
  /** Ollama model name. Defaults to ollama.default_model from PAI_CONFIG.yaml. */
  model?: string;
  expectJson?: boolean;
  timeout?: number;
  /** Optional image file paths. When provided, Read tool is enabled and paths
   * are prepended to the user prompt as @-references so Claude reads them as
   * image attachments. Routes through subscription like all other inference. */
  imagePaths?: string[];
  /** Override config fallback_enabled. true=force on, false=force off, undefined=use config. */
  fallbackToOllama?: boolean;
  /** Try Ollama before Claude. true=force on, false=force off, undefined=use config prefer_local_for_levels. */
  localFirst?: boolean;
  /** Selects Ollama model by task domain: 'code'→default_model, 'general'→general_model. Ignored when --model is set. */
  taskType?: 'code' | 'general';
  /** Optional skill name (matches skill-routing.yaml). When set, the skill's
   * preferred_tier overrides `level`, and model_hints are preferred when
   * resolving the Ollama model. Backward-compatible: callers that omit it
   * see no behavior change. */
  skillName?: string;
  /** When true, skip the warmth check in inferenceOllama(). Used by the --backend ollama direct path to honour explicit user intent. */
  skipWarmthCheck?: boolean;
}

/**
 * Resolve the routing decision for a call: tier + optional preferred Ollama model.
 *
 * Priority for tier:
 *   1. skill preferred_tier (when skillName provided and matches manifest)
 *   2. requested level (--level / options.level)
 *   3. 'standard'
 *
 * Priority for model (Ollama only):
 *   1. explicit options.model
 *   2. first skill model_hint that maps to the resolved tier in inference-routing.yaml
 *   3. (caller falls back to config defaults)
 */
export interface SkillRoutingDecision {
  tier: Tier;
  preferredModel?: string;
  source: 'skill' | 'level' | 'default';
  skillName?: string;
}

export function resolveRoutingDecision(
  skillName: string | undefined,
  requestedLevel: Tier | undefined,
): SkillRoutingDecision {
  const requested = requestedLevel ?? 'standard';

  if (!skillName) {
    return { tier: requested, source: requestedLevel ? 'level' : 'default' };
  }

  const pref = getSkillRoutingPreference(skillName);
  if (!pref.tier && !pref.modelHints) {
    // Unknown skill — fall through to requested level.
    return { tier: requested, source: requestedLevel ? 'level' : 'default', skillName };
  }

  const tier: Tier = pref.tier ?? requested;
  let preferredModel: string | undefined;

  if (pref.modelHints && pref.modelHints.length > 0) {
    for (const hint of pref.modelHints) {
      // Hint is preferred only when we know the model exists in the routing
      // manifest AND its tier matches the resolved tier.
      const hintTier = ROUTING_MODEL_TIERS.get(hint);
      if (hintTier === tier) {
        preferredModel = hint;
        break;
      }
    }
  }

  return {
    tier,
    preferredModel,
    source: pref.tier ? 'skill' : (requestedLevel ? 'level' : 'default'),
    skillName,
  };
}

export interface InferenceResult {
  success: boolean;
  output: string;
  parsed?: unknown;
  error?: string;
  latencyMs: number;
  level: InferenceLevel;
  /** Populated on Ollama calls with the model name actually used. */
  model?: string;
  /** True when Claude hit a usage/rate limit and the call was retried via Ollama. */
  fallbackUsed?: boolean;
  /** Ollama model name used for the fallback call. */
  fallbackModel?: string;
  /** True when localFirst was attempted, Ollama failed, and Claude was used instead. */
  escalatedFromLocal?: boolean;
  /** Actual prompt token count from Ollama (prompt_eval_count). Only set on Ollama calls. */
  promptTokens?: number;
  /** Actual completion token count from Ollama (eval_count). Only set on Ollama calls. */
  completionTokens?: number;
  /** Human-readable reason when fallbackUsed or escalatedFromLocal is true. */
  fallbackReason?: string;
  /** Full resolved base URL (e.g. http://127.0.0.1:11434) used for the ollama call. Present on ollama success results. */
  resolvedUrl?: string;
}

// Level configurations
const LEVEL_CONFIG: Record<InferenceLevel, { model: string; defaultTimeout: number }> = {
  fast: { model: 'haiku', defaultTimeout: 20000 },
  standard: { model: 'sonnet', defaultTimeout: 30000 },
  smart: { model: 'opus', defaultTimeout: 90000 },
};

// Advisor-specific defaults (v3.23 VERIFY doctrine).
const ADVISOR_TIMEOUT_MS = 120000;

// Default timeout for Ollama calls — 60s covers small models (<5s) and
// larger cloud-routed models (kimi-k2.6:cloud, minimax-m2.7:cloud) via Tailscale.
const OLLAMA_DEFAULT_TIMEOUT_MS = 60000;
const MEASURE_DEFAULT_TIMEOUT_MS = 90000;
const COLD_PROBE_COUNT = 1;
const WARM_PROBE_COUNT = 5;
const COLD_WARNING_THRESHOLD_MS = 3000;

// Warmth-based routing: read last N successful Ollama entries, compute P50.
// Cold (P50 > threshold OR < min samples) → skip Ollama on local-first path.
const WARMTH_SAMPLE_COUNT = 10;
const WARMTH_MIN_SAMPLES = 3;
const WARMTH_P50_THRESHOLD_MS = 3000;

// Deterministic probe text keeps every latency run comparable across invocations.
const PROBE_SYSTEM_PROMPT = 'You are a latency probe. Reply with exactly ACK.';
const PROBE_USER_PROMPT = 'ACK';

type ProbeType = 'cold' | 'warm';

export interface LatencyRecord {
  model: string;
  run: number;
  latency_ms: number;
  probe_type: ProbeType;
  inferred_tier: Tier;
  tier_override?: Tier;
  timestamp: string;
  hostname: string;
  ollama_endpoint: string;
  backend: 'ollama';
}

interface ProbeOnceOptions {
  baseUrl: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  timeoutMs: number;
}

interface ProbeOnceResult {
  latencyMs: number;
}

type ServerType = 'openai' | 'ollama';

type OpenAIChatCompletionsResponse = {
  choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
};

interface PercentileSummary {
  p50: number;
  p95: number;
  p99: number;
}

interface RunLatencyMeasureOptions {
  modelOverride?: string;
  timeoutMs?: number;
  levelOverride?: Tier;
}

const HELP_TEXT = `Usage:
  bun Inference.ts --level fast <system_prompt> <user_prompt>
  bun Inference.ts --level standard <system_prompt> <user_prompt>
  bun Inference.ts --level smart <system_prompt> <user_prompt>
  bun Inference.ts --mode advisor <task> <state> <question>
  bun Inference.ts --mode advisor --auto-state <task> <question>
  bun Inference.ts --json --level fast <system_prompt> <user_prompt>
  bun Inference.ts --backend antigravity <system_prompt> <user_prompt>
  bun Inference.ts --backend antigravity-api <system_prompt> <user_prompt>
  bun Inference.ts --backend hermes <system_prompt> <user_prompt>
  bun Inference.ts --backend nous <system_prompt> <user_prompt>
  bun Inference.ts --backend openrouter <system_prompt> <user_prompt>
  bun Inference.ts --backend openrouter --model openai/gpt-4.1 <system_prompt> <user_prompt>
  bun Inference.ts --backend ollama <system_prompt> <user_prompt>
  bun Inference.ts --backend ollama --model qwen2.5-coder:14b <system_prompt> <user_prompt>
  bun Inference.ts --backend ollama --task-type general <system_prompt> <user_prompt>
  bun Inference.ts --prefer-local --level fast <system_prompt> <user_prompt>
  bun Inference.ts --prefer-local --task-type general <system_prompt> <user_prompt>
  bun Inference.ts --cloud-first --level fast <system_prompt> <user_prompt>
  bun Inference.ts --measure --backend ollama
  bun Inference.ts --measure --backend ollama --model qwen2.5-coder:7b

  NOTE: --backend antigravity-api uses GEMINI_API_KEY (likely metered). --backend antigravity uses subscription-backed CLI.
  NOTE: --backend openrouter requires OPENROUTER_API_KEY in ~/.claude/.env

Options:
  --level <fast|standard|smart>  Run level (default: standard; auto-inferred from model latency profile during --measure when omitted) — Claude only
  --backend <claude|ollama|antigravity|antigravity-api|nous|hermes|openrouter>  Backend to use (default: claude)
  --model <name>                 Ollama model name (overrides task-type selection)
  --task-type <code|general>     Ollama model selection: code→default_model, general→general_model
  --prefer-local                 Try Ollama first; escalate to Claude on failure (overrides config)
  --cloud-first                  Always use Claude first even if level is in prefer_local_for_levels
  --mode advisor                 Advisor escalation mode — 3 positional args: task, state, question
  --auto-state                   Auto-synthesize state from current ISA + recent activity (advisor mode only)
  --json                         Expect and parse JSON response
  --timeout <ms>                 Custom timeout (default varies by level/backend; --measure defaults to 90000ms per probe)
  --measure                      Run Ollama latency probes and append results to observability logs
  --help                         Show this help text`;

export interface OllamaConfig {
  baseUrl: string;
  defaultModel: string;
  /** General-purpose model (non-code tasks). Selected via --task-type general. */
  generalModel: string;
  /** Auto-fallback to Ollama when Claude hits usage/rate limits. Default: true. */
  fallbackEnabled: boolean;
  /** Model per inference level to use when falling back from Claude. */
  fallbackModels: Record<InferenceLevel, string>;
  /** Levels that route to Ollama first (localFirst behavior) without explicit flag. Default: []. */
  preferLocalForLevels: InferenceLevel[];
  /** Route ALL tiers to Ollama first — weekend/token-limit override. Default: false. */
  localMode: boolean;
  /** Maps preferred_host names (host1, host2) to base URLs. Port for host2 comes from inference-routing.yaml per model. */
  inferenceHosts?: Record<string, string>;
}

const DEFAULT_GENERAL_MODEL = 'gemma4:latest';

const DEFAULT_FALLBACK_MODELS: Record<InferenceLevel, string> = {
  fast: 'qwen2.5-coder:7b',       // lightweight — fast-tier PAI calls are sentiment/classification
  standard: 'qwen3:30b-a3b',      // Qwen3 MoE (~3B active), strong reasoning — replaces Sonnet for mode classification
  smart: 'qwen3:30b-a3b',         // best available locally — replaces Opus for advisor calls
};

// Code default is safe (empty = all levels go Claude-first).
// PAI_CONFIG.yaml prefer_local_for_levels overrides this per installation.
const DEFAULT_PREFER_LOCAL_LEVELS: InferenceLevel[] = [];

/**
 * Read Ollama connection config from PAI_CONFIG.yaml.
 * Returns fallback values on any error — never throws.
 */
export async function readOllamaConfig(): Promise<OllamaConfig> {
  const fallback: OllamaConfig = {
    baseUrl: 'http://localhost:11434',
    defaultModel: 'qwen2.5-coder:7b',
    generalModel: DEFAULT_GENERAL_MODEL,
    fallbackEnabled: true,
    fallbackModels: { ...DEFAULT_FALLBACK_MODELS },
    preferLocalForLevels: [...DEFAULT_PREFER_LOCAL_LEVELS],
    localMode: false,
  };
  try {
    const { readFile } = await import("fs/promises");
    const { join } = await import("path");
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const configPath = join(home, '.claude', 'PAI', 'USER', 'Config', 'PAI_CONFIG.yaml');
    const raw = await readFile(configPath, 'utf-8');
    const cfg = Bun.YAML.parse(raw) as Record<string, unknown>;
    const ollama = cfg?.ollama as Record<string, unknown> | undefined;
    const yamlFallbackModels = ollama?.fallback_models as Record<string, string> | undefined;
    const inferenceHosts = ollama?.inference_hosts as Record<string, string> | undefined;
    // PAI_PREFER_LOCAL_HOST overrides the default base_url. Set in your shell rc
    // per machine (e.g. `export PAI_PREFER_LOCAL_HOST=autogen` at work) so the
    // initial health check and per-model routing both target the same host.
    const envHost = process.env.PAI_PREFER_LOCAL_HOST?.trim();
    const envBaseUrl = envHost ? inferenceHosts?.[envHost] : undefined;
    return {
      baseUrl: envBaseUrl || (ollama?.base_url as string) || fallback.baseUrl,
      defaultModel: (ollama?.default_model as string) || fallback.defaultModel,
      generalModel: (ollama?.general_model as string) || fallback.generalModel,
      fallbackEnabled: ollama?.fallback_enabled !== undefined
        ? Boolean(ollama.fallback_enabled)
        : fallback.fallbackEnabled,
      fallbackModels: {
        fast: yamlFallbackModels?.fast || DEFAULT_FALLBACK_MODELS.fast,
        standard: yamlFallbackModels?.standard || DEFAULT_FALLBACK_MODELS.standard,
        smart: yamlFallbackModels?.smart || DEFAULT_FALLBACK_MODELS.smart,
      },
      preferLocalForLevels: (() => {
        const raw = ollama?.prefer_local_for_levels;
        if (!Array.isArray(raw)) return fallback.preferLocalForLevels;
        return (raw as string[]).filter((v): v is InferenceLevel =>
          ['fast', 'standard', 'smart'].includes(v)
        );
      })(),
      localMode: ollama?.local_mode !== undefined ? Boolean(ollama.local_mode) : false,
      inferenceHosts: (() => {
        const hosts = ollama?.inference_hosts as Record<string, string> | undefined;
        return hosts && typeof hosts === 'object' ? hosts : undefined;
      })(),
    };
  } catch {
    return fallback;
  }
}

export interface AgyConfig {
  enabled: boolean;
  timeoutMs: number;
  restApiEnabled: boolean;
  restApiTimeoutMs: number;
  restApiEndpoint: string;
  restApiAgent: string;
  restApiRevision: string;
  preferForLevels: InferenceLevel[];
}

/**
 * Read Antigravity (agy CLI + Interactions REST API) config from PAI_CONFIG.yaml.
 * Returns fallback values on any error — never throws.
 *
 * BILLING NOTE: restApiEnabled defaults to false because the Interactions REST
 * endpoint uses GEMINI_API_KEY (likely per-token metered), unlike the agy CLI
 * path which is subscription-backed via OAuth.
 */
export async function readAgyConfig(): Promise<AgyConfig> {
  const fallback: AgyConfig = {
    enabled: true,
    timeoutMs: 60000,
    restApiEnabled: false,  // off by default — billing risk
    restApiTimeoutMs: 30000,
    restApiEndpoint: 'https://generativelanguage.googleapis.com/v1beta/interactions',
    restApiAgent: 'antigravity-preview-05-2026',
    restApiRevision: '2026-05-20',
    preferForLevels: [],
  };
  try {
    const { readFile } = await import('fs/promises');
    const { join } = await import('path');
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const configPath = join(home, '.claude', 'PAI', 'USER', 'Config', 'PAI_CONFIG.yaml');
    const raw = await readFile(configPath, 'utf-8');
    const cfg = Bun.YAML.parse(raw) as Record<string, unknown>;
    const agy = cfg?.agy as Record<string, unknown> | undefined;
    if (!agy) return fallback;
    return {
      enabled: agy.enabled !== undefined ? Boolean(agy.enabled) : fallback.enabled,
      timeoutMs: typeof agy.cli_timeout_ms === 'number' ? agy.cli_timeout_ms : fallback.timeoutMs,
      restApiEnabled: agy.rest_api_enabled !== undefined ? Boolean(agy.rest_api_enabled) : fallback.restApiEnabled,
      restApiTimeoutMs: typeof agy.rest_api_timeout_ms === 'number' ? agy.rest_api_timeout_ms : fallback.restApiTimeoutMs,
      restApiEndpoint: typeof agy.rest_api_endpoint === 'string' ? agy.rest_api_endpoint : fallback.restApiEndpoint,
      restApiAgent: typeof agy.rest_api_agent === 'string' ? agy.rest_api_agent : fallback.restApiAgent,
      restApiRevision: typeof agy.rest_api_revision === 'string' ? agy.rest_api_revision : fallback.restApiRevision,
      preferForLevels: (() => {
        const rawLevels = agy.prefer_for_levels;
        if (!Array.isArray(rawLevels)) return fallback.preferForLevels;
        return (rawLevels as string[]).filter((v): v is InferenceLevel => ['fast', 'standard', 'smart'].includes(v));
      })(),
    };
  } catch {
    return fallback;
  }
}

/**
 * Resolve the Ollama base URL for a specific model using inference-routing.yaml.
 * Reads preferred_host and host2.port from the routing manifest, maps them via
 * config.inferenceHosts. Falls back to config.baseUrl on any error or missing data.
 */
export async function resolveBaseUrlForModel(model: string, config: OllamaConfig): Promise<string> {
  if (!model || !config.inferenceHosts) return config.baseUrl;
  try {
    const raw = readFileSync(ROUTING_MANIFEST_PATH, 'utf-8');
    const manifest = Bun.YAML.parse(raw) as {
      models?: Record<string, Record<string, unknown> & {
        preferred_host?: string;
        host2?: { port?: number; excluded?: boolean };
      }>;
    };
    const entry = manifest?.models?.[model];
    if (!entry) return config.baseUrl;

    const buildUrl = (hostKey: string): string | null => {
      const hostBase = config.inferenceHosts?.[hostKey];
      if (!hostBase) return null;
      const section = entry[hostKey] as { port?: number; excluded?: boolean } | undefined;
      if (!section || section.excluded) return null;
      if (hostKey === 'host2') {
        const port = section.port;
        if (!port) return null;
        return `${hostBase}:${port}`;
      }
      return hostBase;
    };

    // PAI_PREFER_LOCAL_HOST overrides preferred_host. When the model has a
    // non-excluded section for that host, use its URL. When there is no
    // model-specific section (e.g. qwen3:14b has no autogen block), fall back
    // to config.baseUrl — already resolved to this host's URL — rather than
    // falling through to preferred_host which may be on a different network.
    const envHost = process.env.PAI_PREFER_LOCAL_HOST?.trim();
    if (envHost) {
      const url = buildUrl(envHost);
      if (url) return url;
      if (config.inferenceHosts?.[envHost]) return config.baseUrl;
    }

    if (!entry.preferred_host) return config.baseUrl;
    return buildUrl(entry.preferred_host) ?? config.baseUrl;
  } catch {
    return config.baseUrl;
  }
}

/**
 * Returns the actual model ID loaded on an OpenAI-compatible llama-server by querying /v1/models,
 * then checks inference-routing.yaml for requires_no_think. Used to inject /no_think prefix for
 * qwen3-family models that emit empty content when thinking mode is active.
 */
async function getActiveModelRequiresNoThink(baseUrl: string, requestedModel: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    const resp = await fetch(`${baseUrl}/v1/models`, { signal: controller.signal, headers: LOCAL_AUTH_HEADERS });
    clearTimeout(id);
    if (!resp.ok) return false;
    const data = await resp.json() as { data?: Array<{ id: string }> };
    const activeModel = data.data?.[0]?.id ?? requestedModel;
    const raw = readFileSync(ROUTING_MANIFEST_PATH, 'utf-8');
    const manifest = Bun.YAML.parse(raw) as { models?: Record<string, { requires_no_think?: boolean }> };
    return manifest?.models?.[activeModel]?.requires_no_think === true;
  } catch {
    return false;
  }
}

const USAGE_LIMIT_PATTERNS = [
  /usage.?limit/i,
  /rate.?limit/i,
  /quota/i,
  /too.?many.?requests/i,
  /overloaded/i,
  /\b529\b/,
  /\b429\b/,
  /monthly.*limit/i,
  /exceeded.*limit/i,
  /limit.*exceeded/i,
];

function isUsageLimitError(text: string): boolean {
  return USAGE_LIMIT_PATTERNS.some((p) => p.test(text));
}

function getHostFromBaseUrl(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl.replace(/^https?:\/\//, '');
  }
}

async function detectServerType(baseUrl: string, timeoutMs = 3000): Promise<ServerType> {
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(`${baseUrl}/v1/models`, { signal: controller.signal, headers: LOCAL_AUTH_HEADERS });
    clearTimeout(id);
    if (response.ok) return 'openai';
  } catch {}
  return 'ollama';
}

function logInferenceCall(
  backend: 'claude' | 'local' | 'antigravity',
  result: InferenceResult,
  level: InferenceLevel,
  taskType?: 'code' | 'general',
): void {
  try {
    const base: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      backend,
      level,
      task_type: taskType ?? 'code',
      latency_ms: result.latencyMs,
      model: result.model ?? result.fallbackModel ?? level,
      fallback_used: result.fallbackUsed ?? false,
      escalated_from_local: result.escalatedFromLocal ?? false,
    };
    if (result.promptTokens !== undefined) base.prompt_tokens = result.promptTokens;
    if (result.completionTokens !== undefined) base.completion_tokens = result.completionTokens;
    if (result.fallbackReason !== undefined) base.fallback_reason = result.fallbackReason;
    appendFileSync(INFERENCE_LOG, JSON.stringify(base) + '\n');
  } catch {
    // Fire-and-forget — logging failure must never propagate
  }
}

async function checkOllamaHealth(baseUrl: string, timeoutMs = 2000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    let res = await fetch(`${baseUrl}/health`, { signal: controller.signal, headers: LOCAL_AUTH_HEADERS });
    if (!res.ok) {
      res = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal, headers: LOCAL_AUTH_HEADERS });
    }
    clearTimeout(id);
    if (res.ok) return true;
    return await detectServerType(baseUrl, timeoutMs) === 'openai';
  } catch {
    return false;
  }
}

interface WarmthCheck {
  warm: boolean;
  p50: number | null;
  sampleCount: number;
  reason: string;
}

/**
 * Read the tail of latency-per-invocation.jsonl and return latency_ms values
 * for the last `count` successful Ollama calls.
 */
function readOllamaWarmthSamples(count: number = WARMTH_SAMPLE_COUNT, host?: string): number[] {
  try {
    const raw = readFileSync(LATENCY_PER_INVOCATION_LOG, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);
    const samples: number[] = [];
    for (let i = lines.length - 1; i >= 0 && samples.length < count; i--) {
      try {
        const entry = JSON.parse(lines[i]) as LatencyPerInvocationEntry;
        if (entry.backend === 'ollama' && entry.status === 'success' && (host === undefined || entry.host === host)) {
          samples.push(entry.latency_ms);
        }
      } catch { /* skip malformed lines */ }
    }
    return samples;
  } catch {
    return []; // file not found or unreadable → treat as cold
  }
}

function computeMedian(values: number[]): number {
  if (values.length === 0) return Infinity;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function checkOllamaWarmth(host?: string): WarmthCheck {
  try {
    const samples = readOllamaWarmthSamples(WARMTH_SAMPLE_COUNT, host);
    const hostSuffix = host ? ` at ${host}` : '';
    if (samples.length < WARMTH_MIN_SAMPLES) {
      // Per-host: insufficient samples = warm (give-it-a-chance). Without per-host data we
      // cannot conclude cold — attempting the call is the only way to accumulate samples.
      // Host-blind mode preserves original cold-on-insufficient semantics (no bootstrap issue).
      const warmOnInsufficient = host !== undefined;
      return {
        warm: warmOnInsufficient,
        p50: null,
        sampleCount: samples.length,
        reason: `only ${samples.length} recent Ollama samples (min ${WARMTH_MIN_SAMPLES})${hostSuffix}`,
      };
    }
    const p50 = computeMedian(samples);
    if (p50 > WARMTH_P50_THRESHOLD_MS) {
      return {
        warm: false,
        p50,
        sampleCount: samples.length,
        reason: `P50=${Math.round(p50)}ms > ${WARMTH_P50_THRESHOLD_MS}ms threshold${hostSuffix}`,
      };
    }
    return { warm: true, p50, sampleCount: samples.length, reason: `warm${hostSuffix}` };
  } catch {
    return { warm: false, p50: null, sampleCount: 0, reason: 'warmth check error' };
  }
}

function selectModelsForMeasure(config: OllamaConfig, modelOverride?: string): string[] {
  if (modelOverride) {
    return [modelOverride];
  }

  const models: string[] = [];
  for (const candidate of [config.defaultModel, config.generalModel]) {
    if (candidate && !models.includes(candidate)) {
      models.push(candidate);
    }
  }
  return models;
}

async function probeOnce(options: ProbeOnceOptions): Promise<ProbeOnceResult> {
  const serverType = await detectServerType(options.baseUrl);
  const url = serverType === 'openai'
    ? `${options.baseUrl}/v1/chat/completions`
    : `${options.baseUrl}/api/chat`;

  const requiresNoThink = serverType === 'openai'
    ? await getActiveModelRequiresNoThink(options.baseUrl, options.model)
    : false;
  const systemContent = requiresNoThink
    ? `/no_think\n${options.systemPrompt}`
    : options.systemPrompt;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const startTime = Date.now();
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...LOCAL_AUTH_HEADERS },
      signal: controller.signal,
      body: JSON.stringify({
        model: options.model,
        ...(serverType === 'openai'
          ? {
              messages: [
                { role: 'system', content: systemContent },
                { role: 'user', content: options.userPrompt },
              ],
              max_tokens: 50,
              stream: false,
            }
          : {
              messages: [
                { role: 'system', content: options.systemPrompt },
                { role: 'user', content: options.userPrompt },
              ],
              stream: false,
            }),
      }),
    });
    const latencyMs = Date.now() - startTime;
    clearTimeout(timeoutId);

    if (!response.ok) {
      let errBody = '';
      try {
        errBody = await response.text();
      } catch {
        // Best-effort error detail only.
      }
      throw new Error(`Server ${response.status} at ${url} (model: ${options.model}): ${errBody}`);
    }

    if (serverType === 'openai') {
      const payload = await response.json() as OpenAIChatCompletionsResponse;
      const msg = payload.choices?.[0]?.message;
      const hasContent = (msg?.content ?? '').trim().length > 0;
      const hasReasoning = (msg?.reasoning_content ?? '').trim().length > 0;
      if (!hasContent && !hasReasoning) {
        throw new Error(`Empty response content at ${url} (model: ${options.model})`);
      }
    }

    return { latencyMs };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Timeout after ${options.timeoutMs}ms (url: ${url}, model: ${options.model})`);
    }
    throw err instanceof Error
      ? err
      : new Error(`Network error: ${String(err)} (url: ${url}, model: ${options.model})`);
  }
}

function computePercentiles(values: number[]): PercentileSummary {
  if (values.length === 0) {
    throw new Error('computePercentiles requires at least one value');
  }

  if (values.length === 1) {
    const only = values[0];
    return { p50: only, p95: only, p99: only };
  }

  const sorted = [...values].sort((a, b) => a - b);

  // Nearest-rank percentile: rank = ceil((p / 100) * N), then use 1-based rank.
  const nearestRank = (percentile: number): number => {
    const rank = Math.ceil((percentile / 100) * sorted.length);
    return sorted[Math.max(0, Math.min(sorted.length - 1, rank - 1))];
  };

  return {
    p50: nearestRank(50),
    p95: nearestRank(95),
    p99: nearestRank(99),
  };
}

async function runLatencyMeasure(options: RunLatencyMeasureOptions): Promise<void> {
  const config = await readOllamaConfig();
  const models = selectModelsForMeasure(config, options.modelOverride);
  const timeoutMs = options.timeoutMs ?? MEASURE_DEFAULT_TIMEOUT_MS;
  const totalProbeCount = models.length * (COLD_PROBE_COUNT + WARM_PROBE_COUNT);
  const overallTimeoutMs = (timeoutMs * totalProbeCount) + 5000;

  const measureRun = async (): Promise<void> => {
    if (models.length === 0) {
      throw new Error('No Ollama models available for latency measurement.');
    }

    const ollamaReachable = await checkOllamaHealth(config.baseUrl);
    if (!ollamaReachable) {
      throw new Error(`Ollama unreachable at ${config.baseUrl} (health check failed)`);
    }

    mkdirSync(OBSERVABILITY_DIR, { recursive: true });
    const host = hostname();
    const summary = new Map<string, { cold: number[]; warm: number[] }>();

    for (const model of models) {
      const latencies = { cold: [] as number[], warm: [] as number[] };
      summary.set(model, latencies);
      let inferredTier: Tier | undefined;

      for (let run = 1; run <= COLD_PROBE_COUNT + WARM_PROBE_COUNT; run++) {
        const probe_type: ProbeType = run === 1 ? 'cold' : 'warm';
        const probe = await probeOnce({
          baseUrl: config.baseUrl,
          model,
          systemPrompt: PROBE_SYSTEM_PROMPT,
          userPrompt: PROBE_USER_PROMPT,
          timeoutMs,
        });

        latencies[probe_type].push(probe.latencyMs);
        if (probe_type === 'cold') {
          inferredTier = getTierForModel(model, inferTierFromLatency(probe.latencyMs));
        }
        const resolvedTier = inferredTier ?? getTierForModel(model, 'standard');

        const record: LatencyRecord = {
          model,
          run,
          latency_ms: probe.latencyMs,
          probe_type,
          inferred_tier: resolvedTier,
          ...(options.levelOverride ? { tier_override: options.levelOverride } : {}),
          timestamp: new Date().toISOString(),
          hostname: host,
          ollama_endpoint: config.baseUrl,
          backend: 'ollama',
        };

        appendFileSync(LATENCY_BASELINE_LOG, JSON.stringify(record) + '\n');

        // Keep measurement events in the standard inference observability stream
        // without changing the normal logInferenceCall output for non-measure runs.
        appendFileSync(INFERENCE_LOG, JSON.stringify({
          timestamp: record.timestamp,
          backend: 'ollama',
          level: 'standard',
          task_type: 'general',
          latency_ms: probe.latencyMs,
          model,
          fallback_used: false,
          escalated_from_local: false,
          measurement_type: 'latency',
          probe_type,
          run,
          inferred_tier: record.inferred_tier,
          ...(record.tier_override ? { tier_override: record.tier_override } : {}),
          ollama_endpoint: config.baseUrl,
          hostname: host,
        }) + '\n');
      }
    }

    for (const model of models) {
      const latencies = summary.get(model);
      if (!latencies) {
        continue;
      }

      const coldPercentiles = computePercentiles(latencies.cold);
      const warmPercentiles = computePercentiles(latencies.warm);
      const summaryTier = getTierForModel(model, inferTierFromLatency(coldPercentiles.p50));
      const warning = coldPercentiles.p50 > COLD_WARNING_THRESHOLD_MS ? ' ⚠ COLD > 3000ms' : '';
      const tierSummary = options.levelOverride
        ? `tier_override=${options.levelOverride}, inferred_tier=${summaryTier}, `
        : `inferred_tier=${summaryTier}, `;
      console.log(
        `${model}: ${tierSummary}cold ${coldPercentiles.p50}ms, warm p50 ${warmPercentiles.p50}ms, ` +
        `warm p95 ${warmPercentiles.p95}ms, warm p99 ${warmPercentiles.p99}ms${warning}`
      );
    }
  };

  let overallTimeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      measureRun(),
      new Promise<never>((_, reject) => {
        overallTimeoutId = setTimeout(
          () => reject(new Error(`Latency measurement timed out after ${overallTimeoutMs}ms`)),
          overallTimeoutMs,
        );
      }),
    ]);
  } finally {
    if (overallTimeoutId) {
      clearTimeout(overallTimeoutId);
    }
  }
}

export interface NousConfig {
  enabled: boolean;
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
  timeoutMs: number;
  fallbackToSonnet: boolean;
}

export async function readNousConfig(): Promise<NousConfig> {
  const fallback: NousConfig = {
    enabled: true,
    baseUrl: 'https://inference-api.nousresearch.com/v1',
    model: 'nvidia/nemotron-3-ultra:free',
    apiKeyEnv: 'NOUS_API_KEY',
    timeoutMs: 45000,
    fallbackToSonnet: true,
  };
  try {
    const { readFile } = await import('fs/promises');
    const { join } = await import('path');
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const configPath = join(home, '.claude', 'PAI', 'USER', 'Config', 'PAI_CONFIG.yaml');
    const raw = await readFile(configPath, 'utf-8');
    const cfg = Bun.YAML.parse(raw) as Record<string, unknown>;
    const nous = cfg?.nous as Record<string, unknown> | undefined;
    if (!nous) return fallback;
    return {
      enabled: nous.enabled !== undefined ? Boolean(nous.enabled) : fallback.enabled,
      baseUrl: typeof nous.base_url === 'string' ? nous.base_url : fallback.baseUrl,
      model: typeof nous.model === 'string' ? nous.model : fallback.model,
      apiKeyEnv: typeof nous.api_key_env === 'string' ? nous.api_key_env : fallback.apiKeyEnv,
      timeoutMs: typeof nous.timeout_ms === 'number' ? nous.timeout_ms : fallback.timeoutMs,
      fallbackToSonnet: nous.fallback_to_sonnet !== undefined ? Boolean(nous.fallback_to_sonnet) : fallback.fallbackToSonnet,
    };
  } catch {
    return fallback;
  }
}

export interface OpenRouterConfig {
  enabled: boolean;
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
  timeoutMs: number;
  fallbackToSonnet: boolean;
}

export async function readOpenRouterConfig(): Promise<OpenRouterConfig> {
  const fallback: OpenRouterConfig = {
    enabled: true,
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'anthropic/claude-sonnet-4-6',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    timeoutMs: 45000,
    fallbackToSonnet: true,
  };
  try {
    const { readFile } = await import('fs/promises');
    const { join } = await import('path');
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const configPath = join(home, '.claude', 'PAI', 'USER', 'Config', 'PAI_CONFIG.yaml');
    const raw = await readFile(configPath, 'utf-8');
    const cfg = Bun.YAML.parse(raw) as Record<string, unknown>;
    const or = cfg?.openrouter as Record<string, unknown> | undefined;
    if (!or) return fallback;
    return {
      enabled: or.enabled !== undefined ? Boolean(or.enabled) : fallback.enabled,
      baseUrl: typeof or.base_url === 'string' ? or.base_url : fallback.baseUrl,
      model: typeof or.model === 'string' ? or.model : fallback.model,
      apiKeyEnv: typeof or.api_key_env === 'string' ? or.api_key_env : fallback.apiKeyEnv,
      timeoutMs: typeof or.timeout_ms === 'number' ? or.timeout_ms : fallback.timeoutMs,
      fallbackToSonnet: or.fallback_to_sonnet !== undefined ? Boolean(or.fallback_to_sonnet) : fallback.fallbackToSonnet,
    };
  } catch {
    return fallback;
  }
}

export interface HermesConfig {
  enabled: boolean;
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

export async function readHermesConfig(): Promise<HermesConfig> {
  const fallback: HermesConfig = {
    enabled: false,
    baseUrl: 'http://127.0.0.1:8645',
    model: 'deepseek/deepseek-v4-flash:free',
    timeoutMs: 30000,
  };
  try {
    const { readFile } = await import('fs/promises');
    const { join } = await import('path');
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const configPath = join(home, '.claude', 'PAI', 'USER', 'Config', 'PAI_CONFIG.yaml');
    const raw = await readFile(configPath, 'utf-8');
    const cfg = Bun.YAML.parse(raw) as Record<string, unknown>;
    const hermes = cfg?.hermes as Record<string, unknown> | undefined;
    if (!hermes) return fallback;
    return {
      enabled: hermes.enabled !== undefined ? Boolean(hermes.enabled) : fallback.enabled,
      baseUrl: typeof hermes.base_url === 'string' ? hermes.base_url : fallback.baseUrl,
      model: typeof hermes.model === 'string' ? hermes.model : fallback.model,
      timeoutMs: typeof hermes.timeout_ms === 'number' ? hermes.timeout_ms : fallback.timeoutMs,
    };
  } catch {
    return fallback;
  }
}

async function inferenceOpenRouter(options: InferenceOptions): Promise<InferenceResult> {
  const startTime = Date.now();
  const config = await readOpenRouterConfig();
  const apiKey = process.env[config.apiKeyEnv];
  if (!apiKey) {
    return {
      success: false, output: '',
      error: `${config.apiKeyEnv} not set — required for --backend openrouter`,
      latencyMs: Date.now() - startTime,
      level: options.level ?? 'standard',
      model: config.model,
    };
  }
  const timeout = options.timeout ?? config.timeoutMs;
  const model = options.model ?? config.model;
  const url = `${config.baseUrl}/chat/completions`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://your-domain.example.com',
        'X-Title': 'PAI',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: options.systemPrompt ?? '' },
          { role: 'user', content: options.userPrompt },
        ],
        max_tokens: 4096,
        stream: false,
      }),
    });

    clearTimeout(timeoutId);
    const latencyMs = Date.now() - startTime;

    if (!response.ok) {
      let errBody = '';
      try { errBody = await response.text(); } catch { /* ignore */ }
      return {
        success: false, output: '',
        error: `OpenRouter API ${response.status}: ${errBody.slice(0, 200)}`,
        latencyMs, level: options.level ?? 'standard', model,
      };
    }

    const data = await response.json() as OpenAIChatCompletionsResponse;
    const output = (data.choices?.[0]?.message?.content ?? '').trim();
    const promptTokens = data.usage?.prompt_tokens;
    const completionTokens = data.usage?.completion_tokens;

    if (!options.expectJson) {
      return { success: true, output, latencyMs, level: options.level ?? 'standard', model, promptTokens, completionTokens };
    }

    const objectMatch = output.match(/\{[\s\S]*\}/);
    const arrayMatch = output.match(/\[[\s\S]*\]/);
    for (const candidate of [objectMatch?.[0], arrayMatch?.[0]]) {
      if (!candidate) continue;
      try {
        const parsed = JSON.parse(candidate);
        return { success: true, output, parsed, latencyMs, level: options.level ?? 'standard', model, promptTokens, completionTokens };
      } catch { /* try next */ }
    }
    return { success: false, output, error: 'Failed to parse JSON response', latencyMs, level: options.level ?? 'standard', model };

  } catch (err) {
    clearTimeout(timeoutId);
    const latencyMs = Date.now() - startTime;
    const isAbort = err instanceof Error && err.name === 'AbortError';
    return {
      success: false, output: '',
      error: isAbort
        ? `Timeout after ${timeout}ms (OpenRouter at ${url})`
        : `Network error: ${(err as Error).message} (OpenRouter at ${url})`,
      latencyMs, level: options.level ?? 'standard', model,
    };
  }
}

async function inferenceHermes(options: InferenceOptions): Promise<InferenceResult> {
  const startTime = Date.now();
  const config = await readHermesConfig();
  const timeout = options.timeout ?? config.timeoutMs;
  const model = options.model ?? config.model;
  const url = `${config.baseUrl}/v1/chat/completions`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: options.systemPrompt ?? '' },
          { role: 'user', content: options.userPrompt },
        ],
        max_tokens: 2048,
        stream: false,
      }),
    });

    clearTimeout(timeoutId);
    const latencyMs = Date.now() - startTime;

    if (!response.ok) {
      let errBody = '';
      try { errBody = await response.text(); } catch { /* ignore */ }
      return {
        success: false, output: '',
        error: `Hermes proxy ${response.status}: ${errBody.slice(0, 200)}`,
        latencyMs, level: options.level ?? 'standard', model,
      };
    }

    const data = await response.json() as OpenAIChatCompletionsResponse;
    const output = (data.choices?.[0]?.message?.content ?? '').trim();
    const promptTokens = data.usage?.prompt_tokens;
    const completionTokens = data.usage?.completion_tokens;

    if (!options.expectJson) {
      return { success: true, output, latencyMs, level: options.level ?? 'standard', model, promptTokens, completionTokens };
    }

    const objectMatch = output.match(/\{[\s\S]*\}/);
    const arrayMatch = output.match(/\[[\s\S]*\]/);
    for (const candidate of [objectMatch?.[0], arrayMatch?.[0]]) {
      if (!candidate) continue;
      try {
        const parsed = JSON.parse(candidate);
        return { success: true, output, parsed, latencyMs, level: options.level ?? 'standard', model, promptTokens, completionTokens };
      } catch { /* try next */ }
    }
    return { success: false, output, error: 'Failed to parse JSON response', latencyMs, level: options.level ?? 'standard', model };

  } catch (err) {
    clearTimeout(timeoutId);
    const latencyMs = Date.now() - startTime;
    const isAbort = err instanceof Error && err.name === 'AbortError';
    return {
      success: false, output: '',
      error: isAbort
        ? `Timeout after ${timeout}ms (Hermes proxy at ${url})`
        : `Network error: ${(err as Error).message} (Hermes proxy at ${url})`,
      latencyMs, level: options.level ?? 'standard', model,
    };
  }
}

async function inferenceNous(options: InferenceOptions): Promise<InferenceResult> {
  const startTime = Date.now();
  const config = await readNousConfig();
  const apiKey = process.env[config.apiKeyEnv];
  if (!apiKey) {
    return {
      success: false, output: '',
      error: `${config.apiKeyEnv} not set — required for --backend nous`,
      latencyMs: Date.now() - startTime,
      level: options.level ?? 'standard',
      model: config.model,
    };
  }
  const timeout = options.timeout ?? config.timeoutMs;
  const model = options.model ?? config.model;
  const url = `${config.baseUrl}/chat/completions`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: options.systemPrompt ?? '' },
          { role: 'user', content: options.userPrompt },
        ],
        max_tokens: 4096,
        stream: false,
      }),
    });

    clearTimeout(timeoutId);
    const latencyMs = Date.now() - startTime;

    if (!response.ok) {
      let errBody = '';
      try { errBody = await response.text(); } catch { /* ignore */ }
      return {
        success: false, output: '',
        error: `Nous API ${response.status}: ${errBody.slice(0, 200)}`,
        latencyMs, level: options.level ?? 'standard', model,
      };
    }

    const data = await response.json() as OpenAIChatCompletionsResponse;
    const output = (data.choices?.[0]?.message?.content ?? '').trim();
    const promptTokens = data.usage?.prompt_tokens;
    const completionTokens = data.usage?.completion_tokens;

    if (!options.expectJson) {
      return { success: true, output, latencyMs, level: options.level ?? 'standard', model, promptTokens, completionTokens };
    }

    const objectMatch = output.match(/\{[\s\S]*\}/);
    const arrayMatch = output.match(/\[[\s\S]*\]/);
    for (const candidate of [objectMatch?.[0], arrayMatch?.[0]]) {
      if (!candidate) continue;
      try {
        const parsed = JSON.parse(candidate);
        return { success: true, output, parsed, latencyMs, level: options.level ?? 'standard', model, promptTokens, completionTokens };
      } catch { /* try next */ }
    }
    return { success: false, output, error: 'Failed to parse JSON response', latencyMs, level: options.level ?? 'standard', model };

  } catch (err) {
    clearTimeout(timeoutId);
    const latencyMs = Date.now() - startTime;
    const isAbort = err instanceof Error && err.name === 'AbortError';
    return {
      success: false, output: '',
      error: isAbort
        ? `Timeout after ${timeout}ms (Nous API at ${url})`
        : `Network error: ${(err as Error).message} (Nous API at ${url})`,
      latencyMs, level: options.level ?? 'standard', model,
    };
  }
}

/**
 * Run inference against Ollama's /api/chat endpoint via HTTP fetch.
 * Uses Bun's native fetch — no child_process.spawn.
 */
async function inferenceOllama(options: InferenceOptions): Promise<InferenceResult> {
  const startTime = Date.now();
  const timeout = options.timeout ?? OLLAMA_DEFAULT_TIMEOUT_MS;

  const config = await readOllamaConfig();
  const model = options.model || (options.taskType === 'general' ? config.generalModel : config.defaultModel);
  const resolvedBaseUrl = await resolveBaseUrlForModel(model, config);
  const serverType = await detectServerType(resolvedBaseUrl);

  // Pre-flight: if routed to a remote host, verify reachability before committing to the full timeout.
  if (resolvedBaseUrl !== config.baseUrl && serverType === 'ollama') {
    const reachable = await checkOllamaHealth(resolvedBaseUrl, 2000);
    if (!reachable) {
      return {
        success: false,
        output: '',
        error: `Remote host unreachable: ${resolvedBaseUrl}`,
        latencyMs: Date.now() - startTime,
        level: options.level ?? 'standard',
        model,
      };
    }
  }

  // Per-GPU warmth check: skip Ollama if this endpoint's recent P50 indicates a cold model.
  if (!options.skipWarmthCheck) {
    const warmth = checkOllamaWarmth(resolvedBaseUrl);
    if (!warmth.warm) {
      console.error(`[Inference] Ollama cold at ${resolvedBaseUrl} (${warmth.reason}) — routing to Claude directly`);
      return {
        success: false,
        output: '',
        error: `Server cold: ${warmth.reason}`,
        fallbackReason: `server_cold: ${warmth.reason}`,
        latencyMs: Date.now() - startTime,
        level: options.level ?? 'standard',
        model,
      };
    }
  }

  const url = serverType === 'openai'
    ? `${resolvedBaseUrl}/v1/chat/completions`
    : `${resolvedBaseUrl}/api/chat`;

  // For llama.cpp OpenAI-compatible servers, check if the active model requires /no_think.
  // qwen3-family models emit empty content with all output in reasoning_content when thinking
  // mode is active; /no_think prefix suppresses it.
  const requiresNoThink = serverType === 'openai'
    ? await getActiveModelRequiresNoThink(resolvedBaseUrl, model)
    : false;
  const systemContent = requiresNoThink && options.systemPrompt
    ? `/no_think\n${options.systemPrompt}`
    : requiresNoThink
      ? '/no_think'
      : (options.systemPrompt ?? '');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...LOCAL_AUTH_HEADERS },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        ...(serverType === 'openai'
          ? {
              messages: [
                { role: 'system', content: systemContent },
                { role: 'user', content: options.userPrompt },
              ],
              max_tokens: 2048,
              stream: false,
            }
          : {
              messages: [
                { role: 'system', content: options.systemPrompt },
                { role: 'user', content: options.userPrompt },
              ],
              stream: false,
            }),
      }),
    });

    clearTimeout(timeoutId);
    const latencyMs = Date.now() - startTime;

    if (!response.ok) {
      let errBody = '';
      try { errBody = await response.text(); } catch { /* ignore */ }
      return {
        success: false,
        output: '',
        error: `Server ${response.status} at ${url} (model: ${model}): ${errBody}`,
        latencyMs,
        level: 'standard',
        model,
      };
    }

    const outputData = serverType === 'openai'
      ? await response.json() as OpenAIChatCompletionsResponse
      : await response.json() as {
          message?: { content?: string };
          model?: string;
          prompt_eval_count?: number;
          eval_count?: number;
        };
    const output = serverType === 'openai'
      ? (() => {
          const msg = (outputData as OpenAIChatCompletionsResponse).choices?.[0]?.message;
          const content = (msg?.content ?? '').trim();
          if (content) return content;
          // Fallback: thinking model returned empty content — extract tail of reasoning_content
          return (msg?.reasoning_content ?? '').trim();
        })()
      : ((outputData as {
          message?: { content?: string };
          prompt_eval_count?: number;
          eval_count?: number;
        }).message?.content ?? '').trim();
    const promptTokens = serverType === 'openai'
      ? (outputData as OpenAIChatCompletionsResponse).usage?.prompt_tokens
      : (outputData as {
          message?: { content?: string };
          prompt_eval_count?: number;
          eval_count?: number;
        }).prompt_eval_count;
    const completionTokens = serverType === 'openai'
      ? (outputData as OpenAIChatCompletionsResponse).usage?.completion_tokens
      : (outputData as {
          message?: { content?: string };
          prompt_eval_count?: number;
          eval_count?: number;
        }).eval_count;

    if (!options.expectJson) {
      return { success: true, output, latencyMs, level: options.level ?? 'standard', model, promptTokens, completionTokens, resolvedUrl: resolvedBaseUrl };
    }

    // JSON extraction — same logic as Claude path
    const objectMatch = output.match(/\{[\s\S]*\}/);
    const arrayMatch = output.match(/\[[\s\S]*\]/);
    for (const candidate of [objectMatch?.[0], arrayMatch?.[0]]) {
      if (!candidate) continue;
      try {
        const parsed = JSON.parse(candidate);
        return { success: true, output, parsed, latencyMs, level: options.level ?? 'standard', model, promptTokens, completionTokens, resolvedUrl: resolvedBaseUrl };
      } catch { /* try next */ }
    }
    return {
      success: false,
      output,
      error: 'Failed to parse JSON response',
      latencyMs,
      level: options.level ?? 'standard',
      model,
      promptTokens,
      completionTokens,
    };

  } catch (err) {
    clearTimeout(timeoutId);
    const latencyMs = Date.now() - startTime;
    const isAbort = err instanceof Error && err.name === 'AbortError';
    return {
      success: false,
      output: '',
      error: isAbort
        ? `Timeout after ${timeout}ms (url: ${url}, model: ${model})`
        : `Network error: ${(err as Error).message} (url: ${url}, model: ${model})`,
      latencyMs,
      level: options.level ?? 'standard',
      model,
    };
  }
}

/** @internal Run Claude subprocess for inference. */
function inferenceClaudeSubprocess(options: InferenceOptions): Promise<InferenceResult> {
  const level = options.level || 'standard';
  const config = LEVEL_CONFIG[level];
  const startTime = Date.now();
  const timeout = options.timeout || config.defaultTimeout;

  return new Promise((resolve) => {
    // Unset CLAUDECODE so nested `claude` invocations don't trigger the
    // nested-session guard (hooks run inside Claude Code's environment).
    const env = { ...process.env };
    delete env.CLAUDECODE;

    // BILLING: Always use subscription. Anthropic's credential precedence chain
    // (https://code.claude.com/docs/en/authentication#authentication-precedence)
    // puts BOTH ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN above CLAUDE_CODE_OAUTH_TOKEN,
    // so either one in env will silently override OAuth. Bun auto-loads ~/.claude/.env
    // into child processes, and some MCP/plugin setups export ANTHROPIC_AUTH_TOKEN —
    // either path leaks subscription work onto API-key billing. Scrub both.
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;

    const hasImages = options.imagePaths && options.imagePaths.length > 0;
    const args = [
      '--print',
      '--model', config.model,
      ...(hasImages ? ['--allowedTools', 'Read'] : ['--tools', '']),
      '--output-format', 'text',
      '--exclude-dynamic-system-prompt-sections',  // v3.23 C2: cache-friendly prompt prefix (claude-code v2.1.98+)
      '--setting-sources', '',
      '--system-prompt', options.systemPrompt,
    ];

    const userPromptWithImages = hasImages
      ? `${options.imagePaths!.map((p) => `@${p}`).join('\n')}\n\n${options.userPrompt}`
      : options.userPrompt;

    let stdout = '';
    let stderr = '';

    const proc = spawn('claude', args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Write prompt via stdin to avoid ARG_MAX limits on large inputs
    proc.stdin.write(userPromptWithImages);
    proc.stdin.end();

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    // Handle timeout — SIGKILL (not SIGTERM) because claude --print ignores SIGTERM
    // inside CLAUDECODE-adjacent environments and hangs indefinitely. proc.unref()
    // ensures the bun hook process can exit even if the child hasn't died yet,
    // preventing the hook from blocking Claude Code's tool pipeline.
    const timeoutId = setTimeout(() => {
      proc.kill('SIGKILL');
      proc.unref();
      resolve({
        success: false,
        output: '',
        error: `Timeout after ${timeout}ms`,
        latencyMs: Date.now() - startTime,
        level,
      });
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timeoutId);
      const latencyMs = Date.now() - startTime;

      if (code !== 0) {
        resolve({
          success: false,
          output: stdout,
          error: stderr || `Process exited with code ${code}`,
          latencyMs,
          level,
        });
        return;
      }

      const output = stdout.trim();

      // Parse JSON if requested
      if (options.expectJson) {
        // Try both object and array matches — use whichever parses successfully.
        // The greedy object regex /\{[\s\S]*\}/ can capture invalid substrings
        // when the LLM wraps a JSON array inside markdown or explanatory text
        // that happens to contain braces. By trying both candidates and
        // validating with JSON.parse, we handle arrays and objects reliably.
        const objectMatch = output.match(/\{[\s\S]*\}/);
        const arrayMatch = output.match(/\[[\s\S]*\]/);

        for (const candidate of [objectMatch?.[0], arrayMatch?.[0]]) {
          if (!candidate) continue;
          try {
            const parsed = JSON.parse(candidate);
            resolve({
              success: true,
              output,
              parsed,
              latencyMs,
              level,
            });
            return;
          } catch { /* try next candidate */ }
        }
        resolve({
          success: false,
          output,
          error: 'Failed to parse JSON response',
          latencyMs,
          level,
        });
        return;
      }

      resolve({
        success: true,
        output,
        latencyMs,
        level,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timeoutId);
      resolve({
        success: false,
        output: '',
        error: err.message,
        latencyMs: Date.now() - startTime,
        level,
      });
    });
  });
}

/**
 * Run inference via the agy CLI subprocess (Google Antigravity, subscription-backed).
 *
 * Uses `agy --print` non-interactive mode — same subscription billing as the IDE,
 * no per-token API charges. Auth token lives at ~/.gemini/antigravity-cli/antigravity-oauth-token
 * and is managed entirely by agy; no token handling needed here.
 *
 * Limitation: no separate system prompt param — system + user are combined into one prompt.
 * Suitable for classification, fast-tier calls, and moderate inference tasks.
 */
function readAgyModelId(): string {
  try {
    const settingsPath = join(process.env.HOME ?? '', '.gemini', 'antigravity-cli', 'settings.json');
    const raw = readFileSync(settingsPath, 'utf-8');
    const label: string = (JSON.parse(raw) as Record<string, unknown>).model as string ?? '';
    if (label.includes('3.5 Flash')) return 'gemini-3.5-flash';
    if (label.includes('3.1 Pro')) return 'gemini-3.1-pro';
    if (label.includes('3.1 Flash')) return 'gemini-3.1-flash';
    if (label.includes('2.5 Pro')) return 'gemini-2.5-pro';
    if (label.includes('2.5 Flash')) return 'gemini-2.5-flash';
    return label || 'gemini-unknown';
  } catch {
    return 'gemini-3.5-flash';
  }
}

function inferenceAgy(options: InferenceOptions): Promise<InferenceResult> {
  const startTime = Date.now();
  const timeout = options.timeout ?? 60000;
  const timeoutSec = Math.ceil(timeout / 1000);
  const agyModel = readAgyModelId();

  return new Promise((resolve) => {
    const combined = options.systemPrompt
      ? `${options.systemPrompt}\n\n${options.userPrompt}`
      : options.userPrompt;

    const args = [
      '--print', combined,
      '--dangerously-skip-permissions',
      '--print-timeout', `${timeoutSec}s`,
    ];

    let stdout = '';
    let stderr = '';

    const proc = spawn(AGY_BIN, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    proc.stdin.end();

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    const timeoutId = setTimeout(() => {
      proc.kill('SIGTERM');
      resolve({
        success: false,
        output: '',
        error: `Timeout after ${timeout}ms`,
        latencyMs: Date.now() - startTime,
        level: options.level ?? 'standard',
        model: agyModel,
      });
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timeoutId);
      const latencyMs = Date.now() - startTime;
      const output = stdout.trim();

      if (code !== 0) {
        resolve({
          success: false,
          output,
          error: stderr || `agy exited with code ${code}`,
          latencyMs,
          level: options.level ?? 'standard',
          model: agyModel,
        });
        return;
      }

      if (options.expectJson) {
        const objectMatch = output.match(/\{[\s\S]*\}/);
        const arrayMatch = output.match(/\[[\s\S]*\]/);
        for (const candidate of [objectMatch?.[0], arrayMatch?.[0]]) {
          if (!candidate) continue;
          try {
            const parsed = JSON.parse(candidate);
            resolve({ success: true, output, parsed, latencyMs, level: options.level ?? 'standard', model: agyModel });
            return;
          } catch { /* try next */ }
        }
        resolve({ success: false, output, error: 'Failed to parse JSON response', latencyMs, level: options.level ?? 'standard', model: agyModel });
        return;
      }

      resolve({ success: true, output, latencyMs, level: options.level ?? 'standard', model: agyModel });
    });

    proc.on('error', (err) => {
      clearTimeout(timeoutId);
      resolve({
        success: false,
        output: '',
        error: err.message,
        latencyMs: Date.now() - startTime,
        level: options.level ?? 'standard',
        model: agyModel,
      });
    });
  });
}

/**
 * Run inference via the Antigravity Interactions REST API.
 *
 * BILLING WARNING: This path uses GEMINI_API_KEY (x-goog-api-key auth) against the
 * Interactions API endpoint. Unlike inferenceAgy() which uses the CLI OAuth token
 * (subscription-backed), this path is likely API-key-metered per token. Verify billing
 * at aistudio.google.com before enabling in production.
 *
 * API endpoint: POST https://generativelanguage.googleapis.com/v1beta/interactions
 * Agent: antigravity-preview-05-2026
 * Api-Revision: 2026-05-20
 *
 * Advantage over CLI path: no subprocess spawn overhead, richer response metadata
 * (thought_tokens, environment_id, service_tier), potentially lower latency.
 */
async function inferenceAntigravityApi(options: InferenceOptions): Promise<InferenceResult> {
  const startTime = Date.now();
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      success: false,
      output: '',
      error: 'GEMINI_API_KEY not set — required for --backend antigravity-api',
      latencyMs: Date.now() - startTime,
      level: options.level ?? 'standard',
      model: 'antigravity-preview-05-2026',
    };
  }

  const config = await readAgyConfig();
  const timeout = options.timeout ?? config.restApiTimeoutMs;
  const combined = options.systemPrompt
    ? `${options.systemPrompt}\n\n${options.userPrompt}`
    : options.userPrompt;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(config.restApiEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
        'Api-Revision': config.restApiRevision,
      },
      signal: controller.signal,
      body: JSON.stringify({
        agent: config.restApiAgent,
        environment: {},
        input: combined,
      }),
    });

    clearTimeout(timeoutId);
    const latencyMs = Date.now() - startTime;

    if (!response.ok) {
      let errBody = '';
      try { errBody = await response.text(); } catch { /* ignore */ }
      return {
        success: false,
        output: '',
        error: `Interactions API ${response.status}: ${errBody.slice(0, 200)}`,
        latencyMs,
        level: options.level ?? 'standard',
        model: config.restApiAgent,
      };
    }

    const data = await response.json() as {
      status?: string;
      steps?: Array<{ type?: string; content?: Array<{ text?: string; type?: string }> }>;
      environment_id?: string;
      usage?: { total_tokens?: number; total_input_tokens?: number; total_output_tokens?: number; total_thought_tokens?: number };
      service_tier?: string;
    };

    if (data.status && data.status !== 'completed') {
      return {
        success: false,
        output: '',
        error: `Interactions API returned status '${data.status}' (expected 'completed')`,
        latencyMs,
        level: options.level ?? 'standard',
        model: config.restApiAgent,
      };
    }

    // Find the last model_output step — earlier steps may be tool calls, search results, or thoughts
    const outputStep = data.steps?.filter(s => s.type === 'model_output').at(-1);
    const rawText = outputStep?.content?.[0]?.text;
    const text = (typeof rawText === 'string' ? rawText : '').trim();
    if (!text) {
      return {
        success: false,
        output: '',
        error: 'Empty response from Interactions API (no steps[0].content[0].text)',
        latencyMs,
        level: options.level ?? 'standard',
        model: config.restApiAgent,
      };
    }

    if (options.expectJson) {
      const objectMatch = text.match(/\{[\s\S]*\}/);
      const arrayMatch = text.match(/\[[\s\S]*\]/);
      for (const candidate of [objectMatch?.[0], arrayMatch?.[0]]) {
        if (!candidate) continue;
        try {
          const parsed = JSON.parse(candidate);
          return { success: true, output: text, parsed, latencyMs, level: options.level ?? 'standard', model: config.restApiAgent };
        } catch { /* try next */ }
      }
      return { success: false, output: text, error: 'Failed to parse JSON response', latencyMs, level: options.level ?? 'standard', model: config.restApiAgent };
    }

    return { success: true, output: text, latencyMs, level: options.level ?? 'standard', model: config.restApiAgent };
  } catch (err) {
    clearTimeout(timeoutId);
    const latencyMs = Date.now() - startTime;
    const isAbort = err instanceof Error && err.name === 'AbortError';
    const agentName = (await readAgyConfig()).restApiAgent;
    return {
      success: false,
      output: '',
      error: isAbort
        ? `Timeout after ${timeout}ms (Interactions API)`
        : `Network error: ${(err as Error).message}`,
      latencyMs,
      level: options.level ?? 'standard',
      model: agentName,
    };
  }
}

/**
 * Run inference with configurable level.
 *
 * Routing order (claude-default path):
 *   1. localFirst? → try Ollama first; escalate to Claude on failure
 *   2. Claude subprocess
 *   3. usage-limit fallback → retry via Ollama if Claude quota exceeded
 *
 * prefer_local_for_levels in PAI_CONFIG.yaml auto-enables localFirst for
 * configured levels without any caller changes (default: ['fast']).
 */
export async function inference(options: InferenceOptions): Promise<InferenceResult> {
  // P4 latency capture wraps the entire inference call. performance.now()
  // gives sub-millisecond precision; we round to integer ms to keep the
  // schema compact. Both success and error paths log before return/throw.
  const startTime = performance.now();
  try {
    const result = await _inferenceCore(options);
    const latencyMs = Math.round(performance.now() - startTime);
    const decision = resolveRoutingDecision(options.skillName, options.level);
    // antigravity-api collapses to 'antigravity' in the log schema — both paths
    // are antigravity backends from a routing/observability perspective.
    const logBackend: LatencyPerInvocationEntry['backend'] =
      (result.fallbackUsed || result.resolvedUrl)
        ? 'local'
        : (options.backend === 'antigravity-api' ? 'antigravity' :
           options.backend === 'hermes' ? 'local' :
           options.backend === 'nous' ? 'local' : (options.backend ?? 'claude'));
    const entry: LatencyPerInvocationEntry = {
      timestamp: new Date().toISOString(),
      model_selected: result.model ?? result.fallbackModel ?? (options.model ?? decision.tier),
      tier_used: result.level ?? decision.tier,
      backend: logBackend,
      latency_ms: latencyMs,
      status: result.success ? 'success' : 'error',
    };
    if (options.skillName !== undefined) {
      entry.skill_name = options.skillName;
    }
    if (result.resolvedUrl !== undefined) {
      entry.host = result.resolvedUrl;
    }
    if (!result.success && result.error) {
      entry.error = result.error;
    }
    logLatencyPerInvocation(entry);
    return result;
  } catch (err) {
    const latencyMs = Math.round(performance.now() - startTime);
    const decision = resolveRoutingDecision(options.skillName, options.level);
    const message = err instanceof Error ? err.message : String(err);
    const errorBackend: LatencyPerInvocationEntry['backend'] =
      options.backend === 'antigravity-api' ? 'antigravity' :
      options.backend === 'hermes' ? 'local' :
      options.backend === 'nous' ? 'local' : (options.backend ?? 'claude');
    const entry: LatencyPerInvocationEntry = {
      timestamp: new Date().toISOString(),
      model_selected: options.model ?? decision.tier,
      tier_used: decision.tier,
      backend: errorBackend,
      latency_ms: latencyMs,
      status: 'error',
      error: message,
    };
    if (options.skillName !== undefined) {
      entry.skill_name = options.skillName;
    }
    logLatencyPerInvocation(entry);
    throw err;
  }
}

/** @internal Original inference dispatch — wrapped by `inference()` for latency capture. */
async function _inferenceCore(options: InferenceOptions): Promise<InferenceResult> {
  // Skill-level routing: if a skill is named, its preferred_tier overrides
  // `level`, and its model_hints take precedence over taskType-based selection.
  // Backward-compatible: omitting skillName preserves prior behavior exactly.
  const decision = resolveRoutingDecision(options.skillName, options.level);
  const effectiveOptions: InferenceOptions = options.skillName
    ? {
        ...options,
        level: decision.tier,
        model: options.model ?? decision.preferredModel,
      }
    : options;

  if (options.skillName) {
    console.error(
      `[Inference] routing decision: skill=${options.skillName}, requested_tier=${decision.tier}, ` +
      `selected_model=${effectiveOptions.model ?? '(default)'}, source=${decision.source}`,
    );
  }

  if (effectiveOptions.backend === 'antigravity-api') {
    const result = await inferenceAntigravityApi(effectiveOptions);
    logInferenceCall('antigravity', result, effectiveOptions.level ?? 'standard', effectiveOptions.taskType);
    return result;
  }

  if ((effectiveOptions.backend ?? 'claude') === 'ollama') {
    const result = await inferenceOllama({ ...effectiveOptions, skipWarmthCheck: true });
    logInferenceCall('local', result, effectiveOptions.level ?? 'standard', effectiveOptions.taskType);
    return result;
  }

  if (effectiveOptions.backend === 'antigravity') {
    const result = await inferenceAgy(effectiveOptions);
    logInferenceCall('antigravity', result, effectiveOptions.level ?? 'standard', effectiveOptions.taskType);
    return result;
  }

  if (effectiveOptions.backend === 'hermes') {
    const result = await inferenceHermes(effectiveOptions);
    logInferenceCall('local', result, effectiveOptions.level ?? 'standard', effectiveOptions.taskType);
    return result;
  }

  if (effectiveOptions.backend === 'nous') {
    const nousResult = await inferenceNous(effectiveOptions);
    if (nousResult.success) {
      logInferenceCall('local', nousResult, effectiveOptions.level ?? 'standard', effectiveOptions.taskType);
      return nousResult;
    }
    console.error(`[Inference] Nous failed (${(nousResult.error ?? '').slice(0, 80)}) — falling back to Sonnet`);
    const sonnetResult = await inferenceClaudeSubprocess({ ...effectiveOptions, level: 'standard' });
    const finalResult = { ...sonnetResult, fallbackUsed: true, fallbackModel: nousResult.model, fallbackReason: nousResult.error ?? 'nous_error' };
    logInferenceCall('claude', finalResult, 'standard', effectiveOptions.taskType);
    return finalResult;
  }

  if (effectiveOptions.backend === 'openrouter') {
    const orResult = await inferenceOpenRouter(effectiveOptions);
    if (orResult.success) {
      logInferenceCall('local', orResult, effectiveOptions.level ?? 'standard', effectiveOptions.taskType);
      return orResult;
    }
    const orConfig = await readOpenRouterConfig();
    if (orConfig.fallbackToSonnet) {
      console.error(`[Inference] OpenRouter failed (${(orResult.error ?? '').slice(0, 80)}) — falling back to Sonnet`);
      const sonnetResult = await inferenceClaudeSubprocess({ ...effectiveOptions, level: 'standard' });
      const finalResult = { ...sonnetResult, fallbackUsed: true, fallbackModel: orResult.model, fallbackReason: orResult.error ?? 'openrouter_error' };
      logInferenceCall('claude', finalResult, 'standard', effectiveOptions.taskType);
      return finalResult;
    }
    logInferenceCall('local', orResult, effectiveOptions.level ?? 'standard', effectiveOptions.taskType);
    return orResult;
  }

  const level = effectiveOptions.level ?? 'standard';
  const canUseLocal = !effectiveOptions.imagePaths?.length;

  // Lazy-load OllamaConfig at most once per call regardless of branch taken.
  let _cfg: OllamaConfig | undefined;
  const getConfig = async (): Promise<OllamaConfig> => {
    if (!_cfg) _cfg = await readOllamaConfig();
    return _cfg;
  };

  // Resolve localFirst: explicit option → local_mode flag → config level list → false
  let useLocalFirst = effectiveOptions.localFirst;
  if (useLocalFirst === undefined && canUseLocal) {
    const cfg = await getConfig();
    useLocalFirst = cfg.localMode || cfg.preferLocalForLevels.includes(level);
  }

  // Local-first attempt
  let localEscalated = false;
  let localEscalatedReason: string | undefined;
  if (useLocalFirst && canUseLocal) {
    const { fallbackModels, defaultModel, generalModel, baseUrl } = await getConfig();
    // Health check uses primary baseUrl — model isn't selected yet so per-model host resolution
    // isn't possible here. inferenceOllama() will route to the correct host per model.
    const ollamaReachable = await checkOllamaHealth(baseUrl);
    if (!ollamaReachable) {
      console.error(`[Inference] Ollama unreachable (health check failed) — routing to Claude directly`);
      localEscalated = true;
      localEscalatedReason = 'ollama_unreachable';
    } else {
      // Skill model_hint takes priority when present; else taskType selection.
      const localModel = effectiveOptions.model
        ?? (effectiveOptions.taskType === 'general'
              ? generalModel
              : (fallbackModels[level] ?? defaultModel));
      const localResult = await inferenceOllama({ ...effectiveOptions, model: localModel });
      if (localResult.success) {
        logInferenceCall('local', localResult, level, effectiveOptions.taskType);
        return localResult;
      }
      console.error(`[Inference] Local Ollama unavailable — escalating to Claude (${(localResult.error ?? '').slice(0, 80)})`);
      localEscalated = true;
      localEscalatedReason = localResult.fallbackReason ?? 'ollama_error';
    }
  }

  // Claude path
  const result = await inferenceClaudeSubprocess(effectiveOptions);

  // Usage-limit fallback: Claude → Ollama
  if (!result.success && isUsageLimitError(result.error ?? '')) {
    const { fallbackEnabled: cfgEnabled, fallbackModels, defaultModel } = await getConfig();
    const fallbackEnabled = effectiveOptions.fallbackToOllama ?? cfgEnabled;
    if (fallbackEnabled) {
      if (!canUseLocal) {
        console.error(`[Inference] Claude usage limit — Ollama fallback skipped (image attachments unsupported in Ollama text path)`);
      } else {
        const fallbackModel = effectiveOptions.model ?? fallbackModels[level] ?? defaultModel;
        console.error(`[Inference] Claude usage limit — falling back to Ollama (level: ${level}, model: ${fallbackModel})`);
        // Usage-limit: bypass warmth — cold Ollama is better than no response when Claude is quota-blocked.
        const fallbackResult = await inferenceOllama({ ...effectiveOptions, model: fallbackModel, skipWarmthCheck: true });
        const finalFallback = { ...fallbackResult, fallbackUsed: true, fallbackModel };
        logInferenceCall('local', finalFallback, level, effectiveOptions.taskType);
        return finalFallback;
      }
    }
  }

  const finalResult = localEscalated
    ? { ...result, escalatedFromLocal: true, ...(localEscalatedReason ? { fallbackReason: localEscalatedReason } : {}) }
    : result;
  logInferenceCall('claude', finalResult, level, effectiveOptions.taskType);
  return finalResult;
}

/**
 * Synthesize advisor state from the current ISA + recent activity (v3.24 P5).
 *
 * Closes the state-gaming Flaw identified by RedTeam review of v3.23 doctrine:
 * when the caller writes the state string manually, the same cognitive model
 * that might have missed the problem decides what the reviewer sees. Auto-synthesis
 * reads the ISA directly so the reviewer gets the unfiltered state.
 *
 * Reads:
 * - Current ISA content (resolved from MEMORY/STATE/work.json active session, or
 *   the most recently-updated ISA in MEMORY/WORK/)
 * - Recent session activity if available
 *
 * Returns a state string suitable for passing to advisor().
 */
export async function synthesizeAdvisorState(): Promise<string> {
  const fs = await import("fs/promises");
  const path = await import("path");
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const workDir = path.join(home, ".claude", "PAI", "MEMORY", "WORK");
  const stateFile = path.join(home, ".claude", "PAI", "MEMORY", "STATE", "work.json");

  // Try to read active session from work.json
  let activeSlug: string | undefined;
  try {
    const stateRaw = await fs.readFile(stateFile, "utf-8");
    const state = JSON.parse(stateRaw);
    activeSlug = state?.active || state?.current || state?.activeSession;
  } catch {
    // work.json may not exist — fall back to most recent ISA
  }

  // Fall back: find most recently updated ISA in WORK/
  if (!activeSlug) {
    try {
      const entries = await fs.readdir(workDir, { withFileTypes: true });
      const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
      if (dirs.length === 0) {
        return "No active ISA found. Advisor state unavailable.";
      }
      // Sort by mtime
      const statted = await Promise.all(
        dirs.map(async (d) => {
          const s = await fs.stat(path.join(workDir, d));
          return { name: d, mtime: s.mtimeMs };
        }),
      );
      statted.sort((a, b) => b.mtime - a.mtime);
      activeSlug = statted[0].name;
    } catch (err) {
      return `Unable to locate active ISA: ${(err as Error).message}`;
    }
  }

  // Read ISA content
  const isaPath = path.join(workDir, activeSlug, "ISA.md");
  let prdContent: string;
  try {
    prdContent = await fs.readFile(isaPath, "utf-8");
  } catch (err) {
    return `Active session ${activeSlug} has no ISA.md: ${(err as Error).message}`;
  }

  // Truncate to a reasonable size for advisor context (first 300 lines, ~8KB)
  const MAX_LINES = 300;
  const lines = prdContent.split("\n");
  const truncated = lines.length > MAX_LINES
    ? lines.slice(0, MAX_LINES).join("\n") + `\n\n[... ISA truncated at ${MAX_LINES} lines of ${lines.length} total ...]`
    : prdContent;

  return [
    `ISA: ${activeSlug}`,
    `Source: ${isaPath}`,
    ``,
    `--- ISA CONTENT (verbatim, auto-synthesized from disk — not caller-filtered) ---`,
    truncated,
    `--- END ISA CONTENT ---`,
  ].join("\n");
}

/**
 * Advisor escalation — v3.24 Verification Doctrine.
 *
 * Calls smart tier (Opus) framed as a reviewer. Caller may supply explicit state
 * OR set autoSynthesize: true to have the helper read the current ISA automatically
 * (v3.24 P5 — closes state-gaming escape hatch).
 *
 * @param task          What the executor is trying to accomplish
 * @param state         Current relevant state (omit when autoSynthesize is true)
 * @param question      Specific question or decision point the executor faces
 * @param autoSynthesize If true, ignore `state` and read current ISA via synthesizeAdvisorState()
 * @param timeout       Override timeout in ms (default 120000)
 * @returns Structured advisory response
 *
 * Usage:
 *   import { advisor } from "./Inference";
 *
 *   // Manual state
 *   const review = await advisor({
 *     task: "Ship Algorithm v3.24.0",
 *     state: "Edited 8 files; ISC 28/30 passing; Inference.ts typecheck clean.",
 *     question: "Any gaps before declaring done?",
 *   });
 *
 *   // Auto-synthesized state (v3.24 P5 — recommended for commitment boundaries)
 *   const review = await advisor({
 *     task: "Ship Algorithm v3.24.0",
 *     question: "Any gaps before declaring done?",
 *     autoSynthesize: true,
 *   });
 *
 * Rules (from Algorithm v3.24.0 VERIFY doctrine):
 * - Call at commitment boundaries: before approach, when stuck, before declaring done
 * - Skip for MEASURED short reactive tasks (<4 min wall-clock AND <2 files)
 * - Extended+ ISA phase:complete = mandatory advisor call (P4)
 * - On conflict with empirical: re-call surfacing conflict, max 2 re-calls, then escalate (P1)
 */
export interface AdvisorOptions {
  task: string;
  state?: string;
  question: string;
  autoSynthesize?: boolean;
  timeout?: number;
}

export async function advisor(options: AdvisorOptions): Promise<InferenceResult> {
  const systemPrompt = [
    "You are an advisor model invoked at a commitment boundary by an executor model.",
    "Review the executor's task, state, and specific question.",
    "Be direct. Flag risks the executor may have missed.",
    "If you see a fatal flaw, say so. If the approach is sound, confirm and say why.",
    "Your output will be weighed against empirical test results — a passing test does NOT invalidate your review.",
  ].join(" ");

  // Resolve state: either auto-synthesized from ISA or caller-supplied.
  let resolvedState: string;
  if (options.autoSynthesize) {
    resolvedState = await synthesizeAdvisorState();
  } else if (options.state !== undefined) {
    resolvedState = options.state;
  } else {
    return {
      success: false,
      output: "",
      error: "advisor() requires either state or autoSynthesize: true",
      latencyMs: 0,
      level: 'smart',
    };
  }

  const userPrompt = [
    `TASK: ${options.task}`,
    ``,
    `STATE:`,
    resolvedState,
    ``,
    `QUESTION: ${options.question}`,
    ``,
    `Advisory response:`,
  ].join("\n");

  return inference({
    systemPrompt,
    userPrompt,
    level: 'smart',
    timeout: options.timeout ?? ADVISOR_TIMEOUT_MS,
  });
}

/**
 * CLI entry point
 */
async function main() {
  const args = process.argv.slice(2);

  // Parse flags
  let expectJson = false;
  let measure = false;
  let timeout: number | undefined;
  let level: InferenceLevel = 'standard';
  let levelExplicit = false;
  let mode: 'inference' | 'advisor' = 'inference';
  let autoState = false;  // v3.24 P5
  let backend: 'claude' | 'ollama' | 'antigravity' | 'antigravity-api' | 'hermes' | 'nous' | 'openrouter' = 'claude';
  let model: string | undefined;
  let fallbackToOllama: boolean | undefined;
  let localFirst: boolean | undefined;
  let taskType: 'code' | 'general' | undefined;
  const positionalArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help' || args[i] === '-h') {
      console.log(HELP_TEXT);
      return;
    } else if (args[i] === '--json') {
      expectJson = true;
    } else if (args[i] === '--measure') {
      measure = true;
    } else if (args[i] === '--fallback-ollama') {
      fallbackToOllama = true;
    } else if (args[i] === '--no-fallback') {
      fallbackToOllama = false;
    } else if (args[i] === '--prefer-local') {
      localFirst = true;
    } else if (args[i] === '--cloud-first') {
      localFirst = false;
    } else if (args[i] === '--auto-state') {
      autoState = true;
    } else if (args[i] === '--backend' && args[i + 1]) {
      const requestedBackend = args[i + 1].toLowerCase();
      if (requestedBackend === 'claude' || requestedBackend === 'ollama' || requestedBackend === 'antigravity' || requestedBackend === 'antigravity-api' || requestedBackend === 'hermes' || requestedBackend === 'nous' || requestedBackend === 'openrouter') {
        backend = requestedBackend;
      } else {
        console.error(`Invalid backend: ${args[i + 1]}. Use claude, ollama, antigravity, antigravity-api, hermes, nous, or openrouter.`);
        process.exit(1);
      }
      i++;
    } else if (args[i] === '--model' && args[i + 1]) {
      model = args[i + 1];
      i++;
    } else if (args[i] === '--task-type' && args[i + 1]) {
      const requested = args[i + 1].toLowerCase();
      if (requested === 'code' || requested === 'general') {
        taskType = requested;
      } else {
        console.error(`Invalid task-type: ${args[i + 1]}. Use code or general.`);
        process.exit(1);
      }
      i++;
    } else if (args[i] === '--mode' && args[i + 1]) {
      const requestedMode = args[i + 1].toLowerCase();
      if (requestedMode === 'advisor' || requestedMode === 'inference') {
        mode = requestedMode;
      } else {
        console.error(`Invalid mode: ${args[i + 1]}. Use inference or advisor.`);
        process.exit(1);
      }
      i++;
    } else if (args[i] === '--level' && args[i + 1]) {
      const requestedLevel = args[i + 1].toLowerCase();
      if (['fast', 'standard', 'smart'].includes(requestedLevel)) {
        level = requestedLevel as InferenceLevel;
        levelExplicit = true;
      } else {
        console.error(`Invalid level: ${args[i + 1]}. Use fast, standard, or smart.`);
        process.exit(1);
      }
      i++;
    } else if (args[i] === '--timeout' && args[i + 1]) {
      timeout = parseInt(args[i + 1], 10);
      i++;
    } else {
      positionalArgs.push(args[i]);
    }
  }

  if (measure) {
    if (backend !== 'ollama') {
      console.error('--measure requires --backend ollama');
      process.exit(1);
    }
    if (mode !== 'inference') {
      console.error('--measure cannot be combined with --mode advisor');
      process.exit(1);
    }
    if (positionalArgs.length > 0) {
      console.error('--measure does not accept positional prompts');
      process.exit(1);
    }
    try {
      await runLatencyMeasure({
        modelOverride: model,
        timeoutMs: timeout,
        levelOverride: levelExplicit ? level : undefined,
      });
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    return;
  }

  // Advisor mode: normally task/state/question (3 args), or with --auto-state task/question (2 args)
  if (mode === 'advisor') {
    if (autoState) {
      if (positionalArgs.length < 2) {
        console.error('Usage: bun Inference.ts --mode advisor --auto-state [--json] [--timeout <ms>] <task> <question>');
        process.exit(1);
      }
      const [task, question] = positionalArgs;
      const advisoryResult = await advisor({ task, question, autoSynthesize: true, timeout });
      if (advisoryResult.success) {
        console.log(advisoryResult.output);
      } else {
        console.error(`Advisor error: ${advisoryResult.error}`);
        process.exit(1);
      }
      return;
    }
    if (positionalArgs.length < 3) {
      console.error('Usage: bun Inference.ts --mode advisor [--json] [--timeout <ms>] <task> <state> <question>');
      console.error('       bun Inference.ts --mode advisor --auto-state [--json] [--timeout <ms>] <task> <question>');
      process.exit(1);
    }
    const [task, state, question] = positionalArgs;
    const advisoryResult = await advisor({ task, state, question, timeout });
    if (advisoryResult.success) {
      console.log(advisoryResult.output);
    } else {
      console.error(`Advisor error: ${advisoryResult.error}`);
      process.exit(1);
    }
    return;
  }

  if (positionalArgs.length < 2) {
    console.error('Usage: bun Inference.ts [--level fast|standard|smart] [--json] [--timeout <ms>] <system_prompt> <user_prompt>');
    console.error('       bun Inference.ts --measure --backend ollama [--model <name>] [--timeout <ms>]');
    process.exit(1);
  }

  const [systemPrompt, userPrompt] = positionalArgs;

  const result = await inference({
    systemPrompt,
    userPrompt,
    level,
    backend,
    model,
    expectJson,
    timeout,
    fallbackToOllama,
    localFirst,
    taskType,
  });

  if (result.success) {
    if (expectJson && result.parsed) {
      console.log(JSON.stringify(result.parsed));
    } else {
      console.log(result.output);
    }
  } else {
    console.error(`Error: ${result.error}`);
    process.exit(1);
  }
}

// Run if executed directly
if (import.meta.main) {
  main().catch(console.error);
}
