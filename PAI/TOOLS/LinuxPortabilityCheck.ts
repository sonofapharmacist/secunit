#!/usr/bin/env bun
/**
 * LinuxPortabilityCheck.ts
 *
 * Run after `git pull upstream` to catch Linux portability regressions before
 * they bite silently. macOS hides case-sensitivity and platform-API bugs; Linux
 * surfaces them as silent fallbacks, log noise, or broken features.
 *
 * Usage:
 *   bun PAI/TOOLS/LinuxPortabilityCheck.ts
 *   bun PAI/TOOLS/LinuxPortabilityCheck.ts --json    (machine-readable)
 *
 * Exit codes: 0 = clean, 1 = issues found
 */

import { execSync } from "child_process";
import { join } from "path";
import { readFileSync, existsSync } from "fs";

const TOOLS_DIR = import.meta.dir;
const PAI_DIR = join(TOOLS_DIR, "..");
const CLAUDE_DIR = join(PAI_DIR, "..");

const JSON_MODE = process.argv.includes("--json");

// ── Known PAI top-level dirs (all-caps) that upstream often writes with mixed case ──
const PAI_DIRS: Array<{ wrong: string; correct: string }> = [
  { wrong: "Tools",         correct: "TOOLS" },
  { wrong: "Algorithm",     correct: "ALGORITHM" },
  { wrong: "Documentation", correct: "DOCUMENTATION" },
  { wrong: "Memory",        correct: "MEMORY" },
  { wrong: "Pulse",         correct: "PULSE" },
  { wrong: "User",          correct: "USER" },
];

// ── macOS-only CLI tools that should never appear outside a darwin platform guard ──
const MACOS_TOOLS = ["osascript", "say", "pbcopy", "pbpaste", "launchctl"];

// ── Files/dirs that are intentionally macOS-only — skip them ──
const SKIP_LIST = [
  "PAI/PULSE/modules/imessage.ts",
  "PAI/PULSE/lib/messages-db.ts",
  "PAI/PULSE/manage.sh",
  "PAI/PULSE/start-pulse.sh",
  "PAI/PAI-Install/engine/detect.ts",  // correctly platform-gated
  "PAI/PAI-Install/engine/actions.ts", // correctly platform-gated
  "PAI/PULSE/setup.ts",                // orphaned macOS-only setup script
  "skills/Fabric/",
  "node_modules/",
  ".git/",
];

// ── Known-acceptable macOS patterns (guarded at runtime, not a real bug) ──
// These match the check patterns but are protected by other guards:
//   tab-setter: guarded by !isKitty early return; /Applications path never reached on Linux
//   lib.ts gws: guarded by Bun.which("gws") — fallback only if gws not on PATH anywhere
//   pai.ts osascript: has try/catch + non-critical (wallpaper setter)
const KNOWN_ACCEPTABLE = [
  "hooks/lib/tab-setter.ts",
  "PAI/PULSE/lib.ts",
  "PAI/TOOLS/pai.ts",
];

// ── Scan targets ──
const SCAN_PATHS = ["hooks/", "PAI/TOOLS/", "PAI/PULSE/"];

interface Issue {
  type: "case-mismatch" | "unguarded-macos-cli" | "hardcoded-macos-path";
  file: string;
  lineNo: string;
  snippet: string;
  detail: string;
}

function rg(pattern: string, paths: string[]): string[] {
  try {
    // Use grep -r with extended regex — grep is always available as a real binary.
    // rg is a Claude Code shell-function wrapper and not accessible from subprocesses.
    const includes = ["--include=*.ts", "--include=*.tsx", "--include=*.sh"].join(" ");
    const quotedPaths = paths.join(" ");
    const quotedPattern = pattern.replace(/'/g, "'\\''");
    const cmd = `grep -rn -E ${includes} '${quotedPattern}' ${quotedPaths} 2>/dev/null`;
    return execSync(cmd, { encoding: "utf-8", cwd: CLAUDE_DIR })
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

function isSkipped(line: string): boolean {
  return SKIP_LIST.some(s => line.includes(s)) || KNOWN_ACCEPTABLE.some(s => line.includes(s));
}

function parseMatch(line: string): { file: string; lineNo: string; snippet: string } | null {
  const idx = line.indexOf(":");
  if (idx === -1) return null;
  const rest = line.slice(idx + 1);
  const idx2 = rest.indexOf(":");
  if (idx2 === -1) return null;
  return {
    file: line.slice(0, idx),
    lineNo: rest.slice(0, idx2),
    snippet: rest.slice(idx2 + 1).trim(),
  };
}

function fileHasDarwinGuard(relPath: string): boolean {
  const abs = join(CLAUDE_DIR, relPath);
  if (!existsSync(abs)) return false;
  try {
    return readFileSync(abs, "utf-8").includes("darwin");
  } catch {
    return false;
  }
}

const issues: Issue[] = [];

// ── Check 1: Case-sensitive PAI directory names ──────────────────────────────
// Only flag lines in path-construction context: join(), path.join(), string + '/',
// or a string starting with a slash. Avoids false-positives from UI labels and
// role names that use these words but aren't filesystem paths.
for (const { wrong, correct } of PAI_DIRS) {
  // Match: join(..., "Tools", ...) or paiDir + '/Tools' or join(x, "Tools/")
  const pattern = `(join\\(|path\\.join\\(|\\+ ?"/?)[^"']*"${wrong}(/[^"']*)?"`;
  const matches = rg(pattern, SCAN_PATHS).filter(l => !isSkipped(l));

  for (const line of matches) {
    const parsed = parseMatch(line);
    if (!parsed) continue;
    if (parsed.snippet.startsWith("//") || parsed.snippet.startsWith("*")) continue;
    // Skip the check tool itself (it has the mapping table)
    if (parsed.file.includes("LinuxPortabilityCheck")) continue;
    issues.push({
      type: "case-mismatch",
      file: parsed.file,
      lineNo: parsed.lineNo,
      snippet: parsed.snippet.slice(0, 100),
      detail: `"${wrong}" → "${correct}" (Linux is case-sensitive; macOS silently accepts both)`,
    });
  }
}

// ── Check 2: Unguarded macOS-only CLI tool calls ─────────────────────────────
for (const tool of MACOS_TOOLS) {
  // Match spawn/exec patterns calling the tool (with or without full path)
  const pattern = `(spawn|exec|spawnSync|Bun\\.spawn).*${tool}`;
  const matches = rg(pattern, SCAN_PATHS).filter(l => !isSkipped(l));

  for (const line of matches) {
    const parsed = parseMatch(line);
    if (!parsed) continue;
    if (parsed.snippet.startsWith("//") || parsed.snippet.startsWith("*")) continue;
    if (!fileHasDarwinGuard(parsed.file)) {
      issues.push({
        type: "unguarded-macos-cli",
        file: parsed.file,
        lineNo: parsed.lineNo,
        snippet: parsed.snippet.slice(0, 100),
        detail: `"${tool}" called in file with no platform guard — add \`if (process.platform === 'darwin')\` or skip on Linux`,
      });
    }
  }
}

// ── Check 3: Hardcoded macOS-only filesystem paths ───────────────────────────
const MACOS_PATHS: Array<{ pattern: string; label: string }> = [
  { pattern: "/Applications/kitty\\.app/Contents/MacOS/kitten", label: "/Applications/kitty.app fallback" },
  { pattern: "~/Library/LaunchAgents", label: "~/Library/LaunchAgents (macOS launchd)" },
  { pattern: "/opt/homebrew/bin/[a-zA-Z]", label: "/opt/homebrew hardcoded binary" },
];

for (const { pattern, label } of MACOS_PATHS) {
  const matches = rg(pattern, SCAN_PATHS).filter(l => !isSkipped(l));
  for (const line of matches) {
    const parsed = parseMatch(line);
    if (!parsed) continue;
    if (parsed.snippet.startsWith("//") || parsed.snippet.startsWith("*")) continue;
    if (!fileHasDarwinGuard(parsed.file)) {
      issues.push({
        type: "hardcoded-macos-path",
        file: parsed.file,
        lineNo: parsed.lineNo,
        snippet: parsed.snippet.slice(0, 100),
        detail: `${label} — hardcoded macOS path without platform guard`,
      });
    }
  }
}

// ── Output ────────────────────────────────────────────────────────────────────
if (JSON_MODE) {
  console.log(JSON.stringify({ issues, count: issues.length, clean: issues.length === 0 }, null, 2));
  process.exit(issues.length > 0 ? 1 : 0);
}

if (issues.length === 0) {
  console.log("✅  LinuxPortabilityCheck: clean");
  process.exit(0);
}

const byType: Record<string, Issue[]> = {};
for (const issue of issues) {
  (byType[issue.type] ??= []).push(issue);
}

console.log(`\n⚠️   LinuxPortabilityCheck: ${issues.length} issue(s) found\n`);

const LABELS: Record<string, string> = {
  "case-mismatch":       "Case Mismatches (Linux case-sensitive filesystem)",
  "unguarded-macos-cli": "Unguarded macOS CLI Calls",
  "hardcoded-macos-path":"Hardcoded macOS Paths",
};

for (const [type, group] of Object.entries(byType)) {
  console.log(`── ${LABELS[type] ?? type} (${group.length}) ─`);
  for (const issue of group) {
    console.log(`   ${issue.file}:${issue.lineNo}`);
    console.log(`   ${issue.snippet}`);
    console.log(`   → ${issue.detail}`);
    console.log();
  }
}

console.log(`Run \`bun PAI/TOOLS/LinuxPortabilityCheck.ts --json\` for machine-readable output.`);
console.log(`Add to post-merge hook: \`git config core.hooksPath .githooks\``);
process.exit(1);
