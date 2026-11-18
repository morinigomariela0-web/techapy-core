import { resolve } from 'path';
import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

const BACKEND_PORT = Number(process.env.BACKEND_PORT) || 8080;
const BACKEND_TARGET = `http://127.0.0.1:${BACKEND_PORT}`;

/**
 * Plugin ligero para respetar el ImportMap nativo de Three.js v0.164.1 en CDN
 * sin que el analizador de imports de Vite falle buscando en node_modules.
 */
function cdnImportMapPlugin() {
  return {
    name: 'kuroshio-cdn-importmap',
    enforce: 'pre',
    resolveId(source) {
      if (source === 'three') {
        return {
          id: 'https://cdn.jsdelivr.net/npm/three@0.164.1/build/three.module.js',
          external: true
        };
      }
      if (source.startsWith('three/addons/')) {
        const subpath = source.slice('three/addons/'.length);
        return {
          id: `https://cdn.jsdelivr.net/npm/three@0.164.1/examples/jsm/${subpath}`,
          external: true
        };
      }
      return null;
    }
  };
}

/**
 * Plugin de compatibilidad dual HTTP -> HTTPS en el mismo puerto 5173:
 * - Si la conexión entrante inicia con handshake TLS (0x16), la procesa normalmente con HTTPS/WSS.
 * - Si el usuario ingresa por HTTP plano (ej. http://192.168.100.7:5173), redirige automáticamente
 *   con HTTP 302 hacia https://<host>:5173<ruta> sin rechazar ni colgar la conexión.
 */
function dualHttpHttpsRedirectPlugin() {
  return {
    name: 'kuroshio-http-to-https-redirect',
    configureServer(server) {
      const httpServer = server.httpServer;
      if (!httpServer) return;

      const originalListeners = httpServer.listeners('connection').slice();
      httpServer.removeAllListeners('connection');

      httpServer.on('connection', (socket) => {
        const onReadable = () => {
          const chunk = socket.read(1);
          if (!chunk || chunk.length === 0) {
            return;
          }
          socket.removeListener('readable', onReadable);

          // 0x16 = TLS Handshake Record
          if (chunk[0] === 0x16) {
            socket.unshift(chunk);
            for (const listener of originalListeners) {
              listener.call(httpServer, socket);
            }
          } else {
            // Petición HTTP plana -> Redirección 302 a HTTPS
            socket.unshift(chunk);
            let reqData = '';
            const onData = (buf) => {
              reqData += buf.toString('utf8');
              if (reqData.includes('\r\n\r\n') || reqData.length > 4096) {
                socket.removeListener('data', onData);
                const lines = reqData.split('\r\n');
                const firstLine = (lines[0] || '').split(' ');
                const reqPath = firstLine[1] || '/';
                const hostLine = lines.find((l) => l.toLowerCase().startsWith('host:'));
                const host = hostLine
                  ? hostLine.split(':').slice(1).join(':').trim()
                  : 'localhost:5173';
                const redirectUrl = `https://${host}${reqPath}`;
                const body = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${redirectUrl}"></head><body style="background:#0f1115;color:#f59e0b;font-family:sans-serif;padding:2rem;text-align:center;">Redirigiendo a conexión segura <a style="color:#f59e0b" href="${redirectUrl}">${redirectUrl}</a>...</body></html>`;
                const response =
                  `HTTP/1.1 302 Found\r\n` +
                  `Location: ${redirectUrl}\r\n` +
                  `Content-Type: text/html; charset=utf-8\r\n` +
                  `Content-Length: ${Buffer.byteLength(body)}\r\n` +
                  `Connection: close\r\n\r\n` +
                  body;
                socket.end(response);
              }
            };
            socket.on('data', onData);
          }
        };

        socket.on('readable', onReadable);
      });
    }
  };
}

export default defineConfig({
  plugins: [
    basicSsl(),
    cdnImportMapPlugin(),
    dualHttpHttpsRedirectPlugin()
  ],
  server: {
    host: '0.0.0.0',
    port: 5173,
    https: true,
    strictPort: true,
    cors: true,
    proxy: {
      '/api': {
        target: BACKEND_TARGET,
        changeOrigin: true,
        secure: false
      },
      '/ws': {
        target: BACKEND_TARGET.replace(/^http/, 'ws'),
        ws: true,
        changeOrigin: true,
        secure: false
      }
    }
  },
  build: {
    outDir: 'dist',
    minify: 'esbuild',
    cssMinify: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        landing: resolve(__dirname, 'landing.html'),
        mesero: resolve(__dirname, 'mesero.html'),
        adminMenu: resolve(__dirname, 'admin-menu.html'),
        adminQr: resolve(__dirname, 'admin-qr.html'),
        terminos: resolve(__dirname, 'terminos.html'),
        privacidad: resolve(__dirname, 'privacidad.html')
      }
    }
  }
});
