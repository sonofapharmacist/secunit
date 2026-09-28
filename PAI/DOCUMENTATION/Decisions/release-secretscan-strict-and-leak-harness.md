# Release SecretScan fails on any finding; release gates get a regression harness

- **Status:** Accepted
- **Date:** 2026-09-28
- **Scope:** `PAI/TOOLS/SecretScan.ts` (`--strict`), `PAI/TOOLS/release.ts` (`runSecretScan`, identifier-gate whitelist), new `PAI/TOOLS/ReleaseLeakTest.ts`

## Context

`release.ts` is the only sanctioned path out of `~/.claude`. Its deterministic gates had no tests; each release was checked by running it and reading the output. A first run of a canary harness against the real pipeline found:

1. **The SecretScan gate was fail-open for unverifiable secrets.** `SecretScan.ts` exits 1 only when TruffleHog verifies a credential live. `release.ts` read exit 0 as "✓ SecretScan: clean". A staged RSA private key was reported "✗ Unverified" and the release passed. The same holds for any token whose service TruffleHog can't reach or that gets rate-limited during verification.
2. **The identifier gate would have blocked the next release on a false positive.** `agy-egress-lockdown.sh` lists reserved CIDR blocks (RFC 1918, RFC 6598 CGNAT) that the Tailscale/LAN IP patterns match.

## Decision

- `SecretScan.ts --strict` exits 1 on **any** finding. `release.ts` always passes `--strict`. The default mode (verified-only) is unchanged for interactive use.
- The three IP patterns whitelist `PAI/TOOLS/agy-egress-lockdown.sh` only. It holds generic reserved ranges; it reads DNS servers from `/etc/resolv.conf` at run time, so no personal address lives in the file.
- `ReleaseLeakTest.ts` becomes the regression check for the release pipeline. It plants canaries in eight private-zone locations and one leak per gate. It must exit 0 after any change to release tooling, and `--mutate-keep-memory` must exit 1 (proves the harness detects a broken strip).

## Consequences

- An unverifiable credential in a public-destined file now blocks release. A TruffleHog false positive would block too; handle one by fixing the file, not by relaxing `--strict`. Today's staged tree has zero findings besides the harness plant.
- The whitelist means a personal IP later added to `agy-egress-lockdown.sh` would not be caught by the identifier gate. Accepted: the file's purpose is a static reserved-range list.
- The harness takes ~150 s (SBOM step) and must not overlap edits to `PAI/`, `skills/`, `hooks/` (shared-inode false positives).

## Alternatives considered

- **`--only-verified` semantics kept, with a warning surfaced to the operator.** Rejected: CLAUDE.md requires security gates to fail closed; a printed warning with a green gate is the fail-open pattern.
- **Harness against a full copy of the tree.** Rejected on disk: `PAI/` is 2.4 GB with 7.5 GB free; copy plus stage ~4.8 GB. The hardlink farm plus unlink-before-write gives the same isolation at inode cost.
