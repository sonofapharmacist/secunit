#!/usr/bin/env bun
/**
 * NightlyCodeReview.ts - Nightly autopilot code review for Forgejo repos
 *
 * Runs `/code-review high` headlessly against repos that had commits in the
 * last 24h, and appends structured findings to a JSONL queue. Report-only —
 * never applies fixes. Pulse's code-review module renders the queue.
 *
 * Usage:
 *   bun ~/.claude/PAI/TOOLS/NightlyCodeReview.ts --repo ${HOME}/.claude --label pai-config
 *   bun ~/.claude/PAI/TOOLS/NightlyCodeReview.ts --resolve <finding-id>
 */

import { spawnSync } from "child_process"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, join } from "path"
import { randomUUID } from "crypto"

const HOME = process.env.HOME ?? ""
const QUEUE_PATH = join(HOME, ".claude", "PAI", "MEMORY", "STATE", "code-review-queue.jsonl")

interface Finding {
  id: string
  repo: string
  severity: "high" | "medium" | "low"
  file: string
  line: number | null
  description: string
  created_at: string
  resolved: boolean
}

const FINDINGS_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["high", "medium", "low"] },
          file: { type: "string" },
          line: { type: ["number", "null"] },
          description: { type: "string" },
        },
        required: ["severity", "file", "description"],
      },
    },
  },
  required: ["findings"],
}

function hadCommitsInLast24h(repoPath: string): boolean {
  const result = spawnSync("git", ["-C", repoPath, "log", "--since=24.hours", "--oneline"], {
    encoding: "utf-8",
    stdio: "pipe",
  })
  return result.status === 0 && result.stdout.trim().length > 0
}

function runReview(repoPath: string, label: string): Finding[] {
  const result = spawnSync(
    "claude",
    [
      "-p",
      "/code-review high",
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(FINDINGS_SCHEMA),
      "--permission-mode",
      "default",
    ],
    { cwd: repoPath, encoding: "utf-8", stdio: "pipe", timeout: 600_000 }
  )

  if (result.status !== 0) {
    console.error(`[NightlyCodeReview] ${label} review failed (exit ${result.status}): ${result.stderr}`)
    return []
  }

  let parsed: { findings: Array<{ severity: string; file: string; line?: number; description: string }> }
  try {
    const outer = JSON.parse(result.stdout)
    const resultText = typeof outer.result === "string" ? outer.result : result.stdout
    parsed = JSON.parse(resultText)
  } catch (err) {
    console.error(`[NightlyCodeReview] ${label} failed to parse findings: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }

  return parsed.findings.map((f) => ({
    id: randomUUID(),
    repo: label,
    severity: f.severity as Finding["severity"],
    file: f.file,
    line: f.line ?? null,
    description: f.description,
    created_at: new Date().toISOString(),
    resolved: false,
  }))
}

function appendFindings(findings: Finding[]): void {
  if (findings.length === 0) return
  mkdirSync(dirname(QUEUE_PATH), { recursive: true })
  const lines = findings.map((f) => JSON.stringify(f)).join("\n") + "\n"
  appendFileSync(QUEUE_PATH, lines)
}

function resolveFinding(id: string): void {
  if (!existsSync(QUEUE_PATH)) {
    console.error("[NightlyCodeReview] queue file does not exist")
    return
  }
  const lines = readFileSync(QUEUE_PATH, "utf-8").trim().split("\n").filter(Boolean)
  const updated = lines.map((line) => {
    const finding: Finding = JSON.parse(line)
    if (finding.id === id) finding.resolved = true
    return JSON.stringify(finding)
  })
  writeFileSync(QUEUE_PATH, updated.join("\n") + "\n")
}

function main(): void {
  const args = process.argv.slice(2)

  const resolveIdx = args.indexOf("--resolve")
  if (resolveIdx !== -1) {
    resolveFinding(args[resolveIdx + 1])
    return
  }

  const repoIdx = args.indexOf("--repo")
  const labelIdx = args.indexOf("--label")
  if (repoIdx === -1 || labelIdx === -1) {
    console.error("Usage: NightlyCodeReview.ts --repo <path> --label <name>")
    process.exit(1)
  }
  const repoPath = args[repoIdx + 1]
  const label = args[labelIdx + 1]

  if (!hadCommitsInLast24h(repoPath)) {
    console.log(`[NightlyCodeReview] ${label}: no commits in last 24h, skipping`)
    return
  }

  console.log(`[NightlyCodeReview] ${label}: running review`)
  const findings = runReview(repoPath, label)
  appendFindings(findings)
  console.log(`[NightlyCodeReview] ${label}: ${findings.length} findings written`)
}

main()
