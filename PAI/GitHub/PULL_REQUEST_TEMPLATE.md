**What this changes:**

**Why:**

**How to test:**

**Checklist:**
- [ ] Ran `bun PAI/TOOLS/release.ts` (no `--push`) — all gates pass
- [ ] Hook changes smoke-tested with synthetic stdin (`bun hooks/PromptProcessing.hook.ts < test-input.json`)
- [ ] No personal identifiers in new or modified files
- [ ] If architectural change: ADR present in `PAI/DOCUMENTATION/Decisions/`
