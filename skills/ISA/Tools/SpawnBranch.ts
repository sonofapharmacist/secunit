#!/usr/bin/env bun
/**
 * SpawnBranch.ts — turn one `## Branches` entry of a parent ISA into its own ISA.
 *
 * Seeds the new ISA from the entry's four scope answers, sets `parent:`, then marks the parent
 * entry `spawned: <slug>` and appends the slug to the parent's `branches:` frontmatter. This is
 * the bookkeeping that drifts when done by hand, so it's code (IsaFormat.md §Branches, v2.8).
 *
 * Usage:
 *   bun SpawnBranch.ts --parent <path/to/ISA.md> --branch B2 [--desc kebab-slug-part] [--dry-run]
 *
 * Exit: 0 spawned (or dry-run printed) · 1 usage/branch error · 2 I/O error
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";
import { branchEntries } from "../../../hooks/lib/algorithm-v8";

const argv = process.argv.slice(2);
const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const die = (msg: string, code = 1): never => { console.error(msg); process.exit(code); };

if (argv.includes("--help") || argv.includes("-h")) {
  console.log(readFileSync(join(import.meta.dir, "SpawnBranch.help.md"), "utf8"));
  process.exit(0);
}

const parentPath = flag("--parent");
const branchId = flag("--branch")?.toUpperCase();
if (!parentPath || !branchId) die("usage: SpawnBranch.ts --parent <ISA.md> --branch B<n> [--desc kebab] [--dry-run]");
if (!existsSync(parentPath!)) die(`parent ISA not found: ${parentPath}`);

const parent = readFileSync(parentPath!, "utf8");
const entry = branchEntries(parent).find((b) => b.id === branchId);
if (!entry) die(`${branchId} not found under ## Branches in ${parentPath}`);
if (entry!.resolved) die(`${branchId} is already resolved (spawned/filed/dropped): nothing to spawn`);

/** Scope answer n from "(1) Change: ... (2) Wrong if: ..." prose; null when absent. */
function answer(text: string, n: number): string | null {
  const m = text.replace(/\n\s*/g, " ").match(new RegExp(String.raw`\(${n}\)\s*(.*?)(?=\s*\(${n + 1}\)|\*\*spawned|$)`));
  // Drop the answer's own label ("Change:", "Excluded:", "Wrong if ..."), keeping the substance.
  return m ? m[1].replace(/\*\*/g, "").trim().replace(/^[A-Za-z ]+:\s*/, "").replace(/^wrong (?:to build )?if\s+/i, "") : null;
}
const [change, wrong, excluded, evidence] = [1, 2, 3, 4].map((n) => answer(entry!.text, n));
const missing = ["(1) change", "(2) how it could be wrong", "(3) excluded", "(4) evidence"].filter((_, i) => ![change, wrong, excluded, evidence][i]);
if (missing.length) die(`${branchId} lacks scope answers: ${missing.join(", ")}. Write them into the parent entry first.`);

const parentSlug = parent.match(/^slug:\s*(\S+)/m)?.[1] ?? basename(dirname(parentPath!));
const now = new Date();
const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
const desc = (flag("--desc") ?? entry!.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
const slug = `${stamp}_${desc}`;
const workDir = dirname(dirname(parentPath!));
const childPath = join(workDir, slug, "ISA.md");
const iso = now.toISOString().replace(/\.\d{3}Z$/, "Z");

const child = `---
task: "${entry!.name.replace(/"/g, "'").slice(0, 60)}"
slug: ${slug}
effort: E2
effort_source: auto
phase: observe
progress: 0/2
mode: interactive
started: ${iso}
updated: ${iso}
parent: ${parentSlug}
---

## Problem

${change}

Spawned from branch ${branchId} of \`${parentSlug}\`.

## Out of Scope

- ${excluded}

## Goal

${change}

## Criteria

- [ ] ISC-1: ${evidence}
- [ ] ISC-2: Anti: ${wrong}

## Test Strategy

| isc | type | check | threshold | tool |
|---|---|---|---|---|
| 1 | seed | refine into atomic probes at OBSERVE | — | — |

## Decisions

- ${iso.slice(0, 10)} Seeded from \`${parentSlug}\` ${branchId} by SpawnBranch.ts. The four scope answers were copied verbatim; split ISC-1 and ISC-2 into atomic probes before building. Original entry:

${entry!.text.split("\n").map((l) => `  > ${l}`).join("\n")}
`;

// Parent: mark the entry, then add the slug to `branches:` (create the field after `updated:` if absent).
const firstLine = entry!.text.split("\n")[0];
let updated = parent.replace(firstLine, `${firstLine} **spawned: \`${slug}\`**`);
const fm = updated.match(/^---\n[\s\S]*?\n---/)![0];
const withBranches = /^branches:\s*\[(.*)\]\s*$/m.test(fm)
  ? fm.replace(/^branches:\s*\[(.*)\]\s*$/m, (_, list: string) => `branches: [${[...list.split(",").map((s) => s.trim()).filter(Boolean), slug].join(", ")}]`)
  : fm.replace(/^(updated:.*)$/m, `$1\nbranches: [${slug}]`);
updated = updated.replace(fm, withBranches);

if (argv.includes("--dry-run")) {
  console.log(`# would create ${childPath}\n\n${child}\n# parent ${branchId} line would become:\n${firstLine} **spawned: \`${slug}\`**\n# parent frontmatter:\n${withBranches}`);
  process.exit(0);
}
try {
  mkdirSync(dirname(childPath), { recursive: true });
  writeFileSync(childPath, child);
  writeFileSync(parentPath!, updated);
} catch (e) { die(`write failed: ${(e as Error).message}`, 2); }
console.log(`spawned ${branchId} → ${childPath}\nparent marked: spawned: ${slug}`);
