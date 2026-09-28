# PhaseTransitionGuard accepts inline criterion evidence

- **Status:** Accepted
- **Date:** 2026-09-28
- **Scope:** `hooks/lib/algorithm-v8.ts` (`unevidencedPassed`), `PAI/hooks/PhaseTransitionGuard.hook.ts` (block message)

## Context

`PhaseTransitionGuard` refuses `phase: complete` while any `- [x] ISC-N` criterion
lacks quoted evidence. Before this change, evidence was read **only** from the
`## Verification` section. A checkable claim (backticked probe or quoted output)
had to appear there or the close was blocked.

Closing three legacy ISAs on 2026-09-27/28 (audiobookify, interceptor-hardening,
plus others) showed the friction is concentrated on ISAs written before
`## Verification` was conventional. Those ISAs recorded real, quoted evidence
**inline in the criterion line** — e.g. `- [x] ISC-22: \`grep "Kokoro-82M" tool.ts\`
confirms the model ID is set`. The guard couldn't see it, so every legacy close
required hand-copying each inline claim into a duplicate `## Verification` line.

Two other suspected gaps were investigated and found **not** to be real: comma
groups (`ISC-1, ISC-2:`) and numeric ranges (`ISC-6–14:`) already parse via
`idsInLine`. The only failing forms were a repeated-ID range (`ISC-6–ISC-14`) and
prose without any quoted claim — the latter working as designed.

## Decision

`unevidencedPassed` now credits an ID from **either** location:

1. a line under `## Verification` that names the ID and carries a checkable claim
   (unchanged), or
2. the `- [x] ISC-N:` criterion line itself, **only when that line carries its own
   checkable claim** (backtick span or quoted string, per `hasCheckableClaim`).

The evidence bar is unchanged: a quoted, re-runnable claim is still mandatory.
Prose criteria (`- [x] ISC-1: verified in-session`) still require a `## Verification`
entry. This credits the inline form ISAs actually used instead of forcing a
duplicate.

## Consequences

- **Not a loosening of rigor.** A checkable claim is still required; only its
  accepted location widened. Prose-only criteria still block.
- **Tradeoff accepted:** a criterion can now self-evidence if the author backticks
  a probe in it. This matches how self-describing probe-criteria were already
  written, and the quoted-claim requirement keeps "looks good" from passing.
- **Reversible:** revert `unevidencedPassed` to read only `section(content,
  'Verification')` and restore the old block message.
- Covered by `hooks/__tests__/algorithm-v8.evidence.test.ts` (9 cases) and a
  runtime smoke test of the hook (inline → exit 0, prose → exit 2).

## Alternatives considered

- **A migration helper that drafts `## Verification` from inline claims.** Keeps
  the section as the sole home but adds a tool to run per legacy ISA. Rejected as
  more moving parts for the same outcome; the guard change is smaller and durable.
- **Loosening the quoted-claim requirement itself.** Rejected — that reintroduces
  the stale-closure / bookkeeping-drift failure mode the guard exists to prevent.
