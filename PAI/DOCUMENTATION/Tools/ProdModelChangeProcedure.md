# Prod Model Change Procedure

> What to update when the local production model changes. Run `bun PAI/TOOLS/RoutingDriftCheck.ts --quiet` to verify.

## Why this exists

The 2026-08-08 migration to `qwen3_next_80b_a3b` updated `PAI_CONFIG.yaml` and
`Inference.ts`'s `DEFAULT_FALLBACK_MODELS`, but never added the model to
`inference-routing.yaml`. For five weeks `getTierForModel()` could not find the prod
model and fell back to a guessed tier on every call, announcing it only on stderr
(`Inference.ts:175`) where nothing surfaced it. Discovered 2026-09-16 while adding
active-param tracking to the bench harness.

`Inference.ts` says so itself, above `DEFAULT_FALLBACK_MODELS`:

> *"Keep this in sync manually; there's no single source of truth shared between the two."*

That comment is accurate, and it is the problem. This checklist plus
`RoutingDriftCheck.ts` is the mitigation: the sync is still manual, but drift is now
detectable in one command instead of invisible.

## The checklist

When a model becomes (or stops being) the local prod model:

### 1. `USER/Config/inference-routing.yaml` — the routing manifest

Add or update the model's entry under `models:`. Required for tier resolution;
**this is the one that was missed in August.**

```yaml
  <model-alias>:
    tier: smart              # REQUIRED — consumers skip entries without it
    total_params_b: 80       # see "Why params matter" below
    active_params_b: 3       # dense models: same value as total
    cold_start_ms: 0
    warm_p50_ms: 809         # measure, don't copy from a comment
    tok_per_s: 78
    notes: >
      What it is, why it was chosen, and how the numbers were measured.
    preferred_host: your-inference-host
    your-inference-host:
      port: 11434
      excluded: false
```

Code that reads this file — 15 files as of 2026-09-16, via
`grep -rl inference-routing PAI/ --include=*.ts --include=*.sh` (a bare `grep -rl`
returns ~270, mostly MEMORY notes and docs, so scope the include filters):

`Inference.ts`, `lib/tier-inference.ts`, `BenchmarkLocalModels.ts`, `BenchV100.sh`,
`QualityTestModels.ts`, `SubmitLocalMaxxing.ts`, `ObservabilityReport.ts`,
`analyze-latency.ts`, `release.ts`, `RoutingDriftCheck.ts`, `backends/offline.sh`,
`test-secunit-install.sh`, plus three test files.

### 2. `USER/Config/PAI_CONFIG.yaml` — the live routing decision

Under `ollama:`, update as applicable:

- `default_model`, `general_model`, `coding_offload_model`
- `fallback_models.{fast,standard,smart,fable}`
- `base_url` if the host or port changed

Keep the header comment block current. It's the human-readable record of *why* a
model was chosen — and the first thing anyone reads during an incident.

### 3. `TOOLS/Inference.ts` — code-level defaults

Update `DEFAULT_FALLBACK_MODELS` (~line 469) and the `defaultModel` in
`readOllamaConfig`'s fallback (~line 487). These apply **only** when
`PAI_CONFIG.yaml` fails to load, so a stale value here is a latent bug on the
degraded path — it will not show up in normal operation.

> **Known open issue:** `DEFAULT_FALLBACK_MODELS.fast` names `qwen2.5-coder:7b`,
> which is not served anywhere and is not declared in the routing manifest. The
> declared alias is `qwen2.5-coder:7b-instruct-q4_K_M`. Either serve the bare alias,
> repoint the default, or declare it. `RoutingDriftCheck.ts` reports this.

### 4. Systemd units on your-inference-host

Prod is `llama-server.service` (:11434); fast tier is `llama-server-fast.service`
(:11436). A model swap usually means editing the unit's `--model` path and flags.
Record the flags in the routing-manifest `notes:` — they are load-bearing
(e.g. `--spec-type draft-mtp` for the MTP drafter on the 9B).

### 5. Knowledge + memory

- Bench result → `MEMORY/KNOWLEDGE/Research/local-unified-bench-<date>.md`
- Update `reference_ubullm.md` auto-memory if the prod line changed
- ADR in `DOCUMENTATION/Decisions/` if the swap changes routing *policy*, not just
  the model (per CLAUDE.md ADR discipline)

### 6. Verify

```bash
bun PAI/TOOLS/RoutingDriftCheck.ts --quiet          # must exit 0
bun PAI/TOOLS/BenchmarkLocalModels.ts \
    --host localhost:11434 --models <alias>   # drift within 20%
```

## Why params matter

On bandwidth-bound hardware, throughput tracks **active** parameters, not total.
Measured on your-inference-host's dual-V100 pool, tok/s per active billion params:

| Shape | tok/s/active-B |
|---|---|
| Sparse MoE (30B/3B, 30.5B/3.3B) | 35.3, 36.4 |
| Sparse MoE (80B/3B — prod) | 26.3 |
| Dense (24B, 27B) | 1.0, 0.7, 0.2 |

A ~35× spread by architecture at comparable total size. This is why an 80B model is
the prod pick on a 64GB pool at all, and why `active_params_b` belongs in the
manifest rather than being inferred from the model name. Cf.
`MEMORY/KNOWLEDGE/Research/dgx-spark-local-red-team-bench-2026-09.md`, which found
the same effect (~66×) on GB10's 273 GB/s unified memory.

## Host addressing gotcha

`your-inference-host` is **`localhost`**. `BenchmarkLocalModels.ts`'s `--host` default is
`localhost`, which is **your-retired-host** (retired 2026-05-19 per PAI_CONFIG). Always
pass `--host` explicitly when benching your-inference-host, or fix the default. SSH to your-inference-host
rejects the current key; the HTTP API is reachable over Tailscale regardless, which
is all the tooling needs.
