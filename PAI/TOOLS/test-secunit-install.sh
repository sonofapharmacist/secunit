#!/usr/bin/env bash
# test-secunit-install.sh — Docker E2E smoke test for secunit
#
# Usage:
#   bun PAI/TOOLS/test-secunit-install.sh              # run dry-run then test
#   bun PAI/TOOLS/test-secunit-install.sh --stage-dir PATH   # reuse existing stage dir
#
# Requirements: docker, bun, python3 (all standard on dev machines)
# The test simulates a fresh machine that already has Claude Code installed
# (pre-existing ~/.claude/settings.json) and runs install.sh end-to-end.
#
# Coverage note: the Docker image is ubuntu:24.04, so this only exercises
# install.sh's apt-get branch for jq/rg/fd/bat. The brew/dnf/pacman branches
# are unexercised by this test — verify manually on macOS/Fedora/Arch before
# relying on them.
set -euo pipefail

CLAUDE_DIR="${HOME}/.claude"
TOOLS_DIR="${CLAUDE_DIR}/PAI/TOOLS"

# ── Step 1: Stage dir ─────────────────────────────────────────────────────────
if [[ "${1:-}" == "--stage-dir" && -d "${2:-}" ]]; then
  STAGE_DIR="$2"
  echo "Using provided stage dir: $STAGE_DIR"
else
  # Run full stage+strip+sanitize (no --push) — node_modules are stripped so Docker context is small.
  # --yes skips the "proceed?" prompt; gates run but SecretScan skips if TruffleHog absent.
  echo "Running release.ts (stage+strip+sanitize) ..."
  STAGE_OUTPUT=$(bun "${TOOLS_DIR}/release.ts" --yes 2>&1)
  echo "$STAGE_OUTPUT"
  # Capture dir from both gate-pass and gate-fail outputs
  STAGE_DIR=$(echo "$STAGE_OUTPUT" | grep -E "Staged output( at)?:" | tail -1 | awk '{print $NF}')
  if [[ -z "${STAGE_DIR:-}" || ! -d "$STAGE_DIR" ]]; then
    echo "[FAIL] Could not determine stage dir from release output" >&2
    exit 1
  fi
  echo "Stage dir: $STAGE_DIR"
fi

# ── Step 2: Copy stage dir to a clean test context (never pollute the original) ──
TEST_CTX=$(mktemp -d)
cp -r "${STAGE_DIR}/." "${TEST_CTX}/"
STAGE_DIR="$TEST_CTX"
echo "Test context: $TEST_CTX"

# Write assert.sh and Dockerfile.e2e into the test context (not the original stage dir)
cat > "${STAGE_DIR}/_assert.sh" << 'ASSERT_EOF'
#!/usr/bin/env bash
set -uo pipefail
PASS=0; FAIL=0

ok() { echo "  ✓ $1"; PASS=$((PASS+1)); }
no() { echo "  ✗ $1"; FAIL=$((FAIL+1)); }
chk() { local label="$1" cond="$2"; if eval "$cond" 2>/dev/null; then ok "$label"; else no "$label"; fi; }

# ── Simulate pre-existing Claude Code install ─────────────────────────────────
mkdir -p /root/.claude
echo '{"version":"1.0.0","theme":"dark","numStartups":3}' > /root/.claude/settings.json

echo ""
echo "─── Running install.sh ───"
# Sourced (not `bash install.sh`) so the PATH exports install.sh makes for rtk/fd
# land in this shell too — needed for the system-tool assertions below to see them.
# install.sh sets `set -e`; restore this script's own -uo pipefail-only mode right
# after so a single failed `chk` can't abort the rest of the assertion run.
source /secunit/install.sh
set -uo pipefail
echo ""
echo "─── Assertions ───"

# --- settings.json ---
chk "settings: existing fields preserved (theme)" \
  "python3 -c \"import json; d=json.load(open('/root/.claude/settings.json')); assert d.get('theme')=='dark'\""
chk "settings: pai.version present" \
  "python3 -c \"import json; d=json.load(open('/root/.claude/settings.json')); v=d.get('pai',{}).get('version',''); assert v\""
chk "settings: pai.algorithmVersion present" \
  "python3 -c \"import json; d=json.load(open('/root/.claude/settings.json')); v=d.get('pai',{}).get('algorithmVersion',''); assert v\""

# --- Public skills ---
for s in Interview Knowledge Research ISA Agents Council Telos Aphorisms Delegation \
          BitterPillEngineering Prompting RedTeam Science SystemsThinking WorldThreatModel \
          FirstPrinciples IterativeDepth ApertureOscillation ExtractWisdom Ideate; do
  chk "skills/$s present" "[ -d /root/.claude/skills/$s ]"
done

# --- Private skills absent ---
for s in Recon TabletopExercise app-security-assessment esi-branded-docx _ARCHIVE app_best_practice; do
  chk "skills/$s absent" "[ ! -e /root/.claude/skills/$s ]"
done

# --- Skill count ---
N=$(ls -d /root/.claude/skills/*/ 2>/dev/null | wc -l || echo 0)
chk "skill count $N >= 40" "[ $N -ge 40 ]"

# --- USER scaffold ---
chk "PAI/USER/PrincipalIdentity.md" "[ -f /root/.claude/PAI/USER/PrincipalIdentity.md ]"
chk "PAI/USER/Config/PAI_CONFIG.example.yaml" "[ -f /root/.claude/PAI/USER/Config/PAI_CONFIG.example.yaml ]"
chk "PAI/USER/Config/inference-routing.yaml" "[ -f /root/.claude/PAI/USER/Config/inference-routing.yaml ]"
chk "PAI/USER/Config/skill-routing.yaml" "[ -f /root/.claude/PAI/USER/Config/skill-routing.yaml ]"

# --- Hooks ---
chk "hooks/ present" "[ -d /root/.claude/hooks ]"
NH=$(ls /root/.claude/hooks/*.ts 2>/dev/null | wc -l || echo 0)
chk "hook TS files $NH >= 5" "[ $NH -ge 5 ]"
chk "hooks/node_modules" "[ -d /root/.claude/hooks/node_modules ]"

# --- PAI/TOOLS ---
chk "PAI/TOOLS/node_modules" "[ -d /root/.claude/PAI/TOOLS/node_modules ]"

# --- Key files ---
chk "PAI/statusline-command.sh" "[ -f /root/.claude/PAI/statusline-command.sh ]"
chk "PAI/ALGORITHM/LATEST" "[ -f /root/.claude/PAI/ALGORITHM/LATEST ]"
chk "install.sh executable" "[ -x /secunit/install.sh ]"

# --- System tools (installed by install.sh 1b, default path — no SECUNIT_SKIP_TOOLS) ---
# fd/bat land as fd/fd-find/bat on Debian; fd's binary is fdfind, symlinked to fd by install.sh.
chk "jq installed" "command -v jq"
chk "rtk installed" "command -v rtk"
chk "rg (ripgrep) installed" "command -v rg"
chk "fd installed (or fdfind symlinked)" "command -v fd || command -v fdfind"
chk "bat installed (or batcat)" "command -v bat || command -v batcat"

# --- Aphorisms: release seed swap ---
chk "Aphorisms DB present" "[ -f /root/.claude/skills/Aphorisms/Database/aphorisms.md ]"
chk "Aphorisms release seed stripped" "[ ! -f /root/.claude/skills/Aphorisms/Database/aphorisms-release.md ]"

# --- No private content leaked ---
chk "no USER/SECURITY in PAI" "[ ! -f /root/.claude/PAI/USER/SECURITY/PATTERNS.yaml ]"
chk "MEMORY is empty scaffold" "[ ! -d /root/.claude/PAI/MEMORY/WORK ]"
chk "PLANS stripped" "[ ! -d /root/.claude/PAI/PLANS ]"

# --- Print summary ---
echo ""
PAI_VER=$(python3 -c "import json; d=json.load(open('/root/.claude/settings.json')); print(d.get('pai',{}).get('version','?'))" 2>/dev/null || echo "?")
ALGO_VER=$(python3 -c "import json; d=json.load(open('/root/.claude/settings.json')); print(d.get('pai',{}).get('algorithmVersion','?'))" 2>/dev/null || echo "?")
echo "  pai.version=$PAI_VER  algorithmVersion=$ALGO_VER  skills=$N  hooks=$NH"
echo ""
echo "Result: $PASS passed, $FAIL failed"
if [ $FAIL -eq 0 ]; then
  echo "✅ All assertions passed"
  exit 0
else
  echo "❌ Assertions FAILED"
  exit 1
fi
ASSERT_EOF
chmod +x "${STAGE_DIR}/_assert.sh"

# ── Second assertion script: SECUNIT_SKIP_TOOLS=1 path ────────────────────────
# Confirms the opt-out actually skips tool installation (rather than silently
# installing anyway) and that the rest of install.sh still completes normally.
cat > "${STAGE_DIR}/_assert_skip.sh" << 'ASSERT_SKIP_EOF'
#!/usr/bin/env bash
set -uo pipefail
PASS=0; FAIL=0

ok() { echo "  ✓ $1"; PASS=$((PASS+1)); }
no() { echo "  ✗ $1"; FAIL=$((FAIL+1)); }
chk() { local label="$1" cond="$2"; if eval "$cond" 2>/dev/null; then ok "$label"; else no "$label"; fi; }

mkdir -p /root/.claude
echo '{"version":"1.0.0","theme":"dark","numStartups":3}' > /root/.claude/settings.json

echo ""
echo "─── Running install.sh (SECUNIT_SKIP_TOOLS=1) ───"
export SECUNIT_SKIP_TOOLS=1
source /secunit/install.sh
set -uo pipefail
echo ""
echo "─── Assertions ───"

chk "jq NOT installed" "! command -v jq"
chk "rtk NOT installed" "! command -v rtk"
chk "rg NOT installed" "! command -v rg"
chk "fd NOT installed" "! command -v fd && ! command -v fdfind"
chk "bat NOT installed" "! command -v bat && ! command -v batcat"

# Rest of install.sh must still complete despite the tool skip.
chk "skills/ still installed" "[ -d /root/.claude/skills ]"
chk "PAI/USER scaffold still created" "[ -f /root/.claude/PAI/USER/PrincipalIdentity.md ]"
chk "hooks/node_modules still installed" "[ -d /root/.claude/hooks/node_modules ]"

echo ""
echo "Result: $PASS passed, $FAIL failed"
if [ $FAIL -eq 0 ]; then
  echo "✅ All assertions passed"
  exit 0
else
  echo "❌ Assertions FAILED"
  exit 1
fi
ASSERT_SKIP_EOF
chmod +x "${STAGE_DIR}/_assert_skip.sh"

# ── Step 3: Dockerfile ────────────────────────────────────────────────────────
cat > "${STAGE_DIR}/Dockerfile.e2e" << 'DOCKERFILE_EOF'
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -qq && \
    apt-get install -y -qq curl git python3 unzip ca-certificates 2>/dev/null && \
    rm -rf /var/lib/apt/lists/*

# Install bun (needed by install.sh step 1; pre-install here so it's cached)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

# Copy staged secunit release (this IS the secunit repo root)
COPY . /secunit/
RUN chmod +x /secunit/install.sh /secunit/_assert.sh /secunit/_assert_skip.sh

WORKDIR /root
CMD ["/secunit/_assert.sh"]
DOCKERFILE_EOF

# ── Step 4: Build ─────────────────────────────────────────────────────────────
IMAGE="secunit-e2e:$(date +%s)"
echo ""
echo "═══ Building Docker test image ═══"
docker build -t "$IMAGE" -f "${STAGE_DIR}/Dockerfile.e2e" "$STAGE_DIR"
echo "  ✓ Image built: $IMAGE"

# ── Step 5: Run (default path — tools installed) ─────────────────────────────
echo ""
echo "═══ Running E2E test: default (tools installed) ═══"
EXIT_CODE=0
docker run --rm "$IMAGE" || EXIT_CODE=$?

# ── Step 6: Run (opt-out path — SECUNIT_SKIP_TOOLS=1) ────────────────────────
# Fresh container each run (docker run --rm), so no state leaks between the two.
echo ""
echo "═══ Running E2E test: SECUNIT_SKIP_TOOLS=1 (tools skipped) ═══"
SKIP_EXIT_CODE=0
docker run --rm --entrypoint /secunit/_assert_skip.sh "$IMAGE" || SKIP_EXIT_CODE=$?

# Cleanup
docker rmi --force "$IMAGE" >/dev/null 2>&1 || true
rm -rf "$TEST_CTX"

echo ""
if [ $EXIT_CODE -eq 0 ] && [ $SKIP_EXIT_CODE -eq 0 ]; then
  echo "═══ ✅ E2E test PASSED (both default and skip paths) ═══"
else
  echo "═══ ❌ E2E test FAILED (default exit $EXIT_CODE, skip exit $SKIP_EXIT_CODE) ═══"
  exit 1
fi
