#!/usr/bin/env bun
/**
 * SessionStart.hook.ts — P6: Log session baseline context costs
 *
 * PURPOSE:
 * Record fixed context costs at session startup:
 * - system_prompt_tokens: size of PAI_SYSTEM_PROMPT.md
 * - memory_baseline: size of @-imported files (PRINCIPAL_IDENTITY, PROJECTS, etc)
 * - skills_count: number of skills loaded
 *
 * TRIGGER: SessionStart
 *
 * OUTPUT:
 * - Appends to ~/.claude/PAI/MEMORY/OBSERVABILITY/context-sessions.jsonl
 * - Format: {timestamp, event: "session_start", system_prompt_tokens, memory_baseline, skills_count}
 *
 * DESIGN:
 * Compute token counts by reading actual files. System prompt tokens estimated
 * from PAI_SYSTEM_PROMPT.md file size. Memory tokens estimated from @-imported files.
 */

import { appendFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";

const HOME = process.env.HOME || process.env.USERPROFILE || "";
const PAI_DIR = process.env.PAI_DIR || join(HOME, ".claude", "PAI");
const PAI_CONFIG = join(PAI_DIR, "USER", "Config", "PAI_CONFIG.yaml");
const OBSERVABILITY_DIR = join(HOME, ".claude", "PAI", "MEMORY", "OBSERVABILITY");
const CONTEXT_LOG = join(OBSERVABILITY_DIR, "context-sessions.jsonl");
const SYSTEM_PROMPT = join(PAI_DIR, "PAI_SYSTEM_PROMPT.md");
const USER_DIR = join(PAI_DIR, "USER");
const SKILLS_DIR = join(HOME, ".claude", "skills");

// Rough token-to-character ratio: 1 token ≈ 4 characters
const CHARS_PER_TOKEN = 4;

function fileCharCount(path: string): number {
  try {
    if (!existsSync(path)) return 0;
    return readFileSync(path, "utf-8").length;
  } catch {
    return 0;
  }
}

function estimateTokens(charCount: number): number {
  return Math.ceil(charCount / CHARS_PER_TOKEN);
}

function countSkills(): number {
  try {
    if (!existsSync(SKILLS_DIR)) return 0;
    return readdirSync(SKILLS_DIR)
      .filter(f => !f.startsWith("."))
      .length;
  } catch {
    return 0;
  }
}

function computeSystemPromptTokens(): number {
  const chars = fileCharCount(SYSTEM_PROMPT);
  return estimateTokens(chars);
}

function computeMemoryBaselineTokens(): number {
  // @-imported files in CLAUDE.md:
  // - PRINCIPAL_IDENTITY.md
  // - DA_IDENTITY.md
  // - PROJECTS/PROJECTS.md
  // - TELOS/PRINCIPAL_TELOS.md
  // - DOCUMENTATION/ARCHITECTURE_SUMMARY.md

  const files = [
    join(USER_DIR, "PRINCIPAL_IDENTITY.md"),
    join(USER_DIR, "DA_IDENTITY.md"),
    join(USER_DIR, "PROJECTS", "PROJECTS.md"),
    join(USER_DIR, "TELOS", "PRINCIPAL_TELOS.md"),
    join(PAI_DIR, "DOCUMENTATION", "ARCHITECTURE_SUMMARY.md"),
  ];

  let totalChars = 0;
  for (const f of files) {
    totalChars += fileCharCount(f);
  }

  return estimateTokens(totalChars);
}

/**
 * Fire a fire-and-forget health ping to the local inference server so the
 * model is warm by the time the first prompt arrives. Reads base_url from
 * PAI_CONFIG.yaml via a simple regex — no YAML parser dependency needed.
 * Errors are silently swallowed; this is best-effort pre-warming only.
 */
function warmLocalInference(): void {
  try {
    if (!existsSync(PAI_CONFIG)) return;
    const cfg = readFileSync(PAI_CONFIG, "utf-8");
    const match = cfg.match(/base_url:\s*["']?([^\s"'\n]+)["']?/);
    if (!match) return;
    const baseUrl = match[1].trim();
    // Non-blocking: don't await, don't handle errors
    fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(20000) }).catch(() => {});
  } catch {
    // Silent — never block session start
  }
}

async function main() {
  try {
    let sessionId: string | null = null;
    try {
      const raw = await Bun.stdin.text();
      if (raw.trim()) {
        const input = JSON.parse(raw) as { session_id?: string };
        sessionId = input.session_id ?? null;
      }
    } catch {
      // continue without session_id
    }

    if (!existsSync(OBSERVABILITY_DIR)) {
      mkdirSync(OBSERVABILITY_DIR, { recursive: true });
    }

    const systemPromptTokens = computeSystemPromptTokens();
    const memoryBaselineTokens = computeMemoryBaselineTokens();
    const skillsCount = countSkills();

    // Estimated total baseline (system + memory + agents + skills)
    // Agents: ~2.7k (from recent /context run)
    const estimatedAgents = 2700;
    const estimatedSkills = skillsCount * 320; // ~320 tokens per skill description avg

    const totalEstimated = systemPromptTokens + memoryBaselineTokens + estimatedAgents + estimatedSkills;

    const event = {
      timestamp: new Date().toISOString(),
      session_id: sessionId,
      event: "session_start",
      system_prompt_tokens: systemPromptTokens,
      memory_baseline_tokens: memoryBaselineTokens,
      estimated_agents_tokens: estimatedAgents,
      skills_count: skillsCount,
      estimated_skills_tokens: estimatedSkills,
      total_estimated_baseline: totalEstimated,
      context_budget_pct: Math.round((totalEstimated / 200000) * 100),
    };

    appendFileSync(CONTEXT_LOG, JSON.stringify(event) + "\n");

    // Pre-warm local inference server so model is loaded before first prompt
    warmLocalInference();
  } catch (e) {
    // Silent fail — don't crash on observability error
    process.stderr.write(`[SessionStart.hook] Error logging baseline: ${e}\n`);
  }
}

main().catch(err => {
  process.stderr.write(`[SessionStart.hook] Uncaught error: ${err.message}\n`);
});
