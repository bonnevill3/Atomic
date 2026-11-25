#!/usr/bin/env bash
# cookieswap server setup for a fresh Ubuntu 24.04 server (x86_64 or arm64). Run as root:
#
#   bash setup.sh --domain swap.example.com [--email you@example.com]
#
# Safe to run again: existing keys, wallets and settings are kept, never replaced.
# What it does: see deploy/README.md.
set -euo pipefail

REPO="${COOKIESWAP_REPO:-https://github.com/bonnevill3/Atomic.git}"
BRANCH="${COOKIESWAP_BRANCH:-claude/atomic-swap-xmr-eth-btc-pet5yn}"
APP_USER="${COOKIESWAP_USER:-cookieswap}"
APP_ROOT="${COOKIESWAP_APP_ROOT:-/opt/cookieswap}"        # code: $APP_ROOT/app/cookieswap
DATA="${COOKIESWAP_DATA:-/var/lib/cookieswap}"            # database, backups, secrets/, xmr/
ETC="${COOKIESWAP_ETC:-/etc/cookieswap}"                  # cookieswap.env
OPT="${COOKIESWAP_OPT:-/opt}"                             # node and monero binaries
MONERO_DATA="${COOKIESWAP_MONERO_DATA:-/var/lib/monero}"
BIN="${COOKIESWAP_BIN:-/usr/local/bin}"
BINARYFATE_FPR="81AC591FE9C4B65C5806AFC3F0AF4D462A0BDF92"  # Monero release signing key (binaryFate)

DOMAIN=""
EMAIL=""

log() { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die() { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }
ask() { local _v; read -r -p "$1" _v </dev/tty; printf '%s' "$_v"; }

# Run a command as the service user (root runs this script; runuser needs no sudo setup).
as_app() {
  if [[ "$(id -un)" == "$APP_USER" ]]; then env HOME="$DATA" "$@"
  else runuser -u "$APP_USER" -- env HOME="$DATA" "$@"; fi
}

arch() {
  case "$(uname -m)" in
    x86_64) echo "x64" ;;
    aarch64 | arm64) echo "arm64" ;;
    *) die "unsupported CPU $(uname -m): use an x86_64 or arm64 server" ;;
  esac
}

# ---------------------------------------------------------------------------- preflight
parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --domain) DOMAIN="${2:-}"; shift 2 ;;
      --email) EMAIL="${2:-}"; shift 2 ;;
      -h | --help) sed -n '2,8p' "$0"; exit 0 ;;
      *) die "unknown option $1 (see --help)" ;;
    esac
  done
  [[ "$DOMAIN" =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$ ]] || die "give your domain: --domain swap.example.com (lowercase)"
  [[ -z "$EMAIL" || "$EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || die "--email looks wrong: $EMAIL"
}

preflight() {
  [[ $EUID -eq 0 ]] || die "run as root (sudo -i first)"
  arch >/dev/null
  if ! grep -q 'VERSION_ID="24.04"' /etc/os-release 2>/dev/null; then
    info "warning: tested on Ubuntu 24.04; this is $(. /etc/os-release && echo "$PRETTY_NAME")"
  fi
  local free_gb
  free_gb=$(df -BG --output=avail / | tail -1 | tr -dc 0-9)
  (( free_gb >= 150 )) || info "warning: only ${free_gb} GB free; the pruned Monero node needs about 100 GB and grows"
}

# ---------------------------------------------------------------------------- packages
install_packages() {
  log "Installing system packages"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  local keep=(-o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)
  apt-get upgrade -yq "${keep[@]}"
  apt-get install -yq "${keep[@]}" ca-certificates curl git jq sqlite3 gnupg bzip2 xz-utils openssl ufw fail2ban unattended-upgrades caddy
}

# Node.js 22 (LTS) from nodejs.org, checked against the published SHA-256 list.
install_node() {
  local base="https://nodejs.org/dist/latest-v22.x" a file version tmp
  a="$(arch)"
  tmp="$(mktemp -d)"
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  file="$(grep -oE "node-v22\.[0-9]+\.[0-9]+-linux-$a\.tar\.xz" "$tmp/SHASUMS256.txt" | head -1)"
  [[ -n "$file" ]] || die "no Node.js 22 build for linux-$a"
  version="${file%-linux-*}"
  if [[ -x "$OPT/$version/bin/node" ]]; then
    info "Node.js $version already installed"
  else
    log "Installing Node.js $version"
    curl -fsSL "$base/$file" -o "$tmp/$file"
    (cd "$tmp" && grep " $file\$" SHASUMS256.txt | sha256sum -c --status) || die "Node.js download failed its checksum"
    mkdir -p "$OPT/$version"
    tar -xJf "$tmp/$file" -C "$OPT/$version" --strip-components=1
  fi
  ln -sfn "$OPT/$version" "$OPT/node"
  for b in node npm npx; do ln -sfn "$OPT/node/bin/$b" "$BIN/$b"; done
  rm -rf "$tmp"
}

# Monero CLI from getmonero.org: the hash list must carry binaryFate's signature, and the archive must match it.
install_monero() {
  local a url pattern tmp gnupg file
  case "$(arch)" in x64) url="https://downloads.getmonero.org/cli/linux64"; pattern="monero-linux-x64-v[0-9.]+\.tar\.bz2" ;;
                    arm64) url="https://downloads.getmonero.org/cli/linuxarm8"; pattern="monero-linux-armv8-v[0-9.]+\.tar\.bz2" ;; esac
  tmp="$(mktemp -d)"
  gnupg="$tmp/gnupg"
  mkdir -m 700 "$gnupg"
  curl -fsSL https://raw.githubusercontent.com/monero-project/monero/master/utils/gpg_keys/binaryfate.asc -o "$tmp/binaryfate.asc"
  gpg --homedir "$gnupg" --batch --quiet --import "$tmp/binaryfate.asc" 2>/dev/null
  curl -fsSL https://www.getmonero.org/downloads/hashes.txt -o "$tmp/hashes.txt"
  gpg --homedir "$gnupg" --batch --status-fd 1 --verify "$tmp/hashes.txt" 2>/dev/null | grep -q "VALIDSIG $BINARYFATE_FPR " \
    || die "Monero hashes.txt is not signed by binaryFate ($BINARYFATE_FPR)"
  file="$(grep -oE "$pattern" "$tmp/hashes.txt" | head -1)"
  [[ -n "$file" ]] || die "Monero hash list has no $pattern"
  local version="${file%.tar.bz2}"
  if [[ -x "$OPT/$version/monerod" ]]; then
    info "Monero ${version##*-} already installed"
  else
    log "Installing Monero ${version##*-} (signature verified)"
    curl -fsSL "$url" -o "$tmp/$file"
    local want got
    want="$(grep -E " +$file\$" "$tmp/hashes.txt" | awk '{print $1}' | head -1)"
    got="$(sha256sum "$tmp/$file" | awk '{print $1}')"
    [[ -n "$want" && "$want" == "$got" ]] || die "Monero download does not match the signed hash list"
    mkdir -p "$OPT/$version"
    tar -xjf "$tmp/$file" -C "$OPT/$version" --strip-components=1
  fi
  ln -sfn "$OPT/$version" "$OPT/monero"
  rm -rf "$tmp"
}

# ---------------------------------------------------------------------------- users, code
create_users() {
  log "Creating service users and folders"
  id "$APP_USER" &>/dev/null || useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin "$APP_USER"
  id monero &>/dev/null || useradd --system --home-dir "$MONERO_DATA" --shell /usr/sbin/nologin monero
  install -d -m 700 -o "$APP_USER" -g "$APP_USER" "$DATA" "$DATA/secrets" "$DATA/xmr" "$DATA/backups"
  install -d -m 755 -o "$APP_USER" -g "$APP_USER" "$APP_ROOT"
  install -d -m 750 -o monero -g monero "$MONERO_DATA"
  install -d -m 750 -o root -g "$APP_USER" "$ETC"
}

checkout_app() {
  if [[ -d "$APP_ROOT/app/.git" ]]; then
    info "code already checked out (update with: cookieswap-update)"
  else
    log "Downloading cookieswap ($BRANCH)"
    as_app git clone --quiet --depth 1 --filter=blob:none --sparse --branch "$BRANCH" "$REPO" "$APP_ROOT/app"
    as_app git -C "$APP_ROOT/app" sparse-checkout set cookieswap
  fi
  log "Installing dependencies and running the tests"
  (cd "$APP_ROOT/app/cookieswap" && as_app npm ci --no-audit --no-fund && as_app npx tsc --noEmit && as_app npm test --silent)
}

# ---------------------------------------------------------------------------- keys
# Show a recovery phrase once, make the user prove they wrote it down, then clear the screen.
show_phrase_and_confirm() {
  local title="$1" phrase="$2" words i a b
  read -r -a words <<<"$phrase"
  clear || true
  printf '\n\033[1;31m%s\033[0m\n\n' "WRITE THIS DOWN ON PAPER: $title recovery phrase (${#words[@]} words)"
  printf '    Anyone with these words controls the funds. Never type them into a computer, phone, chat or e-mail.\n\n'
  for i in "${!words[@]}"; do
    printf '    %2d. %-12s' "$((i + 1))" "${words[$i]}"
    (( (i + 1) % 4 == 0 )) && printf '\n'
  done
  printf '\n'
  ask "Press Enter when you have written down all ${#words[@]} words... " >/dev/null
  for _try in 1 2 3; do
    a=$(( RANDOM % ${#words[@]} )); b=$(( (a + 1 + RANDOM % (${#words[@]} - 1)) % ${#words[@]} ))
    clear || true
    if [[ "$(ask "Check: word number $((a + 1)) from your paper: ")" == "${words[$a]}" &&
          "$(ask "Check: word number $((b + 1)) from your paper: ")" == "${words[$b]}" ]]; then
      clear || true
      info "$title recovery phrase confirmed."
      return 0
    fi
    info "That doesn't match. Let's show the words again."
    sleep 2
    clear || true
    for i in "${!words[@]}"; do printf '    %2d. %-12s' "$((i + 1))" "${words[$i]}"; (( (i + 1) % 4 == 0 )) && printf '\n'; done
    ask "Press Enter when your paper is correct... " >/dev/null
  done
  die "phrase not confirmed; run setup again (the phrase is kept, you will see it again)"
}

create_hot_wallet() {
  local f="$DATA/secrets/mnemonic.txt"
  if [[ -f "$f" ]]; then
    info "hot wallet recovery phrase already exists, keeping it"
    chown "$APP_USER:$APP_USER" "$f" && chmod 600 "$f"   # e.g. restored by hand before setup
    [[ -f "$DATA/secrets/.mnemonic-confirmed" ]] && return 0
  else
    log "Creating the hot wallet (BTC, LTC, ETH/EVM, Tron, Solana) on this server"
    (cd "$APP_ROOT/app/cookieswap" && as_app node_modules/.bin/tsx scripts/new-mnemonic.ts "$f")
  fi
  show_phrase_and_confirm "Hot wallet (BTC, LTC, ETH and EVM chains, Tron, Solana)" "$(cat "$f")"
  as_app touch "$DATA/secrets/.mnemonic-confirmed"
}

xmr_rpc() { # method [params-json]
  local params="${2:-}"
  [[ -n "$params" ]] || params='{}'
  curl -fsS --max-time 120 http://127.0.0.1:18089/json_rpc -H 'content-type: application/json' \
    -d "$(jq -cn --arg m "$1" --argjson p "$params" '{jsonrpc: "2.0", id: "0", method: $m, params: $p}')"
}

# A separate Monero wallet with its own 25-word seed, created offline by a temporary wallet-rpc.
create_xmr_wallet() {
  local dir="$DATA/xmr" pw="$DATA/secrets/xmr-wallet-password" pid seed
  if [[ -f "$dir/cookieswap.keys" ]]; then
    info "Monero wallet already exists, keeping it"
    chown -R "$APP_USER:$APP_USER" "$dir"
    [[ -f "$DATA/secrets/.xmr-confirmed" ]] && return 0
  fi
  [[ -f "$pw" ]] || as_app sh -c "umask 077 && openssl rand -hex 32 > '$pw'"
  log "Opening the Monero wallet (offline) to $([[ -f "$dir/cookieswap.keys" ]] && echo "show" || echo "create") its seed"
  as_app "$OPT/monero/monero-wallet-rpc" --offline --non-interactive --disable-rpc-login \
    --rpc-bind-ip 127.0.0.1 --rpc-bind-port 18089 --wallet-dir "$dir" --log-file "$dir/setup-wallet-rpc.log" >/dev/null 2>&1 &
  pid=$!
  for _ in $(seq 1 60); do xmr_rpc get_version >/dev/null 2>&1 && break; sleep 1; done
  xmr_rpc get_version >/dev/null || { kill "$pid" 2>/dev/null; die "monero-wallet-rpc did not start (see $dir/setup-wallet-rpc.log)"; }
  local params
  params="$(jq -cn --rawfile p "$pw" '{filename: "cookieswap", password: ($p | rtrimstr("\n")), language: "English"}')"
  if [[ -f "$dir/cookieswap.keys" ]]; then
    xmr_rpc open_wallet "$(jq -c 'del(.language)' <<<"$params")" | jq -e '.result' >/dev/null || { kill "$pid"; die "could not open the Monero wallet"; }
  else
    xmr_rpc create_wallet "$params" | jq -e '.result' >/dev/null || { kill "$pid"; die "could not create the Monero wallet"; }
  fi
  seed="$(xmr_rpc query_key '{"key_type":"mnemonic"}' | jq -r '.result.key')"
  xmr_rpc stop_wallet >/dev/null || true
  wait "$pid" 2>/dev/null || true
  [[ "$(wc -w <<<"$seed")" -eq 25 ]] || die "unexpected Monero seed format"
  show_phrase_and_confirm "Monero wallet" "$seed"
  as_app touch "$DATA/secrets/.xmr-confirmed"
}

# ---------------------------------------------------------------------------- settings
ask_telegram() {
  local token chat
  printf '\nAlerts: cookieswap messages you on Telegram when an order needs you (large orders, problems).\n'
  printf 'Create a bot with @BotFather, send it any message, then read your chat id at\n'
  printf 'https://api.telegram.org/bot<TOKEN>/getUpdates  ("chat":{"id":...}).\n\n'
  for _try in 1 2 3; do
    token="$(ask "Telegram bot token (Enter to skip for now): ")"
    [[ -z "$token" ]] && return 0
    chat="$(ask "Telegram chat id: ")"
    if [[ ! "$token" =~ ^[0-9]+:[A-Za-z0-9_-]+$ || ! "$chat" =~ ^-?[0-9]+$ ]]; then info "That format is wrong, try again."; continue; fi
    if curl -fsS --max-time 15 "https://api.telegram.org/bot$token/sendMessage" \
         --data-urlencode "chat_id=$chat" --data-urlencode "text=cookieswap setup: alerts work" >/dev/null; then
      TG_TOKEN="$token"; TG_CHAT="$chat"
      info "Test message sent. Check Telegram."
      return 0
    fi
    info "Telegram refused that token/chat id, try again."
  done
}

write_env() {
  local f="$ETC/cookieswap.env"
  if [[ -f "$f" ]]; then info "settings already exist in $f, keeping them"; return 0; fi
  # Set COOKIESWAP_TELEGRAM_BOT_TOKEN and COOKIESWAP_TELEGRAM_CHAT_ID (empty = no Telegram) to skip the questions.
  if [[ -n "${COOKIESWAP_TELEGRAM_BOT_TOKEN+set}" ]]; then
    TG_TOKEN="$COOKIESWAP_TELEGRAM_BOT_TOKEN"; TG_CHAT="${COOKIESWAP_TELEGRAM_CHAT_ID:-}"
  else
    TG_TOKEN=""; TG_CHAT=""
    ask_telegram
  fi
  log "Writing settings to $f"
  umask 027
  cat >"$f" <<EOF
# cookieswap settings. After a change: systemctl restart cookieswap
# Every option with an explanation: $APP_ROOT/app/cookieswap/.env.example

NETWORK=mainnet
CHAINS=live
# Stage 1 (now): DRY_RUN=true moves no funds. Stage 2: set DRY_RUN=false (see deploy/README.md).
DRY_RUN=true
# During the dry run every confirmed deposit waits for you. Set to 1000 when you go live.
MANUAL_REVIEW_USD=0
MAX_ORDER_USD=100

HOST=127.0.0.1
PORT=8080
TRUST_PROXY=1
DB_PATH=$DATA/cookieswap.db
MNEMONIC_FILE=$DATA/secrets/mnemonic.txt
XMR_WALLET_RPC_URL=http://127.0.0.1:18083/json_rpc
ADMIN_TOKEN=$(openssl rand -hex 32)

# Alerts (at least one is required on live chains)
$([[ -n "$TG_TOKEN" ]] && echo "TELEGRAM_BOT_TOKEN=$TG_TOKEN" || echo "#TELEGRAM_BOT_TOKEN=")
$([[ -n "$TG_CHAT" ]] && echo "TELEGRAM_CHAT_ID=$TG_CHAT" || echo "#TELEGRAM_CHAT_ID=")
#ALERT_WEBHOOK_URL=

# Your own RPC keys are more reliable than the public defaults (uncomment and fill in):
#ETH_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
#BASE_RPC_URL=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY
#ARB_RPC_URL=https://arb-mainnet.g.alchemy.com/v2/YOUR_KEY
#POL_RPC_URL=https://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY
#TRONGRID_API_KEY=
#SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
EOF
  umask 022
  chown root:"$APP_USER" "$f"
  chmod 640 "$f"
}

# ---------------------------------------------------------------------------- services, web, host
install_services() {
  log "Installing services"
  local d="$APP_ROOT/app/cookieswap/deploy"
  install -m 644 "$d"/systemd/*.service "$d"/systemd/*.timer /etc/systemd/system/
  install -m 755 "$d/cookieswap-admin" "$d/cookieswap-backup" "$d/cookieswap-update" "$BIN/"
  systemctl daemon-reload
  systemctl enable --now monerod.service
  systemctl enable --now monero-wallet-rpc.service
  systemctl enable --now cookieswap-backup.timer
  systemctl enable cookieswap.service
  if grep -qE '^(TELEGRAM_BOT_TOKEN|ALERT_WEBHOOK_URL)=' "$ETC/cookieswap.env"; then
    systemctl restart cookieswap.service
  else
    info "cookieswap is not started yet: it needs an alert channel (see the end of this output)."
  fi
}

configure_caddy() {
  log "Configuring HTTPS for $DOMAIN"
  local tpl="$APP_ROOT/app/cookieswap/deploy/Caddyfile.template"
  {
    [[ -n "$EMAIL" ]] && printf '{\n\temail %s\n}\n\n' "$EMAIL"
    sed "s/__DOMAIN__/$DOMAIN/" "$tpl"
  } >/etc/caddy/Caddyfile
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
  systemctl enable caddy
  systemctl reload-or-restart caddy
  local ips
  ips="$(hostname -I)"
  if ! getent ahosts "$DOMAIN" | awk '{print $1}' | grep -qxF -f <(tr ' ' '\n' <<<"$ips" | sed '/^$/d'); then
    info "note: $DOMAIN does not point to this server yet. Add a DNS A record for this server's public IP;"
    info "HTTPS starts working by itself once it resolves."
  fi
}

harden_host() {
  log "Firewall, automatic security updates, brute-force protection"
  local ssh_port
  ssh_port="$(sshd -T 2>/dev/null | awk '/^port /{print $2; exit}')"
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  ufw allow "${ssh_port:-22}/tcp" >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null
  info "firewall: only SSH (${ssh_port:-22}), 80 and 443 are open"
  printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' >/etc/apt/apt.conf.d/20auto-upgrades
  systemctl enable --now unattended-upgrades fail2ban >/dev/null 2>&1
  # Passwords off for SSH only when the account you logged in with has a key, so nobody gets locked out.
  # "01-": sshd uses the first value it reads, and cloud images ship 50-cloud-init.conf with passwords on.
  local login_home
  login_home="$(getent passwd "${SUDO_USER:-root}" | cut -d: -f6)"
  if [[ -s "$login_home/.ssh/authorized_keys" ]]; then
    printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\n' >/etc/ssh/sshd_config.d/01-cookieswap.conf
    sshd -t
    systemctl try-reload-or-restart ssh
    info "SSH: key login only"
  else
    info "warning: no SSH key for ${SUDO_USER:-root}, so password login stays on. Add an SSH key and run setup again."
  fi
}

summary() {
  local started
  started="$(systemctl is-active cookieswap 2>/dev/null || true)"
  cat <<EOF

========================================================================================
 cookieswap is installed.            https://$DOMAIN   (dry run: no funds move yet)
========================================================================================

 1. DNS        Point $DOMAIN (A record) to this server. HTTPS starts by itself.
 2. Monero     The node is syncing; that takes 1-3 days. Progress: /opt/monero/monerod status
$([[ "$started" == "active" ]] && echo " 3. Alerts     Telegram is set up." || echo " 3. Alerts     Add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to $ETC/cookieswap.env,
               then: systemctl restart cookieswap")
 4. Fund       Send a little working money to the addresses from:  cookieswap-admin addresses
 5. Dry run    Make a small swap on the site yourself. It is detected, double-checked and held
               for you (Telegram alert). Watch:  journalctl -u cookieswap -f
 6. Go live    In $ETC/cookieswap.env set DRY_RUN=false and MANUAL_REVIEW_USD=1000,
               then: systemctl restart cookieswap. Approve or refund your test order:
               cookieswap-admin held / approve <id> / refund <id>

 Everyday:     cookieswap-admin help      cookieswap-update      journalctl -u cookieswap -f
 Keep safe:    your two paper recovery phrases. The server can be rebuilt; they cannot.
EOF
  [[ -f /var/run/reboot-required ]] && printf '\n Updates were installed that need a restart: run  reboot  (everything starts again by itself).\n'
  return 0
}

main() {
  parse_args "$@"
  preflight
  install_packages
  install_node
  create_users
  checkout_app
  install_monero
  create_hot_wallet
  create_xmr_wallet
  write_env
  configure_caddy
  harden_host
  install_services
  summary
}

# `COOKIESWAP_SETUP_LIB=1 source setup.sh` only defines the functions (used for testing).
if [[ "${COOKIESWAP_SETUP_LIB:-}" != "1" ]]; then main "$@"; fi
