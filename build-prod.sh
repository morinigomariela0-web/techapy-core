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

echo "[1/2] Ejecutando compilación y minificación con Vite (minify: esbuild, cssMinify: true) + copia de recursos estáticos..."
npm run build

echo "[2/2] Verificando artefactos generados en dist/..."
ls -lh dist/
echo "================================================================"
echo "  Build de producción completado exitosamente en: $PROJECT_DIR/dist"
echo "================================================================"
