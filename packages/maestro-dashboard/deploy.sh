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
