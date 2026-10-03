import { describe, test, expect } from "bun:test";
import {
  DEFAULT_VARIANT, validateVariant, variantHash, buildRequestBody, acceptVariant, acceptVariantPaired, PAIRED_RULE,
  waitForIdleSlots, modelFamily, judgeIsIndependent, type HarnessVariant,
} from "./harness_variant";

const v = (over: Partial<HarnessVariant>): HarnessVariant => ({ ...DEFAULT_VARIANT, id: "t", proposer: "cloud", ...over });

describe("validateVariant (ISC-11)", () => {
  test("the default control arm is valid", () => expect(validateVariant(DEFAULT_VARIANT)).toEqual([]));

  test("a full variant using every field is valid", () => {
    expect(validateVariant(v({
      template: { system_suffix: "\nAnswer in one line." }, sampler: { temperature: 0.3, top_p: 0.9 },
      grammar: { json_schema: { type: "object" } }, few_shot_k: 3, self_consistency_n: 3, decompose: true,
      max_tokens: 256, context_compression: { bm25_top_k: 4 },
    }))).toEqual([]);
  });

  test("rejects each bad field with a message naming it", () => {
    const errs = validateVariant({ ...DEFAULT_VARIANT, id: "", proposer: "me", template: { footer: "x" },
      sampler: { temperature: 3, mirostat: 1 }, grammar: "gbnf", few_shot_k: 9, self_consistency_n: 2,
      decompose: "yes", max_tokens: 4, context_compression: { bm25_top_k: 0 } });
    for (const needle of ["id", "proposer", "template.footer", "sampler.temperature", "sampler.mirostat", "grammar",
      "few_shot_k", "self_consistency_n", "decompose", "max_tokens", "context_compression"])
      expect(errs.some((e) => e.includes(needle))).toBe(true);
  });

  test("non-objects are rejected", () => expect(validateVariant(null)).toEqual(["variant is not an object"]));
});

describe("variantHash", () => {
  test("ignores labels, so two proposers reaching the same harness collide", () => {
    expect(variantHash(v({ id: "a", proposer: "cloud" }))).toBe(variantHash(v({ id: "b", proposer: "local", parent: "x" })));
  });
  test("is insensitive to key order but sensitive to behavior", () => {
    expect(variantHash(v({ sampler: { temperature: 0.3, top_p: 0.9 } }))).toBe(variantHash(v({ sampler: { top_p: 0.9, temperature: 0.3 } })));
    expect(variantHash(v({ max_tokens: 256 }))).not.toBe(variantHash(v({ max_tokens: 512 })));
  });
});

describe("buildRequestBody", () => {
  test("the default arm sends no sampler or grammar and the case's own cap", () => {
    const b = buildRequestBody(DEFAULT_VARIANT, "m", "SYS", "USER", 900);
    expect(b).toEqual({ model: "m", messages: [{ role: "system", content: "SYS" }, { role: "user", content: "USER" }], max_tokens: 900 });
  });
  test("applies template, sampler, grammar and cap", () => {
    const b: any = buildRequestBody(v({ template: { system_prefix: "P:", user_suffix: "!" }, sampler: { temperature: 0.2 },
      grammar: { json_schema: { type: "object" } }, max_tokens: 128 }), "m", "SYS", "USER", 900);
    expect(b.messages[0].content).toBe("P:SYS");
    expect(b.messages[1].content).toBe("USER!");
    expect(b.temperature).toBe(0.2);
    expect(b.max_tokens).toBe(128);
    expect(b.response_format.json_schema.schema).toEqual({ type: "object" });
  });
});

describe("acceptVariant (ISC-13)", () => {
  test("accepts a gain larger than both arms' rep spread", () => {
    expect(acceptVariant([0.6, 0.62, 0.64], [0.8, 0.82, 0.81]).accept).toBe(true);
  });
  test("rejects a gain inside the noise", () => {
    const r = acceptVariant([0.5, 0.7, 0.6], [0.7, 0.68, 0.72]);
    expect(r.accept).toBe(false);
    expect(r.reason).toContain("within rep spread");
  });
  test("a noisy candidate can't win on its lucky rep", () => {
    expect(acceptVariant([0.6, 0.6, 0.6], [0.4, 1.0, 0.9]).accept).toBe(false);
  });
  test("rejects losses and ties", () => {
    expect(acceptVariant([0.6, 0.6, 0.6], [0.6, 0.6, 0.6]).accept).toBe(false);
    expect(acceptVariant([0.6, 0.6, 0.6], [0.5, 0.5, 0.5]).accept).toBe(false);
  });
  test("needs 3 reps in each arm", () => {
    expect(acceptVariant([0.1, 0.1], [0.9, 0.9, 0.9]).reason).toContain("fewer than 3 reps");
  });
});

describe("waitForIdleSlots (ISC-17)", () => {
  const noSleep = async () => {};
  test("returns at once when the server is idle", async () => {
    const r = await waitForIdleSlots(async () => [{ is_processing: false }], { pollMs: 1000, maxWaitMs: 5000, sleep: noSleep });
    expect(r).toEqual({ waitedMs: 0, polls: 1 });
  });
  test("backs off while a slot is busy, then proceeds", async () => {
    const states = [true, true, false];
    const r = await waitForIdleSlots(async () => [{ is_processing: states.shift()! }], { pollMs: 1000, maxWaitMs: 5000, sleep: noSleep });
    expect(r).toEqual({ waitedMs: 2000, polls: 3 });
  });
  test("any busy slot counts as busy", async () => {
    const states = [[true, false], [false, false]];
    const r = await waitForIdleSlots(async () => states.shift()!.map((b) => ({ is_processing: b })), { pollMs: 500, maxWaitMs: 5000, sleep: noSleep });
    expect(r.polls).toBe(2);
  });
  test("gives up after maxWaitMs instead of queuing forever", async () => {
    await expect(waitForIdleSlots(async () => [{ is_processing: true }], { pollMs: 1000, maxWaitMs: 3000, sleep: noSleep }))
      .rejects.toThrow("still busy after 3000");
  });
});

describe("judge independence (ISC-19)", () => {
  test("KAT is Qwen lineage, so the 80B can't judge it and vice versa", () => {
    expect(modelFamily("kat_coder_v25_apex")).toBe("qwen");
    expect(judgeIsIndependent("qwen3_next_80b_a3b", "kat_coder_v25_apex")).toBe(false);
  });
  test("Haiku judging either local tier is independent", () => {
    expect(judgeIsIndependent("claude-haiku-4-5", "kat_coder_v25_apex")).toBe(true);
    expect(judgeIsIndependent("haiku45", "qwen3_next_80b_a3b")).toBe(true);
  });
  test("a model never judges itself, and unknown lineage is not independent", () => {
    expect(judgeIsIndependent("claude-haiku-4-5", "claude-sonnet-5-5")).toBe(false);
    expect(judgeIsIndependent("claude-haiku-4-5", "mystery-model")).toBe(false);
  });
});

describe("gbnf grammar", () => {
  test("is valid with a root rule and goes on the body as `grammar`", () => {
    const g = v({ grammar: { gbnf: 'root ::= "---\\n" [^\\x00]*' } });
    expect(validateVariant(g)).toEqual([]);
    const b: any = buildRequestBody(g, "m", "S", "U", 100);
    expect(b.grammar).toBe('root ::= "---\\n" [^\\x00]*');
    expect(b.response_format).toBeUndefined();
  });
  test("without a root rule is rejected", () => {
    expect(validateVariant(v({ grammar: { gbnf: 'start ::= "x"' } })).some((e) => e.includes("grammar"))).toBe(true);
  });
});

describe("thinking", () => {
  test("off sends enable_thinking=false; the default sends nothing", () => {
    expect((buildRequestBody(v({ thinking: "off" }), "m", "S", "U", 100) as any).chat_template_kwargs).toEqual({ enable_thinking: false });
    expect((buildRequestBody(DEFAULT_VARIANT, "m", "S", "U", 100) as any).chat_template_kwargs).toBeUndefined();
  });
  test("other values are rejected", () => {
    expect(validateVariant({ ...DEFAULT_VARIANT, thinking: "low" }).some((e) => e.includes("thinking"))).toBe(true);
  });
});

describe("acceptVariantPaired (ISC-13, current rule)", () => {
  const arm = (rates: number[][]) => Object.fromEntries(rates.map((r, i) => [`c${i}`, r]));
  test("a consistent per-case gain is accepted", () => {
    const ctrl = arm(Array.from({ length: 15 }, () => [0, 0, 1]));
    const cand = arm(Array.from({ length: 15 }, () => [1, 1, 1]));
    const r = acceptVariantPaired(ctrl, cand);
    expect(r.accept).toBe(true);
    expect(r.lower).toBeGreaterThan(0);
    expect(r.better).toBe(15);
  });
  test("a mixed result straddling zero is rejected", () => {
    const ctrl = arm([[1, 1, 1], [0, 0, 0], [1, 1, 1], [0, 0, 0], [1, 0, 1], [0, 1, 0]]);
    const cand = arm([[0, 0, 0], [1, 1, 1], [1, 1, 1], [0, 0, 0], [0, 1, 0], [1, 0, 1]]);
    expect(acceptVariantPaired(ctrl, cand).accept).toBe(false);
  });
  test("is deterministic for the same data", () => {
    const ctrl = arm(Array.from({ length: 10 }, (_, i) => [i % 2, 0, 1]));
    const cand = arm(Array.from({ length: 10 }, (_, i) => [1, i % 3 ? 1 : 0, 1]));
    expect(acceptVariantPaired(ctrl, cand)).toEqual(acceptVariantPaired(ctrl, cand));
  });
  test("needs at least minCases paired cases", () => {
    expect(acceptVariantPaired(arm([[0], [0]]), arm([[1], [1]])).reason).toContain("only 2 paired cases");
  });
  test("a higher threshold (ISC-14's +0.10) is stricter", () => {
    const ctrl = arm(Array.from({ length: 15 }, (_, i) => [i < 9 ? 1 : 0]));
    const cand = arm(Array.from({ length: 15 }, (_, i) => [i < 11 ? 1 : 0]));
    const at0 = acceptVariantPaired(ctrl, cand, { ...PAIRED_RULE, threshold: 0 });
    const at10 = acceptVariantPaired(ctrl, cand, { ...PAIRED_RULE, threshold: 0.1 });
    expect(at10.accept && !at0.accept).toBe(false);
  });
  test("reproduces climb 02's paired verdict: real gain, lower bound above 0", () => {
    const d = [0.67, -0.33, 0.67, -0.33, 0.67, 1, 0.33, 0, 0, 0.67, -0.33, 0.67, 0, 0, 1];
    // control 0 for every case, candidate = control + diff, expressed as pass rates in [0,1]
    const ctrl = arm(d.map((x) => (x < 0 ? [1, 1, 0] : [0, 0, 0])));
    const cand = arm(d.map((x) => (x < 0 ? [1, 0, 0] : x === 1 ? [1, 1, 1] : x > 0.5 ? [1, 1, 0] : x > 0 ? [1, 0, 0] : [0, 0, 0])));
    expect(acceptVariantPaired(ctrl, cand).accept).toBe(true);
  });
});

describe("acceptVariantPaired float ties", () => {
  test("a lower bound equal to the threshold is not above it, despite float noise", () => {
    // 0.4 - 0.3 === 0.10000000000000003 in float; every case differs by exactly 0.1.
    const control: Record<string, number[]> = {}, candidate: Record<string, number[]> = {};
    for (let i = 0; i < 10; i++) { control[`c${i}`] = [0.3]; candidate[`c${i}`] = [0.4]; }
    expect(0.4 - 0.3 > 0.1).toBe(true); // the trap
    expect(acceptVariantPaired(control, candidate, { ...PAIRED_RULE, threshold: 0.1 }).accept).toBe(false);
    expect(acceptVariantPaired(control, candidate, { ...PAIRED_RULE, threshold: 0.09 }).accept).toBe(true);
  });
});
