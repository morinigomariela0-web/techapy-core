#!/usr/bin/env bash
# ==============================================================================
# Script de Puesta en Marcha de Túnel HTTPS Gratuito (Cloudflare Tunnel)
# - Verifica que el servidor local (start-server.sh) esté activo en el puerto 8080.
# - Descarga/verifica el binario oficial `cloudflared` para Linux x64.
# - Inicia `cloudflared tunnel --url http://localhost:8080` en segundo plano.
# - Extrae la URL pública HTTPS (`https://xxxx.trycloudflare.com`).
# - Actualiza automáticamente `admin-qr.html` y `data/tunnel-info.json` para que
#   todos los códigos QR apunten al túnel HTTPS (requerido para WebXR / AR).
# ==============================================================================

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

PORT="${PORT:-8080}"
BIN_DIR="$PROJECT_DIR/bin"
LOCAL_CLOUDFLARED="$BIN_DIR/cloudflared"
TUNNEL_PID_FILE="$PROJECT_DIR/.tunnel.pid"
TUNNEL_LOG_FILE="$PROJECT_DIR/tunnel.log"
TUNNEL_INFO_JSON="$PROJECT_DIR/data/tunnel-info.json"
ADMIN_QR_HTML="$PROJECT_DIR/admin-qr.html"

if [[ "${1:-}" == "--stop" ]]; then
  if [[ -f "$TUNNEL_PID_FILE" ]]; then
    OLD_PID="$(cat "$TUNNEL_PID_FILE" 2>/dev/null || true)"
    if [[ -n "$OLD_PID" ]] && kill -0 "$OLD_PID" 2>/dev/null; then
      kill "$OLD_PID" 2>/dev/null || true
      echo "[tunnel] Túnel HTTPS detenido (PID $OLD_PID)."
    fi
    rm -f "$TUNNEL_PID_FILE"
  fi
  rm -f "$TUNNEL_INFO_JSON"
  exit 0
fi

# 1. Verificar estado de UFW Firewall en Linux Mint / Ubuntu
if [[ -f /etc/ufw/ufw.conf ]] && grep -q "ENABLED=yes" /etc/ufw/ufw.conf 2>/dev/null; then
  echo "[tunnel] UFW detectado activo. Intentando habilitar puerto ${PORT}/tcp..."
  sudo -n ufw allow "${PORT}/tcp" >/dev/null 2>&1 || true
else
  echo "[tunnel] Firewall UFW verificado: inactivo (ENABLED=no en /etc/ufw/ufw.conf). Tráfico local permitido."
fi

# 2. Localizar o descargar binario oficial `cloudflared` (Linux amd64)
CLOUDFLARED_BIN=""
if command -v cloudflared >/dev/null 2>&1; then
  CLOUDFLARED_BIN="$(command -v cloudflared)"
elif [[ -x "/usr/local/bin/cloudflared" ]]; then
  CLOUDFLARED_BIN="/usr/local/bin/cloudflared"
elif [[ -x "$LOCAL_CLOUDFLARED" ]]; then
  CLOUDFLARED_BIN="$LOCAL_CLOUDFLARED"
else
  echo "[tunnel] Descargando binario oficial de Cloudflare Tunnel (cloudflared-linux-amd64)..."
  mkdir -p "$BIN_DIR"
  curl -sSL --output /tmp/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
  chmod +x /tmp/cloudflared
  cp /tmp/cloudflared "$LOCAL_CLOUDFLARED"
  chmod +x "$LOCAL_CLOUDFLARED"
  if sudo -n mv /tmp/cloudflared /usr/local/bin/cloudflared 2>/dev/null; then
    CLOUDFLARED_BIN="/usr/local/bin/cloudflared"
  else
    rm -f /tmp/cloudflared
    CLOUDFLARED_BIN="$LOCAL_CLOUDFLARED"
  fi
  echo "[tunnel] Binario instalado en: $CLOUDFLARED_BIN"
fi

# 3. Asegurar que el servidor local (`start-server.sh`) esté corriendo en el puerto 8080
SERVER_RUNNING=0
if [[ -f "$PROJECT_DIR/.server.pid" ]]; then
  SRV_PID="$(cat "$PROJECT_DIR/.server.pid" 2>/dev/null || true)"
  if [[ -n "$SRV_PID" ]] && kill -0 "$SRV_PID" 2>/dev/null; then
    SERVER_RUNNING=1
  fi
fi

if [[ "$SERVER_RUNNING" -eq 0 ]]; then
  echo "[tunnel] Iniciando servidor local en puerto ${PORT}..."
  "$PROJECT_DIR/start-server.sh"
else
  echo "[tunnel] Reiniciando servidor local para sincronizar endpoints de túnel..."
  "$PROJECT_DIR/start-server.sh" >/dev/null
fi

# 4. Detener instancia previa del túnel si existiera
if [[ -f "$TUNNEL_PID_FILE" ]]; then
  OLD_TUNNEL_PID="$(cat "$TUNNEL_PID_FILE" 2>/dev/null || true)"
  if [[ -n "$OLD_TUNNEL_PID" ]] && kill -0 "$OLD_TUNNEL_PID" 2>/dev/null; then
    kill "$OLD_TUNNEL_PID" 2>/dev/null || true
    sleep 0.4
  fi
  rm -f "$TUNNEL_PID_FILE"
fi
pkill -f "cloudflared tunnel --url http://localhost:${PORT}" 2>/dev/null || true

# 5. Iniciar nuevo túnel Cloudflare apuntando a http://localhost:8080
: > "$TUNNEL_LOG_FILE"
echo "[tunnel] Iniciando Cloudflare Quick Tunnel HTTPS hacia http://localhost:${PORT}..."
nohup "$CLOUDFLARED_BIN" tunnel --url "http://localhost:${PORT}" --no-autoupdate > "$TUNNEL_LOG_FILE" 2>&1 &
TUNNEL_PID=$!
echo "$TUNNEL_PID" > "$TUNNEL_PID_FILE"

# 6. Extraer la URL pública HTTPS generada (`https://xxxx.trycloudflare.com`)
PUBLIC_URL=""
for _ in {1..45}; do
  if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
    echo "❌ El proceso de cloudflared terminó inesperadamente. Revisa $TUNNEL_LOG_FILE" >&2
    cat "$TUNNEL_LOG_FILE" >&2 || true
    exit 1
  fi
  FOUND_URL="$(grep -oE 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG_FILE" | head -n 1 || true)"
  if [[ -n "$FOUND_URL" ]]; then
    PUBLIC_URL="$FOUND_URL"
    break
  fi
  sleep 0.5
done

if [[ -z "$PUBLIC_URL" ]]; then
  echo "❌ No se pudo obtener la URL de trycloudflare.com a tiempo. Log actual:" >&2
  cat "$TUNNEL_LOG_FILE" >&2 || true
  exit 1
fi

# 7. Guardar en data/tunnel-info.json y actualizar admin-qr.html automáticamente
python3 - "$PUBLIC_URL" "$TUNNEL_INFO_JSON" "$ADMIN_QR_HTML" <<'PYEOF'
import json
import re
import sys
from datetime import datetime, timezone

public_url = sys.argv[1].rstrip("/")
tunnel_json_path = sys.argv[2]
admin_qr_path = sys.argv[3]

ws_url = "wss://" + re.sub(r"^https?://", "", public_url) + "/ws"

with open(tunnel_json_path, "w", encoding="utf-8") as f:
    json.dump(
        {
            "publicUrl": public_url,
            "wsUrl": ws_url,
            "updatedAt": datetime.now(timezone.utc).isoformat(),
        },
        f,
        indent=2,
    )

with open(admin_qr_path, "r", encoding="utf-8") as f:
    html = f.read()

# Actualizar value="..." y data-tunnel-url="..." en el input #base-url de admin-qr.html
html = re.sub(
    r'(<input\s+[^>]*id="base-url"[^>]*value=")[^"]*(")',
    r"\g<1>" + public_url + r"\2",
    html,
     flags=re.DOTALL,
)
html = re.sub(
    r'(<input\s+[^>]*id="base-url"[^>]*data-tunnel-url=")[^"]*(")',
    r"\g<1>" + public_url + r"\2",
    html,
    flags=re.DOTALL,
)

with open(admin_qr_path, "w", encoding="utf-8") as f:
    f.write(html)
PYEOF

echo "========================================================================"
echo " 🔒 TÚNEL HTTPS PÚBLICO ACTIVO (CLOUDFLARE TUNNEL · PID: $TUNNEL_PID)"
echo "========================================================================"
echo " 🌐 URL Pública HTTPS:  ${PUBLIC_URL}"
echo " 🔌 WebSocket Seguro:   wss://${PUBLIC_URL#https://}/ws"
echo "------------------------------------------------------------------------"
echo " 📱 Celular Cliente (3D + AR en Mesa 4 - Terraza):"
echo "    ${PUBLIC_URL}/index.html?mesa=4&sector=Terraza&mesero=juan"
echo ""
echo " 🛎️  Celular Mesero (Panel en Tiempo Real + PWA Instalable):"
echo "    ${PUBLIC_URL}/mesero.html?id=juan&sector=Terraza"
echo ""
echo " 🖨️  Generador de Tarjetas QR (Preconfigurado con HTTPS):"
echo "    ${PUBLIC_URL}/admin-qr.html"
echo ""
echo " 📋 Administración de Carta 3D:"
echo "    ${PUBLIC_URL}/admin-menu.html"
echo "========================================================================"
