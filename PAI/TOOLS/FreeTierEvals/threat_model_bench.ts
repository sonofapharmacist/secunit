#!/usr/bin/env bun
/**
 * Threat Model Bench — Project 1 head-to-head.
 *
 * Runs Ken Huang's job-packet pattern (prep → plan/audit → execute → verify)
 * against PAI's own agent stack manifest, with three model slots in the
 * `plan_or_audit` position. Each plan is graded by a fresh-context Sonnet 5
 * grader on three axes (coverage, specificity, PAI-specific accuracy).
 *
 * Huang's "Project 1: Threat model your own agent stack" lives at
 *   https://github.com/kenhuangus/fable5/tree/main/projects/01_threat_model
 * and his supporting job-packet library at
 *   https://github.com/kenhuangus/fable5/tree/main/job_packet
 *
 * The pattern in `threat_model.py` is:
 *   1. prep:       cheap model turns the manifest into a one-page architecture doc
 *   2. plan/audit: the variable model (one of three slots) produces a ranked
 *                  threat model + mitigation plan covering prompt injection,
 *                  tool poisoning, memory attacks, and confused-deputy
 *   3. execute:    cheap model turns the ranked plan into a PR checklist
 *   4. verify:     fresh-context grader scores the plan (0-10)
 *
 * Usage:
 *   bun threat_model_bench.ts --all                       # all three slots
 *   bun threat_model_bench.ts --slot fable-5               # one model
 *   bun threat_model_bench.ts --slot gpt-5.4 --dry-run     # dry run a single slot
 *   bun threat_model_bench.ts --manifest /path/to/manifest.json
 *
 * Output:
 *   - ./threat_model_bench_results/threat_model_bench_<ts>_<slot>.json  (per-run)
 *   - ./threat_model_bench_results/threat_model_bench_<ts>.json         (combined)
 *   - ./threat_model_bench_results/threat_model_bench_<ts>.csv          (table)
 *   - stdout summary table at the end
 */

import { spawn } from "bun";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";

// ─────────────────────────────────────────────────────────────────────────────
// PAI agent stack manifest (embedded — see design-doc section 1)
// Shape matches Huang's sample_agent_stack.json so the prompt template works
// unmodified: { agents, tools, mcp_servers, credentials, data_flows, trust_boundaries }
// ─────────────────────────────────────────────────────────────────────────────

const EMBEDDED_MANIFEST = {
  agents: [
    {
      name: "Munro",
      role: "primary DA",
      trust: "high",
      tools: [
        "Bash", "Read", "Write", "Edit", "Grep", "Glob", "WebFetch", "WebSearch",
        "Agent", "TaskCreate", "TaskUpdate", "Cron*", "PushNotification",
        "all MCP servers (Gmail/Drive/Calendar/Context7/Playwright/Hermes)",
      ],
    },
    {
      name: "Explore",
      role: "subagent",
      trust: "medium",
      tools: ["Bash", "Read", "Grep", "Glob"],
    },
    {
      name: "Engineer",
      role: "subagent",
      trust: "medium",
      tools: ["full file-edit suite + Bash"],
    },
    {
      name: "Forge",
      role: "subagent (external: codex CLI)",
      trust: "medium",
      tools: ["codex exec via Bash subprocess"],
    },
    {
      name: "ProofReader",
      role: "subagent (read-only)",
      trust: "medium",
      tools: ["Read", "Grep"],
    },
    {
      name: "Cato",
      role: "security auditor subagent",
      trust: "high",
      tools: ["Read", "Grep", "Bash (read-only flag)"],
    },
  ],
  tools: [
    {
      name: "Bash",
      trust_required: "high",
      exfil_risk: "high",
      notes:
        "shell exec; can curl, ssh, git push, write anywhere with $HOME perms",
    },
    {
      name: "Write/Edit",
      trust_required: "high",
      exfil_risk: "medium",
      notes:
        "filesystem write; can modify PAI config, skills, hooks, settings.json",
    },
    {
      name: "WebFetch",
      trust_required: "medium",
      exfil_risk: "medium",
      notes:
        "data flows outbound to WebFetch's hosted small model",
    },
    {
      name: "PushNotification",
      trust_required: "medium",
      exfil_risk: "medium",
      notes: "external notify path; not authenticated to recipient",
    },
    {
      name: "Agent",
      trust_required: "high",
      exfil_risk: "medium",
      notes:
        "spawns subagents; inherits host credentials + tool surface for child processes",
    },
    {
      name: "Glob/Grep",
      trust_required: "medium",
      exfil_risk: "low",
      notes: "filesystem read paths under $HOME; can leak file presence / size via errors",
    },
  ],
  mcp_servers: [
    {
      name: "Gmail",
      trust: "external Google OAuth",
      scope: "full mailbox read/write",
      exfil_risk: "high",
      notes: "can send mail, read all history, modify labels",
    },
    {
      name: "Google_Drive",
      trust: "external Google OAuth",
      scope: "full drive read/write",
      exfil_risk: "high",
      notes: "can upload, share, modify permissions",
    },
    {
      name: "Google_Calendar",
      trust: "external Google OAuth",
      scope: "calendar CRUD",
      exfil_risk: "medium",
      notes: "read/write events; can leak meeting titles and attendees",
    },
    {
      name: "Context7",
      trust: "Upstash-hosted",
      scope: "library doc queries",
      exfil_risk: "low",
      notes: "queries outbound; no persistent storage of secrets",
    },
    {
      name: "Playwright",
      trust: "snap Chromium (local)",
      scope: "browser automation",
      exfil_risk: "medium",
      notes: "can navigate, fill forms, take screenshots",
    },
    {
      name: "Hermes",
      trust: "self-hosted bridge",
      scope: "cross-platform messaging",
      exfil_risk: "medium",
      notes: "can send to Telegram/Discord/Slack",
    },
  ],
  credentials: [
    {
      name: "Anthropic API key",
      scope: "Inference.ts",
      lifetime: "rotated via Passage",
    },
    {
      name: "Google OAuth tokens",
      scope: "Gmail/Drive/Calendar MCP",
      lifetime: "long-lived",
    },
    {
      name: "OpenRouter API key",
      scope: "ForgeOpenRouter.ts + AnvilProgress.ts",
      lifetime: "rotated",
    },
    {
      name: "ChatGPT OAuth (codex)",
      scope: "Forge subagent",
      lifetime: "long-lived",
    },
    {
      name: "ElevenLabs API key",
      scope: "voice notifications",
      lifetime: "long-lived",
    },
    {
      name: "Cloudflare API token",
      scope: "tunnel management",
      lifetime: "long-lived",
    },
    {
      name: "Forgejo credentials",
      scope: "git over SSH",
      lifetime: "long-lived",
    },
  ],
  data_flows: [
    {
      from: "user prompt",
      to: "Munro",
      data: "raw text + @imports",
      trust_boundary: "user → high-trust DA",
    },
    {
      from: "WebFetch response",
      to: "Munro context",
      data: "summarized page content",
      trust_boundary:
        "external → high-trust context (small-model summarization in path)",
    },
    {
      from: "MCP server response",
      to: "Munro context",
      data: "API response",
      trust_boundary: "external → high-trust context",
    },
    {
      from: "Subagent result",
      to: "Munro",
      data: "agent final message",
      trust_boundary: "medium-trust → high-trust DA",
    },
    {
      from: "Munro",
      to: "subagent prompt",
      data: "task + context",
      trust_boundary: "high-trust → medium-trust execution",
    },
    {
      from: "Bash subprocess",
      to: "host filesystem",
      data: "arbitrary",
      trust_boundary: "model → host (highest risk surface)",
    },
    {
      from: "Codex CLI (Forge)",
      to: "OpenAI API",
      data: "code + diffs",
      trust_boundary: "internal → external API",
    },
  ],
  trust_boundaries: [
    "user input → Munro (prompt injection surface; mitigated by hooks/PromptProcessing)",
    "external content (WebFetch, MCP responses) → context (poisoning surface; mitigated by maker-never-grader + fresh-context verify)",
    "MCP servers → high-trust context (MCP supply-chain risk; mitigated by server allowlist + scope review)",
    "Bash → host (arbitrary code execution; mitigated by sandbox + permission prompts)",
    "codex CLI → OpenAI (data exfil of code; mitigated by --ephemeral + secret scrubbing)",
    "subagent → Munro (transcript injection if subagent compromised)",
    "memory writes (MEMORY/WORK/* and MEMORY/KNOWLEDGE/*) → persistent state (poisoning; mitigated by content-hash integrity check)",
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Prompts — VERBATIM from Huang's threat_model.py main()
// Source: github.com/kenhuangus/fable5/projects/01_threat_model/threat_model.py
// ─────────────────────────────────────────────────────────────────────────────

const PREP_PROMPT_HEAD =
  "Turn this raw agent-stack manifest into a one-page architecture " +
  "doc: list every agent, its tools, MCP servers, credentials, and " +
  "who talks to whom with what data.\n\n";

const PLAN_PROMPT_HEAD =
  "Threat-model this agent stack. Cover: prompt injection paths " +
  "(where untrusted content enters and what it can reach), tool " +
  "poisoning (can one tool's output steer another agent), memory " +
  "persistence attacks (does anything read back its own or another " +
  "agent's saved state), and confused-deputy scenarios (does a " +
  "low-trust agent inherit a high-trust agent's credentials). Output " +
  "a ranked mitigation plan; flag anything that needs a human call.\n\n";

const EXECUTE_PROMPT_HEAD =
  "Turn this ranked mitigation plan into a numbered PR checklist, " +
  "one PR per finding, ordered by rank.\n\n";

// Grader prompt (in design doc section 3) — fresh-context, never sees executor narration
const GRADER_PROMPT_TEMPLATE = `Score this threat-model plan against the manifest.

PLAN:
{plan}

MANIFEST:
{manifest}

Score on three axes (return as JSON):
- coverage: 0-4 (one per attack class: injection, tool poisoning, memory, confused deputy)
- specificity_mean: 0.0-1.0 (mean specificity of all findings, where 5=concrete action, 3=category, 1=platitude)
- pai_specific: 0-3 (did the plan reference PAI's actual mitigation infrastructure by name/path and correctly characterize scope?)
- total: coverage + (specificity_mean * 3) + pai_specific, range 0-10

For each finding, return: { attack_class, finding_text, specificity_score, references_pai_mechanism }.
For coverage, return: { injection: bool, tool_poisoning: bool, memory_attacks: bool, confused_deputy: bool }.

Return ONLY the JSON object, no prose. Keys must include coverage_breakdown, coverage, specificity_mean, pai_specific, total, findings. Use 2 decimals for floats.`;

// ─────────────────────────────────────────────────────────────────────────────
// Slot config
// ─────────────────────────────────────────────────────────────────────────────

interface SlotSpec {
  key: string;
  label: string;
  /** Provider: "anthropic" | "openrouter" | "mistral" | "cohere" | "llamacpp" */
  provider: "anthropic" | "openrouter" | "mistral" | "cohere" | "llamacpp";
  /** Model slug passed to provider */
  model: string;
  /** output_config.effort (Anthropic only); undefined for OpenRouter */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Anthropic-only: server-side fallback beta */
  betas?: string[];
  /** Timeout in seconds */
  timeoutSec: number;
  /** Suggested max output tokens */
  maxTokens: number;
  /** Fallback model on quota exhaustion (OpenRouter only) */
  orFallback?: string;
}

// Curated roster for the full Tier-0/1 cloud + local sweep (2026-07-08).
// Each entry follows the SlotSpec contract. The roster is the source of
// truth here — unified_bench.ts has a superset but mixes direct-Anthropic +
// OpenRouter + NIM + native-Mistral/Cohere/Gemini/local. This harness wires
// five providers now: Anthropic-direct, OpenRouter, Mistral-direct, Cohere
// direct, and llama-server (your-inference-host V100 + your-other-host compatible). Native
// Gemini and NIM are still documented out-of-scope.
//
// Keys resolve as follows:
//   - Anthropic-direct → passage show api/anthropic
//   - OpenRouter       → OPENROUTER_API_KEY env
//   - Mistral-direct   → MISTRAL_API_KEY env or passage show api/mistral
//   - Cohere direct    → COHERE_API_KEY env or passage show api/cohere
//   - llamacpp         → no key; uses UBULLM_URL (default http://your-inference-host.lan:11434/v1)
//
// Local model slots assume the production alias is active on your-inference-host.
// To bench a different local model, the operator must SSH into your-inference-host and:
//   sudo systemctl stop llama-server
//   sudo sed -i 's|alias.*|--alias <name> -ngl 99 --host 0.0.0.0 --port 11434 -c 8192 -np 4 --alias <name>|' /etc/systemd/system/llama-server.service
//   sudo systemctl daemon-reload && sudo systemctl start llama-server
// (~50s reload time from HDD per swap; documented in reference_ubullm.md)
//
// Fable 5 is intentionally excluded — its routing verdict (thin wrapper,
// server-side fallback to Opus 4.8) was closed in the original 3-slot run.
const ROSTER: SlotSpec[] = [
  // ── Anthropic-direct (frontier + recent) ────────────────────────────────
  {
    key: "sonnet46", label: "Claude Sonnet 4.6 (Anthropic direct)",
    provider: "anthropic", model: "claude-sonnet-4-6",
    // no effort — output_config.effort is a Claude 5 family parameter; rejected
    // on Sonnet 4.6 with HTTP 400 (verified 2026-07-08 by the kill-on-400 logic).
    timeoutSec: 200, maxTokens: 8192,
  },
  {
    key: "sonnet5", label: "Claude Sonnet 5 (Anthropic direct)",
    provider: "anthropic", model: "claude-sonnet-5",
    effort: "medium",
    timeoutSec: 300, maxTokens: 8192,
  },
  {
    key: "haiku45", label: "Claude Haiku 4.5 (Anthropic direct, no effort)",
    provider: "anthropic", model: "claude-haiku-4-5-20251001",
    // no effort — Haiku 4.5 rejects the parameter (verified 2026-07-08)
    timeoutSec: 120, maxTokens: 8192,
  },
  {
    key: "opus48", label: "Claude Opus 4.8 (Anthropic direct, Tier-0 frontier)",
    provider: "anthropic", model: "claude-opus-4-8",
    effort: "medium",
    timeoutSec: 600, maxTokens: 8192,
  },
  // ── OpenRouter-routed frontier ─────────────────────────────────────────
  {
    key: "gpt54", label: "OpenAI GPT-5.4 (OpenRouter, high reasoning)",
    provider: "openrouter", model: "openai/gpt-5.4",
    timeoutSec: 300, maxTokens: 8192, orFallback: "mistralai/devstral-2512",
  },
  {
    key: "gpt55", label: "OpenAI GPT-5.5 (OpenRouter)",
    provider: "openrouter", model: "openai/gpt-5.5",
    timeoutSec: 300, maxTokens: 8192, orFallback: "mistralai/devstral-2512",
  },
  {
    key: "m3", label: "MiniMax M3 (OpenRouter proxy, 512K ctx)",
    provider: "openrouter", model: "MiniMax/MiniMax-M3",
    timeoutSec: 300, maxTokens: 8192,
  },
  {
    key: "glm52", label: "Z.ai GLM-5.2 (OpenRouter, 1M ctx, Tier-0 frontier)",
    provider: "openrouter", model: "z-ai/glm-5.2",
    timeoutSec: 300, maxTokens: 8192,
  },
  {
    key: "glm51", label: "Z.ai GLM-5.1 (OpenRouter, top of Z.ai)",
    provider: "openrouter", model: "z-ai/glm-5.1",
    timeoutSec: 300, maxTokens: 8192,
  },
  {
    key: "glm47", label: "Z.ai GLM-4.7 (OpenRouter, Sonnet slot)",
    provider: "openrouter", model: "z-ai/glm-4.7",
    timeoutSec: 300, maxTokens: 8192,
  },
  {
    key: "glm45air", label: "Z.ai GLM-4.5-air (OpenRouter, Haiku slot)",
    provider: "openrouter", model: "z-ai/glm-4.5-air",
    timeoutSec: 200, maxTokens: 8192,
  },
  {
    key: "mistralMedium35", label: "Mistral Medium 3.5 (Mistral direct, SOTA)",
    provider: "mistral", model: "mistral-medium-latest",
    timeoutSec: 300, maxTokens: 8192,
  },
  {
    key: "devstralMed", label: "Mistral Devstral Med (Mistral direct, coding leader)",
    provider: "mistral", model: "devstral-medium-latest",
    timeoutSec: 300, maxTokens: 8192,
  },
  {
    key: "codestral", label: "Mistral Codestral (Mistral direct, Tier-4 STRIDE)",
    provider: "mistral", model: "codestral-latest",
    timeoutSec: 300, maxTokens: 8192,
  },
  {
    key: "deepseekV4Pro", label: "DeepSeek V4 Pro (OpenRouter, Anvil-preferred)",
    provider: "openrouter", model: "deepseek/deepseek-v4-pro",
    timeoutSec: 300, maxTokens: 8192,
  },
  {
    key: "deepseekV4Flash", label: "DeepSeek V4 Flash (OpenRouter, SiliconFlow)",
    provider: "openrouter", model: "deepseek/deepseek-v4-flash",
    timeoutSec: 300, maxTokens: 8192,
  },
  {
    key: "kimiK26", label: "Kimi K2.6 (OpenRouter MoE, Anvil-only)",
    provider: "openrouter", model: "moonshotai/kimi-k2.6",
    timeoutSec: 600, maxTokens: 8192,
  },
  // ── Cohere direct (native Cohere API, /v2/chat) ────────────────────────────
  // North Mini Code is open-weight but not yet on the Cohere chat API as of
  // 2026-07-08; using their flagship command-a-plus-05-2026 instead.
  {
    key: "cohereCommandAPlus", label: "Cohere command-a-plus-05-2026 (Cohere direct, 436K ctx)",
    provider: "cohere", model: "command-a-plus-05-2026",
    timeoutSec: 300, maxTokens: 8192,
  },
  // ── Local llama-server (your-inference-host 127.0.0.1:11434) ──────────────────────
  // All 13 slots below resolve via provider:"llamacpp" → UBULLM_URL.
  // Each requires a `sudo systemctl restart llama-server` cycle (model swap)
  // except the first (qwen3:30b-a3b) which is the active production model.
  // Aliases match the systemd `--alias` flag values; your-inference-host-side swap is the
  // caller's responsibility (see §5 follow-ups in threat-model-bench-2026-07-08.md).
  {
    key: "qwen3_30b_a3b", label: "Qwen3-30B-A3B (your-inference-host active, 42/53 prod champ)",
    provider: "llamacpp", model: "qwen3:30b-a3b",
    timeoutSec: 600, maxTokens: 8192,
  },
  {
    key: "qwen3_coder_30b_a3b", label: "Qwen3-Coder-30B-A3B (your-inference-host, local #2 at 41/53)",
    provider: "llamacpp", model: "qwen3-coder-30b-a3b",
    timeoutSec: 600, maxTokens: 8192,
  },
  {
    key: "gpt_oss_20b", label: "gpt-oss-20b (your-inference-host MXFP4 MoE, agentic-validated)",
    provider: "llamacpp", model: "gpt-oss-20b",
    timeoutSec: 600, maxTokens: 8192,
  },
  {
    key: "mistral_small_31_24b", label: "mistral-small-3.1-24b (your-inference-host dense 24B, 36/53)",
    provider: "llamacpp", model: "mistral-small-3.1-24b",
    timeoutSec: 600, maxTokens: 8192,
  },
  {
    key: "nemotron_3_nano_30b_a3b", label: "nemotron-3-nano-30b-a3b (your-inference-host SSM MoE, 38/53)",
    provider: "llamacpp", model: "nemotron-3-nano-30b-a3b",
    timeoutSec: 600, maxTokens: 8192,
  },
  {
    key: "qwen36_27b", label: "Qwen3.6-27B (your-inference-host Q4_K_M, dense)",
    provider: "llamacpp", model: "qwen36:27b",
    timeoutSec: 600, maxTokens: 8192,
  },
  {
    key: "mellum2_12b_instruct", label: "Mellum2-12B-Instruct (your-inference-host, Apache 2.0)",
    provider: "llamacpp", model: "mellum2:12b-instruct",
    timeoutSec: 600, maxTokens: 8192,
  },
  {
    key: "gemma_4_26b_a4b", label: "gemma-4-26B-A4B-it (your-inference-host, MoE hot-cache candidate)",
    provider: "llamacpp", model: "gemma-4-26b-a4b",
    timeoutSec: 600, maxTokens: 8192,
  },
  {
    key: "nouscoder_14b", label: "NousCoder-14B (your-inference-host, coding specialist)",
    provider: "llamacpp", model: "nouscoder:14b",
    timeoutSec: 600, maxTokens: 8192,
  },
  {
    key: "gemma_4_31b", label: "gemma-4-31B-it (your-inference-host, dense 31B)",
    provider: "llamacpp", model: "gemma-4-31b",
    timeoutSec: 600, maxTokens: 8192,
  },
  {
    key: "gemma_3_27b", label: "gemma-3-27b-it (your-inference-host, dense 27B)",
    provider: "llamacpp", model: "gemma-3-27b",
    timeoutSec: 600, maxTokens: 8192,
  },
  {
    key: "nemotron_nano_9b_v2", label: "nemotron-nano-9b-v2 (your-inference-host, fast tier sleeper)",
    provider: "llamacpp", model: "nemotron-nano-9b-v2",
    timeoutSec: 600, maxTokens: 8192,
  },
  {
    key: "mellum2_12b_thinking", label: "Mellum2-12B-Thinking (your-inference-host, reasoning variant)",
    provider: "llamacpp", model: "mellum2:12b-thinking",
    timeoutSec: 600, maxTokens: 8192,
  },
];

function buildUnderTest(): Record<string, SlotSpec> {
  const out: Record<string, SlotSpec> = {};
  for (const s of ROSTER) out[s.key] = s;
  return out;
}
const UNDER_TEST: Record<string, SlotSpec> = buildUnderTest();

// Cheap fixed slots (per design doc section 2)
const PREP_MODEL = "claude-haiku-4-5-20251001"; // prep
const EXEC_MODEL = "claude-haiku-4-5-20251001"; // execute
const GRADER_MODEL = "claude-sonnet-5"; // fresh-context grader
// Grader uses effort: low — Sonnet 5 at high/max effort burns the entire
// max_tokens budget on thinking and returns 0 text blocks (the eval
// silently scores 0/10 even when the response is HTTP 200). Low effort
// keeps the JSON rubric output within the token budget.
const GRADER_EFFORT = "low";
const GRADER_MAX_TOKENS = 8192;
const PREP_TIMEOUT_SEC = 120;
const EXEC_TIMEOUT_SEC = 120;
const GRADER_TIMEOUT_SEC = 180;

// ─────────────────────────────────────────────────────────────────────────────
// Result types
// ─────────────────────────────────────────────────────────────────────────────

interface RoutingMeta {
  served_by: string;
  model_returned: string | null;
  stop_reason: string | null;
  stop_details_category: string | null;
  iterations: unknown[];
  served_by_fallback: boolean;
}

interface CallMeta {
  wall_seconds: number;
  input_tokens: number;
  output_tokens: number;
  thinking_tokens: number;
  cost_estimate_usd: number;
  raw_status: number;
  raw_error?: string;
}

interface CallResult {
  text: string;
  routing?: RoutingMeta;
  meta: CallMeta;
  rawJson?: unknown;
}

interface FindingGrade {
  attack_class: string;
  finding_text: string;
  specificity_score: number;
  references_pai_mechanism: string | null;
}

interface GraderResult {
  coverage: number;
  coverage_breakdown: {
    injection: boolean;
    tool_poisoning: boolean;
    memory_attacks: boolean;
    confused_deputy: boolean;
  };
  specificity_mean: number;
  pai_specific: number;
  total: number;
  findings: FindingGrade[];
  raw_text: string;
  meta: CallMeta;
}

interface RunResult {
  slot: string;
  slot_label: string;
  timestamp: string;
  manifest_path: string;
  prep: CallResult;
  plan_or_audit: CallResult;
  execute: CallResult;
  grader: GraderResult;
  routing: RoutingMeta;
  cost_total_usd: number;
  wall_total_seconds: number;
  notes: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic API helpers
// ─────────────────────────────────────────────────────────────────────────────

interface AnthropicResponse {
  id: string;
  type: string;
  role: string;
  content: Array<{
    type: string;
    text?: string;
    thinking?: string;
  }>;
  model: string;
  stop_reason: string | null;
  stop_sequence: string | null;
  stop_details?: { category?: string; reason?: string } | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    /** Thinking-mode token accounting for Fable 5 / Claude 5 family.
     *  When present, thinking_tokens counts toward the output_tokens total
     *  but is broken out separately for billing visibility. */
    output_tokens_details?: {
      thinking_tokens?: number;
    };
  };
  iterations?: Array<{
    type: string;
    model?: string;
    input_tokens?: number;
    output_tokens?: number;
  }>;
}

/** Get Anthropic API key from `passage show api/anthropic` (never bake into source) */
async function getAnthropicKey(): Promise<string> {
  const proc = spawn({
    cmd: ["passage", "show", "api/anthropic"],
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`passage show api/anthropic exited ${exitCode}`);
  }
  const key = stdout.trim();
  if (!key) throw new Error("passage returned empty Anthropic key");
  return key;
}

/** Per-million-token USD pricing used purely for cost estimates */
const PRICING: Record<
  string,
  { input: number; output: number; thinking?: number }
> = {
  "claude-fable-5": { input: 10, output: 50, thinking: 50 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5, thinking: 5 },
  "claude-sonnet-5": { input: 3, output: 15, thinking: 15 },
  // OpenRouter prices (GPT-5.4 parity per Anthropic 5× markup assumption)
  "openai/gpt-5.4": { input: 2.5, output: 15, thinking: 15 },
  "mistralai/devstral-2512": { input: 0.4, output: 2, thinking: 2 },
  "deepseek/deepseek-v4-flash": { input: 0.11, output: 0.22 },
  "deepseek/deepseek-v4-pro": { input: 0.44, output: 0.87 },
  "openrouter-default": { input: 1, output: 5, thinking: 5 },
  // Mistral direct API prices (per
  // PAI/MEMORY/KNOWLEDGE/Research/mistral-api-pricing-2026-06.md).
  // Used when slot.provider === "mistral" — billed as open-mistral-tier pricing,
  // not the OpenRouter 5× markup tier.
  "mistral-medium-latest": { input: 1.5, output: 7.5 },
  "devstral-medium-latest": { input: 0.4, output: 2 },
  "codestral-latest": { input: 0.3, output: 0.9 },
  "mistral-default": { input: 1, output: 3 },
};

function estimateCost(model: string, input: number, output: number, thinking: number): number {
  const p = PRICING[model] ?? PRICING["openrouter-default"];
  const inputCost = (input / 1_000_000) * p.input;
  const thinkingCost = (thinking / 1_000_000) * (p.thinking ?? p.output);
  const outputCost = ((output - thinking) / 1_000_000) * p.output;
  // Negative-safe (some providers count thinking inside output)
  return Math.max(0, inputCost + outputCost + thinkingCost);
}

interface AnthropicCallOpts {
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  betas?: string[];
  jsonMode?: boolean;
  timeoutSec?: number;
}

/** Direct Anthropic API call. Returns text + routing metadata. Never throws on refusals. */
async function callAnthropic(
  model: string,
  systemPrompt: string | null,
  userPrompt: string,
  apiKey: string,
  opts: AnthropicCallOpts = {},
): Promise<CallResult> {
  const t0 = Date.now();
  const timeoutMs = (opts.timeoutSec ?? 120) * 1000;
  const payload: Record<string, unknown> = {
    model,
    max_tokens: 8192,
    messages: [{ role: "user", content: userPrompt }],
  };
  if (systemPrompt) payload.system = systemPrompt;
  if (opts.effort) {
    payload.output_config = { effort: opts.effort };
  }
  // Note: `betas` go in the `anthropic-beta` header (set below), NOT in the
  // body. The Anthropic API rejects `betas` in the request body with
  // "betas: Extra inputs are not permitted" — confirmed via curl 2026-07-08.
  // Fable 5's server-side-fallback-2026-06-01 beta is activated by the header;
  // the `fallbacks` body field is the separate mechanism for specifying the
  // fallback model chain.
  if (opts.betas && opts.betas.includes("server-side-fallback-2026-06-01")) {
    payload.fallbacks = [{ model: "claude-opus-4-8" }];
  }
  if (opts.jsonMode) {
    // Some Anthropic beta headers enable JSON output; we use a strict prompt instead.
    // Skip the headers feature for portability.
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        ...(opts.betas ? { "anthropic-beta": opts.betas.join(",") } : {}),
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const wall = (Date.now() - t0) / 1000;
    const status = resp.status;
    const raw = (await resp.json()) as AnthropicResponse | { error?: unknown };
    if (!resp.ok) {
      return {
        text: "",
        meta: {
          wall_seconds: wall,
          input_tokens: 0,
          output_tokens: 0,
          thinking_tokens: 0,
          cost_estimate_usd: 0,
          raw_status: status,
          raw_error: JSON.stringify(raw).slice(0, 1000),
        },
      };
    }
    const data = raw as AnthropicResponse;
    const text = (data.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
    const thinkingTokens =
      data.usage?.output_tokens_details?.thinking_tokens
      ?? data.usage?.output_tokens
      ?? 0; // Fable 5 returns thinking_tokens in output_tokens_details; older
             // models (no thinking) fall back to the total output_tokens count.
    const input_tokens = data.usage?.input_tokens ?? 0;
    const output_tokens = data.usage?.output_tokens ?? 0;
    const cost = estimateCost(model, input_tokens, output_tokens, thinkingTokens);
    const iterations: unknown[] = Array.isArray(data.iterations) ? data.iterations : [];
    const served_by_fallback =
      iterations.some(
        (i) =>
          typeof i === "object" && i !== null && (i as { type?: string }).type === "fallback_message",
      ) ||
      // Also detect by model mismatch: if data.model differs from requested model, fallback fired
      (data.model !== model);
    const routing: RoutingMeta = {
      served_by: data.model ?? model,
      model_returned: data.model ?? null,
      stop_reason: data.stop_reason ?? null,
      stop_details_category: data.stop_details?.category ?? null,
      iterations,
      served_by_fallback,
    };
    return {
      text,
      routing,
      meta: {
        wall_seconds: wall,
        input_tokens,
        output_tokens,
        thinking_tokens: thinkingTokens,
        cost_estimate_usd: cost,
        raw_status: status,
      },
      rawJson: data,
    };
  } catch (e) {
    clearTimeout(timer);
    const wall = (Date.now() - t0) / 1000;
    const isAbort = (e as Error).name === "AbortError";
    return {
      text: "",
      meta: {
        wall_seconds: wall,
        input_tokens: 0,
        output_tokens: 0,
        thinking_tokens: 0,
        cost_estimate_usd: 0,
        raw_status: 0,
        raw_error: isAbort ? `timeout after ${(opts.timeoutSec ?? 120)}s` : (e as Error).message,
      },
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenRouter helpers
// ─────────────────────────────────────────────────────────────────────────────

interface OpenRouterResponse {
  id: string;
  model: string;
  choices: Array<{
    message: { role: string; content: string };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: { message: string; code?: number };
}

interface OpenRouterCallOpts {
  model: string;
  fallbackModel?: string;
  timeoutSec?: number;
}

async function callOpenRouter(
  systemPrompt: string | null,
  userPrompt: string,
  apiKey: string,
  opts: OpenRouterCallOpts,
): Promise<CallResult> {
  const tryCall = async (model: string): Promise<CallResult> => {
    const t0 = Date.now();
    const timeoutMs = (opts.timeoutSec ?? 300) * 1000;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const messages = [];
      if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
      messages.push({ role: "user", content: userPrompt });
      const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
          "HTTP-Referer": "https://pai.local/threat-model-bench",
          "X-Title": "PAI Threat Model Bench",
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: 8192,
          temperature: 0.2,
        }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const wall = (Date.now() - t0) / 1000;
      const status = resp.status;
      const raw = (await resp.json()) as OpenRouterResponse;
      if (!resp.ok) {
        const errBody = raw.error?.message ?? `HTTP ${status}`;
        // 429 = quota exhausted -> fall back
        if (status === 429 && opts.fallbackModel && model !== opts.fallbackModel) {
          const subbed = await tryCall(opts.fallbackModel);
          subbed.meta.raw_error = `primary ${model} quota exhausted (429); fell back to ${opts.fallbackModel} — ${errBody.slice(0, 200)}`;
          return subbed;
        }
        return {
          text: "",
          meta: {
            wall_seconds: wall,
            input_tokens: 0,
            output_tokens: 0,
            thinking_tokens: 0,
            cost_estimate_usd: 0,
            raw_status: status,
            raw_error: errBody.slice(0, 1000),
          },
        };
      }
      const text = raw.choices?.[0]?.message?.content ?? "";
      const input = raw.usage?.prompt_tokens ?? 0;
      const output = raw.usage?.completion_tokens ?? 0;
      const cost = estimateCost(model, input, output, 0);
      return {
        text,
        routing: {
          served_by: raw.model ?? model,
          model_returned: raw.model ?? model,
          stop_reason: raw.choices?.[0]?.finish_reason ?? null,
          stop_details_category: null,
          iterations: [],
          served_by_fallback: raw.model !== model,
        },
        meta: {
          wall_seconds: wall,
          input_tokens: input,
          output_tokens: output,
          thinking_tokens: 0,
          cost_estimate_usd: cost,
          raw_status: status,
        },
        rawJson: raw,
      };
    } catch (e) {
      clearTimeout(timer);
      const wall = (Date.now() - t0) / 1000;
      const isAbort = (e as Error).name === "AbortError";
      return {
        text: "",
        meta: {
          wall_seconds: wall,
          input_tokens: 0,
          output_tokens: 0,
          thinking_tokens: 0,
          cost_estimate_usd: 0,
          raw_status: 0,
          raw_error: isAbort ? `timeout after ${(opts.timeoutSec ?? 300)}s` : (e as Error).message,
        },
      };
    }
  };
  return tryCall(opts.model);
}

// ─────────────────────────────────────────────────────────────────────────────
// Mistral API helpers (native mistral.ai, OpenAI-compatible schema)
// ─────────────────────────────────────────────────────────────────────────────

/** Resolve Mistral API key from `passage show api/mistral` */
async function getMistralKey(): Promise<string> {
  const proc = spawn({
    cmd: ["passage", "show", "api/mistral"],
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`passage show api/mistral exited ${exitCode}`);
  }
  const key = stdout.trim();
  if (!key) throw new Error("passage returned empty Mistral key");
  return key;
}

interface MistralResponse {
  id: string;
  model: string;
  choices: Array<{
    message: {
      role: string;
      // Mistral returns content as either a string OR (for Magistral /
      // reasoning models) a list of blocks shaped like OpenAI's
      // chat.completions content list. We accept either.
      content: string | Array<{ type: string; text?: string }>;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: { message: string; code?: number };
}

/** Direct Mistral API call. OpenAI-compatible /v1/chat/completions.
 *  Always returns the joined text from text-type blocks; never throws on refusals. */
async function callMistral(
  systemPrompt: string | null,
  userPrompt: string,
  apiKey: string,
  opts: { model: string; timeoutSec?: number },
): Promise<CallResult> {
  const t0 = Date.now();
  const timeoutMs = (opts.timeoutSec ?? 300) * 1000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const messages = [];
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    messages.push({ role: "user", content: userPrompt });
    const resp = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: opts.model,
        messages,
        max_tokens: 8192,
        temperature: 0.2,
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const wall = (Date.now() - t0) / 1000;
    const status = resp.status;
    const raw = (await resp.json()) as MistralResponse;
    if (!resp.ok) {
      const errBody = raw.error?.message ?? `HTTP ${status}`;
      return {
        text: "",
        meta: {
          wall_seconds: wall,
          input_tokens: 0,
          output_tokens: 0,
          thinking_tokens: 0,
          cost_estimate_usd: 0,
          raw_status: status,
          raw_error: errBody.slice(0, 1000),
        },
      };
    }
    // Mistral returns content as string OR list of {type, text} blocks
    // (Magistral reasoning models do the latter). Join text blocks only.
    const rawContent = raw.choices?.[0]?.message?.content ?? "";
    let text: string;
    if (typeof rawContent === "string") {
      text = rawContent;
    } else {
      text = rawContent
        .filter((b) => typeof b === "object" && b?.type === "text")
        .map((b) => b.text ?? "")
        .join("");
    }
    const input = raw.usage?.prompt_tokens ?? 0;
    const output = raw.usage?.completion_tokens ?? 0;
    const cost = estimateCost(opts.model, input, output, 0);
    return {
      text,
      routing: {
        served_by: raw.model ?? opts.model,
        model_returned: raw.model ?? null,
        stop_reason: raw.choices?.[0]?.finish_reason ?? null,
        stop_details_category: null,
        iterations: [],
        served_by_fallback: raw.model !== opts.model,
      },
      meta: {
        wall_seconds: wall,
        input_tokens: input,
        output_tokens: output,
        thinking_tokens: 0,
        cost_estimate_usd: cost,
        raw_status: status,
      },
      rawJson: raw,
    };
  } catch (e) {
    clearTimeout(timer);
    const wall = (Date.now() - t0) / 1000;
    const isAbort = (e as Error).name === "AbortError";
    return {
      text: "",
      meta: {
        wall_seconds: wall,
        input_tokens: 0,
        output_tokens: 0,
        thinking_tokens: 0,
        cost_estimate_usd: 0,
        raw_status: 0,
        raw_error: isAbort ? `timeout after ${(opts.timeoutSec ?? 300)}s` : (e as Error).message,
      },
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cohere API helpers (native cohere.com/v2/chat — stubbed 2026-07-08)
// ─────────────────────────────────────────────────────────────────────────────

/** Resolve Cohere API key from `passage show api/cohere` */
async function getCohereKey(): Promise<string> {
  const proc = spawn({
    cmd: ["passage", "show", "api/cohere"],
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`passage show api/cohere exited ${exitCode}`);
  }
  const key = stdout.trim();
  if (!key) throw new Error("passage returned empty Cohere key");
  return key;
}

/** Cohere /v2/chat path. Native Cohere API.
 *  Cohere does NOT currently serve `north-mini-code` via the chat API as of
 *  2026-07-08; available Tier-4 candidates are command-a-plus-05-2026 (436K
 *  ctx, flagship) and command-a-reasoning-08-2025 (reasoning specialist).
 *  North Mini Code is open-weight on HuggingFace but local-only; bench it
 *  via the llamacpp provider when added to ROSTER. */
async function callCohere(
  systemPrompt: string | null,
  userPrompt: string,
  apiKey: string,
  opts: { model: string; timeoutSec?: number },
): Promise<CallResult> {
  const t0 = Date.now();
  const timeoutMs = (opts.timeoutSec ?? 300) * 1000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const messages = [];
    if (systemPrompt) {
      messages.push({ role: "system", content: systemPrompt });
    }
    messages.push({ role: "user", content: userPrompt });
    const resp = await fetch("https://api.cohere.ai/v2/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: opts.model,
        stream: false,
        messages,
        max_tokens: 8192,
        temperature: 0.2,
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const wall = (Date.now() - t0) / 1000;
    const status = resp.status;
    const raw = (await resp.json()) as {
      id?: string;
      finish_reason?: string;
      message?: {
        role: string;
        content?: Array<{ type: string; text?: string; thinking?: string }>;
      };
      usage?: {
        billed_units?: { input_tokens?: number; output_tokens?: number };
        tokens?: {
          input_tokens?: number;
          output_tokens?: number;
          reasoning_tokens?: number;
        };
      };
      error?: { message: string };
    };
    if (!resp.ok) {
      return {
        text: "",
        meta: {
          wall_seconds: wall,
          input_tokens: 0,
          output_tokens: 0,
          thinking_tokens: 0,
          cost_estimate_usd: 0,
          raw_status: status,
          raw_error: (raw.error?.message ?? `HTTP ${status}`).slice(0, 1000),
        },
      };
    }
    // Cohere returns content as a list of blocks (text + thinking). Join
    // text blocks only — thinking blocks are model internal reasoning.
    const blocks = raw.message?.content ?? [];
    const text = blocks
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("");
    const input = raw.usage?.tokens?.input_tokens ?? raw.usage?.billed_units?.input_tokens ?? 0;
    const output = raw.usage?.tokens?.output_tokens ?? raw.usage?.billed_units?.output_tokens ?? 0;
    const reasoning = raw.usage?.tokens?.reasoning_tokens ?? 0;
    // Cohere command-a-plus pricing (per https://cohere.com/pricing, July 2026):
    // $2.50 input / $10 output per MTok. Reasoning tokens are billed as
    // output (per Cohere docs).
    const inputCost = (input / 1_000_000) * 2.5;
    const outputCost = (output / 1_000_000) * 10;
    const cost = inputCost + outputCost;
    return {
      text,
      routing: {
        served_by: opts.model,
        model_returned: opts.model,
        stop_reason: raw.finish_reason ?? null,
        stop_details_category: null,
        iterations: [],
        served_by_fallback: false,
      },
      meta: {
        wall_seconds: wall,
        input_tokens: input,
        output_tokens: output,
        thinking_tokens: reasoning,
        cost_estimate_usd: cost,
        raw_status: status,
      },
      rawJson: raw,
    };
  } catch (e) {
    clearTimeout(timer);
    const wall = (Date.now() - t0) / 1000;
    const isAbort = (e as Error).name === "AbortError";
    return {
      text: "",
      meta: {
        wall_seconds: wall,
        input_tokens: 0,
        output_tokens: 0,
        thinking_tokens: 0,
        cost_estimate_usd: 0,
        raw_status: 0,
        raw_error: isAbort ? `timeout after ${(opts.timeoutSec ?? 300)}s` : (e as Error).message,
      },
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// llama.cpp / local HTTP helpers (stubbed 2026-07-08)
// ─────────────────────────────────────────────────────────────────────────────

/** llama-server OpenAI-compatible endpoint. Used for your-inference-host and your-other-host.
 *  Default URL: http://your-inference-host.lan:11434/v1 (configurable via UBULLM_URL). */
interface LlamacppCallOpts {
  baseUrl?: string;
  model: string;
  timeoutSec?: number;
}

async function callLlamacpp(
  systemPrompt: string | null,
  userPrompt: string,
  _apiKey: string,
  opts: LlamacppCallOpts,
): Promise<CallResult> {
  const t0 = Date.now();
  const baseUrl = opts.baseUrl ?? process.env.UBULLM_URL ?? "http://your-inference-host.lan:11434/v1";
  const timeoutMs = (opts.timeoutSec ?? 600) * 1000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const messages = [];
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    messages.push({ role: "user", content: userPrompt });
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: opts.model,
        messages,
        max_tokens: 8192,
        temperature: 0.2,
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const wall = (Date.now() - t0) / 1000;
    const status = resp.status;
    if (!resp.ok) {
      return {
        text: "",
        meta: {
          wall_seconds: wall,
          input_tokens: 0,
          output_tokens: 0,
          thinking_tokens: 0,
          cost_estimate_usd: 0,
          raw_status: status,
          raw_error: `llamacpp ${baseUrl} → HTTP ${status}`,
        },
      };
    }
    const raw = (await resp.json()) as {
      model: string;
      choices: Array<{ message: { content: string }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = raw.choices?.[0]?.message?.content ?? "";
    const input = raw.usage?.prompt_tokens ?? 0;
    const output = raw.usage?.completion_tokens ?? 0;
    return {
      text,
      routing: {
        served_by: raw.model ?? opts.model,
        model_returned: raw.model ?? null,
        stop_reason: raw.choices?.[0]?.finish_reason ?? null,
        stop_details_category: null,
        iterations: [],
        served_by_fallback: raw.model !== opts.model,
      },
      meta: {
        wall_seconds: wall,
        input_tokens: input,
        output_tokens: output,
        thinking_tokens: 0,
        // Local is free (electricity only); cost estimate $0.
        cost_estimate_usd: 0,
        raw_status: status,
      },
      rawJson: raw,
    };
  } catch (e) {
    clearTimeout(timer);
    const wall = (Date.now() - t0) / 1000;
    const isAbort = (e as Error).name === "AbortError";
    return {
      text: "",
      meta: {
        wall_seconds: wall,
        input_tokens: 0,
        output_tokens: 0,
        thinking_tokens: 0,
        cost_estimate_usd: 0,
        raw_status: 0,
        raw_error: isAbort ? `timeout after ${(opts.timeoutSec ?? 600)}s` : (e as Error).message,
      },
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Unified slot caller (dispatches based on slot.provider)
// ─────────────────────────────────────────────────────────────────────────────

interface SlotCallOpts {
  systemPrompt?: string | null;
  userPrompt: string;
  anthropicKey?: string;
  openrouterKey?: string;
  mistralKey?: string;
  cohereKey?: string;
  llamacppKey?: string;
  jsonMode?: boolean;
}

async function callSlot(slot: SlotSpec, o: SlotCallOpts): Promise<CallResult> {
  if (slot.provider === "anthropic") {
    if (!o.anthropicKey) {
      return emptyCallResult("anthropic key missing");
    }
    return callAnthropic(slot.model, o.systemPrompt ?? null, o.userPrompt, o.anthropicKey, {
      effort: slot.effort,
      betas: slot.betas,
      jsonMode: o.jsonMode,
      timeoutSec: slot.timeoutSec,
    });
  } else if (slot.provider === "mistral") {
    if (!o.mistralKey) {
      return emptyCallResult("mistral key missing");
    }
    return callMistral(o.systemPrompt ?? null, o.userPrompt, o.mistralKey, {
      model: slot.model,
      timeoutSec: slot.timeoutSec,
    });
  } else if (slot.provider === "cohere") {
    if (!o.cohereKey) {
      return emptyCallResult("cohere key missing");
    }
    return callCohere(o.systemPrompt ?? null, o.userPrompt, o.cohereKey, {
      model: slot.model,
      timeoutSec: slot.timeoutSec,
    });
  } else if (slot.provider === "llamacpp") {
    // llamacpp uses no API key (local llama-server); pass anything.
    return callLlamacpp(o.systemPrompt ?? null, o.userPrompt, o.llamacppKey ?? "local", {
      model: slot.model,
      timeoutSec: slot.timeoutSec,
    });
  } else {
    if (!o.openrouterKey) {
      return emptyCallResult("openrouter key missing");
    }
    return callOpenRouter(o.systemPrompt ?? null, o.userPrompt, o.openrouterKey, {
      model: slot.model,
      fallbackModel: slot.orFallback,
      timeoutSec: slot.timeoutSec,
    });
  }
}

function emptyCallResult(reason: string): CallResult {
  return {
    text: "",
    meta: {
      wall_seconds: 0,
      input_tokens: 0,
      output_tokens: 0,
      thinking_tokens: 0,
      cost_estimate_usd: 0,
      raw_status: 0,
      raw_error: reason,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Grader
// ─────────────────────────────────────────────────────────────────────────────

async function callGrader(
  plan: string,
  manifestJson: string,
  anthropicKey: string,
): Promise<GraderResult> {
  const prompt = GRADER_PROMPT_TEMPLATE
    .replace("{plan}", plan)
    .replace("{manifest}", manifestJson);
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GRADER_TIMEOUT_SEC * 1000);
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: GRADER_MODEL,
        max_tokens: GRADER_MAX_TOKENS,
        output_config: { effort: GRADER_EFFORT },
        messages: [{ role: "user", content: prompt }],
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const wall = (Date.now() - t0) / 1000;
    const raw = (await resp.json()) as AnthropicResponse & { error?: { message: string } };
    if (!resp.ok) {
      return {
        coverage: 0,
        coverage_breakdown: {
          injection: false,
          tool_poisoning: false,
          memory_attacks: false,
          confused_deputy: false,
        },
        specificity_mean: 0,
        pai_specific: 0,
        total: 0,
        findings: [],
        raw_text: "",
        meta: {
          wall_seconds: wall,
          input_tokens: 0,
          output_tokens: 0,
          thinking_tokens: 0,
          cost_estimate_usd: 0,
          raw_status: resp.status,
          raw_error: raw.error?.message ?? `HTTP ${resp.status}`,
        },
      };
    }
    const text = (raw.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
    const input = raw.usage?.input_tokens ?? 0;
    const output = raw.usage?.output_tokens ?? 0;
    const cost = estimateCost(GRADER_MODEL, input, output, output);
    const parsed = parseGraderJson(text);
    return {
      ...parsed,
      raw_text: text,
      meta: {
        wall_seconds: wall,
        input_tokens: input,
        output_tokens: output,
        thinking_tokens: output,
        cost_estimate_usd: cost,
        raw_status: 200,
      },
    };
  } catch (e) {
    clearTimeout(timer);
    const wall = (Date.now() - t0) / 1000;
    const isAbort = (e as Error).name === "AbortError";
    return {
      coverage: 0,
      coverage_breakdown: {
        injection: false,
        tool_poisoning: false,
        memory_attacks: false,
        confused_deputy: false,
      },
      specificity_mean: 0,
      pai_specific: 0,
      total: 0,
      findings: [],
      raw_text: "",
      meta: {
        wall_seconds: wall,
        input_tokens: 0,
        output_tokens: 0,
        thinking_tokens: 0,
        cost_estimate_usd: 0,
        raw_status: 0,
        raw_error: isAbort ? "timeout" : (e as Error).message,
      },
    };
  }
}

/** Find the first JSON object in the grader text and parse it. Tolerant of prose wrappers. */
function parseGraderJson(text: string): Omit<GraderResult, "raw_text" | "meta"> {
  // Strip code fences if present
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : text;
  // Find first { ... } block
  const first = candidate.indexOf("{");
  const last = candidate.lastIndexOf("}");
  if (first < 0 || last < 0) {
    return {
      coverage: 0,
      coverage_breakdown: {
        injection: false,
        tool_poisoning: false,
        memory_attacks: false,
        confused_deputy: false,
      },
      specificity_mean: 0,
      pai_specific: 0,
      total: 0,
      findings: [],
    };
  }
  const slice = candidate.slice(first, last + 1);
  try {
    const obj = JSON.parse(slice);
    // Coverage: derive from coverage_breakdown (count of true fields), not
    // `obj.coverage` — graders often return coverage as the breakdown object,
    // and Number({...}) = NaN (which the clamp can't recover from). The
    // breakdown is always present per the grader prompt; if absent, fall back
    // to whatever number the grader declared.
    const cbRaw = obj.coverage_breakdown as Record<string, unknown> | null | undefined;
    let coverageFromBreakdown: number | null = null;
    if (cbRaw && typeof cbRaw === "object") {
      const truthCount = Object.values(cbRaw).filter((v) => v === true).length;
      // 4 attack classes in the rubric; cap at 4 to defend against a chatty
      // grader that adds extra keys.
      coverageFromBreakdown = Math.min(4, truthCount);
    }
    const declaredCoverage = Number(obj.coverage);
    const coverage =
      Number.isFinite(declaredCoverage) && declaredCoverage >= 0 && declaredCoverage <= 4
        ? declaredCoverage
        : coverageFromBreakdown ?? 0;
    const specificity = Number(obj.specificity_mean ?? 0);
    const pai = Number(obj.pai_specific ?? 0);
    // Always recompute total from components — graders sometimes ignore the
    // range-0-10 cap and return inflated scores (e.g. 4 + 3.6*3 + 1 = 15.8).
    // The design doc formula is coverage (0-4) + min(3, specificity*3) (0-3)
    // + pai_specific (0-3) = 0-10. We trust the components, not the model.
    const total = Math.min(10, Math.max(0,
      coverage + Math.min(3, specificity * 3) + pai
    ));
    const findings: FindingGrade[] = Array.isArray(obj.findings)
      ? obj.findings.map((f: Record<string, unknown>) => ({
          attack_class: String(f.attack_class ?? ""),
          finding_text: String(f.finding_text ?? ""),
          specificity_score: Number(f.specificity_score ?? 0),
          references_pai_mechanism: f.references_pai_mechanism
            ? String(f.references_pai_mechanism)
            : null,
        }))
      : [];
    const cb = obj.coverage_breakdown ?? {};
    return {
      coverage,
      coverage_breakdown: {
        injection: !!(cb.injection ?? cb.injection_paths ?? false),
        tool_poisoning: !!(cb.tool_poisoning ?? false),
        memory_attacks: !!(cb.memory_attacks ?? cb.memory_persistence ?? false),
        confused_deputy: !!(cb.confused_deputy ?? false),
      },
      specificity_mean: specificity,
      pai_specific: pai,
      total,
      findings,
    };
  } catch {
    return {
      coverage: 0,
      coverage_breakdown: {
        injection: false,
        tool_poisoning: false,
        memory_attacks: false,
        confused_deputy: false,
      },
      specificity_mean: 0,
      pai_specific: 0,
      total: 0,
      findings: [],
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-run orchestration (one slot)
// ─────────────────────────────────────────────────────────────────────────────

interface RunOneOpts {
  slotKey: string;
  manifestJson: string;
  anthropicKey: string;
  openrouterKey: string;
  mistralKey?: string;
  cohereKey?: string;
  llamacppKey?: string;
  dryRun: boolean;
}

async function runOne(opts: RunOneOpts): Promise<RunResult> {
  const slot = UNDER_TEST[opts.slotKey];
  if (!slot) throw new Error(`Unknown slot: ${opts.slotKey}`);
  const notes: string[] = [];
  const runStart = Date.now();

  if (opts.dryRun) {
    // In dry-run we synthesize plausible "would have called" records.
    return {
      slot: slot.key,
      slot_label: slot.label,
      timestamp: new Date().toISOString(),
      manifest_path: "(embedded PAI manifest)",
      prep: dryRunCall("prep", PREP_MODEL, "anthropic", PREP_TIMEOUT_SEC),
      plan_or_audit: dryRunCall("plan_or_audit", slot.model, slot.provider, slot.timeoutSec, slot),
      execute: dryRunCall("execute", EXEC_MODEL, "anthropic", EXEC_TIMEOUT_SEC),
      grader: dryRunGrader(),
      routing: {
        served_by: "DRY-RUN",
        model_returned: null,
        stop_reason: null,
        stop_details_category: null,
        iterations: [],
        served_by_fallback: false,
      },
      cost_total_usd: 0,
      wall_total_seconds: 0,
      notes: ["--dry-run: no API calls made"],
    };
  }

  // 1. PREP — cheap Haiku model, manifest -> one-page architecture doc
  const prep = await callSlot(
    { key: "prep", label: "prep", provider: "anthropic", model: PREP_MODEL, timeoutSec: PREP_TIMEOUT_SEC, maxTokens: 4096 },
    {
      userPrompt: PREP_PROMPT_HEAD + opts.manifestJson,
      anthropicKey: opts.anthropicKey,
    },
  );

  // 2. PLAN/AUDIT — the variable
  const planPrompt = PLAN_PROMPT_HEAD + prep.text;
  const plan = await callSlot(slot, {
    userPrompt: planPrompt,
    anthropicKey: opts.anthropicKey,
    openrouterKey: opts.openrouterKey,
    mistralKey: opts.mistralKey,
    cohereKey: opts.cohereKey,
    llamacppKey: opts.llamacppKey,
  });

  // Track routing meta for the headline. For OpenRouter, the served_by tag is per-model.
  // Capture any meta-level findings:
  if (plan.routing?.stop_details_category) {
    notes.push(
      `Plan call returned with stop_details.category=${plan.routing.stop_details_category} (Fable 5 classifiers fired)`,
    );
  }
  if (plan.routing?.served_by_fallback) {
    notes.push(
      `Plan call served by fallback: actual model=${plan.routing.model_returned} (expected=${slot.model})`,
    );
  }
  if (plan.meta.raw_error) {
    notes.push(`Plan call error: ${plan.meta.raw_error.slice(0, 200)}`);
  }
  if (plan.routing?.stop_reason === "refusal") {
    notes.push(
      `REFUSAL: model refused the request outright. category=${plan.routing.stop_details_category ?? "unknown"}. This is data — see design-doc section 7.`,
    );
  }

  // 3. EXECUTE — cheap Haiku, plan -> PR checklist
  const exec = await callSlot(
    { key: "execute", label: "execute", provider: "anthropic", model: EXEC_MODEL, timeoutSec: EXEC_TIMEOUT_SEC, maxTokens: 4096 },
    {
      userPrompt: EXECUTE_PROMPT_HEAD + plan.text,
      anthropicKey: opts.anthropicKey,
    },
  );

  // 4. GRADER — fresh-context Sonnet 5 (never sees executor narration, sees only plan + manifest)
  const grader = await callGrader(plan.text, opts.manifestJson, opts.anthropicKey);

  const wallTotal = (Date.now() - runStart) / 1000;
  const costTotal =
    prep.meta.cost_estimate_usd +
    plan.meta.cost_estimate_usd +
    exec.meta.cost_estimate_usd +
    grader.meta.cost_estimate_usd;

  return {
    slot: slot.key,
    slot_label: slot.label,
    timestamp: new Date().toISOString(),
    manifest_path: "(embedded PAI manifest)",
    prep,
    plan_or_audit: plan,
    execute: exec,
    grader,
    routing: plan.routing ?? {
      served_by: slot.model,
      model_returned: null,
      stop_reason: null,
      stop_details_category: null,
      iterations: [],
      served_by_fallback: false,
    },
    cost_total_usd: costTotal,
    wall_total_seconds: wallTotal,
    notes,
  };
}

function dryRunCall(
  name: string,
  model: string,
  provider: "anthropic" | "openrouter",
  timeoutSec: number,
  slot?: SlotSpec,
): CallResult {
  return {
    text: `[DRY-RUN ${name}] would call ${model} via ${provider} (timeout ${timeoutSec}s)` +
      (slot?.effort ? ` effort=${slot.effort}` : "") +
      (slot?.betas ? ` betas=${slot.betas.join(",")}` : ""),
    routing: {
      served_by: model,
      model_returned: model,
      stop_reason: "end_turn",
      stop_details_category: null,
      iterations: [],
      served_by_fallback: false,
    },
    meta: {
      wall_seconds: 0,
      input_tokens: 0,
      output_tokens: 0,
      thinking_tokens: 0,
      cost_estimate_usd: 0,
      raw_status: 0,
    },
  };
}

function dryRunGrader(): GraderResult {
  return {
    coverage: 0,
    coverage_breakdown: {
      injection: false,
      tool_poisoning: false,
      memory_attacks: false,
      confused_deputy: false,
    },
    specificity_mean: 0,
    pai_specific: 0,
    total: 0,
    findings: [],
    raw_text: "[DRY-RUN] grader not invoked",
    meta: {
      wall_seconds: 0,
      input_tokens: 0,
      output_tokens: 0,
      thinking_tokens: 0,
      cost_estimate_usd: 0,
      raw_status: 0,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Output formatting
// ─────────────────────────────────────────────────────────────────────────────

function fmtScore(r: RunResult): string {
  return `${r.grader.total.toFixed(2)}/10`;
}

function summaryTable(results: RunResult[]): string {
  const lines: string[] = [];
  lines.push(
    "| slot | coverage | specificity | pai_specific | total | served_by | cost_usd | wall_s |",
  );
  lines.push(
    "|------|----------|-------------|--------------|-------|-----------|----------|--------|",
  );
  for (const r of results) {
    lines.push(
      `| ${r.slot} | ${r.grader.coverage}/4 | ${r.grader.specificity_mean.toFixed(2)} | ${r.grader.pai_specific}/3 | ${r.grader.total.toFixed(2)} | ${r.routing.served_by}${r.routing.served_by_fallback ? " (fallback)" : ""} | $${r.cost_total_usd.toFixed(3)} | ${r.wall_total_seconds.toFixed(1)} |`,
    );
  }
  return lines.join("\n");
}

function toCsv(results: RunResult[]): string {
  const header =
    "timestamp,slot,coverage,specificity_mean,pai_specific,total,served_by,served_by_fallback,stop_reason,stop_details_category,cost_usd,wall_s,notes";
  const rows = results.map((r) => {
    const notes = r.notes.join(" | ").replace(/[",\n]/g, " ");
    return [
      r.timestamp,
      r.slot,
      r.grader.coverage,
      r.grader.specificity_mean.toFixed(3),
      r.grader.pai_specific,
      r.grader.total.toFixed(3),
      r.routing.served_by,
      r.routing.served_by_fallback,
      r.routing.stop_reason ?? "",
      r.routing.stop_details_category ?? "",
      r.cost_total_usd.toFixed(4),
      r.wall_total_seconds.toFixed(1),
      `"${notes}"`,
    ].join(",");
  });
  return [header, ...rows].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

interface ParsedArgs {
  all: boolean;
  slot?: string;
  manifestPath?: string;
  dryRun: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { all: false, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") out.all = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "-h" || a === "--help") out.help = true;
    else if (a.startsWith("--slot=")) out.slot = a.slice(7);
    else if (a === "--slot") {
      const v = argv[i + 1];
      if (!v) throw new Error("--slot requires a value");
      out.slot = v;
      i++;
    } else if (a.startsWith("--manifest=")) out.manifestPath = a.slice(11);
    else if (a === "--manifest") {
      const v = argv[i + 1];
      if (!v) throw new Error("--manifest requires a value");
      out.manifestPath = v;
      i++;
    }
  }
  return out;
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Threat Model Bench — Project 1 head-to-head

Usage:
  bun threat_model_bench.ts --all                       # all three slots
  bun threat_model_bench.ts --slot <key>               # single slot
  bun threat_model_bench.ts --slot fable-5 --dry-run   # dry run (no API calls)
  bun threat_model_bench.ts --manifest <path>          # use a custom manifest

Slots: fable-5 | gpt-5.4 | haiku-4.5

Output:
  ./threat_model_bench_results/threat_model_bench_<ts>_<slot>.json (per run)
  ./threat_model_bench_results/threat_model_bench_<ts>.json        (combined)
  ./threat_model_bench_results/threat_model_bench_<ts>.csv         (table)

Env:
  OPENROUTER_API_KEY    required for gpt-5.4 slot (and Devstral fallback)
  (Anthropic key is fetched via \`passage show api/anthropic\`)
`);
    process.exit(0);
  }

  // Resolve slots
  let slotsToRun: string[];
  if (args.all) {
    slotsToRun = Object.keys(UNDER_TEST);
  } else if (args.slot) {
    if (!UNDER_TEST[args.slot]) {
      console.error(
        `Unknown slot: ${args.slot}. Available: ${Object.keys(UNDER_TEST).join(", ")}`,
      );
      process.exit(1);
    }
    slotsToRun = [args.slot];
  } else {
    console.error(
      "Must specify --all or --slot=<key>. Run with --help for usage.",
    );
    process.exit(1);
  }

  // Resolve manifest
  let manifestObj: unknown;
  if (args.manifestPath) {
    if (!existsSync(args.manifestPath)) {
      console.error(`Manifest not found: ${args.manifestPath}`);
      process.exit(1);
    }
    manifestObj = JSON.parse(readFileSync(args.manifestPath, "utf-8"));
  } else {
    manifestObj = EMBEDDED_MANIFEST;
  }
  const manifestJson = JSON.stringify(manifestObj, null, 2);

  // Resolve keys (skip on dry-run)
  let anthropicKey = "";
  let openrouterKey = process.env.OPENROUTER_API_KEY ?? "";
  let mistralKey = process.env.MISTRAL_API_KEY ?? "";
  let cohereKey = process.env.COHERE_API_KEY ?? "";
  const llamacppKey = ""; // unused; llama-server doesn't require a key
  if (!args.dryRun) {
    try {
      anthropicKey = await getAnthropicKey();
    } catch (e) {
      console.error(
        `Failed to fetch Anthropic key via \`passage show api/anthropic\`: ${(e as Error).message}\n` +
          `Either start passage / unlock the vault, or use --dry-run.`,
      );
      process.exit(1);
    }
    if (!openrouterKey) {
      console.warn(
        "OPENROUTER_API_KEY not set — OpenRouter slots will fail at the API call",
      );
    }
    // Mistral key: try env first, fall back to passage. Don't fatal — Mistral
    // slots may simply not be in slotsToRun.
    if (!mistralKey) {
      try {
        mistralKey = await getMistralKey();
      } catch (e) {
        console.warn(
          `MISTRAL_API_KEY unset and \`passage show api/mistral\` failed: ${(e as Error).message}\n` +
            `Mistral slots will fail at the API call.`,
        );
      }
    }
    // Cohere key: same fallback pattern as Mistral. Don't fatal — Cohere is
    // currently stubbed in callCohere() and will fail loud at the call site.
    if (!cohereKey) {
      try {
        cohereKey = await getCohereKey();
      } catch (e) {
        console.warn(
          `COHERE_API_KEY unset and \`passage show api/cohere\` failed: ${(e as Error).message}\n` +
            `Cohere slots (currently stubbed) will fail at the API call.`,
        );
      }
    }
  }

  // Output dir
  const resultsDir = join(import.meta.dir, "threat_model_bench_results");
  if (!existsSync(resultsDir)) mkdirSync(resultsDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  // Run
  const results: RunResult[] = [];
  for (const slotKey of slotsToRun) {
    console.log(`\n${"═".repeat(80)}`);
    console.log(`THREAT MODEL BENCH — ${UNDER_TEST[slotKey].label}  (${slotKey})`);
    console.log(`${"═".repeat(80)}`);
    if (args.dryRun) {
      console.log("  --dry-run: skipping API calls\n");
    }
    const r = await runOne({
      slotKey,
      manifestJson,
      anthropicKey,
      openrouterKey,
      mistralKey,
      cohereKey,
      llamacppKey,
      dryRun: args.dryRun,
    });
    results.push(r);
    const perRunPath = join(
      resultsDir,
      `threat_model_bench_${ts}_${r.slot}.json`,
    );
    writeFileSync(perRunPath, JSON.stringify(r, null, 2));
    console.log(`  -> ${perRunPath}`);
    if (!args.dryRun) {
      console.log(
        `     score: ${fmtScore(r)}  served_by: ${r.routing.served_by}${r.routing.served_by_fallback ? " (fallback!)" : ""}  $${r.cost_total_usd.toFixed(3)}  ${r.wall_total_seconds.toFixed(1)}s`,
      );
      for (const n of r.notes) console.log(`     note: ${n}`);
    }
  }

  // Combined JSON + CSV
  const combinedJson = join(
    resultsDir,
    `threat_model_bench_${ts}.json`,
  );
  const combinedCsv = join(
    resultsDir,
    `threat_model_bench_${ts}.csv`,
  );
  writeFileSync(combinedJson, JSON.stringify(results, null, 2));
  writeFileSync(combinedCsv, toCsv(results));

  console.log(`\n${"═".repeat(80)}`);
  console.log("SUMMARY");
  console.log("═".repeat(80));
  console.log(summaryTable(results));
  console.log(`\nCombined JSON: ${combinedJson}`);
  console.log(`Combined CSV:  ${combinedCsv}`);
}
