#!/bin/bash
#
# Maestro Dashboard — Deploy script
#
# Feltölti a dashboard fájlokat és a shared csomagot a szerverre.
# Használat: ./deploy.sh
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SHARED_DIR="$SCRIPT_DIR/../maestro-shared"
REMOTE_USER="emagohu"
REMOTE_HOST="emago.hu"
REMOTE_DIR="~/maestro.emago.hu"

echo "=== Maestro Dashboard Deploy ==="

# 0. Helyi fájlok ellenőrzése
errors=0
[[ -f "$SCRIPT_DIR/index.html" ]] || { echo "HIBA: $SCRIPT_DIR/index.html nem található"; errors=1; }
[[ -d "$SCRIPT_DIR/css" ]]        || { echo "HIBA: $SCRIPT_DIR/css könyvtár nem található"; errors=1; }
[[ -d "$SCRIPT_DIR/js" ]]         || { echo "HIBA: $SCRIPT_DIR/js könyvtár nem található"; errors=1; }
[[ -d "$SHARED_DIR" ]]            || { echo "HIBA: $SHARED_DIR könyvtár nem található"; errors=1; }
if [[ $errors -eq 0 ]]; then
    compgen -G "$SHARED_DIR/*.js" > /dev/null || { echo "HIBA: nincs .js fájl a $SHARED_DIR könyvtárban"; errors=1; }
fi
[[ $errors -eq 0 ]] || exit 1

# 1. Shared könyvtár létrehozása a szerveren
echo "[1/3] Távoli könyvtárstruktúra előkészítése..."
ssh "$REMOTE_USER@$REMOTE_HOST" "mkdir -p $REMOTE_DIR/shared"

# 2. Feltöltés
echo "[2/3] Fájlok feltöltése..."
scp "$SCRIPT_DIR/index.html" "$REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR/"
scp -r "$SCRIPT_DIR/css/" "$REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR/"
scp -r "$SCRIPT_DIR/js/" "$REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR/"
scp "$SHARED_DIR"/*.js "$REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR/shared/"

# 3. Kész
echo "[3/3] Deploy kész!"
echo "     https://maestro.emago.hu/"
