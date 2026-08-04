#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Install target. PAI_INSTALL_ROOT redirects the whole install to a scratch directory so
# the installer can be smoke-tested without touching a real ~/.claude. Unset (the normal
# case) behaves exactly as before. Only the root is redirected — the ".claude" suffix is
# always appended, so a test run lands at $PAI_INSTALL_ROOT/.claude and nothing else moves.
CLAUDE_DIR="${PAI_INSTALL_ROOT:-$HOME}/.claude"
mkdir -p "$CLAUDE_DIR"

# Package-manager installs need root. Use sudo if present and we're not already root;
# otherwise run bare (covers containers/CI, which are commonly root with no sudo binary).
SUDO=""
if [ "$(id -u)" -ne 0 ] && command -v sudo &>/dev/null; then
  SUDO="sudo"
fi

echo ""
echo "═══ secunit install ══════════════════════════════"
echo ""

# 1. Bun
if ! command -v bun &>/dev/null; then
  echo "Installing bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

# 1b. System tools PAI's hooks and skills shell out to.
# jq/rtk are hard dependencies (hooks/ContextReduction.hook.sh fails open — silently
# skips its rewrite — if either is missing). rg/fd/bat are CLAUDE.md tool preferences,
# not hook-enforced, but installed here so a fresh machine matches the documented
# experience instead of silently falling back to slower builtins.
#
# Opt out with SECUNIT_SKIP_TOOLS=1 (checked first, no prompt either way — for CI/
# scripted installs), or by answering "n" at the interactive prompt below (only
# shown when stdin is a TTY, so piped/sourced/non-interactive runs never hang).
echo ""
echo "── System tools ──"
echo "install.sh can install these system tools if missing:"
echo "  rtk   — Rust Token Killer, rewrites noisy Bash output (git log, ls, grep) to"
echo "          cut tokens spent on tool-call results. Without it: hooks/ContextReduction.hook.sh"
echo "          silently no-ops — Bash output goes into context uncompressed."
echo "  jq    — JSON parsing used by hooks/ContextReduction.hook.sh and others. Without"
echo "          it: same hook no-op as above (rtk needs jq to parse the hook payload)."
echo "  rg    — ripgrep, CLAUDE.md's preferred grep for Bash-issued commands. Without"
echo "          it: falls back to grep -E, functionally fine, just slower on large trees."
echo "  fd    — CLAUDE.md's preferred find for Bash-issued commands. Without it: falls"
echo "          back to find, functionally fine, just slower and less ergonomic."
echo "  bat   — CLAUDE.md's preferred cat for Bash-issued commands. Without it: falls"
echo "          back to plain cat, loses syntax highlighting only."
echo ""

INSTALL_TOOLS=1
if [ -n "${SECUNIT_SKIP_TOOLS:-}" ]; then
  INSTALL_TOOLS=0
  echo "SECUNIT_SKIP_TOOLS set — skipping system tool install."
elif [ -t 0 ]; then
  read -r -p "Install these tools now? [Y/n] " REPLY
  case "$REPLY" in
    [nN]*) INSTALL_TOOLS=0 ;;
  esac
fi

if [ "$INSTALL_TOOLS" -eq 0 ]; then
  echo "Skipped. PAI will still work — degraded as noted above wherever a skipped tool is used."
else
echo "Checking system tools..."

# rtk — official installer, no sudo, matches the bun pattern above.
if ! command -v rtk &>/dev/null; then
  echo "Installing rtk..."
  curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
fi

# jq/ripgrep/fd/bat — package-manager installed. Detect apt/brew/dnf/pacman; skip with
# a warning on anything else rather than guessing at a package name.
MISSING_PKG_TOOLS=()
command -v jq &>/dev/null || MISSING_PKG_TOOLS+=("jq")
command -v rg &>/dev/null || MISSING_PKG_TOOLS+=("rg")
if ! command -v fd &>/dev/null && ! command -v fdfind &>/dev/null; then
  MISSING_PKG_TOOLS+=("fd")
fi
command -v bat &>/dev/null || command -v batcat &>/dev/null || MISSING_PKG_TOOLS+=("bat")

if [ "${#MISSING_PKG_TOOLS[@]}" -gt 0 ]; then
  echo "Installing missing tools: ${MISSING_PKG_TOOLS[*]}"
  if command -v apt-get &>/dev/null; then
    # Package names diverge from binary names on Debian/Ubuntu: fd -> fd-find (binary
    # is fdfind), bat stays bat. Build the apt package list from the missing-tool list.
    APT_PKGS=()
    for t in "${MISSING_PKG_TOOLS[@]}"; do
      case "$t" in
        rg) APT_PKGS+=("ripgrep") ;;
        fd) APT_PKGS+=("fd-find") ;;
        *) APT_PKGS+=("$t") ;;
      esac
    done
    $SUDO apt-get update -qq && $SUDO apt-get install -y -qq "${APT_PKGS[@]}"
  elif command -v brew &>/dev/null; then
    BREW_PKGS=()
    for t in "${MISSING_PKG_TOOLS[@]}"; do
      case "$t" in
        rg) BREW_PKGS+=("ripgrep") ;;
        *) BREW_PKGS+=("$t") ;;
      esac
    done
    brew install "${BREW_PKGS[@]}"
  elif command -v dnf &>/dev/null; then
    DNF_PKGS=()
    for t in "${MISSING_PKG_TOOLS[@]}"; do
      case "$t" in
        rg) DNF_PKGS+=("ripgrep") ;;
        *) DNF_PKGS+=("$t") ;;
      esac
    done
    $SUDO dnf install -y "${DNF_PKGS[@]}"
  elif command -v pacman &>/dev/null; then
    PACMAN_PKGS=()
    for t in "${MISSING_PKG_TOOLS[@]}"; do
      case "$t" in
        rg) PACMAN_PKGS+=("ripgrep") ;;
        *) PACMAN_PKGS+=("$t") ;;
      esac
    done
    $SUDO pacman -Sy --noconfirm "${PACMAN_PKGS[@]}"
  else
    echo "⚠ No known package manager (apt/brew/dnf/pacman) found."
    echo "  Install these manually for full functionality: ${MISSING_PKG_TOOLS[*]}"
  fi

  # Debian/Ubuntu installs fd-find's binary as fdfind, not fd — symlink it so PAI's
  # `fd` references resolve without every caller needing to know the rename.
  if ! command -v fd &>/dev/null && command -v fdfind &>/dev/null; then
    mkdir -p "$HOME/.local/bin"
    ln -sf "$(command -v fdfind)" "$HOME/.local/bin/fd"
    export PATH="$HOME/.local/bin:$PATH"
    echo "✓ fdfind → ~/.local/bin/fd (symlink)"
  fi
fi

echo "✓ System tools: $(command -v rtk &>/dev/null && echo -n 'rtk ')$(command -v jq &>/dev/null && echo -n 'jq ')$(command -v rg &>/dev/null && echo -n 'rg ')$( (command -v fd || command -v fdfind) &>/dev/null && echo -n 'fd ')$( (command -v bat || command -v batcat) &>/dev/null && echo -n 'bat')"
fi

# 2. Bundle-copy: repo root IS the ~/.claude/ layout
# Copy every top-level item that is not a repo meta file.
# New directories added to the repo appear automatically — no install.sh update needed.
BUNDLE_EXCLUDE=(".git" ".gitignore" ".github" "install.sh" "README.md" "CHANGELOG.md" "LICENSE" "SECURITY.md" "sbom.json" "node_modules" "_assert.sh" "_assert_skip.sh" "Dockerfile.e2e")

for src in "${REPO_ROOT}"/*; do
  name=$(basename "$src")
  skip=false
  for excl in "${BUNDLE_EXCLUDE[@]}"; do
    [[ "$name" == "$excl" ]] && skip=true && break
  done
  $skip && continue

  dest="${CLAUDE_DIR}/${name}"
  if [ -d "$src" ]; then
    if [ -d "$dest" ]; then
      echo "✓ ~/.claude/${name}/ already exists — skipped"
    else
      cp -r "${src}" "${dest}"
      echo "✓ ${name}/ → ~/.claude/${name}/"
    fi
  elif [ -f "$src" ]; then
    if [ -f "$dest" ]; then
      echo "✓ ~/.claude/${name} already exists — skipped"
    else
      cp "${src}" "${dest}"
      echo "✓ ${name} → ~/.claude/${name}"
    fi
  fi
done

# 2b. Merge the secunit settings.json template into the user's settings.json.
#
# The bundle-copy above is skip-if-exists, which is correct for user-authored files like
# CLAUDE.md (clobbering would destroy their work) but WRONG for settings.json: on any
# machine with Claude Code installed — which the README requires — settings.json already
# exists, so the skip silently dropped the entire secunit config. Every hook registration
# (58 across 13 events), statusLine, env, contextFiles and ~30 other keys were lost while
# the installer still printed "Done" and exited 0.
#
# Merge policy, deliberately asymmetric by key ownership:
#   - MACHINE-OWNED keys (hooks, statusLine, spinnerVerbs, ...) are secunit's to define.
#     The template wins; these are what make the harness function.
#   - USER-OWNED keys (model, permissions, theme, and anything else the user set that the
#     template doesn't define) are never touched.
#   - permissions is explicitly user-owned and never merged: silently unioning allow-lists
#     would widen a user's security posture without consent.
SETTINGS_TEMPLATE="${REPO_ROOT}/settings.json"
SETTINGS_DEST="${CLAUDE_DIR}/settings.json"
if [ -f "$SETTINGS_TEMPLATE" ] && [ -f "$SETTINGS_DEST" ]; then
  cp "$SETTINGS_DEST" "${SETTINGS_DEST}.secunit-backup"
  python3 - "$SETTINGS_DEST" "$SETTINGS_TEMPLATE" << 'PYEOF'
import sys, json

dest_path, tmpl_path = sys.argv[1], sys.argv[2]
with open(dest_path) as f:
    dest = json.load(f)
with open(tmpl_path) as f:
    tmpl = json.load(f)

# Keys secunit owns outright — the harness does not function without them, so the
# template is authoritative and overwrites whatever was there.
MACHINE_OWNED = {
    "hooks", "statusLine", "spinnerVerbs", "spinnerTipsOverride", "contextFiles",
    "_contextFiles_docs", "observability", "loadAtStartup", "dynamicContext",
    "postCompactRestore", "allowedHttpHookUrls", "httpHookAllowedEnvVars",
    "pai", "$schema",
}

# Keys that belong to the user even when the template also defines them. permissions is
# here on purpose: merging allow-lists would widen the user's security posture silently.
USER_OWNED = {"permissions", "model", "theme"}

# Maps where both sides have legitimate entries. Replacing these wholesale would be the
# same bug this merge exists to fix: a user's custom env vars (API keys, PATH overrides,
# DEBUG flags) must survive, while secunit's required vars still land. Template wins only
# on a genuine key collision.
DEEP_MERGED = {"env"}

changed = []
for key, value in tmpl.items():
    if key in USER_OWNED:
        continue
    if key in DEEP_MERGED and isinstance(value, dict):
        existing = dest.get(key)
        merged = dict(existing) if isinstance(existing, dict) else {}
        merged.update(value)
        if merged != existing:
            dest[key] = merged
            changed.append(key)
    elif key in MACHINE_OWNED:
        if dest.get(key) != value:
            dest[key] = value
            changed.append(key)
    elif key not in dest:
        # Scaffold keys (daidentity, principal, preferences, ...) seed only when absent,
        # so re-running the installer never overwrites a configured identity.
        dest[key] = value
        changed.append(key)

with open(dest_path, "w") as f:
    f.write(json.dumps(dest, indent=2) + "\n")

hook_events = len(dest.get("hooks", {}))
hook_count = sum(len(m.get("hooks", [])) for arr in dest.get("hooks", {}).values() for m in arr)
print(f"  merged {len(changed)} key(s); {hook_count} hook registrations across {hook_events} events")
PYEOF
  echo "✓ settings.json — secunit template merged (user keys preserved; backup at settings.json.secunit-backup)"
fi

# 3. Dependencies — PAI/TOOLS
echo "Installing PAI/TOOLS dependencies..."
cd "${CLAUDE_DIR}/PAI/TOOLS" && bun install --frozen-lockfile 2>/dev/null || bun install
cd "$REPO_ROOT"

# 4. Dependencies — hooks/
if [ -d "${CLAUDE_DIR}/hooks" ]; then
  echo "Installing hooks/ dependencies..."
  cd "${CLAUDE_DIR}/hooks" && bun install --frozen-lockfile 2>/dev/null || bun install
  cd "$REPO_ROOT"
fi

# 5. USER/ scaffold
USER_DEST="${CLAUDE_DIR}/PAI/USER"
if [ ! -d "$USER_DEST" ]; then
  cp -r "${CLAUDE_DIR}/PAI/TEMPLATES/User" "$USER_DEST"
  echo "✓ USER/ scaffold created"
fi

# 6. Post-install verification.
#
# Copying a file is not the same as the config being in effect. This asserts the outcome
# and exits non-zero when the install is broken, so a silent "Done" can never again cover
# a harness that isn't actually wired up.
echo ""
echo "── Verifying install ──"

VERIFY_FAILED=0

# settings.json exists and actually registers hooks.
if [ -f "$SETTINGS_DEST" ]; then
  HOOK_SUMMARY=$(python3 - "$SETTINGS_DEST" << 'PYEOF'
import sys, json
try:
    with open(sys.argv[1]) as f:
        s = json.load(f)
except Exception as e:
    print(f"INVALID {e}")
    raise SystemExit(0)
hooks = s.get("hooks", {})
events = len(hooks)
count = sum(len(m.get("hooks", [])) for arr in hooks.values() for m in arr)
print(f"{events} {count}")
PYEOF
)
  case "$HOOK_SUMMARY" in
    INVALID*)
      echo "✗ settings.json is not valid JSON — ${HOOK_SUMMARY#INVALID }"
      VERIFY_FAILED=1
      ;;
    *)
      # Parse both numbers and require each to be non-zero. Glob-matching the string
      # (e.g. "0"*) is not sufficient: "1 0" — one event registering zero hooks, which a
      # hand-edit or a partial copy can produce — would slip through as a success.
      HOOK_EVENTS="${HOOK_SUMMARY%% *}"
      HOOK_COUNT="${HOOK_SUMMARY##* }"
      if ! [ "$HOOK_EVENTS" -gt 0 ] 2>/dev/null || ! [ "$HOOK_COUNT" -gt 0 ] 2>/dev/null; then
        echo "✗ settings.json has no hook registrations — the harness will not run."
        echo "  (events=${HOOK_EVENTS:-?}, registrations=${HOOK_COUNT:-?})"
        echo "  Restore your previous config: mv ${SETTINGS_DEST}.secunit-backup ${SETTINGS_DEST}"
        VERIFY_FAILED=1
      else
        echo "✓ settings.json — ${HOOK_EVENTS} hook events, ${HOOK_COUNT} registrations"
      fi
      ;;
  esac
else
  echo "✗ settings.json missing at ${SETTINGS_DEST}"
  VERIFY_FAILED=1
fi

# CLAUDE.md — the operational doctrine the DA reads every session.
if [ -f "${CLAUDE_DIR}/CLAUDE.md" ]; then
  echo "✓ CLAUDE.md present"
else
  echo "✗ CLAUDE.md missing — the DA will start with no operational doctrine."
  VERIFY_FAILED=1
fi

# Core trees.
for d in skills hooks PAI; do
  if [ -d "${CLAUDE_DIR}/${d}" ]; then
    echo "✓ ${d}/ present"
  else
    echo "✗ ${d}/ missing at ${CLAUDE_DIR}/${d}"
    VERIFY_FAILED=1
  fi
done

echo ""
if [ "$VERIFY_FAILED" -ne 0 ]; then
  echo "═══ Install INCOMPLETE ══════════════════════════"
  echo ""
  echo "One or more checks failed above. secunit is not ready to use."
  echo "Re-run this installer, or open an issue with the failed check names."
  echo ""
  exit 1
fi

echo "═══ Done ════════════════════════════════════════"
echo ""
echo "Next steps:"
echo "  1. Open Claude Code:  cd ~/.claude && claude"
echo "  2. Confirm it loaded: ask your DA \"what mode are you in?\" — it should"
echo "     answer with a PAI mode banner, not a plain chat reply."
echo "  3. Run /interview to set up your identity and DA."
echo ""
