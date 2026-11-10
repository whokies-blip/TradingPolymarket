#!/bin/bash
# Double-cliquez sur ce fichier pour lancer le système sur votre Mac.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js n'est pas installé. Installez la version LTS depuis https://nodejs.org puis relancez ce fichier."
  read -r -p "Appuyez sur Entrée pour fermer."
  exit 1
fi
if [ "$(node -p 'Number(process.versions.node.split(".")[0])')" -lt 22 ]; then
  echo "Node.js 22 ou plus récent est nécessaire (version actuelle : $(node -v)). Mettez-le à jour depuis https://nodejs.org."
  read -r -p "Appuyez sur Entrée pour fermer."
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "Première utilisation : installation des composants (une à deux minutes)…"
  npm install || { read -r -p "L'installation a échoué. Appuyez sur Entrée pour fermer."; exit 1; }
fi

# caffeinate empêche le Mac de se mettre en veille tant que le moteur tourne.
caffeinate -i npm run local
read -r -p "Appuyez sur Entrée pour fermer."
