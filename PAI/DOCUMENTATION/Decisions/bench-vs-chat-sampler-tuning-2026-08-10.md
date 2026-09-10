---
name: bench-vs-chat-sampler-tuning
title: "Bench greedy ≠ chat sampler — do not apply chat-tuned modelfile to bench-facing prod"
date: 2026-08-10
status: complete
detected: manual
change: "Document the separation between 53-pt unified bench sampler config and chat-loop defense sampler config on your-inference-host"
---

## Decision

**Do not unify the two surfaces.** your-inference-host's `qwen3_next_80b_a3b` production modelfile keeps its current sampler state (greedy / llama-server defaults that match the unified bench scoring path) **as long as your-inference-host is serving the 53-pt battery**. The chat-loop defense sampler block (qwen team Best Practices: T=0.7, TopP=0.8, TopK=20, MinP=0, repeat_penalty=1.1, frequency_penalty=0, presence_penalty=0 → raise to 0.3–0.6 if loops persist) is documented at `MEMORY/KNOWLEDGE/Research/local-llm-sampler-tuning-2026-08-10.md` and stays a **reference for chat-loop troubleshooting**, not a prod-default recommendation.

The two surfaces have different success criteria:
- **Bench surface:** maximize exact-match score on the 53-pt battery. Greedy (T=0) is the right default — confirmed by the 2026-08-10 rebench.
- **Chat surface:** prevent `I cannot… I cannot…` style loops and degraded reasoning chains. Higher temp + lower top_p + non-zero repeat_penalty is the right defense — confirmed by the XDA article that triggered the research.

## Evidence

**Re-bench ISA:** `MEMORY/WORK/2026-08-10-sampler-tuning-rebench/ISA.md` (complete, 7/7). Adding `--temperature 0.7 --top-p 0.8 --top-k 20 --repeat-penalty 1.1` (qwen team Best Practices) to `llamacpp_eval.py` against the same `qwen3_next_80b_a3b` instance on port 11434 produced:

| Model | Greedy baseline | Official sampler block | Delta |
|-------|----------------:|-----------------------:|------:|
| `qwen3_next_80b_a3b` (prod) | **47/53** | 46/53 | **−1** |
| `deepseek_r1_distill_qwen32b` | 42/53 | 37/53 | −5 |

Both drops concentrate in the C-battery (code-generation, exact-match biased). The rebench ISA's Changelog states this directly: *"Greedy is the right default for this exact-match biased benchmark; official sampler blocks are right for interactive chat, wrong for eval."*

**Sampler research note:** `MEMORY/KNOWLEDGE/Research/local-llm-sampler-tuning-2026-08-10.md`. Authoritative on chat-loop defense (XDA `repeat_penalty=1.1` sweet spot, qwen team `T=0.7/TopP=0.8`, presence_penalty anti-CoT for reasoning models, Ollama's DRY/XTC/mirostat gaps). Not authoritative for the bench surface — that question requires measurement, not citation.

**Local-review reconciliation:** `MEMORY/STATE/local-review-eval.jsonl` shows the cross-vendor audit rejected the apparent conflict: prod IQ4_NL stays at the bench-measured value, the rebench's 47/53 greedy is the canonical baseline, and the Q4_K_M 49/53 entry is a non-prod variant explicitly flagged "untested-for-prod, 1-point gain doesn't justify the cold-load cost."

## Alternatives Rejected

- **Apply the chat-tuned modelfile globally.** Drops prod by 1 point on the bench battery. Cost: real (bench is the routing-decision evidence base; Tier-1.5 picks, ASA-on-your-inference-host evals, R1-distill comparison all rest on bench numbers). Benefit: zero proven — we have no chat-loop measurement on prod today, so we cannot show the chat surface improved.
- **Force greedy on the chat surface.** Would prevent loops by producing deterministic, low-entropy outputs — wrong shape for conversation. Greedy chat is documented to be flat and repetition-prone even at the tokenizer level.
- **Two physical models / two endpoints.** Operationally heavyweight; the right move if the surfaces diverge further, but currently both serve from one llama-server instance and the divergence is one modelfile flag.

## Consequences

- `local-llm-sampler-tuning-2026-08-10.md` stays a **chat-loop troubleshooting reference**. It is **not** a deployment recommendation. Future sessions reading it must check the surfacce they're tuning before applying values.
- If a future user reports `qwen3_next_80b_a3b` looping in conversation, the answer is *tune the chat surface using the note*, do **not** roll the same change into bench runs.
- If a future user reports the bench score regressing, the answer is *the modelfile was chat-tuned*, not "the model got worse."
- `MEMORY/KNOWLEDGE/Research/local-llm-sampler-tuning-2026-08-10.md` should grow a short header banner: *"Chat-loop defense reference. Not a bench-tuning recommendation. See ADR `bench-vs-chat-sampler-tuning-2026-08-10`."* — proposed but not yet written; flag to next session as a follow-up edit.
- The cross-vendor audit JSONL (`local-review-eval.jsonl`) is the in-flight precedent: when a finding crosses sources, route to the ADR rather than the note. This ADR is that precedent for sampler tuning.

## Related

- `MEMORY/WORK/2026-08-10-sampler-tuning-rebench/ISA.md` — the empirical foundation (47→46 prod, 42→37 R1-distill under official blocks)
- `MEMORY/KNOWLEDGE/Research/local-llm-sampler-tuning-2026-08-10.md` — the chat-loop defense reference
- `MEMORY/WORK/20260810-your-inference-host-sampler-merge/ISA.md` — merge task that produced the canonical reference (no behavior change to prod)
- `MEMORY/KNOWLEDGE/Research/local-unified-bench-2026-08-09.md` — the 53-pt battery prod scoring runs against
- `MEMORY/STATE/local-review-eval.jsonl` (entry 151, 2026-08-10T09:32:17Z) — cross-vendor audit that reconciled the apparent prod-score conflict
</content>
</invoke>