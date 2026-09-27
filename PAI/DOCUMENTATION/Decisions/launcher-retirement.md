---
name: launcher-retirement
title: "Retire the pai.ts launcher and logo-wallpaper workflows"
date: 2026-07-25
status: complete
detected: manual
change: "Deleted the unused pai.ts launcher, moved installation to bare Claude Code, and removed its two logo-wallpaper workflow consumers."
---

## Decision

Delete `PAI/TOOLS/pai.ts`. Bare `claude`, started from the PAI installation directory, is the only supported interactive launch path.

Delete `LogoWallpaper.md` and `EmbossedLogoWallpaper.md` from the active Art skill, Art Pack source, and tracked archive. Remove their routes and trigger language from Art and Media surfaces. Their `k -w` wallpaper application behavior is intentionally not preserved.

Remove the installer's `pai` alias creation, alias validation, and post-install alias handoff. Installer completion now launches or instructs `cd ~/.claude && claude` without sourcing an interactive shell startup file.

## Alternatives Rejected

**Keep a reduced compatibility launcher.** Rejected because the principal does not use it, current installation guidance can invoke Claude Code directly, and keeping an unsupported wrapper preserves parser, platform, documentation, and release surfaces without a demonstrated user.

**Extract wallpaper switching into a standalone tool.** Rejected because both workflows that consumed `k -w` are intentionally retired. A new utility would preserve a feature with no remaining supported route.

**Retain a `pai` alias that expands to bare Claude.** Rejected because the alias adds no capability, forces shell-specific installation and validation, risks overwriting user-owned aliases, and makes post-install startup depend on shell RC evaluation.

**Fold this decision into system-prompt retirement.** Rejected because prompt-layer retirement and launcher retirement have different scope, evidence, compatibility effects, and rollback boundaries. The decisions cross-link instead.

## Evidence

- The principal's observed workflow launches bare `claude`; `pai.ts` was not used in normal sessions.
- The wrapper's retired system-prompt option was its only link to the deleted `PAI_SYSTEM_PROMPT.md`; see [system-prompt-retirement](system-prompt-retirement.md).
- Repository inventory found no runtime import of `pai.ts`. Active dependencies were installer alias/handoff code, documentation, a portability-check exception, and the two logo-wallpaper workflows. The installer block and `PAI/TOOLS/LinuxPortabilityCheck.ts` exception were removed with the launcher.
- The installer previously deleted any line matching `^alias pai=.*`, meaning its compatibility surface could remove a user-owned alias before writing its own.
- The active, Pack, and archive wallpaper workflows had diverged, so all copies and their routes were removed explicitly rather than relying on an undocumented synchronization path.
- Cross-vendor Forge inspection and ProofReader review identified the full installer launch contract and Art/Media routing surfaces before execution.

## Consequences

- Fresh installs launch Claude Code directly from `~/.claude`; no `pai` shell alias is created or required.
- Dynamic MCP selection/profiles, resume shorthand, update/version helpers, one-shot prompting, launcher banner behavior, and wallpaper switching formerly bundled in `pai.ts` are not migrated. Native Claude Code commands remain available where they independently cover the same intent.
- A pre-existing user-defined `pai` alias is left untouched because the installer no longer edits shell RC files for this feature.
- Existing PAI-owned aliases on machines already installed are inert compatibility residue after upgrade unless removed manually; preserving user shell content is safer than broad automatic deletion.
- The aspirational Arbol CLI documentation remains explicitly marked never built and not runnable. Its `pai` name is historical design prose, not a supported executable.
- Rollback is available through Git history; no compatibility shim remains in the runtime or release surface.
