---
name: hook-wiring-5-orphaned-hooks-2026-07
title: "Wired 5 pre-built but unwired hooks into settings.json"
date: 2026-07-26
status: complete
detected: hook-behavior-change
change: "5 hook events added to settings.json hooks block: ConfigChange, PostToolUseFailure, StopFailure, TaskCreated, PermissionRequest"
---

## Decision

Wired 5 hook files that existed on disk since the initial PAI commit but were never registered in `settings.json`: `ConfigAudit.hook.ts` (ConfigChange), `ToolFailureTracker.hook.ts` (PostToolUseFailure), `StopFailureHandler.hook.ts` (StopFailure), `TaskGovernance.hook.ts` (TaskCreated), `SmartApprover.hook.ts` (PermissionRequest, matcher `Write|Edit|MultiEdit|Bash`).

Found while investigating "what's unverified across the whole PAI harness" (GP's broader definition of "secunit" as the entire `~/.claude` system, not just the release-export pipeline). An Explore agent surfaced the gap; re-confirmed via direct `grep` against a fresh `settings.json` read before acting, since the finding was a session old.

## Alternatives Rejected

Wiring all 5 without review: rejected on the first pass. 4 of the 5 are pure logging/governance (ConfigAudit, ToolFailureTracker, StopFailureHandler, TaskGovernance) with no behavior change beyond writing to JSONL/blocking pathological cases (empty task descriptions, >50 tasks/session). SmartApprover is different — it changes live permission-grant behavior (auto-allows reads and known-safe Bash patterns in trusted paths). Bundling it in without a separate call would have been a silent security-posture change. Split into two approval steps instead: wire the 4 logging hooks first, ask explicitly before adding SmartApprover.

Deleting the orphaned files instead of wiring them: rejected — all 5 read as finished, working code (not stubs), just never plugged into the event pipeline. Git history showed zero edits since the initial commit, consistent with "built, then dropped from the checklist" rather than "deliberately disabled."

## Evidence

Each hook was runtime-smoke-tested with synthetic stdin post-wiring, per the "hook changes need runtime smoke test, not just typecheck" rule:
- `ConfigAudit` → wrote `initial snapshot` entry to `config-changes.jsonl`, exit 0
- `ToolFailureTracker` → wrote failure entry to `tool-failures.jsonl`, exit 0
- `TaskGovernance` → accepted a valid synthetic task, exit 0
- `StopFailureHandler` → wrote entry to `MEMORY/SECURITY/2026/07/stop-failures-2026-07-26.jsonl`, exit 0
- `SmartApprover` → 3 scenarios: trusted-path Read → `{"decision":{"behavior":"allow"}}`; untrusted-path Write → silent (no output, user decides); trusted-path read-only Bash (`git status ~/.claude`) → auto-allow. All matched documented behavior.

`settings.json` validated as well-formed JSON after each edit (`python3 -c "import json; json.load(...)"`).

## Consequences

Going forward, `ConfigChange` events get an audit trail in `MEMORY/OBSERVABILITY/config-changes.jsonl`; tool failures land in `tool-failures.jsonl` instead of vanishing; API-error turn-endings get logged + a voice ping; subagent task creation is rate-limited at 50/session and rejects empty descriptions; and reads/known-safe Bash in trusted paths (`~/.claude`, `~/Projects`, `~/LocalProjects`, `~/Downloads`, `/tmp`) auto-approve instead of prompting, while writes still ask every time (SmartApprover never caches write decisions).

Test-run synthetic log entries (tagged `test-session`/`synthetic`) were left in place as honest verification history rather than scrubbed; `/tmp` cache-state files (`pai-settings-snapshot.json`, `pai-task-governance.json`) were cleared so the next real event starts clean.

Follow-up, still open: the broader "what else in the harness lacks verification" question this was pulled from is not fully answered — this was one concrete, cheap finding acted on, not the whole audit.
