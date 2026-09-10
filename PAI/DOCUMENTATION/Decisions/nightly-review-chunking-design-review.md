---
name: nightly-review-chunking-design-review
title: "Design review: chunked diff review for NightlyCodeReview.ts (FirstPrinciples + RedTeam + SystemsThinking + Cato/GPT-5.4)"
date: 2026-08-08
status: reviewed-not-built
change: "Pre-build adversarial review of the chunked-diff-review ISA (PAI/MEMORY/WORK/20260808-nightly-review-chunked-diff/ISA.md) before any implementation. Kept fixed chunk-count cap (rejected time-budget swap — non-deterministic under RedTeam's trace). Kept file-level chunking (rejected per-hunk swap — real unscoped cost against sortDiffByPriority). Added ISC-35 (local-failure vs clean-chunk logging gap) and ISC-36 (calibrated maxChunks constant). Flagged the zero-finding-coverage rule's cost model as unvalidated against too-thin real data. Added two Out of Scope lines (review cadence; fix-local-recall-instead-of-Sonnet-backstop) that were absent-not-deferred in the original scaffold. Cross-vendor pass (Cato, GPT-5.4 via OpenRouter after codex CLI quota exhaustion) then found 6 implementation-contract gaps none of the Claude-run thinking skills caught, including one genuine interface contradiction (ISC-8 vs ISC-10)."
---

## Decision

Ran three thinking skills against the freshly-scaffolded chunked-diff-review ISA before starting a build session, per explicit user request ("run the design through the most appropriate thinking skills first"). Order: FirstPrinciples/Challenge → RedTeam/ParallelAnalysis → SystemsThinking (FindArchetype + FindLeverage + Iceberg). Findings were batched into ISA revisions rather than left as a standalone report — this document is the compact trail; the ISA itself (`PAI/MEMORY/WORK/20260808-nightly-review-chunked-diff/ISA.md` Decisions section) has the full narrative.

## What changed, and what didn't

| Design element | FirstPrinciples said | RedTeam found | Resolution |
|---|---|---|---|
| Chunk-count cap | Soft constraint — count is the wrong proxy for "bounded run duration"; suggested a time budget instead | A time budget under sequential + priority-ordered processing makes skip behavior non-deterministic across runs (timing-dependent) and lets one slow chunk starve every later chunk in that run | **Kept fixed count.** Deterministic-but-wrong-variable beats non-deterministic. Logged as a debt item with a revisit trigger (ISC-36, new named constant + calibration comment) rather than treated as settled. |
| Mid-file split ban | Soft constraint — `git diff` hunks carry their own line markers, per-hunk splitting could work and would eliminate the oversized-single-file special case | `sortDiffByPriority`'s priority partition operates on whole files today with no hunk-adjacency mechanism; adopting per-hunk splitting is real unscoped rewrite work, not a free substitution | **Kept file-level splitting.** Per-hunk chunking deferred to a future ISA, triggered only if the oversized-file case (ISC-4) proves painful in practice. |
| Zero-finding Sonnet coverage rule | Unvalidated heuristic — assumes local's misses concentrate in zero-finding output, never measured | If local under-reports broadly (plausible per existing `feedback_local_llm_code_review.md` ~30% real-finding-rate note), the "selective" rule's zero-finding branch fires on MOST chunks, converging toward the same cost as exhaustive validation on exactly the diffs where it matters | **Not resolved — flagged.** Checked `local-review-eval.jsonl`: only 4 historical rows exist, too thin to decide either way pre-build. ISC-32's cost measurement is the real test; this is now an explicit open question in the ISA, not a silent assumption. |
| Local-failure vs clean-chunk distinction | — | Traced a real merge-logic gap: a failed-local chunk and a genuinely-clean chunk both trigger the same Sonnet coverage check (ISC-12); if that check also comes back clean, the two are indistinguishable in output — undermining ISC-34's own distinguishability goal at the per-file level | **New ISC-35 added.** Requires the two cases to log distinctly even when both end in "Sonnet found nothing." |
| Review cadence as a lever | — | — | SystemsThinking (FindLeverage): of the four candidate intervention points, this is the highest-leverage one and was never considered, not considered-and-rejected. **New Out of Scope line added** naming it explicitly as deferred, not absent. |
| Fix local's recall vs. permanent Sonnet backstop | — | — | SystemsThinking (FindArchetype — Shifting the Burden): the zero-finding-coverage rule compensates for local's weak recall every night forever, and doing so removes the pressure to ever fix the recall itself. **New Out of Scope line added** naming this as an accepted-for-now tradeoff, not a resolved design choice. |

## Archetype findings (SystemsThinking)

- **Fixes That Fail:** this file's own history — 906KB doc-ordering bug → 40K local cap added → 1.95MB diff refusal past that cap → 200K Sonnet cap added → now chunking to survive the new cap — is the same archetype recurring at shrinking intervals. Every fix has been sized to the incident that just happened, not the growth trend. The chunk-count cap in this ISA is the same archetype's next instance unless explicitly tracked as a debt (now is, via the revisit trigger in ISA Decisions).
- **Shifting the Burden:** the zero-finding-coverage rule is a compensating action for local's recall weakness, not a fix to it. The symptom (missed findings) stays invisible because Sonnet quietly absorbs it — which removes the pressure to ever revisit local model/prompt quality.

## Leverage ranking (SystemsThinking, Meadows' 12 leverage points)

Of the four candidate intervention points in this design — chunk boundary strategy, cap mechanism, Sonnet selection rule, and review cadence — the ISA's 34 (now 36) ISCs spend essentially all their effort on the two lowest-leverage items (cap value as a parameter; chunk mechanics as a rule change built to survive that parameter). Review cadence (a stock-and-flow lever — how much diff accumulates before a review cycle has to absorb it) ranks meaningfully higher and was outside the ISA's original consideration entirely. Not adopted this round (explicitly out of scope now, not silently absent), but named as the thing to revisit if the chunking approach keeps needing patches.

## Why this didn't change the Goal or Constraints structurally

None of the three skills' findings invalidated the core approach (chunk + selectively validate). RedTeam's job was to stress-test the *specific mechanisms* chosen (time-budget, per-hunk splitting) and found both proposed FirstPrinciples alternatives introduce worse problems than the ones they'd solve — so the original mechanisms survived, just with their tradeoffs now stated explicitly instead of implied. SystemsThinking's findings operate one level up (is this the right problem to be solving at all) and didn't produce a "stop building this" verdict — they produced two named, deferred alternatives and a debt-tracking mechanism so the current approach doesn't quietly become permanent by default.

## Cato cross-vendor pass (GPT-5.4, via OpenRouter fallback)

The primary `codex exec` path (`CrossVendorAudit.ts`, which this session also fixed — it was hardcoded to a `gpt-5.4` model string that OpenAI has since retired for ChatGPT-account auth, and separately the installed codex CLI was 19 versions stale and couldn't parse a new field in OpenAI's models manifest) was blocked for this specific run by ChatGPT Plus usage quota exhaustion (resets 2026-08-23). Rather than accept a same-vendor substitute or fabricate a result, the audit ran through OpenRouter's `openai/gpt-5.4` instead — a separate account/quota from the ChatGPT Plus subscription, confirmed genuinely OpenAI via the response's `provider: OpenAI` / `model: openai/gpt-5.4` routing metadata (the model's own self-reported `model_used: "gpt-5"` field was NOT trusted as verification — models are unreliable narrators of their own exact version).

Six new findings surfaced, all implementation-contract-level gaps the three Claude-run thinking skills didn't catch (they operated at the design/strategy level):

1. **ISC-8 vs ISC-10 — genuine interface contradiction.** Chunk-index tagging (ISC-8) and an unchanged `LocalFinding[]` public shape (ISC-10, Constraints) cannot both hold literally as written. Needs resolution before build.
2. **ISC-16 vs ISC-13 — merge representation gap.** No specified way to carry "no Sonnet verdict exists" for low-only findings through an unchanged conversion path.
3. **ISC-18 — chunk-to-file attribution gap.** Chunks can hold multiple files (ISC-3's packing rule); "tag with the chunk's file context" assumes 1:1.
4. **ISC-15 — nested truncation, undisclosed.** An oversized-file chunk that ALSO exceeds the Sonnet cap gets silently re-truncated — the exact class of problem this whole design exists to stop, one level deeper.
5. **ISC-32 — same-family blind spot, squarely Cato's job.** Cost/refusal measurement assumes `claude -p --output-format json`'s field names are a stable API contract; never verified as such.
6. **ISC-33 — partial-failure-of-fallback, undecided.** No rule for "local failed AND its Sonnet fallback-check also failed" on the same chunk.

None of these were resolved in this pass — they're logged in the ISA Decisions section as build-session inputs, same treatment as the FirstPrinciples/RedTeam/SystemsThinking findings.

## Cross-reference

Full ISA: `PAI/MEMORY/WORK/20260808-nightly-review-chunked-diff/ISA.md` — see Decisions section for the complete narrative and Criteria section for ISC-35/ISC-36. Cato's raw findings logged at `PAI/MEMORY/VERIFICATION/cato-findings.jsonl` (`audit_path: openrouter-fallback`).
