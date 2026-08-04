---
name: BitterPillEngineering
description: "Audits any AI instruction set for over-prompting using the core test: would a smarter model make this rule unnecessary? Applies Six Questions to every rule — Does the model already do this? Contradiction? Redundant? One-off fix? Vague? Always-loaded when it could be fetched? — then classifies each as CUT / RESOLVE / MERGE / EVALUATE / SHARPEN / LAYER / MOVE / KEEP. Two workflows: Audit (full system — reads all force-loaded files from settings.json, reports token savings estimate) and QuickCheck (single file, fast keep/cut/sharpen verdict). Grounded in Anthropic's Claude-5-generation context-engineering guidance: constraints give way to judgment, examples to interface design, upfront loading to progressive disclosure. Anti-fragile rules to KEEP: verification harnesses, ISC, data pipelines, tool interface design, routing rules. Fragile rules to CUT: CoT orchestrators, format parsers, retry cascades, numeric personality scales, abstract value statements. Flags cuts touching files that ship in a public release. NOT FOR general code simplification or refactoring (use simplify skill). NOT FOR attacking logical or strategic flaws in ideas (use RedTeam for that). USE WHEN BPE, bitter pill, audit setup, over-prompting, trim instructions, audit rules, dead weight, redundant rules, simplify setup, instruction audit, prompt hygiene, check these rules, clean up CLAUDE.md."
effort: medium
---

## Customization

**Before executing, check for user customizations at:**
`~/.claude/PAI/USER/SKILLCUSTOMIZATIONS/BitterPillEngineering/`

If this directory exists, load and apply any PREFERENCES.md, configurations, or resources found there. These override default behavior. If the directory does not exist, proceed with skill defaults.

# BitterPillEngineering

Audit any AI instruction set for over-prompting. Based on the principle that **less scaffolding = better output** — every unnecessary rule competes for attention and degrades the rules that matter.

The core test: *"Would a smarter model make this unnecessary?"* If yes, it's scaffolding, not architecture.

Anthropic's own Claude-5-generation context-engineering guidance reports removing **over 80% of Claude Code's system prompt with no measurable performance loss** (their internal measurement, not independently replicated). The direction of travel it describes is the audit's spine: constraints → judgment, examples → interface design, upfront loading → progressive disclosure, repetition → one statement at one layer.

## Workflow Routing

| Workflow | Trigger | File |
|----------|---------|------|
| **Audit** | "audit setup", "full audit", "check all rules" | `Workflows/Audit.md` |
| **QuickCheck** | "quick check", "check this file", "check these rules" | `Workflows/QuickCheck.md` |

## Examples

**Example 1: Full system audit**
```
User: "Run BPE on my setup"
→ Invokes Audit workflow
→ Reads all force-loaded files from settings.json
→ Evaluates each rule against the Six Questions
→ Returns categorized report with estimated token savings
```

**Example 2: Check a single file**
```
User: "Quick check this CLAUDE.md"
→ Invokes QuickCheck workflow
→ Reads the target file
→ Returns concise keep/cut/sharpen verdict
```

**Example 3: Post-cleanup validation**
```
User: "I trimmed my rules, check if anything's still redundant"
→ Invokes Audit workflow
→ Compares remaining rules against Claude defaults
→ Flags any surviving dead weight
```

## Gotchas

- Claude's built-in system prompt changes across versions — what was "default behavior" 3 months ago may not be now. When in doubt, test rather than assume.
- Rules that seem redundant with defaults may have been added because Claude was inconsistent about following the default. Check failure history before cutting.
- "One-off fix" rules sometimes prevent recurring failures. Check if the failure pattern is truly gone before removing.
- The `loadAtStartup` list in settings.json and `postCompactRestore.fullFiles` must stay in sync — if you remove a file from one, check the other.
- Instruction files that ship in a public release (templates, user-scaffold files, public docs and READMEs) rightsize differently from private config. A private file is tuned for one operator whose failure history is known; a released file is read by people whose setups and models you cannot see, so a rule that looks redundant locally may be the only thing carrying that context downstream. Flag these cuts as release-affecting and decide them separately rather than folding them into the same batch.
- `/doctor` (`claude doctor`) rightsizes oversized skills and instruction files independently. Where its recommendations and an audit's agree, confidence is high; where they diverge, that divergence is the interesting part — investigate before cutting.

## The Six Questions

For every rule, instruction, or preference found, evaluate:

1. **Default behavior?** Does the model already do this without being told?
2. **Contradiction?** Does this conflict with another rule in the same or different file?
3. **Redundancy?** Is this already covered by a different rule or file?
4. **One-off fix?** Was this added to fix one specific bad output rather than improve outputs generally?
5. **Vague?** Would the model interpret this differently every time? (e.g., "be more natural", numeric personality scales)
6. **Always-loaded?** Does this need to be in context every session, or could it be fetched when relevant? Distinguish *wrong altitude* (→ LAYER) from *wrong load timing* (→ MOVE).

## Classification

| Category | Action |
|----------|--------|
| Restates default behavior | **CUT** — the model already does this |
| Contradicts another rule | **RESOLVE** — pick one, cut the other |
| Duplicates another rule | **MERGE** — one location, one statement |
| One-off fix for past mistake | **EVALUATE** — still relevant or already learned? |
| Vague / unquantifiable | **SHARPEN** — replace with judgment framing, or add DO/DON'T examples if safety-critical, or cut |
| Right rule, wrong altitude | **LAYER** — relocate to the most specific layer that governs it |
| Loaded but rarely actionable | **MOVE to on-demand** — load via CONTEXT_ROUTING when needed |
| Specific, actionable, non-default | **KEEP** — this is what good instructions look like |

### LAYER vs MOVE

Both defer, but they answer different questions. **MOVE** = the rule is at the right altitude but doesn't need to be resident every session. **LAYER** = the rule is stated at the wrong altitude entirely, so it either leaks into sessions that don't need it or gets restated at several levels at once.

State a rule once, at the most specific layer that governs it:

| Layer | Holds |
|-------|-------|
| System prompt | Product context, where a deployment has one — PAI itself does not; CLAUDE.md is its top layer |
| CLAUDE.md | Repo-specific gotchas the model cannot infer from the code |
| Skill | Team/product opinions, loaded selectively when the work matches |
| Tool description | Guidance about that tool, and nowhere else |

A tool preference restated in CLAUDE.md *and* the tool's own description is LAYER, not MERGE — the fix is deleting the CLAUDE.md copy, not reconciling two peers.

## Anti-Fragile vs Fragile

**Keep (anti-fragile):** Verification harnesses, ISC, data pipelines, routing rules, tool *interface* design (expressive parameter names, enumerated values).

**Cut (fragile):** CoT orchestrators, format parsers, retry cascades, numeric personality scales, abstract value statements, process descriptions that aren't followed.

**Conditional — examples and tool preferences.** Earlier BPE treated "specific DO/DON'T examples" and "tool preferences" as unconditional keeps. On current-generation models they usually aren't, because the model infers from context what a rule used to have to spell out. Keep them only when at least one holds:

- The operation is destructive, irreversible, or safety-critical.
- The preference is a genuine environment gotcha the model cannot infer by looking (a wrapper that isn't the bare binary, a flag that fails only in this setup).
- Failure history shows the model was observably inconsistent here — see the Gotchas note on checking before cutting.

Otherwise convert to judgment framing, which generalizes where an enumerated rule does not. "Match the file's existing comment density, naming, and idiom" survives cases a list of banned constructs never anticipated. For tools specifically, prefer redesigning the interface over documenting its use: a well-named, enumerated parameter teaches usage without spending context or narrowing exploration.

## Output Format

```
## BitterPillEngineering Audit

**Scope:** [what was audited]
**Files read:** [count]
**Rules evaluated:** [count]

### CUT (restating defaults)
- [rule] — [reason]

### RESOLVE (contradictions)
- [rule A] vs [rule B] — [which to keep and why]

### MERGE (redundancies)
- [locations] — [merge into where]

### EVALUATE (one-off fixes)
- [rule] — [still needed? verdict]

### SHARPEN or CUT (vague)
- [rule] — [judgment framing to replace it, or cut why]

### LAYER (wrong altitude)
- [rule] — [current layer] → [correct layer]

### MOVE to on-demand
- [content] — [how often it's actually needed]

### KEEP (carrying weight)
- [rule] — [why it matters]

### Release-affecting (decide separately)
- [rule] — [which released file, why it may read differently downstream]

**Estimated savings:** [lines] lines, ~[tokens] tokens
```

## Execution Log

After completing any workflow, append a single JSONL entry:

```bash
echo '{"ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","skill":"BitterPillEngineering","workflow":"WORKFLOW_USED","input":"8_WORD_SUMMARY","status":"ok|error","duration_s":SECONDS}' >> ~/.claude/PAI/MEMORY/SKILLS/execution.jsonl
```
