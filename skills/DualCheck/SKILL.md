---
name: DualCheck
description: "Adversarial code review by two independent models in parallel (Devstral via Mistral, Solar Pro 4 via OpenRouter), reported side by side: agreement is signal, disagreement is a finding. USE WHEN dual review, two-model check, second opinion on a diff, cross-model review, verify a fix or completed work with another model. NOT FOR single-model review (_COMMITREVIEW if present) or subjective writing review (ProofReader)."
effort: medium
---

## Customization

**Before executing, check for user customizations at:**
`~/.claude/PAI/USER/SKILLCUSTOMIZATIONS/DualCheck/`

If this directory exists, load and apply any PREFERENCES.md, configurations, or resources found there. These override default behavior. If the directory does not exist, proceed with skill defaults.

# DualCheck

Get two independent adversarial verdicts on a completed code change, run in parallel, called directly against each model's own API rather than through a single aggregator. Two models agreeing "no findings" is meaningfully stronger evidence than one model saying so; a split verdict between them is a signal to investigate, not noise to average away.

**Why direct, not through one gateway:** routing both calls through the same intermediary (a single proxy, a single API key, a single provider account) means both "independent" opinions could still share a failure mode upstream of the models themselves — a truncated request, a shared rate limit, a misconfigured system prompt applied to both. Calling each model's own API directly keeps the two checks genuinely separate.

**Why parallel, not sequential:** the two calls have no dependency on each other — running them concurrently costs the wall-clock time of the slower one, not the sum of both.

## Workflow Routing

| Trigger | Workflow |
|---------|----------|
| "dual check", "two-model review", "check this with both models" | `Workflows/RunDualCheck.md` |

## Quick Reference

- **Tool:** `Tools/DualDirectReview.ts` — takes a prompt via stdin, returns both verdicts as JSON.
- **Models:** Devstral Medium (`devstral-medium-latest`, Mistral direct) + Upstage Solar Pro 4 (`upstage/solar-pro4`, OpenRouter direct; was MiniMax M3 until 2026-09-26). Override via `--mistral-model` / `--or-model` if a newer slug supersedes these.
- **Credentials:** resolved via `passage show api/mistral` and `passage show api/openrouter` (env var override supported: `MISTRAL_API_KEY`, `OPENROUTER_API_KEY`). Never resolved via shell command-substitution — see Gotchas.
- **Evidence discipline:** the tool gives neither model any tool-calling or shell access — it is a plain chat-completion call. All evidence (diffs, grep output, file excerpts) must be gathered by the invoker first and pasted into the prompt. A model that believes it can run a command itself will narrate intent instead of reasoning from real evidence — this is the single most important discipline in this skill; see `Workflows/RunDualCheck.md` for the evidence-gathering steps.
- **Output:** both verdicts printed together, never silently reduced to one. If the two disagree, surface both explicitly rather than picking the "more thorough-sounding" one.

## Gotchas

- **Never resolve API keys via shell command-substitution (`$(passage show ...)`).** Command substitution can briefly expose the resolved secret in `/proc` or `ps aux` process listings during the substitution. Use `Bun.spawn(['passage', 'show', name], { stdout: 'pipe' })` and read the piped stdout instead — the pattern `Tools/DualDirectReview.ts` already implements.
- **Neither model can execute a command.** Both calls are plain `chat/completions` requests — no tool-calling, no filesystem, no shell. If a prompt is phrased as an instruction addressed to the model ("run `git show`," "check the file at..."), the model will narrate compliance without ever having done it, and a "no findings" verdict produced this way is not trustworthy. Every piece of evidence must already be in the prompt before it's sent — see the evidence-gathering steps in `Workflows/RunDualCheck.md`, which follow the same discipline established for single-model adversarial checks in this environment.
- **A clean verdict from one model is not the same as a clean verdict from both.** Report each model's result on its own terms. If the two disagree, that disagreement is the most interesting output of the whole check — don't resolve it silently by trusting whichever model "sounds more confident."
- **Model IDs drift.** `devstral-medium-latest` and `upstage/solar-pro4` are current as of this skill's writing. If either provider retires or renames a model, the tool will surface an HTTP error naming the bad model ID rather than silently falling back — update the model flags rather than assuming the old ID still resolves.
- **Timeouts are independent per call.** A slow or hung call from one model does not block the other — both run under `Promise.all`, and a timeout on one is reported as that model's own failure, not a fatal error for the whole check.
- **The default timeout is 300s because the OpenRouter leg reasons.** Solar Pro 4 thinks before answering and is slower per task than the non-reasoning model it replaced. A 120s cap cut reviews off. Raise `--timeout-ms` for large diffs rather than lowering it.
- **Expect noise in the reasoning leg; filter by convergence.** In the first live run, Solar headlined a finding that its own analysis then contradicted, and retracted another mid-answer. The real bug (an unvalidated numeric flag) was the one **both** models raised independently. Treat a finding raised by one model as a lead to verify against the code, and a finding raised by both as a likely real issue.

## Examples

**Example 1: Second opinion on a fix you just made**
```
User: "cross-model review of the fix I just made to the config loader"
→ Gather the real diff and relevant file excerpts with Bash first (the models can't run commands)
→ Paste that evidence into one review prompt, pipe it to Tools/DualDirectReview.ts
→ Report Devstral's verdict and Solar's verdict separately, in full
→ Call out findings both raised; verify single-model findings against the code before acting
```

**Example 2: The two models disagree**
```
User: "have two models check this migration script"
→ Devstral: NO FINDINGS · Solar: flags a missing transaction around two writes
→ Don't average this away. Surface the split, then check the script yourself:
  the disagreement is the most useful output of the run
```

**Example 3: One leg fails**
```
User: "dual review this diff"
→ Mistral key missing → the mistral leg returns { ok: false, reason }, exit code 1
→ Report the Solar verdict as a single-model result and say plainly that the second
  opinion didn't run. Never present one verdict as a dual check.
```

## Related

- Single-model fallback review patterns (calling one model, retrying with an alternate on failure) are a different tool for a different situation — useful when you want *a* review and don't need two independent takes, not when you specifically want cross-model agreement/disagreement as a signal.
