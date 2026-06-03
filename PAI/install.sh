#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="${HOME}/.claude"

echo ""
echo "═══ secunit install ══════════════════════════════"
echo ""

# 1. Bun
if ! command -v bun &>/dev/null; then
  echo "Installing bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

# 2. Bundle-copy: repo root IS the ~/.claude/ layout
# Copy every top-level item that is not a repo meta file.
# New directories added to the repo appear automatically — no install.sh update needed.
BUNDLE_EXCLUDE=(".git" ".gitignore" ".github" "install.sh" "README.md" "CHANGELOG.md" "LICENSE" "SECURITY.md" "sbom.json" "node_modules" "_assert.sh" "Dockerfile.e2e")

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
