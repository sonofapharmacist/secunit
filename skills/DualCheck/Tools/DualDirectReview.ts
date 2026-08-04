#!/usr/bin/env bun
/**
 * DualDirectReview.ts — Two independent adversarial code reviewers, run in
 * parallel, called directly (not through an aggregator/gateway API):
 *   - Devstral Medium via Mistral's own direct API
 *   - MiniMax M3 via OpenRouter's direct API
 * Both keys resolve via `passage` (env var first, then `passage show <name>`
 * via Bun.spawn with piped stdout — never shell command-substitution, which
 * can briefly expose a key in /proc or `ps aux` during substitution).
 *
 * This is deliberately NOT a Forge/Anvil-style single-model fallback chain —
 * both models run on the same evidence at the same time, and both verdicts
 * are reported side by side. Two independent models agreeing "no findings"
 * is stronger evidence than either one alone; a split verdict is itself a
 * signal worth surfacing, not something to silently resolve.
 *
 * Invocation: cat prompt.txt | bun DualDirectReview.ts
 *   [--mistral-model devstral-medium-latest] [--m3-model minimax/minimax-m3]
 *   [--timeout-ms 120000]
 *
 * Prints a single JSON object to stdout: { mistral: {...}, m3: {...} }
 * Exit code 0 if both calls completed (regardless of verdict content),
 * 1 if either call failed to complete (key missing, HTTP error, timeout).
 */

type Args = { mistralModel: string; m3Model: string; timeoutMs: number };
type CallResult =
  | { ok: true; model: string; content: string }
  | { ok: false; model: string; reason: string };

function parseArgs(argv: string[]): Args {
  const args: Args = { mistralModel: "devstral-medium-latest", m3Model: "minimax/minimax-m3", timeoutMs: 120000 };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const eq = token.indexOf("=");
    const flag = eq === -1 ? token : token.slice(0, eq);
    const inline = eq === -1 ? undefined : token.slice(eq + 1);
    const next = (): string => {
      if (inline !== undefined) return inline;
      const value = argv[++i];
      if (value === undefined) throw new Error(`${flag} requires a value`);
      return value;
    };
    switch (flag) {
      case "--mistral-model": args.mistralModel = next(); break;
      case "--m3-model": args.m3Model = next(); break;
      case "--timeout-ms": {
        const value = Number(next());
        if (!Number.isFinite(value) || value <= 0) throw new Error("--timeout-ms must be a positive number");
        args.timeoutMs = value;
        break;
      }
      default: throw new Error(`unknown flag: ${flag}`);
    }
  }
  return args;
}

async function readPrompt(): Promise<string> {
  const stdin = process.stdin as typeof process.stdin & { isTTY?: boolean };
  if (stdin.isTTY) throw new Error("no prompt provided — pipe prompt text via stdin");
  let text = "";
  for await (const chunk of stdin) text += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
  if (text.trim().length === 0) throw new Error("stdin was empty — no prompt to review");
  return text;
}

/**
 * Resolves a secret via `passage`: env var first, then `passage show <name>`.
 * Uses Bun.spawn with piped stdout, never `$(passage show ...)` shell
 * substitution — a prior audit flagged command-substitution as briefly
 * exposing the resolved value in /proc and `ps aux` process listings.
 */
async function readSecret(envVar: string, passageName: string): Promise<string | null> {
  const envValue = process.env[envVar];
  if (envValue && envValue.trim()) return envValue.trim();
  try {
    const proc = Bun.spawn(["passage", "show", passageName], { stdout: "pipe", stderr: "pipe" });
    const value = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    return value || null;
  } catch {
    return null;
  }
}

async function callWithTimeout(model: string, run: () => Promise<Response>, timeoutMs: number): Promise<CallResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await run();
    if (!res.ok) return { ok: false, model, reason: `HTTP ${res.status}: ${(await res.text()).slice(0, 500)}` };
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return { ok: false, model, reason: "response had no message content" };
    return { ok: true, model, content };
  } catch (error: unknown) {
    const isAbort = error instanceof Error && error.name === "AbortError";
    return { ok: false, model, reason: isAbort ? `timed out after ${timeoutMs}ms` : error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function callMistralDirect(apiKey: string, model: string, prompt: string, timeoutMs: number): Promise<CallResult> {
  return callWithTimeout(model, () => {
    const controller = new AbortController();
    return fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0.2 }),
      signal: controller.signal,
    });
  }, timeoutMs);
}

async function callOpenRouterDirect(apiKey: string, model: string, prompt: string, timeoutMs: number): Promise<CallResult> {
  return callWithTimeout(model, () => {
    const controller = new AbortController();
    return fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0.2 }),
      signal: controller.signal,
    });
  }, timeoutMs);
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const prompt = await readPrompt();

  const [mistralKey, openrouterKey] = await Promise.all([
    readSecret("MISTRAL_API_KEY", "api/mistral"),
    readSecret("OPENROUTER_API_KEY", "api/openrouter"),
  ]);

  const [mistralResult, m3Result]: [CallResult, CallResult] = await Promise.all([
    mistralKey
      ? callMistralDirect(mistralKey, args.mistralModel, prompt, args.timeoutMs)
      : Promise.resolve<CallResult>({ ok: false, model: args.mistralModel, reason: "no Mistral API key (env MISTRAL_API_KEY or passage api/mistral)" }),
    openrouterKey
      ? callOpenRouterDirect(openrouterKey, args.m3Model, prompt, args.timeoutMs)
      : Promise.resolve<CallResult>({ ok: false, model: args.m3Model, reason: "no OpenRouter API key (env OPENROUTER_API_KEY or passage api/openrouter)" }),
  ]);

  process.stdout.write(`${JSON.stringify({ mistral: mistralResult, m3: m3Result }, null, 2)}\n`);
  return mistralResult.ok && m3Result.ok ? 0 : 1;
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2));
  process.exit(code);
}

export default main;
