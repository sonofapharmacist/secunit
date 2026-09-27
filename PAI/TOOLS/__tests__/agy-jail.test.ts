import { describe, expect, test } from "bun:test";
import { finalText, parseTranscript, researchEvidence, systemErrors, toolAttempts } from "../AgyJail";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Shapes captured from real agy 2026-09-23 transcripts (content trimmed).
const clean = [
  `{"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE","content":"<USER_REQUEST>\\nReply with exactly: PONG\\n</USER_REQUEST>"}`,
  `{"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","content":"PONG"}`,
].join("\n");

const deniedTool = [
  `{"step_index":0,"type":"USER_INPUT","status":"DONE","content":"run ls"}`,
  `{"step_index":1,"type":"PLANNER_RESPONSE","status":"DONE","tool_calls":[{"name":"run_command","args":{"CommandLine":"\\"ls\\""}}]}`,
  `{"step_index":2,"type":"GENERIC","status":"ERROR","content":"permission check failed ... user denied"}`,
].join("\n");

const executedTools = [
  `{"step_index":0,"type":"USER_INPUT","status":"DONE","content":"x"}`,
  `{"step_index":1,"type":"PLANNER_RESPONSE","status":"DONE","tool_calls":[{"name":"run_command","args":{}}]}`,
  `{"step_index":2,"type":"GENERIC","status":"DONE","content":"The command exited with code 1."}`,
  `{"step_index":3,"type":"PLANNER_RESPONSE","status":"DONE","tool_calls":[{"name":"write_to_file","args":{}}]}`,
  `{"step_index":4,"type":"GENERIC","status":"DONE","content":"Created file"}`,
  `{"step_index":5,"type":"PLANNER_RESPONSE","status":"DONE","content":"The command output was: ..."}`,
].join("\n");

describe("AgyJail tripwire", () => {
  test("clean text-only turn has no tool attempts and yields the answer", () => {
    const s = parseTranscript(clean);
    expect(toolAttempts(s)).toEqual([]);
    expect(finalText(s)).toBe("PONG");
  });

  test("denied tool is still a violation (headless agy exits 0 on denial)", () => {
    const s = parseTranscript(deniedTool);
    expect(toolAttempts(s)).toEqual(["run_command", "step:GENERIC:ERROR"]);
    expect(finalText(s)).toBe("");
  });

  test("executed tools are all reported even when a final answer follows", () => {
    const s = parseTranscript(executedTools);
    expect(toolAttempts(s)).toEqual(["run_command", "step:GENERIC:DONE", "write_to_file", "step:GENERIC:DONE"]);
    expect(finalText(s)).toBe("The command output was: ...");
  });

  test("unknown step types count as attempts (fail closed on new agy step kinds)", () => {
    const s = parseTranscript(`{"step_index":0,"type":"BROWSER_ACTION","status":"DONE"}`);
    expect(toolAttempts(s)).toEqual(["step:BROWSER_ACTION:DONE"]);
  });

  test("agy SYSTEM error steps (429 quota) are harness errors, not tool attempts", () => {
    const s = parseTranscript([
      `{"step_index":0,"type":"USER_INPUT","status":"DONE","content":"x"}`,
      `{"step_index":1,"source":"SYSTEM","type":"ERROR_MESSAGE","status":"DONE","error":"API error (attempt 1): RESOURCE_EXHAUSTED (code 429): Individual quota reached."}`,
    ].join("\n"));
    expect(toolAttempts(s)).toEqual([]);
    expect(systemErrors(s)[0]).toContain("429");
  });

  test("an ERROR_MESSAGE claiming MODEL source still fails closed", () => {
    const s = parseTranscript(`{"step_index":0,"source":"MODEL","type":"ERROR_MESSAGE","status":"DONE"}`);
    expect(toolAttempts(s)).toEqual(["step:ERROR_MESSAGE:DONE"]);
  });
});

describe("AgyJail research evidence", () => {
  // Shape taken from a real jailed session (2026-09-26): planner search_web → GENERIC DONE result, then run_command.
  const steps = [
    { step_index: 0, type: "USER_INPUT", status: "DONE" },
    { step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", tool_calls: [{ name: "search_web" }] },
    { step_index: 2, type: "GENERIC", status: "DONE", content: "transcript copy (may be truncated)" },
    { step_index: 3, type: "PLANNER_RESPONSE", status: "DONE", tool_calls: [{ name: "run_command" }] },
  ];

  test("search output comes from steps/N/output.txt, query parsed, non-search tools reported", () => {
    const dir = mkdtempSync(join(tmpdir(), "agy-ev-"));
    mkdirSync(join(dir, "2"));
    writeFileSync(join(dir, "2", "output.txt"), 'The search for "solar pro 4 price" returned the following summary:\n$0.09/$0.36 [openrouter.ai]');
    const { evidence, disallowed } = researchEvidence(steps, dir);
    expect(evidence).toHaveLength(1);
    expect(evidence[0].query).toBe("solar pro 4 price");
    expect(evidence[0].output).toContain("$0.09/$0.36");
    expect(evidence[0].path).toBe(join(dir, "2", "output.txt"));
    expect(disallowed).toEqual(["run_command"]);
  });

  test("falls back to transcript content when output.txt is missing", () => {
    const { evidence } = researchEvidence(steps, mkdtempSync(join(tmpdir(), "agy-ev-")));
    expect(evidence[0].output).toBe("transcript copy (may be truncated)");
    expect(evidence[0].path).toBeNull();
  });
});

