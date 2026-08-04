---
name: RunDualCheck
description: "Gather real evidence for a completed code change, build a grounded review prompt, and run it through both Devstral Medium (Mistral direct) and MiniMax M3 (OpenRouter direct) in parallel — reporting both verdicts."
---

# RunDualCheck

Run the dual-model adversarial check against a specific diff or completed change, and report both verdicts back to the user.

**Core rule: neither model can run a command.** `Tools/DualDirectReview.ts` makes plain `chat/completions` calls — no tool-calling, no shell, no filesystem access for either model. Every command in this workflow (`git diff`, `git show`, `grep`) is run by the invoking session itself, and its literal output is pasted into the prompt. The models judge evidence that's already in front of them; they never fetch it themselves. A prompt that tells a model to "run" something produces narrated intent, not a real check — the model will describe compliance and answer anyway, with nothing behind the answer.

## Required inputs (ask the user if not given)

1. **What changed** — a diff, a commit, or a set of file paths plus a description of the change.
2. **Scope** — one paragraph on what changed and why, so both models have the same framing.

## Step 1 — Gather evidence (run every command yourself, don't delegate to the prompt)

Capture the real evidence before writing the prompt — nothing here is optional, and nothing here should be phrased as an instruction to either model.

1. **The diff itself.** For a commit: `git show <sha>`. For uncommitted work: `git diff` (or `git diff --staged` if relevant). If the diff is large, use a stat summary plus targeted per-file diffs for the files that actually matter to the change, and say explicitly in the prompt which files were only seen in summary form — never claim full coverage you don't have.
2. **Straggler check.** If the change removed or renamed anything, grep the wider tree for lingering references: `grep -rn '<old-name>' <search-roots>`. A clean "no matches" result is itself evidence worth including, not an absence of it.
3. **Anything else material** — a related config file, an ADR, a test file — read it directly and capture its actual content rather than describing it from memory.

**Redirect output to a file and paste it, don't retype it from memory.** A regex can catch an obvious placeholder, but it can't catch an honest-sounding paraphrase of what a command "probably" showed. If you find yourself describing what a command's output said instead of pasting the output itself, stop and go capture it directly.

## Step 2 — Build the prompt

Assemble one prompt text file with this shape. Every section marked with `<...>` gets literal captured content from Step 1, never a description of what should be there.

```
You are a senior code reviewer. Audit this change for correctness,
completeness, and risk, using ONLY the evidence provided below. You have
no tools, no shell, and no filesystem access — if evidence needed to
confirm or refute a concern isn't present below, say so explicitly under
"gaps" rather than guessing or assuming you could check it.

SCOPE
=====
<one paragraph: what changed and why>

EVIDENCE — DIFF
================
<literal diff output from Step 1.1>

EVIDENCE — STRAGGLER CHECK
============================
<literal grep output from Step 1.2, including "no matches" if that's
 what was found>

EVIDENCE — OTHER
=================
<any other literal file content captured in Step 1.3, or omit this
 section if nothing else applied>

OUTPUT (strict)
===============
Return findings ordered most-severe first. For each finding give:
- Severity: blocker | major | minor | nit
- File:line reference
- One-sentence claim
- Concrete evidence (quote the exact line from the EVIDENCE above —
  do not invent a line that isn't there)
- Why it matters

If nothing real survives, say "NO FINDINGS" and stop. Do not pad. Do
not invent risk. Do not propose rewrites. Do not claim to have checked
anything not present in the EVIDENCE sections above.
```

## Step 2.5 — Pre-send check (mandatory)

Before sending, grep the EVIDENCE sections specifically for unfilled placeholders:

```bash
sed -n '/^EVIDENCE —/,/^OUTPUT (strict)/p' <prompt-file> | grep -nE '<literal|<one paragraph|\[omit'
```

If this finds a match inside an EVIDENCE section (not just the section headers/instructions themselves), a placeholder survived unfilled — go back and run the actual Step 1 command for that section. Only a clean result means the prompt is ready to send.

## Step 3 — Run the dual check

```bash
cat <prompt-file> | bun ~/.claude/skills/DualCheck/Tools/DualDirectReview.ts \
  --timeout-ms 120000
```

This prints one JSON object with `mistral` and `m3` keys, each either `{ ok: true, model, content }` or `{ ok: false, model, reason }`.

## Step 4 — Report both verdicts

1. Report Devstral's verdict and M3's verdict **separately and in full** — never merge them into one summary or silently prefer one over the other.
2. If both say NO FINDINGS: state that plainly, and note it's two independent models agreeing on the same evidence — stronger than either alone.
3. If they disagree (one finds something, the other doesn't; or they flag different things): surface the disagreement explicitly as the headline result, not a footnote. A split verdict is real signal — it usually means either one model caught something real the other missed, or one model is hallucinating against evidence that doesn't support its claim. Read the disputed finding against the EVIDENCE section yourself before deciding which is which.
4. If either call failed (`ok: false`): report the failure reason (missing key, HTTP error, timeout) — a failed call is not the same as a clean verdict, and must never be silently treated as "no findings" from that model.

## Known failure modes

- **A model regurgitates the SCOPE description as if it were analysis.** Usually means an EVIDENCE section was thin or empty — there was nothing else to analyze, so the model fell back to restating what it was told. Re-run Step 1 for that section.
- **A model invents a file:line reference that doesn't appear in the evidence.** A real finding quotes the pasted evidence verbatim; a fabricated one won't match anything in the prompt. Check every cited line against the actual EVIDENCE text before trusting a finding.
- **One model hallucinates on evidence that's already correct.** Some models can confidently misread text that's fine as if it were broken — this is a known failure mode for at least one of the two models this workflow uses, worth an extra "does this claim actually match the evidence" pass on any finding before accepting it, especially from whichever model runs it.
