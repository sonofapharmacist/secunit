# Chain Workflow

Sequences `Verify` after another skill (`code-review` or `simplify`) so a check-and-fix loop runs end-to-end with no human approving intermediate stages.

## When to invoke

- "run code-review then verify the fixes"
- "simplify this, then check it against the rule"
- Any request for an unattended, multi-stage check-and-fix pass on the same target.

## The chain pattern

Each stage is a literal `Skill(...)` tool call — never a description of what a stage "would" do. The output of one stage becomes the target for the next.

```
Skill("code-review")                          # or Skill("simplify")
  → produces edits / findings on <target>
Skill("Verify", "check rule <rule> on <target>")
  → runs Workflows/CheckRules.md against the post-edit target
  → reports PASS/FAIL with literal command output
```

### Two-stage example: simplify → verify

```
1. Skill("simplify")                          # applies simplification edits to <target>
2. Skill("Verify", "check that <target> has no leftover console.log after simplify, target=<target>")
```

### Three-stage example (article's cited pattern): code-review → simplify → verify

```
1. Skill("code-review")                       # produces findings/fixes on <target>
2. Skill("simplify")                          # cleans up the result
3. Skill("Verify", "check rule <rule> on <target>")
```

## Procedure

### Step 1 — Confirm every stage is a real Skill() call

Before running the chain, name each stage and its exact `Skill(...)` invocation. If a stage can't be named as a real skill call, it doesn't belong in the chain — narrating a stage instead of invoking it is the exact failure mode this workflow exists to prevent.

### Step 2 — Run stages in sequence, waiting for each to complete

Do not parallelize a chain — each stage depends on the previous stage's output as its target.

### Step 3 — Terminal stage is always `Verify`

The chain's last stage MUST be a `Verify` (`CheckRules.md`) call so the loop ends in a tool-verified pass/fail, not in "the prior skill said it was done."

### Step 4 — Report the full chain result

```
🔗 CHAIN RESULT: [stage 1] → [stage 2] → ... → Verify
  [stage 1]: [one-line outcome]
  [stage 2]: [one-line outcome]
  Verify: PASS | FAIL — [probe + output]
```

## Failure modes

- **A stage is narrated instead of invoked.** If the transcript doesn't show a literal `Skill()` tool call for a stage, the chain is not proven — re-run it for real before reporting a result.
- **Chain ends on a non-Verify stage.** A chain that ends on `code-review` or `simplify` alone has no tool-verified pass/fail — always terminate on `Verify`.
- **Target drifts between stages.** If stage 2 operates on a different file than stage 1 touched, the chain is broken — confirm the target path is identical (or an explicitly intended superset) across stages.
