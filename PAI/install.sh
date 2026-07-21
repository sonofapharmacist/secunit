#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="${HOME}/.claude"

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

# 2b. Ensure pai.* fields are in settings.json.
# The bundle-copy above skips settings.json if ~/.claude/settings.json already exists
# (which it does on any machine that has Claude Code installed). Merge pai.* explicitly
# so pai.version / algorithmVersion / repoUrl always land regardless of prior state.
SETTINGS_TEMPLATE="${REPO_ROOT}/settings.json"
SETTINGS_DEST="${CLAUDE_DIR}/settings.json"
if [ -f "$SETTINGS_TEMPLATE" ] && [ -f "$SETTINGS_DEST" ]; then
  python3 - "$SETTINGS_DEST" "$SETTINGS_TEMPLATE" << 'PYEOF'
import sys, json
dest_path, tmpl_path = sys.argv[1], sys.argv[2]
dest = json.load(open(dest_path))
tmpl = json.load(open(tmpl_path))
dest['pai'] = tmpl.get('pai', {})
with open(dest_path, 'w') as f:
    f.write(json.dumps(dest, indent=2) + '\n')
PYEOF
  echo "✓ settings.json — pai.* fields merged from secunit template"
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

echo ""
echo "═══ Done ════════════════════════════════════════"
echo ""
echo "Next steps:"
echo "  Open Claude Code and run /interview to set up your identity and DA."
echo ""
