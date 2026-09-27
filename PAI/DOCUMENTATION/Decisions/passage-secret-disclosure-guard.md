---
name: passage-secret-disclosure-guard
title: "Passage: gate secret disclosure behind --reveal; add presence-only status"
date: 2026-07-05
status: complete
detected: manual
change: "Two-command split: `passage status <key>` for presence + metadata, `passage show <key>` requires --reveal for full value"
---

## Decision

Gate `passage show <key>` behind an explicit `--reveal` flag so that any usage without the flag returns metadata only (key path, length, last-rotated timestamp, scope tags) — never the value. Add a sibling `passage status <key>` that always returns metadata-only and is the default "do I have a credential wired?" check.

Concretely:

```bash
# Default behaviour (the next agent on any host should land here):
$ passage show api/anthropic
api/anthropic                                    rotated 2026-07-05
length: 109                                      scope: env-only
last-used: 2026-07-05T14:33:14-05:00              created: 2025-09-12

# Explicit reveal required for the value:
$ passage show api/anthropic --reveal
sk-ant-api03-...

# Presence check (new command, default-safe):
$ passage status api/anthropic
OK                                                  api/anthropic
```

## Why

**2026-07-05 Fable 5 unified-bench session.** While wiring `claude-fable-5` into the bench, I ran `passage show api/anthropic | head -2` to confirm Passage had the credential. Passage's `show` subcommand returned the full API key as the first line of stdout. Two harms followed:

1. **Tool-result context leak.** The Bash tool returned the value into my session context window, where any summary/compaction step could surface it elsewhere.
2. **Terminal scrollback capture.** Whatever scrolls past during a session is recoverable; on hosts with `bash_history` append, `unset HISTFILE` discipline is shaky.

GP rotated the burned Anthropic key the same day. The harm contained itself to one key on one host. The trap does not.

Every host using Passage has the same hazard. Every agent that wants to do a presence check before calling an inference tool has the same incentive to invoke `passage show`, get the long stdout, and pipe it through `head` or `wc` — and that's the canonical accidental disclosure path. The current API is unsafe-by-default: `passage show <key>` returns the value with no acknowledgement that "show" is the most dangerous word in the command.

## Alternatives Rejected

**Documentation only ("agents should use `wc -c` after `passage show`").** Operationally fragile. Every new agent, every new harness, every new Codex/Claude/Gemini instance starts with its own conventions. Trust me — I just demonstrated that even with knowledge of the discipline, I tripped it.

**Audit log + post-hoc rotation.** Treats the symptom. Doesn't prevent the leak. The burned-key replay path is unprotected.

**Subprocess-output capture wrapper in PAI hook.** The PreToolUse hook chain could strip `sk-*` patterns from `Bash` tool results before they reach context. This is a viable defense in depth (and we should do it regardless), but it doesn't fix the root problem: Passage is the source of the leak, and any tooling that uses Passage inherits it.

**Defaulting `passage show` to refuse unless interactive TTY.** Adds friction without fixing the API surface. Agents running headless need a way to confirm presence; gating on TTY-only forces them to wait for a human and breaks the wiring flow.

## Evidence

- **Burned value:** `sk-ant-api03-[REDACTED-ROTATED-2026-07-05]` — rotated 2026-07-05
- **Session artifacts:** `~/.claude/PAI/MEMORY/KNOWLEDGE/Research/claude-fable-5-unified-bench-2026-07.md` §6 documents the incident; `~/.claude/projects/-home-<username>/memory/feedback_passage_show_key_leak.md` is the per-session memory entry
- **Wider blast radius:** every PAI host that uses Passage (your-third-host, your-other-host, your-inference-host, your-third-host-vm, workhorse WSL) inherits the same `show <key>` semantics. Cost of the fix: one Passage patch + one Passage release. Cost of waiting: one more burned key per quarter.

## Consequences

**Required before merge:**
- `passage status <key>` implementation: read `~/.passage/<key>` (or wherever Passage stores entries), print metadata table, never include the value bytes
- `passage show <key>` change: refuse without `--reveal`; print same metadata + a one-line "pass --reveal to display value" hint
- `--reveal` flag: passes through to the existing read path, optionally logging `(revealed at <ts> by <user>)` to Passage's audit log so rotation cadence can be measured

**Defense-in-depth (separate but related work, not blocked by this proposal):**
- PAI hook: PreToolUse `Bash` filter that scrubs known-secret prefixes (`sk-ant-`, `sk-`, `ghp_`, `gho_`, `rk_live_`, AWS access-key IDs) from tool results before they reach model context. Fail-closed: detection triggers `require_approval` so the human can confirm rotation.
- PAI memory: `feedback_passage_show_key_leak.md` documents the discipline for the next agent; should be load-bearing across sessions, which it now is (added 2026-07-05).

**Open questions for the Passage maintainer:**
- Should `--reveal` require interactive confirmation, or is `passage show ... --reveal` sufficient? My preference is `sufficient` with audit log — agents run headless and a confirm-prompt would force every wiring step back to a human.
- Does Passage currently have a notion of "key scope" (e.g. env-only vs disk-persisted vs rotation-candidate)? The proposed `status` output assumes yes. If no, add minimally — `env|disk` is enough.
- Should `passage show <key> --reveal` truncate to first/last N chars by default, with full-reveal as a `--reveal-all`? This would make the dangerous surface smaller. My preference is "no, keep `passage show --reveal` simple" — humans running it deliberately want the full value when they need it.

**Operational rollout:** once Passage ships the change, audit-log every `reveal` event for the first 90 days; if `reveal` rate stays low (humans doing intentional rotations only), the safety story is intact; if `reveal` rate is high (agents/agents/agents), the harness design needs revisiting.
