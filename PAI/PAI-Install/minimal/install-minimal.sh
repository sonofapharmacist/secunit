#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════
#  PAI Minimal Installer
#  Copies the security pipeline and a flat memory template
#  into an existing Claude Code project. No identity setup,
#  no DA naming, no voice config, no skill bundle, no
#  Algorithm/ISA doctrine. Land in a working, secured session
#  in one command; grow into the rest later if you want it.
#
#  Usage:
#    install-minimal.sh [--target DIR] [--team-name NAME] [--yes]
#
#  --target DIR      Directory to install into. Defaults to the
#                     current directory.
#  --team-name NAME  Used only to fill the CLAUDE.md template
#                     heading. Defaults to "this team".
#  --yes             Skip all prompts — use flag values or defaults,
#                     no confirmation. For scripted/repeat installs.
#
#  Run with no flags in an interactive terminal and the installer asks
#  for target dir and team name instead of silently defaulting — easier
#  for a first-time user than requiring flag syntax up front. Any flag
#  you DO pass is used as-is and skips its corresponding prompt. --yes
#  skips prompting entirely, for CI or rolling out to the rest of a team
#  that's already validated the defaults.
# ═══════════════════════════════════════════════════════════
set -euo pipefail

# ─── Resolve bundle root (this script's location) ────────────
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
MINIMAL_DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
# PAI/PAI-Install/minimal -> PAI-Install -> PAI -> bundle root (~/.claude).
# Manifest paths (hooks/..., USER/...) are relative to this root, matching
# install.sh's PAI_BUNDLE_DIR convention — NOT relative to PAI/.
BUNDLE_ROOT="$(cd "$MINIMAL_DIR/../../.." && pwd)"
MANIFEST="$MINIMAL_DIR/manifest.json"
TEMPLATES_DIR="$MINIMAL_DIR/templates"

# ─── Defaults ─────────────────────────────────────────────
TARGET_DIR="$(pwd)"
TEAM_NAME="this team"
ASSUME_YES=0
TARGET_DIR_EXPLICIT=0
TEAM_NAME_EXPLICIT=0

# ─── Parse args ───────────────────────────────────────────
# Explicit flags always win and skip their prompt below — the *_EXPLICIT
# tracking is what lets "ran with no flags" and "ran with --yes and no
# flags" both fall back to defaults without re-asking for something the
# user already told us on the command line.
while [ $# -gt 0 ]; do
  case "$1" in
    --target)
      TARGET_DIR="$2"; TARGET_DIR_EXPLICIT=1; shift 2 ;;
    --team-name)
      TEAM_NAME="$2"; TEAM_NAME_EXPLICIT=1; shift 2 ;;
    --yes|-y)
      ASSUME_YES=1; shift ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

info()    { echo "  [i] $1"; }
success() { echo "  [+] $1"; }
warn()    { echo "  [!] $1"; }
error()   { echo "  [x] $1"; }

echo ""
echo "PAI — minimal install"
echo "No identity setup. No DA. No voice. Just the security pipeline"
echo "and a flat memory file."
echo ""

if [ ! -f "$MANIFEST" ]; then
  error "manifest.json not found at $MANIFEST"
  exit 1
fi

# ─── Check for bun (required to run the .hook.ts files) ──
if ! command -v bun &>/dev/null; then
  warn "bun not found — required for the security hooks to run."
  info "Install it first: curl -fsSL https://bun.sh/install | bash"
  exit 1
fi
success "bun found: $(bun --version 2>/dev/null || echo 'unknown')"

# ─── Interactive prompts (skipped by --yes or by passing the flag) ──
# Only prompts for values the user didn't already give on the command
# line, and only when running interactively — `read` on a non-tty (e.g.
# a CI pipe) would hang otherwise, so `[ -t 0 ]` gates every prompt here.
if [ "$ASSUME_YES" -ne 1 ] && [ -t 0 ]; then
  if [ "$TARGET_DIR_EXPLICIT" -ne 1 ]; then
    read -r -p "Install into which directory? [$TARGET_DIR] " REPLY_TARGET
    [ -n "$REPLY_TARGET" ] && TARGET_DIR="$REPLY_TARGET"
  fi

  if [ "$TEAM_NAME_EXPLICIT" -ne 1 ]; then
    read -r -p "Team name (for the CLAUDE.md heading)? [this team] " REPLY_TEAM
    [ -n "$REPLY_TEAM" ] && TEAM_NAME="$REPLY_TEAM"
  fi

  echo ""
  echo "Installing into: $TARGET_DIR"
  echo "Team name:       $TEAM_NAME"
  read -r -p "Proceed? [Y/n] " REPLY_CONFIRM
  case "$REPLY_CONFIRM" in
    [nN]*) echo "Cancelled."; exit 0 ;;
  esac
else
  echo "Installing into: $TARGET_DIR"
fi

# ─── Existing-install guard (runs regardless of --yes) ────────────
# TARGET_DIR defaults to the current directory, and this installer writes
# CLAUDE.md + .claude/settings.json — both of which a real PAI or Claude
# Code project already has. Silently overwriting someone's actual config
# because they ran this from inside ~/.claude (or any configured project)
# is the single worst failure mode this script can have, so this check
# runs even under --yes rather than trusting the confirmation prompt above
# to have caught it — a scripted/unattended run has no prompt to catch it.
if [ -f "$TARGET_DIR/CLAUDE.md" ] || [ -f "$TARGET_DIR/.claude/settings.json" ]; then
  echo ""
  warn "TARGET ALREADY HAS CLAUDE CODE CONFIG:"
  [ -f "$TARGET_DIR/CLAUDE.md" ] && warn "  $TARGET_DIR/CLAUDE.md exists — this WILL be overwritten"
  [ -f "$TARGET_DIR/.claude/settings.json" ] && warn "  $TARGET_DIR/.claude/settings.json exists — this WILL be overwritten"
  echo ""
  read -r -p "Type OVERWRITE to proceed anyway, anything else to cancel: " REPLY_OVERWRITE
  if [ "$REPLY_OVERWRITE" != "OVERWRITE" ]; then
    echo "Cancelled — no files were touched."
    exit 0
  fi
fi

mkdir -p "$TARGET_DIR/.claude"

# ─── Install npm deps the security hooks need (yaml) ──────
# PatternInspector.ts parses PATTERNS.yaml via the `yaml` package. Installed
# into TARGET_DIR/.claude/node_modules so the hooks resolve it the same way
# a full PAI install's ~/.claude/node_modules would.
#
# Deliberately NOT run inside `if (...); then ...; fi` — bash exempts the
# condition of an `if` from `set -e`, so a failing `bun install` piped
# through grep/sed would be silently swallowed there and the script would
# go on to copy a missing or stale node_modules while claiming success.
# Running it as a plain statement lets `set -euo pipefail` do its job, and
# the explicit existence check below is a second, independent guard in
# case `bun install` ever succeeds (exit 0) without actually producing the
# package (e.g. a version mismatch that resolves to nothing installable).
info "Installing hook dependencies (yaml)..."
(cd "$MINIMAL_DIR" && bun install --production --silent) 2>&1 | sed 's/^/      /'
if [ ! -d "$MINIMAL_DIR/node_modules/yaml" ]; then
  error "bun install did not produce node_modules/yaml — cannot proceed."
  exit 1
fi
mkdir -p "$TARGET_DIR/.claude/node_modules"
cp -r "$MINIMAL_DIR/node_modules/." "$TARGET_DIR/.claude/node_modules/"
success "Hook dependencies installed"

# ─── Copy manifest-listed files (hooks + config) ──────────
copy_group() {
  local group="$1"
  local dest_prefix="$2"
  # Reads a top-level JSON array by key without a JSON tool dependency —
  # bun is already a required install-time dependency, so use it here
  # rather than assume jq is present.
  #
  # MANIFEST_PATH/GROUP_KEY/REL_PATH are passed as environment variables
  # and read via process.env inside the script, never interpolated into
  # the JS source string. String-interpolating a shell variable into a
  # `bun -e` script is a JS-injection shape (a manifest path containing a
  # single quote would break out of the string literal) — using env vars
  # closes that off structurally rather than requiring the caller to
  # escape correctly. manifest.json is a file this repo controls, not
  # user input, but there's no reason to leave the fragile pattern in
  # place when the safe one costs nothing extra.
  local files
  files="$(MANIFEST_PATH="$MANIFEST" GROUP_KEY="$group" bun -e "
    const m = require(process.env.MANIFEST_PATH);
    for (const f of (m[process.env.GROUP_KEY] || [])) console.log(f);
  ")"
  while IFS= read -r rel; do
    [ -z "$rel" ] && continue
    local src="$BUNDLE_ROOT/$rel"
    # hook_renames lets a manifest entry install under a different path than
    # it lives at in the bundle — used for SecurityPipeline.minimal.hook.ts,
    # which installs as hooks/SecurityPipeline.hook.ts so settings.json's
    # hook registration doesn't need a minimal-specific variant.
    local dest_rel
    dest_rel="$(MANIFEST_PATH="$MANIFEST" REL_PATH="$rel" bun -e "
      const m = require(process.env.MANIFEST_PATH);
      console.log((m.hook_renames || {})[process.env.REL_PATH] || process.env.REL_PATH);
    ")"
    local dest="$TARGET_DIR/.claude/$dest_rel"
    if [ ! -f "$src" ]; then
      warn "missing from bundle, skipped: $rel"
      continue
    fi
    mkdir -p "$(dirname "$dest")"
    cp "$src" "$dest"
  done <<< "$files"
}

info "Copying security pipeline..."
copy_group "hooks" ""
success "Security pipeline installed ($(MANIFEST_PATH="$MANIFEST" bun -e "console.log(require(process.env.MANIFEST_PATH).hooks.length)") files)"

info "Copying security config..."
copy_group "config" ""
success "Security patterns installed"

# ─── Render templates ─────────────────────────────────────
# TEAM_NAME can come from free-form user input (interactive prompt above),
# so it must be escaped before it reaches sed's replacement text: `&` means
# "the matched text" and `\` is sed's escape char, and the `|` delimiter
# used below would itself break if the value contained a literal `|`.
# Without this, a team name like "R&D" or "Ops | Infra" corrupts the
# rendered file instead of just appearing verbatim.
sed_escape_replacement() {
  printf '%s' "$1" | sed -e 's/[&|\\]/\\&/g'
}

render_template() {
  local template="$1"
  local dest="$2"
  local team_name_escaped
  team_name_escaped="$(sed_escape_replacement "$TEAM_NAME")"
  sed \
    -e "s|{{TEAM_NAME}}|$team_name_escaped|g" \
    -e "s|{{UPGRADE_DOC_PATH}}|PAI-Install/minimal/UPGRADE.md|g" \
    "$template" > "$dest"
}

info "Writing CLAUDE.md, MEMORY.md, settings.json..."
render_template "$TEMPLATES_DIR/CLAUDE.md.template" "$TARGET_DIR/CLAUDE.md"
render_template "$TEMPLATES_DIR/MEMORY.md.template" "$TARGET_DIR/MEMORY.md"
cp "$TEMPLATES_DIR/settings.json.template" "$TARGET_DIR/.claude/settings.json"
success "Config written"

echo ""
echo "Done. What you have:"
echo "  - Security pipeline active (prompt injection, egress, pattern checks)"
echo "  - A flat MEMORY.md you can read/edit directly"
echo "  - A short CLAUDE.md — no persona, no fixed workflow"
echo ""
echo "What you don't have (by design — see PAI-Install/minimal/UPGRADE.md to add any of it):"
echo "  - The Algorithm (structured multi-phase task execution)"
echo "  - ISA (living task/project spec documents)"
echo "  - A named assistant identity or voice"
echo "  - A bundled skill library"
echo ""
echo "Start Claude Code from $TARGET_DIR and just describe what you want done."
