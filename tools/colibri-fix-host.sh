#!/bin/bash
# Lets colibri accept requests for this server's sslip.io address (they come through Caddy),
# then restarts it cleanly and checks the answer.
set -x
IP=$(curl -fsS --max-time 5 http://169.254.169.254/hetzner/v1/metadata/public-ipv4 || curl -fsS --max-time 5 https://api.ipify.org)
HOST="${IP//./-}.sslip.io"
U=$(systemctl show -p User --value colibri); [ -n "$U" ] || U=root
DIR=$(systemctl show -p WorkingDirectory --value colibri)
mkdir -p /etc/systemd/system/colibri.service.d
printf '[Service]\nEnvironment=COLI_ALLOWED_HOSTS=%s\n' "$HOST" > /etc/systemd/system/colibri.service.d/host.conf
systemctl daemon-reload
# Stop the service and any colibri server still running on its own, then start again.
systemctl stop colibri
(cd "$DIR" && runuser -u "$U" -- env HOME="$(getent passwd "$U" | cut -d: -f6)" python3 c/coli stop) || true
pkill -u "$U" -f "c/coli" || true
sleep 3
systemctl start colibri
echo "Démarrage du modèle (jusqu'à 2 minutes)..."
for i in $(seq 1 24); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: $HOST" http://127.0.0.1:8000/)
  [ "$code" = "200" ] && break
  sleep 5
done
set +x
systemctl show -p Environment --value colibri
echo "Réponse locale avec le nom public : HTTP $code (200 = bon, 403 = nom refusé)"
[ "$code" = "200" ] && echo "OK : https://$HOST" || journalctl -u colibri -n 20 --no-pager
