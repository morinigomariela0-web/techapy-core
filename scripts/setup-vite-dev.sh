#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"

# 1. Instalar Node.js LTS (v20.18.1 linux-x64) en ~/.local/bin si no está presente
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "[setup] Node.js / npm no detectado en el sistema. Descargando Node.js v20.18.1 LTS oficial (linux-x64)..."
  mkdir -p "$HOME/.local/bin" "$HOME/.local/node"
  NODE_TAR="/tmp/node-v20.18.1-linux-x64.tar.xz"
  curl -sSL --output "$NODE_TAR" https://nodejs.org/dist/v20.18.1/node-v20.18.1-linux-x64.tar.xz
  tar -xJf "$NODE_TAR" -C "$HOME/.local/node" --strip-components=1
  rm -f "$NODE_TAR"
  ln -sf "$HOME/.local/node/bin/node" "$HOME/.local/bin/node"
  ln -sf "$HOME/.local/node/bin/npm" "$HOME/.local/bin/npm"
  ln -sf "$HOME/.local/node/bin/npx" "$HOME/.local/bin/npx"
  if sudo -n true 2>/dev/null; then
    sudo -n ln -sf "$HOME/.local/node/bin/node" /usr/local/bin/node || true
    sudo -n ln -sf "$HOME/.local/node/bin/npm" /usr/local/bin/npm || true
    sudo -n ln -sf "$HOME/.local/node/bin/npx" /usr/local/bin/npx || true
  fi
  echo "[setup] Node.js $(node -v) y npm $(npm -v) listos."
fi

# 2. Instalar dependencias (vite y @vitejs/plugin-basic-ssl)
echo "[setup] Ejecutando npm install..."
npm install --no-audit --no-fund

# 3. Arrancar npm run dev en segundo plano y capturar la salida de consola de Vite
DEV_LOG="$PROJECT_DIR/vite-dev.log"
DEV_PID_FILE="$PROJECT_DIR/.vite-dev.pid"

if [[ -f "$DEV_PID_FILE" ]]; then
  OLD_PID="$(cat "$DEV_PID_FILE" 2>/dev/null || true)"
  if [[ -n "$OLD_PID" ]] && kill -0 "$OLD_PID" 2>/dev/null; then
    kill "$OLD_PID" 2>/dev/null || true
    sleep 0.4
  fi
  rm -f "$DEV_PID_FILE"
fi

: > "$DEV_LOG"
echo "[setup] Ejecutando: npm run dev"
nohup npm run dev > "$DEV_LOG" 2>&1 &
DEV_PID=$!
echo "$DEV_PID" > "$DEV_PID_FILE"

for _ in {1..40}; do
  if grep -q "Network:" "$DEV_LOG" 2>/dev/null; then
    sleep 0.5
    break
  fi
  sleep 0.5
done

echo ""
echo "================= SALIDA DE: npm run dev ================="
cat "$DEV_LOG"
echo "=========================================================="
