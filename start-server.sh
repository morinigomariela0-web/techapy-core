#!/usr/bin/env bash
# ==============================================================================
# Script de Arranque Automático para el Menú Digital 3D & AR (Kuroshio)
# - Libera el puerto 8080 si quedó ocupado por una instancia previa.
# - Detecta automáticamente Node.js (`server.js`) o Python 3 (`server.py`).
# - Soporta ejecución en segundo plano (por defecto) o `--foreground` (systemd).
# ==============================================================================

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"
export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"

PORT="${PORT:-8080}"
PID_FILE="$PROJECT_DIR/.server.pid"
LOG_FILE="$PROJECT_DIR/server.log"
MODE="${1:-background}"

# 1. Detener instancia previa registrada en .server.pid
if [[ -f "$PID_FILE" ]]; then
  OLD_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "$OLD_PID" ]] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[start-server] Deteniendo proceso previo (PID $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 0.5
  fi
  rm -f "$PID_FILE"
fi

# 2. Asegurar que el puerto 8080 esté libre
if command -v fuser >/dev/null 2>&1; then
  fuser -k "${PORT}/tcp" >/dev/null 2>&1 || true
elif command -v lsof >/dev/null 2>&1; then
  PIDS_ON_PORT="$(lsof -ti tcp:${PORT} 2>/dev/null || true)"
  if [[ -n "$PIDS_ON_PORT" ]]; then
    kill -9 $PIDS_ON_PORT 2>/dev/null || true
  fi
fi

# 3. Seleccionar motor de ejecución (Node.js + Vite HTTPS o Python 3)
if command -v node >/dev/null 2>&1 && [[ -f "$PROJECT_DIR/node_modules/vite/bin/vite.js" ]]; then
  RUNTIME_CMD=(node "$PROJECT_DIR/scripts/dev-runner.js")
  RUNTIME_NAME="Node.js (server.js :8080 + Vite HTTPS :5173)"
elif command -v node >/dev/null 2>&1; then
  RUNTIME_CMD=(node "$PROJECT_DIR/server.js")
  RUNTIME_NAME="Node.js (server.js)"
elif command -v python3 >/dev/null 2>&1; then
  RUNTIME_CMD=(python3 -u "$PROJECT_DIR/server.py")
  RUNTIME_NAME="Python 3 (server.py)"
else
  echo "❌ Error: No se encontró ni Node.js ni Python 3 en el sistema." >&2
  exit 1
fi

# 4. Detectar IP LAN local para mostrar en consola
LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || echo '127.0.0.1')"
[[ -z "$LAN_IP" ]] && LAN_IP="127.0.0.1"

if [[ "$MODE" == "--foreground" || "$MODE" == "-f" ]]; then
  echo "[start-server] Iniciando en modo foreground con $RUNTIME_NAME en puerto $PORT..."
  exec "${RUNTIME_CMD[@]}"
else
  echo "[start-server] Iniciando en segundo plano con $RUNTIME_NAME..."
  nohup "${RUNTIME_CMD[@]}" >> "$LOG_FILE" 2>&1 &
  NEW_PID=$!
  echo "$NEW_PID" > "$PID_FILE"
  sleep 0.6

  if kill -0 "$NEW_PID" 2>/dev/null; then
    echo "=================================================================="
    echo " ✅ SERVIDOR KUROSHIO 3D & AR ACTIVO EN SEGUNDO PLANO (PID: $NEW_PID)"
    echo "=================================================================="
    echo " • Motor activo:       $RUNTIME_NAME"
    echo " • URL Red Local Wi-Fi: http://${LAN_IP}:${PORT}"
    echo " • URL Localhost:       http://localhost:${PORT}"
    echo " • Gestión de Carta:    http://${LAN_IP}:${PORT}/admin-menu.html"
    echo " • Generador QR:        http://${LAN_IP}:${PORT}/admin-qr.html"
    echo " • Panel Mesero:        http://${LAN_IP}:${PORT}/mesero.html?id=juan&sector=Terraza"
    echo " • Archivo de Log:      $LOG_FILE"
    echo "=================================================================="
  else
    echo "❌ Error al iniciar el servidor. Revisa el log en: $LOG_FILE" >&2
    exit 1
  fi
fi
