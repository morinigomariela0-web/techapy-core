/**
 * Script multiplataforma Node.js para copiar recursos estáticos a `dist/` tras `vite build`.
 * Copia `assets/`, `data/` (excluyendo backups/temporales), `js/vendor/` y `manifest.json`.
 */

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');

function copyDirRecursive(srcDir, destDir, filterFn = null) {
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(destDir, { recursive: true });

  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);

    if (filterFn && !filterFn(entry.name, srcPath)) {
      continue;
    }

    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath, filterFn);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function main() {
  fs.mkdirSync(DIST_DIR, { recursive: true });

  // 1. Copiar assets/ (modelos .glb multi-tenant)
  copyDirRecursive(
    path.join(ROOT_DIR, 'assets'),
    path.join(DIST_DIR, 'assets')
  );

  // 2. Copiar data/ (menu-data.json y config.json por tenant, omitiendo backups y tunnel-info)
  copyDirRecursive(
    path.join(ROOT_DIR, 'data'),
    path.join(DIST_DIR, 'data'),
    (name) => !name.endsWith('.backup.json') && !name.endsWith('.tmp') && name !== 'tunnel-info.json'
  );

  // 3. Copiar js/vendor/ (qrcode.min.js offline)
  copyDirRecursive(
    path.join(ROOT_DIR, 'js', 'vendor'),
    path.join(DIST_DIR, 'js', 'vendor')
  );

  // 4. Copiar manifest.json
  const manifestSrc = path.join(ROOT_DIR, 'manifest.json');
  if (fs.existsSync(manifestSrc)) {
    fs.copyFileSync(manifestSrc, path.join(DIST_DIR, 'manifest.json'));
  }

  console.log('[copy-dist-assets] ✅ Recursos estáticos copiados en dist/ (assets, data, js/vendor, manifest.json)');
}

main();
