#!/usr/bin/env bun
/**
 * AgyJail — run one Antigravity (agy) print-mode turn inside a bubblewrap jail, text in / text out.
 *
 * Containment (by construction, not by asking the model nicely):
 *   - No view of the real home: /home is tmpfs; ~/.claude, ~/code, keys, and the real agy state do not exist inside.
 *   - agy gets its OWN state dir (~/.local/share/agy-jail/state), seeded once with the OAuth token.
 *     Its brain/scratch/history never touch the real ~/.gemini/antigravity-cli.
 *   - Config and settings are rewritten every call: empty permission allow-list, no trusted workspaces, no MCP servers.
 *   - Environment cleared (--clearenv): no API keys leak in via env.
 *   - Fresh empty /work per call, deleted afterwards. The jail's scratch/ is wiped after each call.
 *   - Network is shared (agy must reach Google). In uid mode (after `sudo bash PAI/TOOLS/agy-egress-lockdown.sh`), the jail runs as
 *     uid `agy` and nftables rejects its traffic to loopback (except DNS), RFC1918, Tailscale, and all IPv6.
 *     Before that script runs, LAN/Tailscale/localhost egress is open.
 *   - Tool-attempt transcripts are archived to <jail root>/violations/ (outlives agy's own brain rotation).
 *
 * Tripwire: the transcript is parsed after every call. Any tool call (planner tool_calls or a GENERIC step)
 * marks the call a violation. Headless agy auto-denies tools but still exits 0, so exit code alone lies.
 *
 * Usage:
 *   bun AgyJail.ts --prompt "..." [--system-file f] [--model gemini-3.8-flash-medium (default: GP's agy settings model)] [--timeout 300] [--json]
 *   echo "prompt" | bun AgyJail.ts [--json]
 * Exit: 0 clean · 4 tool-use violation · 2 harness error (no answer, timeout, missing transcript)
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, copyFileSync, chmodSync, statSync, utimesSync, renameSync } from "fs";
import { join, dirname, basename } from "path";

const HOME = process.env.HOME!;
// uid mode: once PAI/TOOLS/agy-egress-lockdown.sh has run as root, the jail
// runs as system user `agy` via `sudo -n -u agy <WRAPPER>`, and nftables rejects that uid's
// traffic to loopback/LAN/Tailscale. The wrapper's presence switches the mode on; after that
// there is no fallback: if sudo fails, bwrap never runs and the call fails closed.
const UID_WRAPPER = "/usr/local/lib/agy-jail/run";
const UID_MODE = existsSync(UID_WRAPPER);
const AGY_SRC = process.env.AGY_BIN ?? join(HOME, ".local/bin/agy");
// uid `agy` cannot traverse $HOME, so it runs a copy that syncAgyBinary() keeps current.
const AGY_BIN = UID_MODE ? "/opt/agy/agy" : AGY_SRC;
const REAL_STATE = join(HOME, ".gemini/antigravity-cli");
// uid mode: /var/lib/agy-jail is 2770 (owner = you, group agyjail = {agy}); that gate is what
// makes the looser file modes below safe.
const JAIL_ROOT = UID_MODE ? "/var/lib/agy-jail" : join(process.env.XDG_DATA_HOME ?? join(HOME, ".local/share"), "agy-jail");
const FILE_MODE = UID_MODE ? 0o644 : 0o600;
// Tool-attempt transcripts are copied here: agy rotates its own brain at ~500 sessions (about
// a day at current volume), and this dir is never mounted inside the jail.
const VIOLATIONS_DIR = join(JAIL_ROOT, "violations");
const JAIL_STATE = join(JAIL_ROOT, "state");
const JAIL_CONFIG = join(JAIL_ROOT, "config");
const JAIL_WORK = join(JAIL_ROOT, "work");
const TRUNCATION_MARK = /<truncated \d+ bytes>/;
const MAX_PROMPT_BYTES = 120_000; // Linux MAX_ARG_STRLEN is 128 KiB per argv element

export interface TranscriptStep { step_index: number; type: string; status: string; source?: string; error?: string; content?: unknown; tool_calls?: { name: string }[] }

/** agy's own error steps (e.g. 429 quota) are harness errors, not model tool use. Model-sourced unknowns still fail closed. */
const isSystemError = (s: TranscriptStep) => s.type === "ERROR_MESSAGE" && s.source === "SYSTEM";

export function systemErrors(steps: TranscriptStep[]): string[] {
  return steps.filter(isSystemError).map((s) => s.error ?? "agy system error");
}
export interface JailResult {
  ok: boolean; violation: boolean; text: string; model: string; session: string | null;
  tool_calls: string[]; steps: number; in_tokens: number; out_tokens: number; duration_ms: number; error?: string;
}

/** Tripwire: every tool the model attempted, whether or not it was denied or contained. */
export function toolAttempts(steps: TranscriptStep[]): string[] {
  const names: string[] = [];
  for (const s of steps) {
    for (const t of s.tool_calls ?? []) names.push(t.name);
    if (s.type !== "USER_INPUT" && s.type !== "PLANNER_RESPONSE" && !isSystemError(s) && !(s.tool_calls?.length)) names.push(`step:${s.type}:${s.status}`);
  }
  return names;
}

/** Final answer = last planner response with string content and no tool calls. */
export function finalText(steps: TranscriptStep[]): string {
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s.type === "PLANNER_RESPONSE" && typeof s.content === "string" && !(s.tool_calls?.length)) return s.content;
  }
  return "";
}

export function parseTranscript(raw: string): TranscriptStep[] {
  return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/**
 * Write a jail config file. In uid mode agy rewrites some of these itself with its own modes
 * (settings.json comes back 0600, owned by agy), so unlink first: the containing dir is ours,
 * and unlinking needs write on the dir, not on the file.
 */
function writeJailFile(path: string, data: string) {
  if (UID_MODE) rmSync(path, { force: true });
  writeFileSync(path, data, { mode: FILE_MODE });
}

/**
 * Delete a path the jailed process may have filled. In uid mode agy creates 2755 dirs that we
 * cannot empty, so the delete runs as agy through the same sudo wrapper, in a minimal bwrap that
 * sees only the target's parent dir.
 */
function removeJailPath(path: string) {
  if (!UID_MODE) { rmSync(path, { recursive: true, force: true }); return; }
  if (!existsSync(path)) return;
  const r = Bun.spawnSync([
    "sudo", "-n", "-u", "agy", UID_WRAPPER,
    "--ro-bind", "/usr", "/usr", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64", "--symlink", "usr/bin", "/bin",
    "--bind", dirname(path), "/t", "--unshare-all", "--die-with-parent",
    "rm", "-rf", `/t/${basename(path)}`,
  ], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) console.error(`[AgyJail] agy-side rm of ${path} exited ${r.exitCode}: ${r.stderr.toString().trim()}`);
  // Anything left is ours; this throws EACCES if not, rather than leaving jail debris silently.
  rmSync(path, { recursive: true, force: true });
}

/** uid mode: re-copy the agy binary after `agy update` replaces the one in $HOME. */
function syncAgyBinary() {
  if (!UID_MODE) return;
  const src = statSync(AGY_SRC);
  const dst = existsSync(AGY_BIN) ? statSync(AGY_BIN) : null;
  if (dst && dst.size === src.size && dst.mtimeMs === src.mtimeMs) return;
  const tmp = `${AGY_BIN}.tmp-${process.pid}`;
  copyFileSync(AGY_SRC, tmp); chmodSync(tmp, 0o755); utimesSync(tmp, src.atime, src.mtime);
  renameSync(tmp, AGY_BIN);
}

function prepareJail() {
  syncAgyBinary();
  for (const d of [JAIL_STATE, JAIL_CONFIG, join(JAIL_CONFIG, "projects"), JAIL_WORK, VIOLATIONS_DIR]) mkdirSync(d, { recursive: true, mode: UID_MODE ? 0o777 : 0o700 });
  const token = join(JAIL_STATE, "antigravity-oauth-token");
  if (!existsSync(token)) {
    const real = join(REAL_STATE, "antigravity-oauth-token");
    if (!existsSync(real)) throw new Error(`no agy login found at ${real} — run 'agy' once to sign in`);
    copyFileSync(real, token); chmodSync(token, FILE_MODE);
  }
  // Rewritten every call so anything agy did to its own permissions last time is undone.
  const locked = { permissions: { allow: [] }, trustedWorkspaces: [] };
  // Carry only the model choice over from GP's real agy settings; everything else stays locked.
  let model: string | undefined;
  try { model = JSON.parse(readFileSync(join(REAL_STATE, "settings.json"), "utf8")).model; } catch {}
  writeJailFile(join(JAIL_STATE, "settings.json"), JSON.stringify({ ...locked, ...(model ? { model } : {}) }));
  writeJailFile(join(JAIL_CONFIG, "config.json"), JSON.stringify(locked));
  writeJailFile(join(JAIL_CONFIG, "mcp_config.json"), "{}");
  removeJailPath(join(JAIL_STATE, "scratch"));
}

function bwrapArgs(work: string): string[] {
  const ro = (p: string) => (existsSync(p) ? ["--ro-bind", p, p] : []);
  return [
    "--ro-bind", "/usr", "/usr",
    "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64", "--symlink", "usr/bin", "/bin", "--symlink", "usr/sbin", "/sbin",
    ...["/etc/resolv.conf", "/etc/ssl", "/etc/ca-certificates", "/etc/hosts", "/etc/nsswitch.conf", "/etc/passwd"].flatMap(ro),
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--tmpfs", "/home",
    "--ro-bind", AGY_BIN, AGY_BIN,
    "--bind", JAIL_STATE, REAL_STATE,
    "--bind", JAIL_CONFIG, join(HOME, ".gemini/config"),
    "--bind", work, "/work", "--chdir", "/work",
    "--clearenv", "--setenv", "HOME", HOME, "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "LANG", "C.UTF-8", "--setenv", "TERM", "dumb",
    "--unshare-all", "--share-net", "--die-with-parent", "--new-session",
  ];
}

let inflight = 0;

export async function runJailed(prompt: string, opts: { model?: string; timeoutSec?: number } = {}): Promise<JailResult> {
  const model = opts.model ?? "agy-settings-default"; // no --model → agy uses the model in GP's agy settings
  const timeoutSec = opts.timeoutSec ?? 300;
  const t0 = Date.now();
  const fail = (error: string, extra: Partial<JailResult> = {}): JailResult =>
    ({ ok: false, violation: false, text: "", model, session: null, tool_calls: [], steps: 0, in_tokens: 0, out_tokens: 0, duration_ms: Date.now() - t0, error, ...extra });

  if (Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) return fail(`prompt exceeds ${MAX_PROMPT_BYTES} bytes`);
  if (inflight === 0) prepareJail();
  inflight++;
  const work = mkdtempSync(join(JAIL_WORK, "w-"));
  if (UID_MODE) chmodSync(work, 0o777); // uid agy must write /work; the 2770 jail root gates access
  try {
    const proc = Bun.spawn([
      ...(UID_MODE ? ["sudo", "-n", "-u", "agy", UID_WRAPPER] : ["bwrap"]), ...bwrapArgs(work),
      "timeout", "-k", "10", String(timeoutSec + 15), AGY_BIN, "-p", prompt,
      ...(opts.model ? ["--model", opts.model] : []), "--disable-slash-commands", "--output-format", "json", "--print-timeout", `${timeoutSec}s`,
    ], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const exit = await proc.exited;

    // conversation_id ties this call to its own transcript, so concurrent calls can't cross wires.
    let out: any;
    try { out = JSON.parse(stdout.trim().split("\n").pop() ?? ""); }
    catch { return fail(exit === 124 ? "timeout" : `unparseable agy output; exit=${exit} stdout=${stdout.slice(0, 300)}`); }
    const session: string | null = out.conversation_id ?? null;
    const in_tokens = out.usage?.input_tokens ?? 0;
    const out_tokens = (out.usage?.output_tokens ?? 0) + (out.usage?.thinking_tokens ?? 0);
    if (!session) return fail(`no conversation_id; status=${out.status}`, { in_tokens, out_tokens });
    const tpath = join(JAIL_STATE, "brain", session, ".system_generated/logs/transcript.jsonl");
    if (!existsSync(tpath)) return fail("transcript missing", { session, in_tokens, out_tokens });
    const steps = parseTranscript(readFileSync(tpath, "utf8"));
    const tool_calls = toolAttempts(steps);
    // The transcript elides the middle of long responses ("<truncated N bytes>"), so the answer comes from
    // agy's JSON `response`; the transcript is only the tripwire's evidence.
    const text = typeof out.response === "string" && out.response.trim() ? out.response.trim() : finalText(steps);
    if (TRUNCATION_MARK.test(text)) return fail("agy answer contains a transcript truncation marker", { session, in_tokens, out_tokens });
    const violation = tool_calls.length > 0 || readdirSync(work).length > 0;
    if (violation) {
      try { copyFileSync(tpath, join(VIOLATIONS_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}_${session}.jsonl`)); }
      catch (e) { console.error(`[AgyJail] could not archive violation transcript ${session}: ${e}`); }
    }
    const res: JailResult = { ok: !violation && text.length > 0, violation, text, model, session, tool_calls, steps: steps.length, in_tokens, out_tokens, duration_ms: Date.now() - t0 };
    const sysErr = systemErrors(steps).pop();
    if (!text && !violation) res.error = sysErr ? `agy: ${sysErr}` : `no answer; status=${out.status} exit=${exit}`;
    return res;
  } finally {
    removeJailPath(work);
    if (--inflight === 0) removeJailPath(join(JAIL_STATE, "scratch"));
  }
}

// ── Research mode ─────────────────────────────────────────────────────────────
// agy's search_web runs even with an empty permission allow-list, and each result lands in the
// brain as steps/<N>/output.txt: a grounded summary written by agy's search backend, not by the
// model's narration. agy's final prose can fabricate (memory: agy-fabrication-scope-creep), so
// research callers get the search outputs as the evidence, and the prose only as a secondary summary.

const RESEARCH_TOOLS = new Set(["search_web", "read_url_content"]);
const RESEARCH_PREAMBLE = [
  "You are a web researcher. Use ONLY the search_web tool (and read_url_content to open a result).",
  "Never run commands, read or write files, or use any other tool. There is nothing local to inspect.",
  "Finish with a plain-text answer: each finding on its own line with the source URL.",
].join("\n");

/** `path` is the brain's output.txt, or null when that file was missing and `output` fell back to the transcript. */
export interface SearchEvidence { step: number; tool: string; query: string | null; output: string; path: string | null }
export interface ResearchResult extends JailResult { evidence: SearchEvidence[]; contained_violations: string[] }

/** Pair each allowed tool call with the executed step that follows it; read that step's output.txt. */
export function researchEvidence(steps: TranscriptStep[], stepsDir: string): { evidence: SearchEvidence[]; disallowed: string[] } {
  const evidence: SearchEvidence[] = [];
  const disallowed: string[] = [];
  for (let i = 0; i < steps.length; i++) {
    for (const t of steps[i].tool_calls ?? []) {
      if (!RESEARCH_TOOLS.has(t.name)) { disallowed.push(t.name); continue; }
      const result = steps.slice(i + 1).find((s) => s.type === "GENERIC");
      if (!result || result.status !== "DONE") continue;
      const file = join(stepsDir, String(result.step_index), "output.txt");
      const onDisk = existsSync(file);
      const output = onDisk ? readFileSync(file, "utf8") : String(result.content ?? "");
      const query = output.match(/The search for "(.*?)" returned/s)?.[1] ?? null;
      evidence.push({ step: result.step_index, tool: t.name, query, output: output.trim(), path: onDisk ? file : null });
    }
  }
  return { evidence, disallowed };
}

export async function runJailedResearch(question: string, opts: { model?: string; timeoutSec?: number } = {}): Promise<ResearchResult> {
  const r = await runJailed(`${RESEARCH_PREAMBLE}\n\n---\n\n${question}`, opts);
  if (!r.session) return { ...r, evidence: [], contained_violations: [] };
  const brain = join(JAIL_STATE, "brain", r.session, ".system_generated");
  const steps = parseTranscript(readFileSync(join(brain, "logs/transcript.jsonl"), "utf8"));
  const { evidence, disallowed } = researchEvidence(steps, join(brain, "steps"));
  // Searching is the job here, so search calls aren't violations. Anything else was attempted,
  // denied or contained by the jail, and gets surfaced rather than silently dropped.
  return { ...r, ok: evidence.length > 0, violation: disallowed.length > 0, evidence, contained_violations: disallowed };
}

if (import.meta.main && process.argv.includes("--research")) {
  const argv = process.argv.slice(2);
  const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const q = flag("--prompt") ?? (await Bun.stdin.text());
  if (!q.trim()) { console.error("usage: AgyJail.ts --research --prompt '...' [--timeout s] [--json]"); process.exit(2); }
  const r = await runJailedResearch(q, { model: flag("--model"), timeoutSec: flag("--timeout") ? Number(flag("--timeout")) : undefined });
  if (argv.includes("--json")) console.log(JSON.stringify(r));
  else {
    console.log(`# Gemini (agy, jailed) research — ${r.evidence.length} search results, session ${r.session}\n`);
    for (const e of r.evidence) {
      const where = e.path ? `Evidence: \`${e.path}\`` : "Evidence: transcript only (output.txt missing)";
      console.log(`## [step ${e.step}] ${e.tool}: ${e.query ?? "(query not parsed)"}\n\n${where}\n\n${e.output}\n`);
    }
    if (r.text) console.log(`## agy summary (secondary — verify against the evidence above)\n\n${r.text}\n`);
    if (r.contained_violations.length) console.error(`AGYJAIL CONTAINED: non-search tool attempts [${r.contained_violations.join(", ")}] session=${r.session}`);
    if (r.error) console.error(`AGYJAIL ERROR: ${r.error}`);
  }
  process.exit(r.ok ? 0 : 2);
}

if (import.meta.main && !process.argv.includes("--research")) {
  const argv = process.argv.slice(2);
  const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  let prompt = flag("--prompt") ?? "";
  if (!prompt) prompt = await Bun.stdin.text();
  const sys = flag("--system-file");
  if (sys) prompt = `${readFileSync(sys, "utf8").trim()}\n\n---\n\n${prompt}`;
  if (!prompt.trim()) { console.error("usage: AgyJail.ts --prompt '...' | stdin  [--system-file f] [--model m] [--timeout s] [--json]"); process.exit(2); }
  const r = await runJailed(prompt, { model: flag("--model"), timeoutSec: flag("--timeout") ? Number(flag("--timeout")) : undefined });
  if (argv.includes("--json")) console.log(JSON.stringify(r));
  else {
    if (r.text) console.log(r.text);
    if (r.violation) console.error(`AGYJAIL VIOLATION: tool attempts [${r.tool_calls.join(", ")}] session=${r.session}`);
    if (r.error) console.error(`AGYJAIL ERROR: ${r.error}`);
  }
  process.exit(r.violation ? 4 : r.ok ? 0 : 2);
}
