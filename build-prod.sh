#!/usr/bin/env bash
# ==============================================================================
# TechaPY — Script de Empaquetado para Producción (build-prod.sh)
# Ejecuta `npm run build` (Vite + Terser + CSS Minify) y copia los recursos
# estáticos requeridos (modelos .glb, datos JSON multi-tenant, vendor QR y PWA).
# ==============================================================================

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

export PATH="/home/carlos/.local/bin:$PATH"

echo "================================================================"
echo "  TechaPY · Empaquetado de Producción (dist/)"
echo "================================================================"

echo "[1/3] Ejecutando compilación y minificación con Vite (minify: terser, cssMinify: true)..."
npm run build

echo "[2/3] Copiando recursos estáticos multi-tenant (assets/, data/, js/vendor/, manifest.json)..."
mkdir -p dist/js/vendor
if [ -d "assets" ]; then
  cp -r assets dist/
fi
if [ -d "data" ]; then
  cp -r data dist/
fi
if [ -d "js/vendor" ]; then
  cp -r js/vendor/* dist/js/vendor/
fi
if [ -f "manifest.json" ]; then
  cp manifest.json dist/manifest.json
fi

echo "[3/3] Verificando artefactos generados en dist/..."
ls -lh dist/
echo "================================================================"
echo "  Build de producción completado exitosamente en: $PROJECT_DIR/dist"
echo "================================================================"
