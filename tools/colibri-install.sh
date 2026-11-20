#!/bin/bash
# Installs the colibri LLM (github.com/JustVugg/colibri) on a fresh Ubuntu server, with its web page
# behind HTTPS and a password (Caddy). Independent of the trading engine; meant for a separate server.
#   bash colibri-install.sh <password>
# Runs itself in the background; follow it with: tail -n 30 /root/colibri-install.log
set -uo pipefail
PASS="${1:?usage: bash colibri-install.sh <password>}"
if [ -z "${COLIBRI_DETACHED:-}" ]; then
  COLIBRI_DETACHED=1 setsid nohup bash "$0" "$PASS" > /root/colibri-install.log 2>&1 < /dev/null &
  echo "Installation lancée en arrière-plan. Suivi : tail -n 30 /root/colibri-install.log"
  exit 0
fi
set -ex
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y git python3 build-essential curl caddy

# Dedicated user when possible; runuser does not need a password (sudo refused a new user here).
id coli >/dev/null 2>&1 || useradd -m -s /bin/bash coli
if runuser -u coli -- true; then RUN="runuser -u coli --"; U=coli; HOME_DIR=/home/coli; else RUN=""; U=root; HOME_DIR=/root; fi
DIR="$HOME_DIR/colibri"
[ -d "$DIR/.git" ] || $RUN git clone https://github.com/JustVugg/colibri "$DIR"
cd "$DIR"
$RUN env HOME="$HOME_DIR" python3 c/coli setup --yes --model qwen36-35b --no-start --no-browser

cat > /etc/systemd/system/colibri.service <<UNIT
[Unit]
Description=colibri LLM
After=network-online.target
[Service]
User=$U
Environment=HOME=$HOME_DIR
WorkingDirectory=$DIR
ExecStart=/usr/bin/python3 c/coli start --no-browser
Restart=always
RestartSec=10
[Install]
WantedBy=multi-user.target
UNIT
IP=$(curl -fsS --max-time 5 http://169.254.169.254/hetzner/v1/metadata/public-ipv4 || curl -fsS --max-time 5 https://api.ipify.org)
HOST="${IP//./-}.sslip.io"
# colibri only answers the host names it knows: allow the public address Caddy forwards.
mkdir -p /etc/systemd/system/colibri.service.d
printf '[Service]\nEnvironment=COLI_ALLOWED_HOSTS=%s\n' "$HOST" > /etc/systemd/system/colibri.service.d/host.conf
systemctl daemon-reload
systemctl enable --now colibri
HASH=$(caddy hash-password --plaintext "$PASS")
printf '%s {\n  basicauth {\n    admin %s\n  }\n  reverse_proxy 127.0.0.1:8000\n}\n' "$HOST" "$HASH" > /etc/caddy/Caddyfile
systemctl restart caddy
echo "TERMINÉ : https://$HOST (utilisateur admin)" | tee /root/colibri-url.txt
