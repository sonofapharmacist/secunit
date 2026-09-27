import { describe, expect, test } from "bun:test";
import { algorithmAtLeast, unresolvedBranches } from "../lib/algorithm-v8";

describe("algorithmAtLeast (gate staging: the branch gate turns on at 8.1)", () => {
  const at = (v: string, ma: number, mi: number) => {
    const prev = process.env.PAI_ALGORITHM_VERSION;
    process.env.PAI_ALGORITHM_VERSION = v;
    try { return algorithmAtLeast(ma, mi); } finally {
      if (prev === undefined) delete process.env.PAI_ALGORITHM_VERSION; else process.env.PAI_ALGORITHM_VERSION = prev;
    }
  };
  test("8.0.0 is below 8.1", () => expect(at("8.0.0", 8, 1)).toBe(false));
  test("8.1.0 and v8.1.2 meet 8.1", () => { expect(at("8.1.0", 8, 1)).toBe(true); expect(at("v8.1.2", 8, 1)).toBe(true); });
  test("9.0.0 meets 8.1; 7.9.0 doesn't", () => { expect(at("9.0.0", 8, 1)).toBe(true); expect(at("7.9.0", 8, 1)).toBe(false); });
  test("garbage version never activates", () => expect(at("latest", 8, 1)).toBe(false));
});

const isa = (branches: string | null) => [
  "---", "phase: execute", "---", "", "## Goal", "", "Ship it.", "", "## Criteria", "",
  "- [x] ISC-1: thing works",
  ...(branches === null ? [] : ["", "## Branches (spawn as new ISAs; out of this ISA's scope)", "", branches]),
  "", "## Decisions", "", "- 2026-09-26 spawned: this word in Decisions is not a branch marker",
].join("\n");

describe("unresolvedBranches", () => {
  test("no Branches section → nothing to resolve (existing ISAs unaffected)", () => {
    expect(unresolvedBranches(isa(null))).toEqual([]);
  });

  test("all entries resolved by spawned / filed / dropped", () => {
    const b = [
      "- **B1: KAT as fast tier.** (1) Change: x. **spawned: `20260927-000000_kat-fast-tier`**",
      "- **B2: Binary upgrade.** (1) Change: y.",
      "  filed: PAI/MEMORY/KNOWLEDGE/Projects/pai-infra.md",
      "- **B3: Bench v2.** dropped: superseded by upstream eval",
    ].join("\n");
    expect(unresolvedBranches(isa(b))).toEqual([]);
  });

  test("one unresolved entry is named; resolved siblings are not", () => {
    const b = [
      "- **B1: KAT as fast tier.** spawned: 20260927-000000_kat-fast-tier",
      "- **B2: Upgrade the prod llama.cpp binary.** (1) Change: moves off d2f8305. (4) Evidence: throughput.",
    ].join("\n");
    expect(unresolvedBranches(isa(b))).toEqual(["B2: Upgrade the prod llama.cpp binary"]);
  });

  test("watch items and notes in the section are not branches", () => {
    const b = [
      "This sweep produced evidence for four projects.",
      "- **Watch item, no ISA:** Space Bunny Alpha is unroutable while stealth.",
    ].join("\n");
    expect(unresolvedBranches(isa(b))).toEqual([]);
  });

  test("a marker word with no value doesn't count as resolved", () => {
    expect(unresolvedBranches(isa("- **B4: One score source.** Evidence: spawned: "))).toEqual(["B4: One score source"]);
  });

  test("marker inside a later section doesn't resolve a branch", () => {
    expect(unresolvedBranches(isa("- **B5: Something.** (1) Change: z."))).toEqual(["B5: Something"]);
  });
});
