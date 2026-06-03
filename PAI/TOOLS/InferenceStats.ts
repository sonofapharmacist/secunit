#!/usr/bin/env bun
/**
 * InferenceStats — Cost savings report for PAI inference calls
 *
 * Reads MEMORY/OBSERVABILITY/inference-calls.jsonl and reports:
 *   status   Today's call breakdown and estimated savings
 *   report   All-time stats with per-level breakdown and hypothetical Claude cost
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";

const HOME = process.env.HOME || process.env.USERPROFILE || '';
const INFERENCE_LOG = join(HOME, '.claude', 'PAI', 'MEMORY', 'OBSERVABILITY', 'inference-calls.jsonl');

// Claude pricing ($/MTok in / $/MTok out) — update when Anthropic changes pricing
const PRICING: Record<string, { in: number; out: number; name: string }> = {
  fast:     { in: 0.80,  out: 4.00,  name: 'Haiku' },
  standard: { in: 3.00,  out: 15.00, name: 'Sonnet' },
  smart:    { in: 15.00, out: 75.00, name: 'Opus' },
};

// Token estimation heuristics — local inference doesn't expose counts without streaming
const TOKEN_ESTIMATES: Record<string, { in: number; out: number }> = {
  fast:     { in: 800,  out: 200  },
  standard: { in: 2000, out: 500  },
  smart:    { in: 4000, out: 1000 },
};

interface LogEntry {
  timestamp: string;
  backend: 'claude' | 'ollama' | 'local';
  level: string;
  latency_ms: number;
  model: string;
  fallback_used: boolean;
  escalated_from_local: boolean;
  prompt_tokens?: number;
  completion_tokens?: number;
}

function loadLog(): LogEntry[] {
  if (!existsSync(INFERENCE_LOG)) return [];
  const raw = readFileSync(INFERENCE_LOG, 'utf-8').trim();
  if (!raw) return [];
  const entries: LogEntry[] = [];
  for (const line of raw.split('\n')) {
    try { entries.push(JSON.parse(line)); } catch { /* skip malformed lines */ }
  }
  return entries;
}

function estimatedCost(level: string): number {
  const p = PRICING[level] ?? PRICING.standard;
  const t = TOKEN_ESTIMATES[level] ?? TOKEN_ESTIMATES.standard;
  return (t.in / 1_000_000) * p.in + (t.out / 1_000_000) * p.out;
}

function isToday(timestamp: string): boolean {
  const now = new Date();
  const ts = new Date(timestamp);
  return ts.getFullYear() === now.getFullYear() &&
         ts.getMonth() === now.getMonth() &&
         ts.getDate() === now.getDate();
}

function avg(nums: number[]): number {
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}

function tokenStats(entries: LogEntry[]): { actualCount: number; totalPrompt: number; totalCompletion: number } {
  let actualCount = 0;
  let totalPrompt = 0;
  let totalCompletion = 0;
  for (const e of entries) {
    if (e.prompt_tokens !== undefined || e.completion_tokens !== undefined) {
      actualCount++;
      totalPrompt += e.prompt_tokens ?? 0;
      totalCompletion += e.completion_tokens ?? 0;
    }
  }
  return { actualCount, totalPrompt, totalCompletion };
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function statusCmd(entries: LogEntry[]): void {
  const today = entries.filter(e => isToday(e.timestamp));
  const localToday = today.filter(e => e.backend === 'local' || e.backend === 'ollama');
  const claudeToday = today.filter(e => e.backend === 'claude');

  const date = new Date().toISOString().slice(0, 10);
  console.log(`Today (${date}):  ${today.length} calls | ${localToday.length} local / ${claudeToday.length} claude`);
  const parts: string[] = [];
  if (localToday.length) parts.push(`local avg ${fmtMs(avg(localToday.map(e => e.latency_ms)))}`);
  if (claudeToday.length) parts.push(`claude avg ${fmtMs(avg(claudeToday.map(e => e.latency_ms)))}`);
  if (parts.length) console.log(`Avg latency:     ${parts.join(' / ')}`);

  if (localToday.length) {
    const { actualCount, totalPrompt, totalCompletion } = tokenStats(localToday);
    if (actualCount > 0) {
      const avgPrompt = Math.round(totalPrompt / actualCount);
      const avgCompletion = Math.round(totalCompletion / actualCount);
      console.log(`Local tokens:    ${fmtTokens(totalPrompt + totalCompletion)} total today  (avg ${fmtTokens(avgPrompt)} prompt / ${fmtTokens(avgCompletion)} completion per call, ${actualCount}/${localToday.length} calls with actual counts)`);
    } else {
      const savings = localToday.reduce((sum, e) => sum + estimatedCost(e.level), 0);
      console.log(`Estimated savings today: ~${fmtUsd(savings)}  (no actual token counts yet — upgrade Inference.ts to capture them)`);
    }
  }
}

function reportCmd(entries: LogEntry[]): void {
  const levels = ['fast', 'standard', 'smart'];
  const localAll = entries.filter(e => e.backend === 'local' || e.backend === 'ollama');
  const claudeAll = entries.filter(e => e.backend === 'claude');

  const pct = (n: number) => entries.length ? `${((n / entries.length) * 100).toFixed(1)}%` : '0%';
  const border = '═'.repeat(64);

  console.log(border);
  console.log(` PAI Inference Stats — all time`);
  console.log(border);
  console.log(` Total calls:  ${entries.length}`);
  console.log(` Local:        ${localAll.length} (${pct(localAll.length)})   Claude: ${claudeAll.length} (${pct(claudeAll.length)})`);

  const { actualCount: totalActual, totalPrompt: grandPrompt, totalCompletion: grandCompletion } = tokenStats(localAll);
  if (totalActual > 0) {
    console.log(` Local tokens:  ${fmtTokens(grandPrompt + grandCompletion)} total  (${fmtTokens(grandPrompt)} prompt / ${fmtTokens(grandCompletion)} completion, ${totalActual}/${localAll.length} calls with actual counts)`);
  }

  console.log(``);
  console.log(` By level:`);

  for (const level of levels) {
    const o = localAll.filter(e => e.level === level);
    const c = claudeAll.filter(e => e.level === level);
    if (!o.length && !c.length) continue;
    const p = PRICING[level];
    const oAvg = o.length ? fmtMs(avg(o.map(e => e.latency_ms))) : '—';
    const cAvg = c.length ? fmtMs(avg(c.map(e => e.latency_ms))) : '—';

    const { actualCount, totalPrompt, totalCompletion } = tokenStats(o);
    let tokenLine: string;
    if (actualCount > 0) {
      const avgP = Math.round(totalPrompt / actualCount);
      const avgC = Math.round(totalCompletion / actualCount);
      tokenLine = `tokens: ${fmtTokens(totalPrompt + totalCompletion)} total  avg ${fmtTokens(avgP)}p/${fmtTokens(avgC)}c`;
    } else {
      const levelSavings = o.reduce((sum, e) => sum + estimatedCost(e.level), 0);
      tokenLine = `est. savings: ~${fmtUsd(levelSavings)} (heuristic — no actual counts)`;
    }

    console.log(`   ${level.padEnd(8)} local:  ${String(o.length).padStart(3)}  claude: ${String(c.length).padStart(3)}   ${tokenLine}`);
    console.log(`            latency avg: local  ${oAvg} / claude ${cAvg}  (${p.name}: ${fmtUsd(p.in)}/${fmtUsd(p.out)} MTok)`);
  }

  console.log(border);
}

function main(): void {
  const cmd = process.argv[2] ?? 'status';

  if (cmd === '--help' || cmd === '-h') {
    console.log('Usage: bun InferenceStats.ts <status|report>');
    console.log('  status   Today\'s call breakdown and estimated savings');
    console.log('  report   All-time stats with per-level breakdown and hypothetical Claude cost');
    return;
  }

  const entries = loadLog();

  if (!entries.length) {
    console.log('No inference call data yet.');
    return;
  }

  switch (cmd) {
    case 'status': statusCmd(entries); break;
    case 'report': reportCmd(entries); break;
    default:
      console.error(`Unknown command: ${cmd}. Use status or report.`);
      process.exit(1);
  }
}

main();
