#!/usr/bin/env bun
/**
 * AlgorithmAB.ts — score v7.1.1 vs v8 ISAs for the Algorithm v8 falsifier (ISC-14).
 *
 * Usage:
 *   bun PAI/TOOLS/AlgorithmAB.ts [--since YYYY-MM-DD] [--json] [--out <file>]
 *
 * Arms:
 *   v8 — ISAs with a reflection row whose algorithm_version starts with "8"
 *        (written by ISASync when an ISA completes under v8).
 *   v7 — every other completed ISA under MEMORY/WORK.
 *
 * Mechanical metrics per arm (nothing self-reported; evidence and anti come from
 * ISA text, the Cato metric also reads MEMORY/VERIFICATION/cato-findings.jsonl):
 *   evidence_rate      passed criteria that have a `## Verification` line / passed criteria
 *   anti_rate          ISAs with at least one Anti criterion / ISAs with criteria
 *   cato_narrated_rate deep/comprehensive (E4/E5) ISAs, where Cato was mandatory,
 *                      that have no cato-findings.jsonl row / those ISAs
 *
 * Post-compaction recovery is NOT measured here; it needs session transcripts.
 *
 * Pass thresholds (from the ISA): v8 evidence_rate drop < 20% relative to v7,
 * v8 cato_narrated_rate < 10%.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { paiPath } from '../../hooks/lib/paths';
import { frontmatterPhase, unevidencedPassed, criteriaLines } from '../../hooks/lib/algorithm-v8';

interface Scored {
  slug: string;
  arm: 'v7' | 'v8';
  started: string | null;
  criteria: number;
  passed: number;
  evidenced: number;
  hasAnti: boolean;
  catoMandated: boolean;
  catoRow: boolean;
}

function args() {
  const a = process.argv.slice(2);
  const get = (f: string) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : undefined; };
  return { since: get('--since'), json: a.includes('--json'), out: get('--out') };
}

function readLines(path: string): string[] {
  return existsSync(path) ? readFileSync(path, 'utf-8').split('\n').filter(Boolean) : [];
}

function v8Slugs(): Set<string> {
  const rows = readLines(paiPath('MEMORY', 'LEARNING', 'REFLECTIONS', 'algorithm-reflections.jsonl'));
  const slugs = new Set<string>();
  for (const line of rows) {
    try {
      const r = JSON.parse(line);
      if (String(r.algorithm_version ?? '').startsWith('8') && r.prd_id) slugs.add(String(r.prd_id));
    } catch { /* skip malformed row */ }
  }
  return slugs;
}

function score(slug: string, content: string, v8: Set<string>, catoLog: string): Scored {
  const criteria = criteriaLines(content);
  const passed = criteria.filter((c) => /- \[[xX]\]/.test(c)).length;
  const unevidenced = unevidencedPassed(content).length;
  return {
    slug,
    arm: v8.has(slug) ? 'v8' : 'v7',
    started: content.match(/^started:\s*(\S+)/m)?.[1] ?? null,
    criteria: criteria.length,
    passed,
    evidenced: passed - unevidenced,
    hasAnti: criteria.some((c) => /Anti[-:]/.test(c)),
    catoMandated: /^effort:\s*["']?(deep|comprehensive|e4|e5)\b/im.test(content),
    catoRow: catoLog.includes(`"${slug}"`),
  };
}

function summarize(rows: Scored[]) {
  const withCriteria = rows.filter((r) => r.criteria > 0);
  const passed = rows.reduce((s, r) => s + r.passed, 0);
  const evidenced = rows.reduce((s, r) => s + r.evidenced, 0);
  const cato = rows.filter((r) => r.catoMandated);
  const pct = (n: number, d: number) => (d === 0 ? null : Math.round((n / d) * 1000) / 10);
  return {
    isas: rows.length,
    isas_with_criteria: withCriteria.length,
    passed_criteria: passed,
    evidence_rate_pct: pct(evidenced, passed),
    anti_rate_pct: pct(withCriteria.filter((r) => r.hasAnti).length, withCriteria.length),
    cato_mandated: cato.length,
    cato_narrated_rate_pct: pct(cato.filter((r) => !r.catoRow).length, cato.length),
  };
}

function main() {
  const { since, json, out } = args();
  const workDir = paiPath('MEMORY', 'WORK');
  const catoLog = readLines(paiPath('MEMORY', 'VERIFICATION', 'cato-findings.jsonl')).join('\n');
  const v8 = v8Slugs();
  const scored: Scored[] = [];

  for (const slug of readdirSync(workDir)) {
    const isa = join(workDir, slug, 'ISA.md');
    if (!existsSync(isa)) continue;
    const content = readFileSync(isa, 'utf-8');
    if (frontmatterPhase(content) !== 'complete') continue;
    const s = score(slug, content, v8, catoLog);
    if (since && s.started && s.started < since) continue;
    scored.push(s);
  }

  const v7Sum = summarize(scored.filter((s) => s.arm === 'v7'));
  const v8Sum = summarize(scored.filter((s) => s.arm === 'v8'));
  const drop = v7Sum.evidence_rate_pct !== null && v8Sum.evidence_rate_pct !== null && v7Sum.evidence_rate_pct > 0
    ? Math.round(((v7Sum.evidence_rate_pct - v8Sum.evidence_rate_pct) / v7Sum.evidence_rate_pct) * 1000) / 10
    : null;
  const verdict = v8Sum.isas < 20
    ? `insufficient v8 data (${v8Sum.isas}/20 completed v8 ISAs)`
    : (drop !== null && drop < 20 && (v8Sum.cato_narrated_rate_pct ?? 0) < 10) ? 'pass' : 'fail';

  const result = { generated: new Date().toISOString(), since: since ?? null, v7: v7Sum, v8: v8Sum, evidence_rate_relative_drop_pct: drop, verdict, recovery: 'not measured — needs session transcripts' };

  if (out) writeFileSync(out, JSON.stringify({ ...result, rows: scored }, null, 2) + '\n', 'utf-8');
  if (json) { console.log(JSON.stringify(result, null, 2)); return; }

  const row = (name: string, s: ReturnType<typeof summarize>) =>
    `| ${name} | ${s.isas} | ${s.passed_criteria} | ${s.evidence_rate_pct ?? '—'} | ${s.anti_rate_pct ?? '—'} | ${s.cato_mandated} | ${s.cato_narrated_rate_pct ?? '—'} |`;
  console.log('| arm | ISAs | passed ISCs | evidence % | anti % | Cato mandated | Cato narrated % |');
  console.log('|---|---|---|---|---|---|---|');
  console.log(row('v7', v7Sum));
  console.log(row('v8', v8Sum));
  console.log(`\nverdict: ${verdict}`);
}

main();
