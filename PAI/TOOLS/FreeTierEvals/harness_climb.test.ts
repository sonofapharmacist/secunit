import { describe, test, expect } from "bun:test";
import { makeSplits } from "./harness_climb";

const ucs = [{ name: "a", cases: Array.from({ length: 10 }, (_, i) => ({ id: String(i + 1).padStart(2, "0") })) },
  { name: "b", cases: Array.from({ length: 7 }, (_, i) => ({ id: `c${i}` })) }];

describe("makeSplits (ISC-10)", () => {
  test("halves each use case into disjoint train/held-out sets covering every case", () => {
    const s = makeSplits(ucs);
    expect(s.a.train).toHaveLength(5);
    expect(s.a.heldout).toHaveLength(5);
    expect(s.b.train).toHaveLength(4);
    expect(s.a.train.filter((id) => s.a.heldout.includes(id))).toEqual([]);
    expect([...s.a.train, ...s.a.heldout].sort()).toEqual(ucs[0].cases.map((c) => c.id));
  });
  test("is deterministic and independent of input order", () => {
    const rev = ucs.map((u) => ({ ...u, cases: [...u.cases].reverse() }));
    expect(makeSplits(rev)).toEqual(makeSplits(ucs));
  });
});

describe("makeSplits is append-only", () => {
  test("existing cases keep their side; only new cases are split", () => {
    const before = makeSplits(ucs);
    const grown = [{ name: "a", cases: Array.from({ length: 30 }, (_, i) => ({ id: String(i + 1).padStart(2, "0") })) }];
    const after = makeSplits(grown, before);
    for (const id of before.a.train) expect(after.a.train).toContain(id);
    for (const id of before.a.heldout) expect(after.a.heldout).toContain(id);
    expect(after.a.train).toHaveLength(15);
    expect(after.a.heldout).toHaveLength(15);
  });
});

describe("confirmation sets", () => {
  test("a -confirm use case is all held-out, even when new cases are added", () => {
    const c = [{ name: "x-confirm", cases: Array.from({ length: 20 }, (_, i) => ({ id: String(i) })) }];
    const s = makeSplits(c);
    expect(s["x-confirm"].train).toEqual([]);
    expect(s["x-confirm"].heldout).toHaveLength(20);
    const grown = makeSplits([{ name: "x-confirm", cases: Array.from({ length: 25 }, (_, i) => ({ id: String(i) })) }], s);
    expect(grown["x-confirm"].train).toEqual([]);
  });
});
