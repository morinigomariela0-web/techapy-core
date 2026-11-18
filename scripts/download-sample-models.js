#!/usr/bin/env node
/**
 * Wrapper en Node.js para preparar y verificar los 3 modelos .glb reales (`burger.glb`, `ramen.glb`, `dessert.glb`)
 * y actualizar `data/menu-data.json`.
 */
const { execFileSync } = require('child_process');
const path = require('path');

const pyScript = path.join(__dirname, 'download-sample-models.py');
execFileSync('python3', [pyScript], { stdio: 'inherit' });
