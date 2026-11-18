#!/usr/bin/env node
/**
 * Script de Arranque Único Integrado (`npm run dev`):
 * - Libera colisiones previas en los puertos 8080 (API/WS) y 5173 (Vite HTTPS).
 * - Inicia `server.js` en segundo plano en el puerto 8080.
 * - Inicia Vite (`https://0.0.0.0:5173`) con `@vitejs/plugin-basic-ssl` y proxy
 *   automático de `/api` y `/ws` hacia `127.0.0.1:8080`.
 * - Mantiene `stdin` de Vite en un pipe abierto e ignora `SIGHUP` para que nunca
 *   se cierre al ejecutarse con `nohup npm run dev > vite.log 2>&1 &`.
 */

const { spawn, execSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT_DIR = path.resolve(__dirname, '..');
const API_PORT = Number(process.env.PORT) || 8080;
const VITE_PORT = Number(process.env.VITE_PORT) || 5173;

function getLocalLanIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

function freePort(port) {
  try {
    execSync(`fuser -k ${port}/tcp`, { stdio: 'ignore' });
  } catch (_) {
    try {
      const pids = execSync(`lsof -ti tcp:${port}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (pids) {
        for (const pid of pids.split(/\s+/)) {
          if (pid && Number(pid) !== process.pid) {
            try {
              process.kill(Number(pid), 'SIGKILL');
            } catch (_) {}
          }
        }
      }
    } catch (_) {}
  }
}

function waitForBackendReady(port, timeoutMs = 4000) {
  const start = Date.now();
  return new Promise((resolve) => {
    const check = () => {
      const req = http.get(`http://127.0.0.1:${port}/api/server-info`, (res) => {
        res.resume();
        resolve(true);
      });
      req.on('error', () => {
        if (Date.now() - start >= timeoutMs) {
          resolve(false);
        } else {
          setTimeout(check, 120);
        }
      });
    };
    check();
  });
}

function syncQrBaseUrlForViteHttps(lanIp) {
  const httpsBaseUrl = `https://${lanIp}:${VITE_PORT}`;
  const wssUrl = `wss://${lanIp}:${VITE_PORT}/ws`;
  const tunnelInfoPath = path.join(ROOT_DIR, 'data', 'tunnel-info.json');
  const adminQrPath = path.join(ROOT_DIR, 'admin-qr.html');

  try {
    fs.writeFileSync(
      tunnelInfoPath,
      JSON.stringify(
        {
          publicUrl: httpsBaseUrl,
          wsUrl: wssUrl,
          mode: 'vite-https-lan',
          updatedAt: new Date().toISOString()
        },
        null,
        2
      ) + '\n',
      'utf8'
    );
  } catch (_) {}

  try {
    if (fs.existsSync(adminQrPath)) {
      let html = fs.readFileSync(adminQrPath, 'utf8');
      html = html.replace(
        /(<input\s+[^>]*id="base-url"[^>]*value=")[^"]*(")/s,
        `$1${httpsBaseUrl}$2`
      );
      html = html.replace(
        /(<input\s+[^>]*id="base-url"[^>]*data-tunnel-url=")[^"]*(")/s,
        `$1${httpsBaseUrl}$2`
      );
      fs.writeFileSync(adminQrPath, html, 'utf8');
    }
  } catch (_) {}
}

async function main() {
  // Ignorar SIGHUP para persistencia en segundo plano con nohup
  process.on('SIGHUP', () => {});

  const lanIp = getLocalLanIp();

  console.log('[dev] Liberando puertos 8080 (API/WS) y 5173 (Vite HTTPS) para evitar colisiones...');
  freePort(API_PORT);
  freePort(VITE_PORT);

  syncQrBaseUrlForViteHttps(lanIp);

  console.log(`[dev] Iniciando Backend API + WebSocket (server.js) en http://0.0.0.0:${API_PORT}...`);
  const apiProc = spawn(process.execPath, [path.join(ROOT_DIR, 'server.js')], {
    cwd: ROOT_DIR,
    env: { ...process.env, PORT: String(API_PORT) },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  apiProc.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    if (text.includes('[API]') || text.includes('[WS')) {
      process.stdout.write(text);
    }
  });
  apiProc.stderr.on('data', (chunk) => {
    process.stderr.write(chunk);
  });

  await waitForBackendReady(API_PORT);
  console.log(`[dev] ✅ Backend listo en puerto ${API_PORT}. Iniciando Vite HTTPS en puerto ${VITE_PORT}...\n`);

  const viteBin = path.join(ROOT_DIR, 'node_modules', 'vite', 'bin', 'vite.js');
  // IMPORTANTE: stdio[0] = 'pipe' evita que Vite reciba EOF desde /dev/null bajo nohup y se cierre solo
  const viteProc = spawn(
    process.execPath,
    [viteBin, '--host', '0.0.0.0', '--port', String(VITE_PORT)],
    {
      cwd: ROOT_DIR,
      env: { ...process.env, BACKEND_PORT: String(API_PORT) },
      stdio: ['pipe', 'inherit', 'inherit']
    }
  );

  // Mantener event loop vivo permanentemente
  const keepAliveTimer = setInterval(() => {}, 60000);

  let shuttingDown = false;
  const cleanup = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(keepAliveTimer);
    try {
      viteProc.kill('SIGTERM');
    } catch (_) {}
    try {
      apiProc.kill('SIGTERM');
    } catch (_) {}
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  viteProc.on('exit', (code) => {
    clearInterval(keepAliveTimer);
    try {
      apiProc.kill('SIGTERM');
    } catch (_) {}
    process.exit(code || 0);
  });
}

main().catch((err) => {
  console.error('[dev] Error fatal:', err);
  process.exit(1);
});
