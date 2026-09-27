#!/usr/bin/env bun
/**
 * ScaffoldSkillInference — writes a minimal @anthropic-ai/sdk inference shim
 * into a standalone skill's generators/lib/ directory.
 *
 * Usage:
 *   bun PAI/TOOLS/ScaffoldSkillInference.ts <skill-dir>           # write shim (errors if exists)
 *   bun PAI/TOOLS/ScaffoldSkillInference.ts <skill-dir> --patch   # update default model only
 *
 * What it writes:
 *   <skill-dir>/generators/lib/inference.ts  — standalone shim, no PAI deps
 *
 * What it patches:
 *   <skill-dir>/generators/package.json      — adds @anthropic-ai/sdk if absent
 */

import { existsSync, mkdirSync } from "fs";
import { join, resolve } from "path";

const CANONICAL_MODEL = "claude-sonnet-4-6";
const MODEL_LINE_RE = /model = "claude-[^"]+"/;

const args = Bun.argv.slice(2);
const patch = args.includes("--patch");
const skillDir = resolve(args.find((a) => !a.startsWith("--")) ?? ".");

if (!existsSync(skillDir)) {
  console.error(`Error: directory not found: ${skillDir}`);
  process.exit(1);
}

const generatorsDir = join(skillDir, "generators");
const libDir = join(generatorsDir, "lib");
const shimPath = join(libDir, "inference.ts");
const pkgPath = join(generatorsDir, "package.json");

if (existsSync(shimPath) && !patch) {
  console.error(`Already exists: ${shimPath}`);
  console.error("Use --patch to update the default model without overwriting customizations.");
  process.exit(1);
}

// --patch: update default model string only, preserve everything else
if (patch && existsSync(shimPath)) {
  const existing = await Bun.file(shimPath).text();
  const match = existing.match(MODEL_LINE_RE);
  if (!match) {
    console.error("Could not locate model default in existing shim. Manual update required.");
    process.exit(1);
  }
  const current = match[0].replace('model = "', "").replace('"', "");
  if (current === CANONICAL_MODEL) {
    console.log(`✅ Already at canonical model (${CANONICAL_MODEL}) — nothing to do.`);
    process.exit(0);
  }
  const patched = existing.replace(MODEL_LINE_RE, `model = "${CANONICAL_MODEL}"`);
  await Bun.write(shimPath, patched);
  console.log(`✅ Patched: model default ${current} → ${CANONICAL_MODEL}`);
  process.exit(0);
}

mkdirSync(libDir, { recursive: true });

// New shim path — intentionally minimal, no PAI coupling, works for any consumer
// of this skill who sets ANTHROPIC_API_KEY.
const SHIM = `import Anthropic from "@anthropic-ai/sdk";

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) throw new Error("ANTHROPIC_API_KEY environment variable is required");

const client = new Anthropic({ apiKey });

export interface GenerateOptions {
  model?: string;
  maxTokens?: number;
  jsonMode?: boolean;
}

export async function generate(
  system: string,
  user: string,
  opts: GenerateOptions = {}
): Promise<string> {
  const { model = "claude-sonnet-4-6", maxTokens = 8192, jsonMode = false } = opts;

  const systemPrompt = jsonMode
    ? \`\${system}\\n\\nRespond with valid JSON only. No markdown fences, no explanation.\`
    : system;

  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: "user", content: user }],
  });

  const block = response.content[0];
  if (block.type !== "text") throw new Error(\`Unexpected content type: \${block.type}\`);
  return block.text;
}
`;

await Bun.write(shimPath, SHIM);
console.log(`✅ Wrote: ${shimPath}`);

// Patch package.json if it exists and is missing the SDK dep
if (existsSync(pkgPath)) {
  const pkg = JSON.parse(await Bun.file(pkgPath).text());
  if (!pkg.dependencies?.["@anthropic-ai/sdk"]) {
    pkg.dependencies = { ...(pkg.dependencies ?? {}), "@anthropic-ai/sdk": "^0.95.0" };
    await Bun.write(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    console.log("✅ Patched: package.json (added @anthropic-ai/sdk ^0.95.0)");
    console.log("   Run: cd generators && bun install");
  } else {
    console.log("   package.json already has @anthropic-ai/sdk — skipped");
  }
} else {
  console.log(`   No package.json at ${pkgPath}`);
  console.log("   Run: cd generators && bun add @anthropic-ai/sdk");
}

console.log("\nImport in your generator:");
console.log('  import { generate } from "./lib/inference.ts";');
