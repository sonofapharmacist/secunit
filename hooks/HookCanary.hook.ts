#!/usr/bin/env bun
/**
 * HookCanary.hook.ts — SessionStart
 *
 * Detects unexpected changes to hook files and critical PAI settings by
 * comparing the current git working tree to HEAD. In default mode it reports
 * changes through Pulse and a JSONL security log without writing to stdout. In
 * --ack mode it stages and commits intentional changes to refresh the canary
 * baseline.
 */

import { execSync } from 'child_process';
import { appendFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';

const PAI_DIR = join(process.env.HOME!, '.claude');
const CANARY_PATHS = ['hooks/', 'settings.json', 'PAI/PAI_SYSTEM_PROMPT.md'];
const SECURITY_LOG = join(PAI_DIR, 'PAI/MEMORY/OBSERVABILITY/security-events.jsonl');
const PULSE_URL = 'http://localhost:31337/notify';

interface HookInput {
  session_id?: string;
}

interface SecurityEvent {
  ts: string;
  event_type: 'integrity_mismatch' | 'integrity_acknowledged';
  files: string[];
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function pathspecArgs(): string {
  return CANARY_PATHS.map(shellQuote).join(' ');
}

function runGit(command: string): string | null {
  try {
    return execSync(command, { cwd: PAI_DIR, stdio: 'pipe' }).toString().trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[HookCanary] Git command failed: ${command}: ${message}\n`);
    return null;
  }
}

function appendLog(eventType: SecurityEvent['event_type'], files: string[]): void {
  const event: SecurityEvent = {
    ts: new Date().toISOString(),
    event_type: eventType,
    files,
  };

  try {
    mkdirSync(dirname(SECURITY_LOG), { recursive: true });
    appendFileSync(SECURITY_LOG, `${JSON.stringify(event)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[HookCanary] Failed to append security log: ${message}\n`);
  }
}

function notifyPulse(message: string): void {
  const payload = JSON.stringify({ message });
  const curlCommand = `curl -sS --max-time 2 -X POST -H 'Content-Type: application/json' -d ${shellQuote(payload)} ${shellQuote(PULSE_URL)}`;

  try {
    execSync(curlCommand, { stdio: 'pipe' });
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[HookCanary] Pulse notification failed: ${messageText}\n`);
  }
}

function detectChanges(): string[] {
  const diffCommand = `git diff --name-only HEAD -- ${pathspecArgs()}`;
  const untrackedCommand = `git ls-files --others --exclude-standard -- ${pathspecArgs()}`;
  const diffOutput = runGit(diffCommand) ?? '';
  const untrackedOutput = runGit(untrackedCommand) ?? '';
  const files = new Set<string>();

  for (const entry of diffOutput.split('\n')) {
    const trimmed = entry.trim();
    if (trimmed) {
      files.add(trimmed);
    }
  }

  for (const entry of untrackedOutput.split('\n')) {
    const trimmed = entry.trim();
    if (trimmed) {
      files.add(trimmed);
    }
  }

  return Array.from(files).sort();
}

function acknowledgeChanges(files: string[]): void {
  if (files.length === 0) {
    process.stdout.write('baseline current, nothing to acknowledge\n');
    return;
  }

  for (const file of files) {
    process.stdout.write(`${file}\n`);
  }

  const addCommand = `git add -- ${files.map(shellQuote).join(' ')}`;
  const commitMessage = `security: ack intentional change to ${files.join(', ')}`;
  const commitCommand = `git commit -m ${shellQuote(commitMessage)} -- ${files.map(shellQuote).join(' ')}`;
  const addResult = runGit(addCommand);
  if (addResult === null) {
    return;
  }

  const commitResult = runGit(commitCommand);
  if (commitResult === null) {
    return;
  }

  appendLog('integrity_acknowledged', files);
  notifyPulse(`Canary: acknowledged intentional change in ${files.join(', ')}`);
}

async function readHookInput(): Promise<HookInput> {
  if (process.stdin.isTTY) {
    return {};
  }

  const chunks: string[] = [];
  process.stdin.setEncoding?.('utf8');

  return await new Promise<HookInput>((resolve, reject) => {
    process.stdin.on('data', (chunk: Uint8Array | string) => {
      chunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
    });
    process.stdin.on('end', () => {
      try {
        const raw = chunks.join('');
        if (!raw.trim()) {
          resolve({});
          return;
        }
        resolve(JSON.parse(raw) as HookInput);
      } catch (error) {
        reject(error);
      }
    });
    process.stdin.on('error', reject);
  });
}

async function main(): Promise<void> {
  const isAckMode = process.argv.includes('--ack');

  try {
    // Drain stdin if present so the harness pipe closes cleanly. We don't
    // currently need session_id, but reading the input keeps the hook
    // contract honest and avoids EPIPE on the caller side.
    await readHookInput();
  } catch {
    // Harness input absent or malformed — proceed; the canary check is
    // self-sufficient.
  }

  const files = detectChanges();

  if (isAckMode) {
    acknowledgeChanges(files);
    return;
  }

  if (files.length === 0) {
    return;
  }

  appendLog('integrity_mismatch', files);
  notifyPulse(`Canary: unexpected change detected in ${files.join(', ')}`);
}

main().catch(err => {
  process.stderr.write(`[HookCanary] Error: ${err}\n`);
  // Exit 0 even if the canary itself fails.
});
