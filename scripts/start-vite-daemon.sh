#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"
export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"

echo "=== 1. DIAGNÓSTICO DE IP LOCAL Y PUERTOS PREVIOS ==="
echo "hostname -I: $(hostname -I)"
ip -4 -o addr show | awk '{print " • Interfaz:", $2, "-> IPv4:", $4}'
echo ""
echo "Puertos 5173/8080 antes del reinicio:"
ss -tulpn | grep -E '5173|8080' || echo " (Ningún proceso escuchando en 5173/8080)"

echo ""
echo "=== 2. ARRANQUE PERSISTENTE EN SEGUNDO PLANO (nohup npm run dev > vite.log 2>&1 &) ==="
: > "$PROJECT_DIR/vite.log"
nohup npm run dev > "$PROJECT_DIR/vite.log" 2>&1 < /dev/null &
DAEMON_PID=$!
echo "$DAEMON_PID" > "$PROJECT_DIR/.vite-dev.pid"
echo "Proceso lanzado en background con PID: $DAEMON_PID"

sleep 3.5

echo ""
echo "=== 3. VERIFICACIÓN DE PUERTOS EN ESTADO LISTEN (ss -tulpn | grep -E '5173|8080') ==="
ss -tulpn | grep -E '5173|8080'

echo ""
echo "=== 4. ÚLTIMAS 15 LÍNEAS DE vite.log ==="
tail -n 15 "$PROJECT_DIR/vite.log"

echo ""
echo "=== 5. TEST RÁPIDO DE RESPUESTA HTTPS Y REDIRECCIÓN HTTP->HTTPS ==="
curl -k -I -s https://127.0.0.1:5173/index.html | head -n 3
curl -I -s http://127.0.0.1:5173/index.html | head -n 3
