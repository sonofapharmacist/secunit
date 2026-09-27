---
title: your-inference-host dual-model prod — Fast tier (jackrong MTP) + Standard tier (Qwen3-Next-80B), both systemd-managed
adr_id: local-inference-dual-model-fast-standard-tier-2026-08-14
status: accepted
date: 2026-08-14
deciders: GP + Munro
consulted: (none)
bench: `MEMORY/WORK/20260808-your-inference-host-six-pull-bench/ISA.md` (jackrong benched 31/53), `MEMORY/KNOWLEDGE/Research/qwen38-27b-unified-bench-2026-08-14.md` (prompted this ADR)
bench-isa: `MEMORY/WORK/20260808-your-inference-host-six-pull-bench/ISA.md`
replaces: (none — first documentation of this architecture)
supersedes: (none)
related: [local-unified-bench-2026-08-08, deepseek-r1-distill-routing-2026-08-10, reference_ubullm (auto-memory)]
---

# your-inference-host dual-model prod — Fast + Standard tier, both systemd-managed

## Context

your-inference-host (dual V100 32GB PCIe, 64GB pooled, `-ts 1,1`) has run a single production model since inception, managed by `llama-server.service`. During the 2026-08-08/08-14 model-pull bench campaign, `jackrong_v4_pro_qwen35_9b_mtp` (DeepSeek-V4-Pro-Qwen3.5-9B-MTP distill, IQ4_XS, 31/53 bench, MTP-capable) was loaded on port 11436 as a bench subject and never torn down. It sat running for multiple days, started via a bare `nohup ... & disown` outside systemd — untracked, not boot-persistent, no documented VRAM budget, and at one point observed running with **589 MiB free on one GPU** (default `n_ctx=199680`, no explicit context cap — an artifact of how it happened to be launched, not a chosen config).

This came to a head 2026-08-14 during the Qwen3.8-27B eviction-mode bench: the bench session found the orphaned process, asked whether to kill it, and was told to leave it — "there are NOW 2 models loaded at a time per recent fast and standard session work." A follow-up question later the same session revealed the real intent: **jackrong is the Fast-tier routing target; `qwen3_next_80b_a3b` is Standard tier.** This was a real, deliberate architecture decision from prior session work — it just was never written down or made durable, so a fresh session had no way to distinguish "intentional standing architecture" from "leftover bench process."

## Decision

**your-inference-host runs two production models simultaneously, both systemd-managed, both boot-persistent:**

| Tier | Service | Model | Port | Context | VRAM (measured) |
|---|---|---|---|---|---|
| **Standard** | `llama-server.service` | Qwen3-Next-80B-A3B-Instruct IQ4_NL | 11434 | 32768 | 45184 MiB (23364+21820) |
| **Fast** | `llama-server-fast.service` | DeepSeek-V4-Pro-Qwen3.5-9B-MTP IQ4_XS (jackrong distill, MTP draft-enabled) | 11436 | 32768 | 8290 MiB (3492+4798) |

**Combined: ~53474 MiB of the 65536 MiB pool, leaving ~11.8GB (12062 MiB) headroom.**

`llama-server-fast.service` has `BindsTo=llama-server.service` — it stops when prod stops (matches the existing eviction-mode bench pattern, where the whole pool needs to be free for a bench subject) and won't run standalone without prod also being up. Both units are `enabled` for boot persistence.

## Reasoning

### Why document this now instead of leaving it informal

A fresh session (or the same session after a context compact) has no way to tell "someone chose this" from "someone forgot to clean this up" by looking at process state alone — a bare `nohup`'d process with no systemd unit, no context budget, and no ADR is indistinguishable from an abandoned bench artifact. That ambiguity already cost one round-trip this session (kill-it-or-keep-it question, then a second round to learn the actual intent). Writing it down once removes the ambiguity for every future session.

### Why -c 32768 for jackrong, not the default 199680 or something larger

The live process before this ADR had no explicit `-c` flag and defaulted to `n_ctx=199680` — far more context than a 9.2B fast/draft-tier model plausibly needs, and it left only 589 MiB free on one GPU with prod also loaded (measured 2026-08-14, before this fix). That's not a real safety margin — a single larger prompt or KV-cache growth on either model could OOM.

Measured empirically (not estimated) by restarting jackrong at explicit context sizes and reading `nvidia-smi` deltas:

- `-c 32768` (matching prod's own context budget): jackrong uses 8290 MiB, combined 53474 MiB, headroom **11.8GB**
- Projected `-c 65536` (double prod's budget): jackrong would use ~11460 MiB, combined ~56644 MiB, headroom ~8.7GB — still safe, but no evidence Fast tier needs more than Standard tier's own budget

Chose 32768 to match prod's precedent exactly — no measured need for jackrong to have a larger context window than the Standard-tier model it complements, and matching keeps the mental model simple (both tiers get the same budget, difference is model size/speed, not context reach).

### Why systemd instead of the prior bare-nohup pattern

Every other production model on your-inference-host (`qwen3_next_80b_a3b`) has been systemd-managed since early in the project specifically because bare `nohup` processes don't survive reboots, aren't tracked by `systemctl status`, and can't be cleanly restarted via the documented `sudo systemctl restart` pattern used throughout `reference_ubullm.md`. jackrong had none of these properties before this ADR. `llama-server-fast.service` mirrors `llama-server.service`'s structure exactly (same `[Unit]`/`[Service]`/`[Install]` shape, `Restart=on-failure`, `RestartSec=5`) so the existing operational muscle memory (start/stop/restart/status) applies unchanged to the second tier.

### Why BindsTo=llama-server.service rather than fully independent

Every eviction-mode bench on your-inference-host to date has assumed "stop prod, the whole 64GB pool is free, load the bench subject." If jackrong ran fully independently of prod's lifecycle, a future eviction-mode bench session would need to *also* remember to stop jackrong first, or risk OOM/VRAM contention with whatever's being benched. `BindsTo=` makes prod's stop/start the single lever that also manages Fast tier — one fewer thing to forget mid-bench.

## Consequences

- **Future eviction-mode benches**: stopping `llama-server.service` now also stops `llama-server-fast.service` automatically (via `BindsTo=`) — the full 64GB pool is free with a single `sudo systemctl stop llama-server`, no separate jackrong teardown step needed. Restoring is the reverse: `sudo systemctl start llama-server` brings Standard tier back; Fast tier needs its own explicit `sudo systemctl start llama-server-fast` (BindsTo does not imply auto-restart on the bound unit's start — verify this on next use and update this ADR if it turns out to need `PartOf=` instead for symmetric behavior).
- **Routing consumers** (whatever code/skill selects Fast vs Standard tier) should target `http://<your-inference-host-host>:11436` for Fast and `:11434` for Standard — this ADR is the canonical source for that port mapping until a routing-config file supersedes it.
- **`reference_ubullm.md`** (auto-memory) should get a short pointer to this ADR rather than re-describing the dual-model setup inline, to avoid the two docs drifting.
- **Any future "should I kill this second model" moment**: check for this ADR first. If the ADR's config doesn't match what's live, treat the live state as unreviewed drift, not as evidence the ADR is wrong — reconcile explicitly rather than assume either side is stale.

## Verified: BindsTo= behavior on prod restart (2026-08-14, same session)

Tested directly: `sudo systemctl restart llama-server.service` while `llama-server-fast.service` was up. Result — **jackrong (Fast tier) was NOT stopped or restarted by prod's restart cycle; it stayed up and serving throughout**, confirmed via `curl :11436/v1/models` responding correctly both immediately after the restart command and after prod finished reloading (~50s later for the 45GB weight file). `BindsTo=` only enforces the stop-when-target-stops direction, as documented — a `restart` (stop+start) on the bound-to unit does not appear to cascade to the binding unit in this systemd version. This is actually the desired behavior here: Fast tier doesn't need to reload every time Standard tier is bounced for an unrelated reason (e.g. a config tweak), only when the pool needs to be fully freed (eviction-mode benching), which is a `stop`, not a `restart`.

No further action needed — the original open question is resolved and matches the intended design.

## Further validation (2026-08-15)

A ~5hr overnight regression campaign (`MEMORY/WORK/20260815-030000_qwen38-scope-creep-regression/`) stopped prod for the full duration (not just a quick test) — `sudo systemctl stop llama-server` correctly took Fast tier down with it via `BindsTo=`, and `sudo systemctl start llama-server llama-server-fast` brought both back cleanly at the end, with VRAM matching the pre-stop baseline exactly (26522/26028 MiB both before and after). Confirms the design holds under a real, long eviction-mode workload, not just the short verification test from the ADR's original session.

## Open questions

- Whether Fast tier's actual routing consumer(s) exist yet in code, or whether this ADR is documenting infrastructure ahead of the software that will use it — not established in this session.
