---
name: containment-enforcement-consolidation
title: "Containment enforcement consolidated on release.ts; ContainmentGuard retired"
date: 2026-07-24
status: complete
detected: manual
change: "ContainmentGuard.hook.ts + hooks/lib/containment-zones.ts retired as dead code; release.ts identifier gate confirmed as sole containment enforcer; private-skill exclusion hardened with `_` prefix check"
---

## Decision

PAI containment — keeping principal-identifying strings out of public-destined content — is enforced solely by `PAI/TOOLS/release.ts` at release time. The prospective write-time guard (`hooks/ContainmentGuard.hook.ts`) and its zone library (`hooks/lib/containment-zones.ts`) are retired as dead code. The behavioral half of the rule, which no hook can observe, moves to `CLAUDE.md` Operational Rules.

Private-skill exclusion in `release.ts` now uses two layers: the existing explicit `PRIVATE_SKILL_DIRS` allowlist (for TitleCase skills that are private despite their name) plus an `entry.startsWith('_')` check enforcing the documented `skills/_*` convention.

## Evidence

`ContainmentGuard.hook.ts` was never registered on this machine — `git log -S "ContainmentGuard" -- settings.json` returns empty across the repo's full history, and the hook is absent from the 34 hooks registered in `settings.json`. Independently reached the same conclusion on 2026-07-03 (`PAI/MEMORY/WORK/paiupgrade-2026-07-03/report.md:24`: "ContainmentGuard=secunit release tool (wrong identity strings, dormant)").

Even if registered it would be inert here: `IDENTITY_PATTERNS` (lines 38-46) hardcodes upstream identity from PAI's original author — a different home-directory username, personal email domain, a third-party social handle, personal site domain, and two Cloudflare IDs. Zero patterns match this principal (a different user's fork); grepping for this principal's own identifying strings across both files returns nothing. Two later commits (`843b385f`, `00f538e1`, 2026-05-28) applied fail-closed doctrine to code that has never executed.

`release.ts` is correctly localized and hard-gating. `PERSONAL_PATTERNS` (line 762) scans for this principal's home-directory username, derived path forms, full name, personal email, business name, self-hosted infra hostnames, personal Git handles, machine names, work-employer name/initialism, and LAN IPs. Four gates (ADR stubs, SecretScan, identifier, Grype) run at lines 1224-1226; any failure hits `process.exit(1)` with staged output preserved. Two-layer design: `sanitizeFile()` rewrites known paths during staging, then the identifier gate catches residue.

**Live bug found and fixed during this investigation.** `PRIVATE_SKILL_DIRS` was a manual allowlist that omitted one `_ALLCAPS` private skill containing vendor/client work content across 4 of its 5 files. It would have been staged into the public release; the identifier gate scanning for this principal's employer name/initialism would probably have caught it, but as a content backstop rather than the structural exclusion the docs promise. Verified post-fix: 8 skills excluded, 44 shipped, no private skill leaking.

## Alternatives Rejected

**Localize ContainmentGuard's patterns and register it.** Would buy earlier feedback (write-time vs release-time) but no new coverage — `release.ts` re-scans the entire staged tree with correct patterns before anything ships. A fail-closed `exit 2` PreToolUse hook that misfires blocks writes, so the cost of a bad pattern is high and the marginal benefit is timing only. Rejected on cost/benefit, not on principle; revisit if write-time feedback becomes valuable.

**Delete the dead files immediately.** Rejected as sequencing: three live docs (`Tools/Containment.md`, `Skills/SkillSystem.md:28`, `PAISystemArchitecture.md:192`) cite `containment-zones.ts` as the authoritative source for the `skills/_*` boundary. Deleting first would trade dead code for dangling references. Doc repointing must land in the same commit as the deletion.

**Rely on `release.ts` alone with no behavioral rule.** Rejected because the release gate only sees content routed through it. Pasting a hook's source into a pastebin, quoting an absolute path in a blog draft, or copying an ISA excerpt into a public repo are not `Write` calls and never reach the gate. That residual is exactly what the CLAUDE.md rule covers.

## Consequences

- `PAI/TOOLS/release.ts` is the single containment enforcer. When a new principal-specific string enters the threat model, add it to `PERSONAL_PATTERNS` there — and nowhere else.
- New `_ALLCAPS` skills are excluded from release by default via the prefix check; the allowlist remains for non-underscore private skills.
- `CLAUDE.md` Operational Rules carries the behavioral half. Note this rule ships publicly in `CLAUDE.md.template`, so it is written generically.
- **Completed in this change:** `Tools/Containment.md` (header, body procedure, and living appendix), `Skills/SkillSystem.md`, and `PAISystemArchitecture.md` were repointed from `containment-zones.ts`/`ShadowRelease.ts` to `PAI/TOOLS/release.ts`; `hooks/ContainmentGuard.hook.ts` and `hooks/lib/containment-zones.ts` were deleted in the same working tree. The doc repointing and the deletion land together, as required.
- `PAI_SYSTEM_PROMPT.md:173` ("that hook IS this rule, automated") was factually false. That file was retired in the same session — see [system-prompt-retirement](system-prompt-retirement.md).
