#!/bin/bash
# Lets colibri accept requests for this server's sslip.io address (they come through Caddy).
set -ex
IP=$(curl -fsS --max-time 5 http://169.254.169.254/hetzner/v1/metadata/public-ipv4 || curl -fsS --max-time 5 https://api.ipify.org)
HOST="${IP//./-}.sslip.io"
mkdir -p /etc/systemd/system/colibri.service.d
printf '[Service]\nEnvironment=COLI_ALLOWED_HOSTS=%s\n' "$HOST" > /etc/systemd/system/colibri.service.d/host.conf
systemctl daemon-reload
systemctl restart colibri
sleep 5
systemctl is-active colibri
echo "OK : https://$HOST"
