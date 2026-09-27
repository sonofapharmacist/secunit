#!/usr/bin/env bun
/**
 * OrWebResearch.ts — one web-grounded research call through OpenRouter's web plugin,
 * printing the answer plus the citation list (Inference.ts drops annotations).
 *
 * Backs GrokResearcher (default model x-ai/grok-4.7). Model-agnostic: any OR model works,
 * since the web plugin is OpenRouter's, not the vendor's.
 *
 * Usage:
 *   bun OrWebResearch.ts --prompt "question" [--model x-ai/grok-4.7] [--max-results 3] [--engine exa|native] [--json]
 *
 * Engine defaults to exa. With engine unset, xAI models use xAI's native search, which ignores
 * max_results and bills per source: 2026-09-26 measured $0.24 (83 sources) and $0.078 (19) per call,
 * against $0.014 (3) with exa. Pass --engine native only when breadth is worth ~6-17x the cost.
 * Exit: 0 answer with ≥1 citation · 3 answer but no citations · 2 error
 */

const argv = process.argv.slice(2);
const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

const prompt = flag("--prompt") ?? (await Bun.stdin.text());
const model = flag("--model") ?? "x-ai/grok-4.7";
const maxResults = Number(flag("--max-results") ?? 3);
const engine = flag("--engine") ?? "exa";
const key = process.env.OPENROUTER_API_KEY;

if (!prompt.trim()) { console.error("usage: OrWebResearch.ts --prompt '...' [--model m] [--max-results n] [--engine exa|native] [--json]"); process.exit(2); }
if (!key) { console.error("OPENROUTER_API_KEY not set"); process.exit(2); }
// NaN would serialize as null and silently drop the cap (DualCheck finding, 2026-09-26).
if (!Number.isInteger(maxResults) || maxResults < 1) { console.error(`--max-results must be a positive integer, got ${flag("--max-results")}`); process.exit(2); }
if (engine !== "exa" && engine !== "native") { console.error(`--engine must be exa or native, got ${engine}`); process.exit(2); }

interface Citation { url: string; title?: string }

try {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-Title": "PAI OrWebResearch" },
    body: JSON.stringify({
      model,
      max_tokens: 4000,
      plugins: [{ id: "web", engine, max_results: maxResults }],
      messages: [{ role: "user", content: `${prompt}\n\nCite a source URL for every finding.` }],
    }),
    signal: AbortSignal.timeout(240_000),
  });
  const body = await res.text();
  let j: any;
  try { j = JSON.parse(body); } catch { console.error(`non-JSON response (HTTP ${res.status}): ${body.slice(0, 200)}`); process.exit(2); }
  if (!res.ok || j.error) { console.error(`OpenRouter error (HTTP ${res.status}): ${j.error?.message ?? body.slice(0, 200)}`); process.exit(2); }

  const msg = j.choices?.[0]?.message ?? {};
  const text: string = typeof msg.content === "string" ? msg.content : "";
  const citations: Citation[] = (msg.annotations ?? [])
    .filter((a: any) => a.type === "url_citation" && a.url_citation?.url)
    .map((a: any) => ({ url: a.url_citation.url, title: a.url_citation.title }));
  const out = { model: j.model, provider: j.provider, text, citations, cost_usd: j.usage?.cost ?? null };

  if (argv.includes("--json")) console.log(JSON.stringify(out));
  else {
    console.log(`# ${out.model} via ${out.provider} (OpenRouter web) — ${citations.length} citations, $${out.cost_usd ?? "?"}\n\n${text}\n`);
    if (citations.length) console.log("## Citations\n" + citations.map((c, i) => `${i + 1}. ${c.title ? c.title + " — " : ""}${c.url}`).join("\n"));
  }
  process.exit(text ? (citations.length ? 0 : 3) : 2);
} catch (e) {
  console.error(`request failed: ${(e as Error).message}`);
  process.exit(2);
}
