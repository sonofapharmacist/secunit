#!/usr/bin/env bun
/**
 * CrossVendorAudit.ts — Cato's audit tool
 *
 * Bundles ISA + artifacts + tool-activity tail + Advisor verdict, pipes to
 * codex exec (GPT-5.5 read-only — gpt-5.4 was removed from the ChatGPT-account
 * model manifest at some point after 2026-06-17, confirmed absent via a live
 * `codex exec --model gpt-5.4` HTTP 400 on 2026-08-08; gpt-5.5 is the only
 * frontier slug currently served), parses JSON response, appends to
 * MEMORY/VERIFICATION/cato-findings.jsonl, emits parsed JSON to stdout.
 *
 * Usage:
 *   bun CrossVendorAudit.ts --slug <slug> --advisor-verdict "<text>"
 *
 * Algorithm v3.27 Rule 2a. E4/E5 VERIFY phase only.
 */

import { spawn } from "node:child_process";
import { readFile, writeFile, readdir, appendFile, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const HOME = homedir();
const PAI_DIR = join(HOME, ".claude", "PAI");
const WORK_DIR = join(PAI_DIR, "MEMORY", "WORK");
const FINDINGS_LOG = join(PAI_DIR, "MEMORY", "VERIFICATION", "cato-findings.jsonl");
const TOOL_ACTIVITY_LOG = join(PAI_DIR, "MEMORY", "OBSERVABILITY", "tool-activity.jsonl");
const CODEX_BIN = join(HOME, ".bun", "bin", "codex");

const BUNDLE_TOKEN_CAP = 80_000;
const CHARS_PER_TOKEN = 4; // rough estimate for bundle sizing
const BUNDLE_CHAR_CAP = BUNDLE_TOKEN_CAP * CHARS_PER_TOKEN;
const CODEX_TIMEOUT_MS = 120_000;
const TOOL_ACTIVITY_TAIL_LINES = 200;
const ARTIFACT_PER_FILE_CAP = 30_000 * CHARS_PER_TOKEN;

const AUDIT_PROMPT = `You are Cato, an independent cross-vendor auditor. The executor (Claude Sonnet) and reviewer (Claude Opus via the Advisor) have already signed off on this work. Your job is to find what THEY missed — specifically Anthropic-family blind spots they share (format conventions, API contract readings, RLHF preferences, constitutional biases).

Audit this ISA against its ISC criteria. For each criterion:
 1. Is there concrete evidence of completion in the artifacts?
 2. Is the evidence consistent with the stated claim?
 3. Are there failure modes the same-family reviewers would share that are present here?

Signal over noise. If the Advisor was right and there is nothing to flag, say so explicitly with "agrees_with_advisor": "yes" and "findings": []. Do not manufacture concerns. Your credibility depends on surfacing real Anthropic-family blind spots, not on inflating finding counts.

Output ONLY this JSON on one line, no markdown, no prose, no preamble. Set "model_used" to your own actual model identifier (whatever you would call yourself if asked directly) — do not copy the placeholder value below verbatim, it exists only to show the field's shape:

{"verdict":"pass|concerns|fail","criticality":"high|medium|low","findings":[{"severity":"critical|warning|info","isc_ref":"ISC-N or null","issue":"...","evidence":"..."}],"blind_spots_surfaced":["..."],"agrees_with_advisor":"yes|no|partial","model_used":"<your actual model name>","tokens_used":0}`;

interface Args {
  slug: string;
  advisorVerdict: string;
  fallbackModel: string;
  noFallback: boolean;
}

interface CatoResponse {
  verdict: "pass" | "concerns" | "fail" | "skipped" | "error";
  criticality?: "high" | "medium" | "low";
  findings?: Array<{ severity: string; isc_ref: string | null; issue: string; evidence: string }>;
  blind_spots_surfaced?: string[];
  agrees_with_advisor?: "yes" | "no" | "partial";
  model_used?: string;
  tokens_used?: number;
  cost_usd_est?: number;
  reason?: string;
  audit_path?: "codex" | "openrouter-fallback";
  openrouter_model_requested?: string;
  fallback_reason?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = { fallbackModel: "openai/gpt-5.4", noFallback: false };
  const seen = new Set<string>();
  const valueFor = (flag: string, index: number): [string, number] => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    return [value, index + 1];
  };
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--no-fallback") { if (seen.has(token)) throw new Error(`duplicate flag: ${token}`); seen.add(token); args.noFallback = true; continue; }
    const eq = token.indexOf("="), flag = eq === -1 ? token : token.slice(0, eq);
    if (seen.has(flag)) throw new Error(`duplicate flag: ${flag}`);
    seen.add(flag);
    let value: string;
    let next: number;
    if (eq !== -1) { value = token.slice(eq + 1); next = i; }
    else { [value, next] = valueFor(token, i); i = next; }
    switch (flag) {
      case "--slug": args.slug = value; break;
      case "--advisor-verdict": args.advisorVerdict = value; break;
      case "--fallback-model": args.fallbackModel = value; break;
      default: throw new Error(`unknown flag: ${token}`);
    }
  }
  if (!args.slug) throw new Error("--slug required");
  if (!args.advisorVerdict) args.advisorVerdict = "(not provided)";
  return args as Args;
}

async function readISA(slug: string): Promise<string> {
  // Read order: ISA.md (canonical, v4.1.0+) → PRD.md (legacy alias, retired at v4.2.0).
  const dir = join(WORK_DIR, slug);
  const isaPath = join(dir, "ISA.md");
  const legacyPath = join(dir, "PRD.md");
  const path = existsSync(isaPath) ? isaPath : existsSync(legacyPath) ? legacyPath : null;
  if (!path) throw new Error(`ISA not found in ${dir} (tried ISA.md and legacy PRD.md)`);
  return await readFile(path, "utf8");
}

async function readArtifacts(slug: string, isa: string): Promise<string> {
  // Extract file paths referenced in ISA ## Decisions section.
  const decisionsMatch = isa.match(/## Decisions\n([\s\S]*?)(?=\n## |\n---|\n*$)/);
  if (!decisionsMatch) return "(no ## Decisions section found)";

  const decisions = decisionsMatch[1];
  const pathPattern = /`([~/][^\s`]+\.(?:ts|md|json|yaml|yml|tsx|jsx|js|txt))`/g;
  const paths = new Set<string>();
  let match;
  while ((match = pathPattern.exec(decisions))) {
    let p = match[1];
    if (p.startsWith("~/")) p = join(HOME, p.slice(2));
    paths.add(resolve(p));
  }

  if (paths.size === 0) return "(no file references found in ## Decisions)";

  const chunks: string[] = [];
  let totalChars = 0;
  for (const p of paths) {
    if (!existsSync(p)) continue;
    const stats = await stat(p);
    if (!stats.isFile()) continue;
    let content = await readFile(p, "utf8");
    if (content.length > ARTIFACT_PER_FILE_CAP) {
      content = content.slice(0, ARTIFACT_PER_FILE_CAP) + "\n[TRUNCATED]";
    }
    const block = `--- FILE: ${p} ---\n${content}\n`;
    if (totalChars + block.length > BUNDLE_CHAR_CAP / 2) break; // reserve half for other sections
    chunks.push(block);
    totalChars += block.length;
  }
  return chunks.length > 0 ? chunks.join("\n") : "(no readable artifacts found)";
}

async function readToolActivityTail(slug: string): Promise<string> {
  if (!existsSync(TOOL_ACTIVITY_LOG)) return "(tool-activity.jsonl not found)";
  const content = await readFile(TOOL_ACTIVITY_LOG, "utf8");
  const lines = content.trim().split("\n");
  const recent = lines.slice(-500); // look at last 500 lines total
  const filtered = recent.filter((l) => l.includes(slug)).slice(-TOOL_ACTIVITY_TAIL_LINES);
  return filtered.length > 0 ? filtered.join("\n") : "(no tool-activity lines for this slug)";
}

function assembleBundle(isa: string, artifacts: string, toolTail: string, advisorVerdict: string): string {
  let bundle = [
    "===== ISA =====",
    isa,
    "",
    "===== OUTPUT ARTIFACTS =====",
    artifacts,
    "",
    "===== TOOL ACTIVITY TAIL =====",
    toolTail,
    "",
    "===== ADVISOR VERDICT =====",
    advisorVerdict,
    "",
    "===== AUDIT INSTRUCTIONS =====",
    AUDIT_PROMPT,
  ].join("\n");

  // If over cap, drop tool-tail first, then trim artifacts.
  if (bundle.length > BUNDLE_CHAR_CAP) {
    bundle = [
      "===== ISA =====",
      isa,
      "",
      "===== OUTPUT ARTIFACTS =====",
      artifacts,
      "",
      "===== TOOL ACTIVITY TAIL =====",
      "(dropped — bundle size cap)",
      "",
      "===== ADVISOR VERDICT =====",
      advisorVerdict,
      "",
      "===== AUDIT INSTRUCTIONS =====",
      AUDIT_PROMPT,
    ].join("\n");
  }
  if (bundle.length > BUNDLE_CHAR_CAP) {
    const overshoot = bundle.length - BUNDLE_CHAR_CAP;
    const trimmed = artifacts.slice(0, Math.max(0, artifacts.length - overshoot - 100));
    bundle = [
      "===== ISA =====",
      isa,
      "",
      "===== OUTPUT ARTIFACTS (trimmed) =====",
      trimmed + "\n[TRUNCATED - bundle size cap]",
      "",
      "===== TOOL ACTIVITY TAIL =====",
      "(dropped — bundle size cap)",
      "",
      "===== ADVISOR VERDICT =====",
      advisorVerdict,
      "",
      "===== AUDIT INSTRUCTIONS =====",
      AUDIT_PROMPT,
    ].join("\n");
  }
  return bundle;
}

function invokeCodex(bundle: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolvePromise) => {
    const proc = spawn(
      CODEX_BIN,
      ["exec", "--sandbox", "read-only", "--model", "gpt-5.5", "-"],
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      resolvePromise({ stdout, stderr: stderr + "\n[TIMEOUT after 120s]", code: 124 });
    }, CODEX_TIMEOUT_MS);

    proc.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    proc.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, code });
    });
    proc.stdin.write(bundle);
    proc.stdin.end();
  });
}

function invokeOpenRouterFallback(bundle: string, args: Args): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolvePromise) => {
    const orHelper = join(PAI_DIR, "TOOLS", "ForgeOpenRouter.ts");
    const proc = spawn(
      "bun",
      [orHelper,
        "--slug", args.slug,
        "--model", args.fallbackModel,
        "--timeout-ms", String(CODEX_TIMEOUT_MS),
        "--max-tokens", "4000",
        "--temperature", "0",
      ],
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      resolvePromise({ stdout, stderr: stderr + "\n[TIMEOUT after 120s]", code: 124 });
    }, CODEX_TIMEOUT_MS);

    proc.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    proc.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, code });
    });
    proc.stdin.on("error", (_err: unknown) => { /* EPIPE if helper exited before we wrote; harmless — final line still parses */ });
    proc.stdin.write(bundle);
    proc.stdin.end();
  });
}

function parseOpenRouterStdout(stdout: string, args: Args): CatoResponse {
  // ForgeOpenRouter.ts emits a wrapper JSON; the actual Cato response lives in wrapper.final_message.
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return { verdict: "skipped", reason: "openrouter fallback: empty stdout", audit_path: "openrouter-fallback", openrouter_model_requested: args.fallbackModel, fallback_reason: "no_output" };
  }
  let wrapper: { verdict?: string; final_message?: string; reason?: string } | null = null;
  try { wrapper = JSON.parse(trimmed); } catch (_err: unknown) {
    return { verdict: "skipped", reason: `openrouter fallback: unparseable wrapper (${trimmed.slice(0, 120)})`, audit_path: "openrouter-fallback", openrouter_model_requested: args.fallbackModel, fallback_reason: "parse_error" };
  }
  if (typeof wrapper?.final_message !== "string") {
    return { verdict: "skipped", reason: `openrouter fallback: wrapper missing final_message (verdict=${wrapper?.verdict ?? "?"})`, audit_path: "openrouter-fallback", openrouter_model_requested: args.fallbackModel, fallback_reason: "missing_final_message" };
  }
  const inner = extractJSON(wrapper.final_message);
  inner.audit_path = "openrouter-fallback";
  inner.openrouter_model_requested = args.fallbackModel;
  if (inner.verdict === "skipped" && inner.reason === "no JSON in codex output") {
    // The model didn't return a parseable Cato response — record but keep audit_path so downstream knows.
    inner.fallback_reason = inner.fallback_reason ?? "model_returned_unstructured";
  }
  return inner;
}

function extractJSON(rawStdout: string): CatoResponse {
  // Codex CLI wraps output with session metadata. Find the JSON object.
  const jsonMatch = rawStdout.match(/\{[\s\S]*"verdict"[\s\S]*\}/);
  if (!jsonMatch) {
    return { verdict: "skipped", reason: "no JSON in codex output" };
  }
  try {
    return JSON.parse(jsonMatch[0]) as CatoResponse;
  } catch (err) {
    return { verdict: "skipped", reason: `parse error: ${(err as Error).message}` };
  }
}

function estimateCost(tokens: number): number {
  // GPT-5 class rough: $0.015/1K combined. Conservative.
  return +(tokens * 0.000015).toFixed(4);
}

async function appendFinding(slug: string, advisorVerdict: string, response: CatoResponse, tier: string): Promise<void> {
  await mkdir(join(PAI_DIR, "MEMORY", "VERIFICATION"), { recursive: true });
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    slug,
    tier,
    advisor_verdict: advisorVerdict.slice(0, 200),
    cato_verdict: response.verdict,
    criticality: response.criticality ?? null,
    unique_findings_count: response.findings?.length ?? 0,
    agrees_with_advisor: response.agrees_with_advisor ?? null,
    tokens: response.tokens_used ?? 0,
    cost_usd: response.cost_usd_est ?? estimateCost(response.tokens_used ?? 0),
    skipped: response.verdict === "skipped",
    reason: response.reason ?? null,
    audit_path: response.audit_path ?? "codex",
    openrouter_model_requested: response.openrouter_model_requested ?? null,
    fallback_reason: response.fallback_reason ?? null,
  });
  await appendFile(FINDINGS_LOG, line + "\n", "utf8");
}

function extractTier(isa: string): string {
  const m = isa.match(/^effort:\s*(\w+)/m);
  return m ? m[1] : "unknown";
}

async function main() {
  let args: Args;
  try {
    args = parseArgs(process.argv);
  } catch (err) {
    console.error(JSON.stringify({ verdict: "error", reason: (err as Error).message, audit_path: "codex" }));
    process.exit(2);
  }

  if (!existsSync(CODEX_BIN)) {
    const resp = { verdict: "skipped" as const, reason: "codex CLI not installed", audit_path: "codex" as const };
    await appendFinding(args.slug, args.advisorVerdict, resp, "unknown");
    console.log(JSON.stringify(resp));
    process.exit(0);
  }

  let isa: string;
  try {
    isa = await readISA(args.slug);
  } catch (err) {
    const resp = { verdict: "error" as const, reason: (err as Error).message, audit_path: "codex" as const };
    console.log(JSON.stringify(resp));
    process.exit(1);
  }

  const tier = extractTier(isa);
  const [artifacts, toolTail] = await Promise.all([
    readArtifacts(args.slug, isa),
    readToolActivityTail(args.slug),
  ]);
  const bundle = assembleBundle(isa, artifacts, toolTail, args.advisorVerdict);

  const { stdout, stderr, code } = await invokeCodex(bundle);
  if (code === 124 || code !== 0) {
    if (args.noFallback) {
      const reason = code === 124
        ? "codex timeout at 120s"
        : `codex exit ${code}: ${stderr.slice(0, 200)}`;
      const resp = { verdict: "skipped" as const, reason, audit_path: "codex" as const };
      await appendFinding(args.slug, args.advisorVerdict, resp, tier);
      console.log(JSON.stringify(resp));
      return;
    }
    // Cascade to OpenRouter. Same bundle, same prompt path. Stamps audit_path automatically.
    const orResult = await invokeOpenRouterFallback(bundle, args);
    if (orResult.code === 124 || orResult.code !== 0) {
      const reason = orResult.code === 124
        ? "openrouter fallback: timeout at 120s"
        : `openrouter fallback: exit ${orResult.code}: ${orResult.stderr.slice(0, 200)}`;
      const resp = { verdict: "skipped" as const, reason, audit_path: "openrouter-fallback" as const, openrouter_model_requested: args.fallbackModel, fallback_reason: orResult.code === 124 ? "timeout_120s" : `exit_${orResult.code ?? "null"}` };
      await appendFinding(args.slug, args.advisorVerdict, resp, tier);
      console.log(JSON.stringify(resp));
      return;
    }
    const orResp = parseOpenRouterStdout(orResult.stdout, args);
    await appendFinding(args.slug, args.advisorVerdict, orResp, tier);
    console.log(JSON.stringify(orResp));
    return;
  }

  const parsed = extractJSON(stdout);
  if (parsed.tokens_used && !parsed.cost_usd_est) {
    parsed.cost_usd_est = estimateCost(parsed.tokens_used);
  }
  parsed.audit_path = "codex";
  await appendFinding(args.slug, args.advisorVerdict, parsed, tier);
  console.log(JSON.stringify(parsed));
}

main().catch(async (err) => {
  console.error(JSON.stringify({ verdict: "error", reason: err.message }));
  process.exit(1);
});
