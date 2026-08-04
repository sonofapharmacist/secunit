# Upgrading from a minimal install

A minimal install gives you the security pipeline and a flat memory file.
Everything else PAI offers is still available — you just have to opt in.
None of it requires undoing the minimal install first.

## Add the Algorithm (structured task execution)

Run the full installer's CLI wizard instead of doing anything by hand:

```bash
bash install.sh
```

It detects the existing `.claude/` directory and layers the Algorithm,
ISA system, and skill library on top rather than overwriting what's there.
Your `MEMORY.md` content is preserved — the full install's memory system
reads flat files as a starting point.

## Add a named assistant identity / voice

Also handled by the CLI wizard (`bash install.sh`) — it's the DA-naming
and voice steps that the minimal install explicitly skips. Run it whenever
you're ready; there's no time limit on when you're "supposed to" do this.

## Add specific skills without the rest

If you want individual skills (not the full doctrine), copy the relevant
`skills/<SkillName>/` directory from the bundle into `.claude/skills/` and
it'll be picked up next session. Skills are self-contained — they don't
require the Algorithm to function, though some assume it's present and
degrade gracefully if it isn't.

## Nothing here is one-way

Every step above is additive. If a heavier setup doesn't work for how your
team operates, deleting what the wizard added and going back to the
minimal `CLAUDE.md` + `MEMORY.md` is always an option — nothing in the
minimal install depends on staying minimal forever, and nothing in the
full install requires you to have started there.
