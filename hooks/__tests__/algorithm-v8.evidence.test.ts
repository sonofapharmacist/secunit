import { describe, expect, test } from "bun:test";
import { unevidencedPassed } from "../lib/algorithm-v8";

const isa = (criteria: string[], verification?: string[]) => [
  "---", "phase: execute", "---", "", "## Goal", "", "Ship it.", "", "## Criteria", "",
  ...criteria,
  ...(verification ? ["", "## Verification", "", ...verification] : []),
].join("\n");

describe("unevidencedPassed — Verification section (unchanged behavior)", () => {
  test("a checked criterion with a quoted claim under ## Verification is evidenced", () => {
    const c = isa(["- [x] ISC-1: the thing works"], ["- ISC-1: `grep foo f.ts` → `2`"]);
    expect(unevidencedPassed(c)).toEqual([]);
  });

  test("a checked criterion with no Verification entry is unevidenced", () => {
    const c = isa(["- [x] ISC-1: the thing works"]);
    expect(unevidencedPassed(c)).toEqual(["ISC-1"]);
  });

  test("prose-only Verification (no quoted claim) does not count", () => {
    const c = isa(["- [x] ISC-1: the thing works"], ["- ISC-1: looks good, verified it"]);
    expect(unevidencedPassed(c)).toEqual(["ISC-1"]);
  });

  test("unchecked criteria are never required to have evidence", () => {
    const c = isa(["- [ ] ISC-1: not done", "- [x] ISC-2: done `exit 0`"], ["- ISC-2: ran, got `exit 0`"]);
    expect(unevidencedPassed(c)).toEqual([]);
  });
});

describe("unevidencedPassed — inline criterion evidence (new)", () => {
  test("a checked criterion whose own line carries a backticked probe self-evidences", () => {
    const c = isa(['- [x] ISC-22: `grep "Kokoro-82M" tool.ts` confirms the model ID is set']);
    expect(unevidencedPassed(c)).toEqual([]);
  });

  test("a checked criterion with a double-quoted output self-evidences", () => {
    const c = isa(['- [x] ISC-14: wrong token → "unauthorized" and the socket closes']);
    expect(unevidencedPassed(c)).toEqual([]);
  });

  test("inline PROSE (no quote/backtick) still requires a Verification entry", () => {
    const c = isa(["- [x] ISC-1: verified in-session that it works"]);
    expect(unevidencedPassed(c)).toEqual(["ISC-1"]);
  });

  test("mixed: inline-evidenced passes, prose one is still flagged", () => {
    const c = isa([
      '- [x] ISC-1: `stat -c %a token` → `600`',
      "- [x] ISC-2: works fine in practice",
    ]);
    expect(unevidencedPassed(c)).toEqual(["ISC-2"]);
  });

  test("the quoted claim must be on the SAME criterion line, not a neighbor", () => {
    const c = isa([
      "- [x] ISC-1: does the thing",
      '- [x] ISC-2: `probe` → `ok`',
    ]);
    // ISC-1 has no quote of its own; ISC-2's quote must not leak to it.
    expect(unevidencedPassed(c)).toEqual(["ISC-1"]);
  });
});
