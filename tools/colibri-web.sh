#!/bin/bash
# Builds colibri's web dashboard (web/dist, not in a source checkout) and restarts colibri.
set -x
export DEBIAN_FRONTEND=noninteractive
command -v npm >/dev/null || apt-get install -y nodejs npm
node -v
U=$(systemctl show -p User --value colibri); [ -n "$U" ] || U=root
DIR=$(systemctl show -p WorkingDirectory --value colibri)
H=$(getent passwd "$U" | cut -d: -f6)
cd "$DIR/web" || exit 1
runuser -u "$U" -- env HOME="$H" npm ci --no-audit --no-fund || exit 1
runuser -u "$U" -- env HOME="$H" npm run build || exit 1
ls dist/index.html || exit 1
systemctl restart colibri
set +x
echo "Démarrage du modèle (jusqu'à 2 minutes)..."
HOST=$(sed -n 's/.*COLI_ALLOWED_HOSTS=//p' /etc/systemd/system/colibri.service.d/host.conf)
for i in $(seq 1 24); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: $HOST" http://127.0.0.1:8000/)
  [ "$code" = "200" ] && break
  sleep 5
done
echo "Page d'accueil : HTTP $code (200 = bon)"
[ "$code" = "200" ] && echo "OK : https://$HOST" || journalctl -u colibri -n 20 --no-pager
