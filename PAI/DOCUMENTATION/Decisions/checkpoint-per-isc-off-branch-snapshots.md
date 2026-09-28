---
name: checkpoint-per-isc-off-branch-snapshots
title: "ISC checkpoints become off-branch snapshots under refs/checkpoints/"
date: 2026-09-27
status: complete
detected: manual
change: "CheckpointPerISC.hook.ts no longer runs `git add -A` + `git commit` on the current branch. It snapshots the whole working tree into a throwaway index and stores the commit at refs/checkpoints/<slug>/<isc-id>. Checkpoint.ts rollback now prints a diff and a path-scoped `git restore` instead of `git reset --hard`, and gains `prune`."
---

## Context

On each ISC checkoff, CheckpointPerISC ran `git add -A` and then `git commit` on the current branch of every allowlisted repo. The allowlist holds only `~/.claude`. The whole-tree snapshot was valuable, because it captures edits made through Bash, subagents and generators, which a scoped add would miss. Landing it on the branch caused four problems:

- **Unrelated changes got swept in.** On 2026-09-27 a checkoff committed 13 unrelated files (Pulse state, marketplace caches, auto-memory) under the subject "ISC-1 (20260808-fix-precompact-handover-gaps)".
- **Other work got captured.** It committed anything already staged, and any half-finished edits from other sessions running in the same repo.
- **Mixed commits couldn't be reverted.** Undoing one ISC's work with `git revert` also undid whatever else rode along in the commit.
- **Rollback was all or nothing.** It suggested `git reset --hard <sha>` over all of `~/.claude`. That also rewinds memory, service state, other sessions' commits and the nightly commit, so in practice nobody could use it.

## Decision

Keep the whole-tree snapshot, but move it off the branch.

- **The hook.** It copies the real index to a temp file and sets `GIT_INDEX_FILE` to it. Then it runs `add -A`, `write-tree`, `commit-tree -p HEAD`, and finally `update-ref refs/checkpoints/<slug>/<isc-id>`. The real index, HEAD and branch are never touched. It snapshots even when the tree is clean, so every checked ISC gets a ref. On the real `~/.claude` this took 62 ms.
- **Rollback.** `Checkpoint.ts rollback` resolves the ref first and falls back to searching commit subjects for older checkpoints that are on the branch. It prints `git diff --stat <sha>` and `git restore --source=<sha> -- <path>`. It is still preview-only.
- **Prune.** `Checkpoint.ts prune [--days N] [--apply]` defaults to a dry run over 30 days. It deletes only the checkpoint refs of ISAs that are complete, abandoned, superseded, or missing.

## Consequences

- **Branch history is intentional again.** It holds only the principal's own commits and the nightly job.
- **Checkpoint refs stay local.** They aren't pushed by default, which suits a local safety net.
- **Adding active-WIP repos to the allowlist is now safe.** Before this change it would have auto-committed their in-progress work.
- **Old checkpoints stay put.** The 191 existing ISC commits on the branch remain and can still be found by `show` and `rollback`.

## Alternatives rejected

- **Stage only the files the session edited.** This loses Bash, subagent and generated edits, which weakens rollback, and those edits are exactly the ones the snapshot exists to catch.
- **`git stash create`.** It skips untracked files.
- **Remove checkpointing altogether.** That throws away a real rollback net just to fix where it was stored.

## Evidence

A throwaway-repo smoke test passed 21/21. With staged, unstaged, untracked and ignored files present, HEAD, the branch commit count and the real index stayed unchanged. The snapshot held the staged, unstaged and untracked changes and left out the ignored file. The ref was created, re-runs were idempotent, `show` and `rollback` found the snapshot, rollback printed no `reset`, and prune dry-run, `--apply` and the active-ISA protection all behaved as intended. Checkpoints on the branch in the old style are still found.
