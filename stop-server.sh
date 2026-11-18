#!/usr/bin/env bash
# ==============================================================================
# Script para Detener el Servidor Menú Digital 3D & AR (Kuroshio)
# ==============================================================================

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-8080}"
PID_FILE="$PROJECT_DIR/.server.pid"

echo "[stop-server] Deteniendo servidor Menú 3D en puerto ${PORT}..."

# 1. Si existe un PID registrado en .server.pid, finalizarlo
if [[ -f "$PID_FILE" ]]; then
  PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    sleep 0.3
    kill -9 "$PID" 2>/dev/null || true
    echo "[stop-server] Proceso PID $PID detenido."
  fi
  rm -f "$PID_FILE"
fi

# 2. Liberar el puerto 8080 por si quedó algún subproceso activo
if command -v fuser >/dev/null 2>&1; then
  fuser -k "${PORT}/tcp" >/dev/null 2>&1 || true
elif command -v lsof >/dev/null 2>&1; then
  PIDS_ON_PORT="$(lsof -ti tcp:${PORT} 2>/dev/null || true)"
  if [[ -n "$PIDS_ON_PORT" ]]; then
    kill -9 $PIDS_ON_PORT 2>/dev/null || true
  fi
fi

echo "✅ Servidor detenido y puerto ${PORT} liberado."
