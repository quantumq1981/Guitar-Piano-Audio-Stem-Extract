#!/usr/bin/env bash
# Stem Splitter processing server: one-shot, idempotent installer for an
# Ubuntu 22.04/24.04 VM (built for Oracle Cloud Always Free Ampere A1, arm64; also works on x86_64).
#
# Usage, from a phone (no SSH): paste deploy/oracle/cloud-init.sh as the instance's
# "Initialization script" (it downloads and runs this file on first boot).
# Usage, over SSH:  curl -fsSL <raw URL of this file> | sudo bash
# Re-run it any time to update to the latest commit on $STEMSPLIT_REF.
#
# Result: Node API on 127.0.0.1:8787 (systemd: stemsplit), Caddy on :80/:443 with an
# automatic Let's Encrypt certificate for https://<a-b-c-d>.sslip.io (or $STEMSPLIT_DOMAIN).
# Log: /var/log/stemsplit-setup.log
set -Eeuo pipefail

REPO="${STEMSPLIT_REPO:-https://github.com/quantumq1981/Guitar-Piano-Audio-Stem-Extract.git}"
REF="${STEMSPLIT_REF:-main}"
CORS_ORIGIN="${STEMSPLIT_CORS_ORIGIN:-https://quantumq1981.github.io}"
APP_DIR=/opt/stemsplit
DATA_DIR=/var/lib/stemsplit
ENV_FILE=/etc/stemsplit/env
NODE_MIN="22.18.0"
LOG=/var/log/stemsplit-setup.log

exec > >(tee -a "$LOG") 2>&1
trap 'echo "!! setup failed at line $LINENO (exit $?). See $LOG"' ERR
log() { printf '\n==> [%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

[[ $(id -u) -eq 0 ]] || { echo "Run as root (sudo)."; exit 1; }
export DEBIAN_FRONTEND=noninteractive
HAS_SYSTEMD=0
[[ -d /run/systemd/system ]] && HAS_SYSTEMD=1

case "$(uname -m)" in
  aarch64 | arm64) NODE_ARCH=arm64 ;;
  x86_64 | amd64) NODE_ARCH=x64 ;;
  *) echo "Unsupported CPU architecture: $(uname -m)"; exit 1 ;;
esac

log "Installing system packages (ffmpeg with libsoxr, git, caddy)"
# Pre-answer iptables-persistent's interactive questions.
echo "iptables-persistent iptables-persistent/autosave_v4 boolean true" | debconf-set-selections
echo "iptables-persistent iptables-persistent/autosave_v6 boolean true" | debconf-set-selections
apt-get update -y
apt-get install -y --no-install-recommends ca-certificates curl git xz-utils ffmpeg caddy iptables iptables-persistent

version_ge() { [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" == "$2" ]]; }
CURRENT_NODE="$(command -v node >/dev/null && node -v | sed 's/^v//' || echo 0)"
if ! version_ge "$CURRENT_NODE" "$NODE_MIN"; then
  log "Installing Node.js 22 ($NODE_ARCH) from nodejs.org with sha256 verification"
  TMP="$(mktemp -d)"
  BASE=https://nodejs.org/dist/latest-v22.x
  curl -fsSL "$BASE/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
  TARBALL="$(grep -o "node-v22\.[0-9.]*-linux-${NODE_ARCH}\.tar\.xz" "$TMP/SHASUMS256.txt" | head -1)"
  curl -fsSL "$BASE/$TARBALL" -o "$TMP/$TARBALL"
  (cd "$TMP" && grep " $TARBALL\$" SHASUMS256.txt | sha256sum -c -)
  tar -xJf "$TMP/$TARBALL" -C /usr/local --strip-components=1 --exclude='*/CHANGELOG.md' --exclude='*/README.md' --exclude='*/LICENSE'
  rm -rf "$TMP"
fi
log "Node $(node -v), npm $(npm -v)"

if ! id stemsplit >/dev/null 2>&1; then
  log "Creating system user 'stemsplit'"
  useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin stemsplit
fi
mkdir -p "$DATA_DIR/jobs" "$DATA_DIR/models" /etc/stemsplit

log "Fetching $REPO@$REF"
if [[ -d "$APP_DIR/.git" ]]; then
  git -C "$APP_DIR" fetch --depth 1 origin "$REF"
  git -C "$APP_DIR" reset --hard FETCH_HEAD
else
  git clone --depth 1 --branch "$REF" "$REPO" "$APP_DIR"
fi
log "Commit $(git -C "$APP_DIR" rev-parse --short HEAD)"

log "Installing server dependencies"
(cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund --workspace @stemsplit/server --include-workspace-root=false)

log "Downloading and sha256-verifying the model (about 285 MB)"
(cd "$APP_DIR" && STEMSPLIT_MODELS_DIR="$DATA_DIR/models" node packages/server/src/cli.ts models fetch)
chown -R stemsplit:stemsplit "$DATA_DIR"

if [[ -n "${STEMSPLIT_DOMAIN:-}" ]]; then
  DOMAIN="$STEMSPLIT_DOMAIN"
else
  log "Discovering public IPv4"
  PUBLIC_IP="$(curl -fsS --max-time 10 https://checkip.amazonaws.com || curl -fsS --max-time 10 https://api.ipify.org)"
  PUBLIC_IP="$(echo "$PUBLIC_IP" | tr -d '[:space:]')"
  [[ "$PUBLIC_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Could not determine public IPv4 (got '$PUBLIC_IP')."; exit 1; }
  # sslip.io resolves a-b-c-d.sslip.io to a.b.c.d, which lets Caddy get a real certificate without owning a domain.
  DOMAIN="${PUBLIC_IP//./-}.sslip.io"
fi
log "Public hostname: $DOMAIN"

# Keep an existing signing secret so previously issued download links stay valid across updates.
SECRET="$( [[ -f "$ENV_FILE" ]] && sed -n 's/^STEMSPLIT_SIGNING_SECRET=//p' "$ENV_FILE" || true)"
[[ -n "$SECRET" ]] || SECRET="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
umask 077
cat > "$ENV_FILE" <<ENV
NODE_ENV=production
STEMSPLIT_SIGNING_SECRET=$SECRET
STEMSPLIT_PUBLIC_URL=https://$DOMAIN
STEMSPLIT_CORS_ORIGIN=$CORS_ORIGIN
STEMSPLIT_MODELS_DIR=$DATA_DIR/models
ENV
umask 022
chown root:stemsplit "$ENV_FILE"
chmod 640 "$ENV_FILE"

THREADS="$(nproc)"
log "Writing systemd unit (threads=$THREADS)"
cat > /etc/systemd/system/stemsplit.service <<UNIT
[Unit]
Description=Stem Splitter processing API
After=network-online.target
Wants=network-online.target

[Service]
User=stemsplit
Group=stemsplit
EnvironmentFile=$ENV_FILE
WorkingDirectory=$APP_DIR
ExecStart=/usr/local/bin/node packages/server/src/cli.ts serve --host 127.0.0.1 --port 8787 --data $DATA_DIR/jobs --threads $THREADS --rtf 1.0
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
UNIT

log "Writing Caddy config"
cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
	request_body {
		max_size 70MB
	}
	reverse_proxy 127.0.0.1:8787 {
		# Long-poll requests hold for up to 25 s.
		transport http {
			read_timeout 60s
		}
	}
}
CADDY

log "Opening ports 80 and 443 in the OS firewall"
# Oracle's Ubuntu images ship iptables rules that REJECT everything except SSH.
for PORT in 80 443; do
  if ! iptables -C INPUT -p tcp -m state --state NEW --dport "$PORT" -j ACCEPT 2>/dev/null; then
    REJECT_LINE="$(iptables -L INPUT --line-numbers -n | awk '$2 == "REJECT" {print $1; exit}')"
    if [[ -n "$REJECT_LINE" ]]; then
      iptables -I INPUT "$REJECT_LINE" -p tcp -m state --state NEW --dport "$PORT" -j ACCEPT
    else
      iptables -A INPUT -p tcp -m state --state NEW --dport "$PORT" -j ACCEPT
    fi
  fi
done
if command -v netfilter-persistent >/dev/null; then netfilter-persistent save; else iptables-save > /etc/iptables/rules.v4; fi

if [[ "$HAS_SYSTEMD" -eq 1 ]]; then
  log "Starting services"
  systemctl daemon-reload
  systemctl enable --now stemsplit
  systemctl restart stemsplit
  systemctl enable caddy
  systemctl restart caddy
  for _ in $(seq 1 60); do
    curl -fsS http://127.0.0.1:8787/v1/health >/dev/null 2>&1 && break
    sleep 2
  done
  curl -fsS http://127.0.0.1:8787/v1/health || { echo "API did not come up; see: journalctl -u stemsplit"; exit 1; }
else
  echo "No systemd detected (container test?): skipping service start."
fi

cat <<DONE

====================================================================
 Stem Splitter server installed.
   API:        https://$DOMAIN
   Health:     https://$DOMAIN/v1/health
 The HTTPS certificate is issued once ports 80/443 are open in the
 cloud firewall (OCI: subnet Security List ingress rules).
 Then set GitHub repo variable VITE_API_BASE=https://$DOMAIN
 and re-run "Deploy PWA to GitHub Pages".
 Update later:  sudo bash $APP_DIR/deploy/oracle/setup.sh
====================================================================
DONE
