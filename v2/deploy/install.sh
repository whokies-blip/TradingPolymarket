#!/usr/bin/env bash
# One-shot install of the v2 engine on a fresh Ubuntu server (no SSH needed: run from cloud-init).
#   bash install.sh <ADMIN_TOKEN>
# Installs Docker, downloads v2 from GitHub, starts the engine, and serves the dashboard over HTTPS
# at https://<ip-with-dashes>.sslip.io (certificate from Let's Encrypt, via Caddy).
# Safe to run again: keeps the existing .env and data.
set -euxo pipefail

TOKEN="${1:?usage: install.sh <ADMIN_TOKEN>}"
REPO="whokies-blip/TradingPolymarket"
BRANCH="claude/beautiful-cerf-3udilk"
DIR=/opt/polymarket-mm-v2
export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y curl unzip ufw
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh

# Code
TMP=$(mktemp -d)
curl -fsSL -o "$TMP/src.zip" "https://codeload.github.com/$REPO/zip/refs/heads/$BRANCH"
unzip -q "$TMP/src.zip" -d "$TMP"
mkdir -p "$DIR"
cp -r "$TMP"/*/v2/. "$DIR"/
rm -rf "$TMP"

# Settings: demo only (MM_LIVE=false) until configured by hand.
cd "$DIR"
[ -f .env ] || cp .env.example .env
sed -i "s/^ADMIN_TOKEN=.*/ADMIN_TOKEN=$TOKEN/" .env

# Engine (restarts by itself, data kept in deploy/data)
cd deploy
docker compose up -d --build

# HTTPS dashboard
IP=$(curl -fsS --max-time 5 http://169.254.169.254/hetzner/v1/metadata/public-ipv4 || curl -fsS --max-time 5 https://api.ipify.org)
HOST="${IP//./-}.sslip.io"
docker rm -f caddy 2>/dev/null || true
docker run -d --name caddy --restart unless-stopped --network host -v caddy_data:/data caddy:2 \
  caddy reverse-proxy --from "$HOST" --to localhost:8080

# Firewall: SSH and web only (the engine port stays bound to 127.0.0.1)
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "https://$HOST" | tee /root/dashboard-url.txt
