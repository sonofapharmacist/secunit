#!/usr/bin/env bun
/**
 * TmuxDriver.ts — Drive interactive CLI tools through a real tmux TTY.
 *
 * Subcommands:
 *   create <session>
 *   send   <session> <text>
 *   capture <session>
 *   wait   <session> <pattern> [--timeout <ms>]
 *   kill   <session>
 *   run    <session> <command> [--respond <trigger>=<response> ...] [--timeout <ms>]
 *
 * The `run` subcommand wraps the command with `; echo "__EXIT_$?__"` to capture
 * exit code, drives trigger/response pairs in sequence, then returns JSON:
 *   { "output": "<pane text>", "exitCode": <N> }
 */

import { spawnSync } from "child_process";

const DEFAULT_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 100;

// ── tmux primitives ──────────────────────────────────────────────────────────

function tmux(...args: string[]): { stdout: string; stderr: string; status: number } {
  const r = spawnSync("tmux", args, { encoding: "utf-8", stdio: "pipe" });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? 1 };
}

function cmdCreate(session: string): void {
  const r = tmux("new-session", "-d", "-s", session);
  if (r.status !== 0) throw new Error(`tmux new-session failed: ${r.stderr.trim()}`);
}

function cmdSend(session: string, text: string): void {
  const r = tmux("send-keys", "-t", session, text, "Enter");
  if (r.status !== 0) throw new Error(`tmux send-keys failed: ${r.stderr.trim()}`);
}

function cmdCapture(session: string): string {
  // -S - captures from the start of scrollback, not just the visible pane.
  // Without this, output longer than the terminal height is silently truncated.
  const r = tmux("capture-pane", "-t", session, "-p", "-S", "-");
  if (r.status !== 0) throw new Error(`tmux capture-pane failed: ${r.stderr.trim()}`);
  return r.stdout;
}

function cmdKill(session: string): void {
  tmux("kill-session", "-t", session); // ignore errors — may already be dead
}

// ── async wait-for-pattern ───────────────────────────────────────────────────

async function waitForPattern(
  session: string,
  pattern: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const output = cmdCapture(session);
    if (output.includes(pattern)) return output;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  const last = cmdCapture(session);
  throw new Error(
    `timeout after ${timeoutMs}ms waiting for pattern "${pattern}"\nLast pane:\n${last}`
  );
}

// ── run subcommand ───────────────────────────────────────────────────────────

interface RunResult {
  output: string;
  exitCode: number;
}

async function cmdRun(
  session: string,
  command: string,
  responds: Array<[string, string]>,
  timeoutMs: number
): Promise<RunResult> {
  cmdCreate(session);
  try {
    // Wrap command to capture exit code via __EXIT_N__ marker
    const wrapped = `${command}; echo "__EXIT_$?__"`;
    cmdSend(session, wrapped);

    // Walk through trigger/response pairs in order
    for (const [trigger, response] of responds) {
      await waitForPattern(session, trigger, timeoutMs);
      cmdSend(session, response);
    }

    // Wait for exit marker
    await waitForPattern(session, "__EXIT_", timeoutMs);
    const output = cmdCapture(session);

    // Parse exit code from __EXIT_N__ marker
    const match = output.match(/__EXIT_(\d+)__/);
    const exitCode = match ? parseInt(match[1], 10) : 0;

    return { output, exitCode };
  } finally {
    cmdKill(session);
  }
}

// ── CLI entry ────────────────────────────────────────────────────────────────

const [, , subcommand, ...rest] = process.argv;

if (!subcommand || subcommand === "--help" || subcommand === "-h") {
  console.log(`TmuxDriver.ts — interactive CLI driver via tmux TTY

Usage:
  bun TmuxDriver.ts create  <session>
  bun TmuxDriver.ts send    <session> <text>
  bun TmuxDriver.ts capture <session>
  bun TmuxDriver.ts wait    <session> <pattern> [--timeout <ms>]
  bun TmuxDriver.ts kill    <session>
  bun TmuxDriver.ts run     <session> <command> \\
                              [--respond <trigger>=<response> ...] \\
                              [--timeout <ms>]

The 'run' subcommand returns JSON: {"output":"...","exitCode":N}
Default timeout: ${DEFAULT_TIMEOUT_MS}ms
`);
  process.exit(0);
}

(async () => {
  try {
    switch (subcommand) {
      case "create": {
        const [session] = rest;
        if (!session) throw new Error("create requires <session>");
        cmdCreate(session);
        console.log(`session created: ${session}`);
        break;
      }

      case "send": {
        const [session, ...textParts] = rest;
        if (!session || textParts.length === 0) throw new Error("send requires <session> <text>");
        cmdSend(session, textParts.join(" "));
        console.log(`sent to ${session}`);
        break;
      }

      case "capture": {
        const [session] = rest;
        if (!session) throw new Error("capture requires <session>");
        process.stdout.write(cmdCapture(session));
        break;
      }

      case "wait": {
        // wait <session> <pattern> [--timeout <ms>]
        const args = [...rest];
        let timeoutMs = DEFAULT_TIMEOUT_MS;
        const tIdx = args.indexOf("--timeout");
        if (tIdx !== -1) {
          timeoutMs = parseInt(args[tIdx + 1], 10);
          args.splice(tIdx, 2);
        }
        const [session, ...patternParts] = args;
        const pattern = patternParts.join(" ");
        if (!session || !pattern) throw new Error("wait requires <session> <pattern>");
        const output = await waitForPattern(session, pattern, timeoutMs);
        process.stdout.write(output);
        break;
      }

      case "kill": {
        const [session] = rest;
        if (!session) throw new Error("kill requires <session>");
        cmdKill(session);
        console.log(`session killed: ${session}`);
        break;
      }

      case "run": {
        // run <session> <command> [--respond trigger=response ...] [--timeout <ms>]
        const args = [...rest];
        let timeoutMs = DEFAULT_TIMEOUT_MS;
        const responds: Array<[string, string]> = [];

        // Extract --timeout
        const tIdx = args.indexOf("--timeout");
        if (tIdx !== -1) {
          timeoutMs = parseInt(args[tIdx + 1], 10);
          args.splice(tIdx, 2);
        }

        // Extract all --respond pairs (may appear multiple times)
        let rIdx: number;
        while ((rIdx = args.indexOf("--respond")) !== -1) {
          const pair = args[rIdx + 1];
          if (!pair) throw new Error("--respond requires trigger=response");
          const eqPos = pair.indexOf("=");
          if (eqPos === -1) throw new Error(`--respond value must be trigger=response, got: ${pair}`);
          const trigger = pair.slice(0, eqPos);
          const response = pair.slice(eqPos + 1);
          responds.push([trigger, response]);
          args.splice(rIdx, 2);
        }

        const [session, ...commandParts] = args;
        const command = commandParts.join(" ");
        if (!session || !command) throw new Error("run requires <session> <command>");

        const result = await cmdRun(session, command, responds, timeoutMs);
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      default:
        throw new Error(`unknown subcommand: ${subcommand}`);
    }
  } catch (err) {
    console.error(`TmuxDriver error: ${(err as Error).message}`);
    process.exit(1);
  }
})();
