#!/usr/bin/env bash
# agy-egress-lockdown.sh — one-time root setup that closes the jailed-agy network gap.
# Companion to AgyJail.ts: without this, the jail runs as you and can reach localhost, the LAN,
# and Tailscale. Once installed, AgyJail.ts detects the wrapper and runs every call as uid `agy`.
# Linux + bubblewrap + nftables + sudo. Tested on Ubuntu with systemd-resolved and ufw active.
#
# Run:   sudo bash PAI/TOOLS/agy-egress-lockdown.sh           (install; idempotent, safe to re-run)
#        sudo bash PAI/TOOLS/agy-egress-lockdown.sh --remove  (undo everything except the copied state)
#
# What it does:
#   1. System user `agy` (no login, no home), primary group `agyjail` (members: agy only).
#   2. Jail root /var/lib/agy-jail owned by YOU, group agyjail, mode 2770: only you and agy can
#      enter it. Inside, agy runs with umask 000 so both sides can read/clean each other's files.
#      You need no new group membership, so no relogin and no Pulse/user-manager restart.
#   3. agy binary copy at /opt/agy/agy, owned by you (AgyJail.ts re-syncs it after `agy update`
#      without sudo; agy only needs read+exec).
#   4. /usr/local/lib/agy-jail/run: `umask 000; exec bwrap "$@"`, the ONLY thing you may run as agy.
#   5. /etc/sudoers.d/agy-jail: you may run that wrapper as agy without a password. Validated with visudo.
#   6. nftables table `inet agy_egress` (its own table; never `flush ruleset`, which would wipe
#      ufw/docker/tailscale rules): packets from uid agy to loopback, RFC1918, CGNAT/Tailscale,
#      link-local, and multicast are rejected, and so is all agy IPv6. DNS (port 53) is allowed
#      to each IPv4 nameserver in /etc/resolv.conf at install time (127.0.0.53 with
#      systemd-resolved). Loaded at boot by agy-egress.service. If your resolvers change, re-run.
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }
OWNER=${SUDO_USER:?"run via sudo from your own account"}
OWNER_HOME=$(getent passwd "$OWNER" | cut -d: -f6)
for bin in /usr/bin/bwrap /usr/sbin/nft /usr/sbin/visudo; do
  [[ -x $bin ]] || { echo "missing $bin (install bubblewrap / nftables / sudo)" >&2; exit 1; }
done
NFT_FILE=/etc/nftables.d/agy-egress.nft
UNIT=/etc/systemd/system/agy-egress.service
WRAPPER=/usr/local/lib/agy-jail/run
SUDOERS=/etc/sudoers.d/agy-jail

if [[ ${1:-} == --remove ]]; then
  systemctl disable --now agy-egress.service 2>/dev/null || true
  nft delete table inet agy_egress 2>/dev/null || true
  rm -f "$UNIT" "$NFT_FILE" "$SUDOERS" "$WRAPPER"
  systemctl daemon-reload
  echo "Removed rules, unit, sudoers, wrapper. Left in place: user agy, /var/lib/agy-jail, /opt/agy."
  echo "Delete those by hand if wanted: userdel agy; groupdel agyjail; rm -rf /var/lib/agy-jail /opt/agy"
  exit 0
fi

# 1. user + group
getent group agyjail >/dev/null || groupadd --system agyjail
id agy &>/dev/null || useradd --system --no-create-home --home-dir /nonexistent \
  --shell /usr/sbin/nologin --gid agyjail agy

# 2. jail root, seeded from the current per-user jail (token + config; brain history not copied)
install -d -o "$OWNER" -g agyjail -m 2770 /var/lib/agy-jail /var/lib/agy-jail/state \
  /var/lib/agy-jail/config /var/lib/agy-jail/config/projects /var/lib/agy-jail/work
OLD="$OWNER_HOME/.local/share/agy-jail"
if [[ -f "$OLD/state/antigravity-oauth-token" && ! -f /var/lib/agy-jail/state/antigravity-oauth-token ]]; then
  install -o agy -g agyjail -m 0600 "$OLD/state/antigravity-oauth-token" /var/lib/agy-jail/state/
fi

# 3. binary copy
install -d -o "$OWNER" -g "$OWNER" -m 0755 /opt/agy
install -o "$OWNER" -g "$OWNER" -m 0755 "$OWNER_HOME/.local/bin/agy" /opt/agy/agy

# 4. wrapper
install -d -o root -g root -m 0755 /usr/local/lib/agy-jail
cat > "$WRAPPER" <<'EOF'
#!/bin/sh
# Runs bwrap as uid agy with umask 000 so the invoking user can read transcripts and clean up.
# Safe because the jail root (/var/lib/agy-jail, 2770) admits only its owner and group agyjail. Installed by agy-egress-lockdown.sh.
umask 000
exec /usr/bin/bwrap "$@"
EOF
chown root:root "$WRAPPER"; chmod 0755 "$WRAPPER"

# 5. sudoers (validated before install)
TMP_SUDO=$(mktemp)
echo "$OWNER ALL=(agy) NOPASSWD: $WRAPPER" > "$TMP_SUDO"
visudo -cf "$TMP_SUDO" >/dev/null
install -o root -g root -m 0440 "$TMP_SUDO" "$SUDOERS"; rm -f "$TMP_SUDO"

# 6. nftables egress table + boot unit
install -d -m 0755 /etc/nftables.d
# DNS: allow port 53 to whatever resolvers this host uses (often private or loopback addresses
# that the reject set below would otherwise block).
DNS4=$(awk '$1 == "nameserver" && $2 ~ /^[0-9.]+$/ { print $2 }' /etc/resolv.conf | sort -u | paste -sd, -)
awk '$1 == "nameserver" && $2 ~ /:/ { found = 1 } END { exit !found }' /etc/resolv.conf &&
  echo "warning: IPv6 nameservers in /etc/resolv.conf are unreachable for agy (all agy IPv6 is rejected)" >&2
[[ -n $DNS4 ]] || echo "warning: no IPv4 nameserver in /etc/resolv.conf; agy will have no DNS" >&2
{
  echo "# Egress lockdown for uid agy (jailed Antigravity). Own table only; never flush ruleset."
  echo "# Generated by agy-egress-lockdown.sh; DNS allow-list from /etc/resolv.conf: ${DNS4:-none}"
  echo "table inet agy_egress"
  echo "delete table inet agy_egress"
  echo "table inet agy_egress {"
  echo "  chain output {"
  echo "    type filter hook output priority 0; policy accept;"
  if [[ -n $DNS4 ]]; then
    echo "    meta skuid \"agy\" ip daddr { $DNS4 } udp dport 53 accept"
    echo "    meta skuid \"agy\" ip daddr { $DNS4 } tcp dport 53 accept"
  fi
  echo "    meta skuid \"agy\" ip daddr { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16, 224.0.0.0/4, 240.0.0.0/4 } counter reject"
  echo "    meta skuid \"agy\" meta nfproto ipv6 counter reject"
  echo "  }"
  echo "}"
} > "$NFT_FILE"
chmod 0644 "$NFT_FILE"
cat > "$UNIT" <<EOF
[Unit]
Description=Egress lockdown for jailed agy (uid agy)
After=network-pre.target
Wants=network-pre.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f $NFT_FILE
ExecStop=/usr/sbin/nft delete table inet agy_egress

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now agy-egress.service
systemctl restart agy-egress.service   # reload rules on re-run

echo
echo "Installed. Checks:"
id agy
nft list table inet agy_egress | grep -c reject | xargs echo "reject rules:"
sudo -n -u agy -l "$WRAPPER" >/dev/null 2>&1 || true
echo "No relogin needed. AgyJail.ts switches to uid mode on its next call."
