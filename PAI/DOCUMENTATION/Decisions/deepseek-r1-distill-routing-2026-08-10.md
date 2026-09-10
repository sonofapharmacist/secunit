---
title: DeepSeek-R1-Distill-Qwen-32B Q5_K_M routing — Tier-1.5 reasoning-pick, NOT prod swap
adr_id: deepseek-r1-distill-routing-2026-08-10
status: accepted
date: 2026-08-10
deciders: GP + Munro
consulted: Sonnet-5-parallel-session (recommendation)
bench: PAI unified 53-pt, see `MEMORY/KNOWLEDGE/Research/deepseek-r1-distill-qwen32b-your-inference-host-bench-2026-08.md`
bench-isa: `MEMORY/WORK/2026-08-10-deepseek-r1-distill-qwen32b-bench/ISA.md`
replaces: (none)
supersedes: (none)
related: [pai-model-tiers-unified-2026-06, local-unified-bench-2026-08-09, unified-bench-2026-06-16, deepseek-v4-nous-research]
---

# DeepSeek-R1-Distill-Qwen-32B Q5_K_M — routing decision

## Context

GP asked whether DeepSeek-family models larger than the 9B distills fit in 64 GB on your-inference-host. Scout under-sold the options; a parallel Sonnet 5 session recommended pulling the largest R1-distill that fits solo on a single V100: **DeepSeek-R1-Distill-Qwen-32B-Q5_K_M (22 GB)**.

Bench result: **42/53 (79.2%)** on the PAI unified 53-pt battery. Qwen3-Next-80B IQ4_NL prod sits at 47/53 (88.7%). The raw delta is 5 points — but the *distribution* of points is different, and a few R1-distill signatures are worth surfacing.

## Decision

**Tier-1.5 reasoning-pick.** Loaded on demand for reasoning-class workloads. **Production stays on Qwen3-Next-80B-A3B IQ4_NL.**

## Reasoning

### Why NOT a production swap

| Metric | Qwen3-Next-80B prod | R1-distill Qwen32B | Delta |
|---|---|---|---|
| T-battery | 9/9 | 7/9 | -2 |
| R-battery | 16/17 | 15/17 | -1 |
| C-battery | 23/27 | 20/27 | -3 |
| **Total** | **47/53** | **42/53** | **-5** |
| Cold-load | ~3 min | ~60s | **+ for R1** |
| VRAM | 45 GB (dual) | 22 GB (single) | **+ for R1** |
| Gen tok/s | ~86 | 26.44 | -60 |

The 5-point total is the deciding factor. 47/53 production is the routing tier — 42/53 is below the production floor established in `pai-model-tiers-unified-2026-06`. Cold-load speed and single-V100 fit are real operational wins, but they don't compensate for losing T9, T8, and C4.

### Why it earns Tier-1.5

The R-battery artifact. R1-distill inherits DeepSeek-R1's reasoning trace, and on tasks where trace-then-answer is structural it ties Qwen3-Next-80B on the R battery (15/17 vs 16/17) while having distinctive C-battery strengths:

- **R3 vuln analysis — 2/3 partial, ties Qwen3-Next-80B.** Both models produce reasoning traces on this prompt; both miss one of three vulnerabilities.
- **R4 logic 3/3 — ties Qwen3-Next-80B.**
- **C5 REST API 5/5 — beats Qwen3-Next-80B's 4/5.** Real, defensible edge: R1 reasoning trace handles structured JSON output better than Qwen3-Next-80B at default sampling.

**Correction (2026-08-10):** The original draft of this ADR claimed "R2 STRIDE→JSON 5/5 — beats Qwen3-Next-80B prod's 2/5." This was wrong — both models score 5/5 on R2 STRIDE→JSON in greedy mode. The R2 STRIDE→JSON edge does not exist between them. Other edges (C5 REST, R3 partial) hold; the Tier-1.5 reasoning-pick verdict holds; the specific R2 claim is removed. See `MEMORY/KNOWLEDGE/Research/local-llm-sampler-tuning-rebench-2026-08-10.md` for the rebench that surfaced the error.

### Why the failures matter

- **T8 tool_call = FAIL** — the reasoning trace biases toward internal monologue. R1-distill is NOT an agent-step model. Don't route it through tool-call harnesses.
- **T9 STRIDE = FAIL** — same failure mode as the 9B distills: returns "I" mid-stride. /no_think prefix may help; not in scope for this ADR.
- **C4 zero 0/5** — code-test scaffolding is dead. This is the model's cleanest weakness. If GP needs a local code-gen pick, route to Qwen3-Coder-Next (49/53 in the 2026-08-08 sweep) instead.

### Why "on-demand" and not "swap or alongside"

- **Swap:** loses 5 points. No.
- **Alongside-prod:** 22 GB R1-distill + 45 GB Qwen3-Next-80B = 67 GB. Dual V100 only has 64. Doesn't fit.
- **On-demand:** R1-distill lives on `/data/models/`, prod swaps to it for the ~3-min cold-load, then swaps back. Costs ~6 min of inference time per swap. Acceptable for reasoning-class tasks where the lift justifies it.

## Routing table

| Task class | Routing |
|---|---|
| Default chat / open Q&A | Qwen3-Next-80B prod (port 11434) |
| STRIDE classification (R2 — single-letter T9 STRIDE) | Cloud or Qwen3-Coder-Next-80B (local pass list) |
| Security vuln analysis (R3) | Either; R1-distill marginally better for trace-heavy cases |
| Logic / chain-of-thought (R4) | Either; R1-distill marginally better |
| REST API / structured JSON (C5) | **R1-distill preferred** (5/5 vs Qwen3-Next-80B prod's 4/5) |
| Tool-call / agent harness (T8) | Qwen3-Next-80B prod |
| Code generation (C4) | Qwen3-Coder-Next on a separate load |
| Vision / multimodal (T9) | Cloud (Claude / Gemini) |
| Default reasoning | R1-distill unless the prompt is short or batch-mode |

## Operational checklist

- [x] Model file at `/data/models/DeepSeek-R1-Distill-Qwen-32B-Q5_K_M.gguf` (22 GB)
- [x] `MODELS` dict entry in `FreeTierEvals/llamacpp_eval.py` for bench reproducibility
- [x] MOC entry at `Knowledge/Research/deepseek-r1-distill-qwen32b-your-inference-host-bench-2026-08.md`
- [x] Production confirmed restored: Qwen3-Next-80B IQ4_NL on port 11434, 45.0 GB VRAM
- [x] bench_r1q32.sh exit trap fired; port 11440 confirmed empty
- [ ] Add a swap-launch wrapper (`TOOLS/SwapToR1Distill.sh`) — does the prod-stop → eval-start → 11440 swap dance in one command
- [ ] Wire the swap wrapper into the ASA skill's reasoning-mode router once ASA picks up

## What would change this decision

- **If Qwen3-Next-80B C-battery drops below 22/27** in a regression sweep — R1-distill re-opens for production swap.
- **If a /no_think prefix is confirmed to fix T8 + T9 cleanly** — R1-distill jumps to a Tier-1.5 candidate for default reasoning routes.
- **If a 70B R1-distill IQ4_XS gets a re-quant** (current 35.33 GB crowds both cards); would re-evaluate alongside-prod.

## References

- `MEMORY/WORK/2026-08-10-deepseek-r1-distill-qwen32b-bench/ISA.md` — full work record
- `MEMORY/KNOWLEDGE/Research/deepseek-r1-distill-qwen32b-your-inference-host-bench-2026-08.md` — bench MOC
- `MEMORY/KNOWLEDGE/Research/local-unified-bench-2026-08-09.md` — prior sweep this slots into
- `MEMORY/KNOWLEDGE/Research/pai-model-tiers-unified-2026-06.md` — canonical routing
- `MEMORY/KNOWLEDGE/Research/deepseek-v4-nous-research.md` — DeepSeek family context
- Sonnet 5 parallel session — original recommendation rationale
