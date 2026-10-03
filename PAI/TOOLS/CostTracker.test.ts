import { describe, expect, test } from "bun:test";
import { keysToPost } from "./CostTracker";

const H = 3600 * 1000;

describe("keysToPost", () => {
  test("first alert posts every key", () => {
    expect(keysToPost(["new-call-sites", "bypass-call-sites"], null, 0)).toEqual(["new-call-sites", "bypass-call-sites"]);
  });

  test("the same condition an hour later is not re-sent", () => {
    const last = { ts: 0, keys: ["new-call-sites", "bypass-call-sites"] as const };
    expect(keysToPost(["new-call-sites", "bypass-call-sites"], { ...last, keys: [...last.keys] }, 1 * H)).toEqual([]);
  });

  test("a new key inside 24h posts only the new key", () => {
    expect(keysToPost(["bypass-call-sites", "api-spend"], { ts: 0, keys: ["bypass-call-sites"] }, 2 * H)).toEqual(["api-spend"]);
  });

  test("after 24h the standing condition posts again", () => {
    expect(keysToPost(["bypass-call-sites"], { ts: 0, keys: ["bypass-call-sites"] }, 24 * H)).toEqual(["bypass-call-sites"]);
  });
});
