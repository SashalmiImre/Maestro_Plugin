#!/bin/bash
#
# Maestro Dashboard — Deploy script
#
# Build + feltöltés a szerverre.
# Használat: ./deploy.sh
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REMOTE_USER="emagohu"
REMOTE_HOST="emago.hu"
REMOTE_DIR="~/maestro.emago.hu"

echo "=== Maestro Dashboard Deploy ==="

# 1. Build
echo "[1/3] Build..."
cd "$SCRIPT_DIR" && npm run build

# 2. Ellenőrzés
DIST_DIR="$SCRIPT_DIR/dist"
errors=0
[[ -f "$DIST_DIR/index.html" ]] || { echo "HIBA: $DIST_DIR/index.html nem található"; errors=1; }
[[ -f "$DIST_DIR/.htaccess" ]]  || { echo "HIBA: $DIST_DIR/.htaccess nem található (SPA fallback rewrite)"; errors=1; }
[[ -d "$DIST_DIR/assets" ]]     || { echo "HIBA: $DIST_DIR/assets könyvtár nem található"; errors=1; }
[[ $errors -eq 0 ]] || exit 1

# 3. Feltöltés
echo "[2/3] Fájlok feltöltése..."
# Régi fájlok törlése a szerveren (js/, css/, shared/ már nem kellenek)
ssh "$REMOTE_USER@$REMOTE_HOST" "rm -rf $REMOTE_DIR/js $REMOTE_DIR/css $REMOTE_DIR/shared $REMOTE_DIR/assets"
# Build output feltöltése
scp "$DIST_DIR/index.html" "$REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR/"
scp "$DIST_DIR/.htaccess"  "$REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR/"
scp -r "$DIST_DIR/assets/" "$REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR/"

# 4. Kész
echo "[3/3] Deploy kész!"
echo "     https://maestro.emago.hu/"
