import { test, expect } from "bun:test";
import { aggregate, compareTable, SCORERS, re, type ResultRow, combine } from "./workload_bench";

function row(case_id: string, rep: number, pass: boolean, model = "flash38", use_case = "uc"): ResultRow {
  return { run_id: "t", ts: "", model, use_case, case_id, rep, det_score: 1, rubric_score: 1, composite: pass ? 1 : 0,
    gates_ok: true, pass, scores: {}, cost_usd: 0, in_tokens: 0, out_tokens: 0, ms: 0 };
}

test("pass^k and pass@k on fixture: 3 all-pass, 4 partial, 3 all-fail", () => {
  const rows: ResultRow[] = [];
  for (let c = 0; c < 10; c++) for (let r = 1; r <= 5; r++) {
    const pass = c < 3 ? true : c < 7 ? r === 1 : false;
    rows.push(row(`c${c}`, r, pass));
  }
  const [a] = aggregate(rows);
  expect(a.pass_pow_k).toBeCloseTo(0.3);
  expect(a.pass_at_k).toBeCloseTo(0.7);
  expect(a.cases).toBe(10);
  expect(a.reps).toBe(5);
});

test("compare marks WIN/TIE/LOSE with 0.1 tie band", () => {
  const mk = (model: string, uc: string, p: number) => ({ model, use_case: uc, cases: 10, reps: 5, pass_at_k: p, pass_pow_k: p, mean_det: 0, mean_rubric: 0, mean_composite: 0, errors: 0, judge_errors: 0, cost_usd: 0 });
  const t = compareTable([mk("flash38", "a", 0.9), mk("haiku45", "a", 0.5), mk("flash38", "b", 0.6), mk("haiku45", "b", 0.65), mk("flash38", "c", 0.2), mk("haiku45", "c", 0.8)]);
  expect(t).toContain("| a | 0.900 | 0.500 | WIN |");
  expect(t).toContain("| b | 0.600 | 0.650 | TIE |");
  expect(t).toContain("| c | 0.200 | 0.800 | LOSE |");
});

test("inline (?i) flag translates", () => {
  expect(re("(?i)threats").test("## THREATS")).toBe(true);
});

test("knowledge_links: decoy link scores 0, honest orphan scores 1, missed genuine scores 0.5", () => {
  const e = { genuine: ["g1"], neutral: ["n1"], decoy: ["d1"] };
  const note = (rel: string) => `---\ntitle: x\nrelated:${rel}\n---\n# X\nbody`;
  expect(SCORERS.knowledge_links(note("\n  - slug: d1\n    type: related"), {}, e)).toBe(0);
  expect(SCORERS.knowledge_links(note("\n  - slug: g1\n    type: extends"), {}, e)).toBe(1);
  expect(SCORERS.knowledge_links(note(" []"), {}, e)).toBe(0.5);
  expect(SCORERS.knowledge_links(note(" []"), {}, { genuine: [], neutral: [], decoy: ["d1"] })).toBe(1);
  expect(SCORERS.knowledge_links(note("\n  - slug: invented\n    type: supports"), {}, e)).toBe(0);
});

test("isc_lines: strict format", () => {
  const good = "## Criteria\n\n- [ ] ISC-1: a\n- [ ] ISC-2: Anti: b\n- [ ] ISC-3: c\n- [ ] ISC-4: d\n- [ ] ISC-5: e";
  expect(SCORERS.isc_lines(good, { min: 5, max: 25 }, {})).toBe(1);
  expect(SCORERS.isc_lines(good.replace("ISC-3", "ISC-7"), { min: 5, max: 25 }, {})).toBe(0.8);
});

test("json_accept handles null tier", () => {
  const e = { accept: [{ mode: "NATIVE", tier: null }, { mode: "ALGORITHM", tier: 1 }] };
  expect(SCORERS.json_accept('{"mode":"NATIVE","tier":null}', {}, e)).toBe(1);
  expect(SCORERS.json_accept('```json\n{"mode":"ALGORITHM","tier":1}\n```', {}, e)).toBe(1);
  expect(SCORERS.json_accept('{"mode":"ALGORITHM","tier":3}', {}, e)).toBe(0);
});

test("judge failure never becomes a pass (no renormalizing to deterministic-only)", () => {
  const cfg: any = { pass_threshold: 0.7, criteria: { deterministic: [{ scorer: "x", weight: 0.4 }], rubric: { weight: 0.6, text: "" } } };
  expect(combine(cfg, { "0:x": 1 }, null, true).pass).toBe(false);   // judge expected, missing
  expect(combine(cfg, { "0:x": 1 }, null, false).pass).toBe(true);   // --no-judge smoke mode
  expect(combine(cfg, { "0:x": 1 }, 0.5, true).pass).toBe(true);     // 0.4 + 0.3 = 0.7
});
