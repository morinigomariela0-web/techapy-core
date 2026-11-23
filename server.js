/**
 * Servidor HTTP Estático + API REST de Gestión de Carta + WebSocket RFC 6455 Nativo (Cero dependencias).
 * - Sirve los archivos del proyecto en el puerto 8080 (HTML, CSS, JS, JSON, GLB, texturas).
 * - Endpoints REST para administración de carta:
 *   * GET  /api/menu         -> Devuelve el contenido actual de data/menu-data.json
 *   * POST /api/menu         -> Valida, crea backup en data/menu-data.backup.json y guarda data/menu-data.json
 *   * POST /api/upload-model -> Recibe un modelo 3D .glb (Base64 JSON, Multipart o Binario) y lo guarda en assets/models/
 * - Escucha conexiones WebSocket en ws://<ip-local>:8080/ws.
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.PORT) || 8080;
const ROOT_DIR = __dirname;
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const MENU_FILE_PATH = path.join(ROOT_DIR, 'data', 'menu-data.json');
const MENU_BACKUP_PATH = path.join(ROOT_DIR, 'data', 'menu-data.backup.json');
const MODELS_DIR_PATH = path.join(ROOT_DIR, 'assets', 'models');
const TENANTS_DATA_DIR = path.join(ROOT_DIR, 'data', 'tenants');
const TENANTS_ASSETS_DIR = path.join(ROOT_DIR, 'assets', 'tenants');
const LOGS_DIR = path.join(ROOT_DIR, 'logs');
const PROD_LOG_PATH = path.join(LOGS_DIR, 'techapy-prod.log');
const DEFAULT_TENANT = 'demo';
const WS_MAGIC_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const AUTH_SECRET = process.env.TECHAPY_AUTH_SECRET || 'techapy-cloud-hmac-key-2026-py';
const SUPERADMIN_MASTER_PIN =
  process.env.TECHAPY_SUPERADMIN_PIN || process.env.SUPERADMIN_KEY || 'techapy2026';
function normalizeParaguayWhatsapp(rawPhone, fallback = '595972736447') {
  let digits = String(rawPhone || '').replace(/[^0-9]/g, '');
  if (!digits || digits === '595981000000') return fallback;
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('09') && digits.length === 10) {
    digits = `595${digits.slice(1)}`;
  } else if (digits.startsWith('9') && digits.length === 9) {
    digits = `595${digits}`;
  }
  return digits;
}

const DEFAULT_SALES_WHATSAPP = normalizeParaguayWhatsapp(
  process.env.TECHAPY_WHATSAPP,
  '595972736447'
);

/**
 * Determina si una URL o host corresponde a una IP privada de red local o loopback.
 */
function isPrivateOrLocalUrl(rawUrl) {
  const s = String(rawUrl || '').trim().toLowerCase();
  if (!s) return true;
  return /(?:^|\/\/)(?:localhost|127\.0\.0\.1|0\.0\.0\.0|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)(?::\d+)?(?:\/|$)/i.test(
    s
  );
}

/**
 * Normaliza una URL base pública (sin barras finales, archivos .html ni parámetros ?query).
 */
function sanitizePublicBaseUrl(rawUrl) {
  let clean = String(rawUrl || '').trim();
  if (!clean) return '';
  clean = clean.replace(/\/[a-z0-9_-]+\.html.*/i, '');
  clean = clean.replace(/[?#].*$/, '');
  clean = clean.replace(/\/+$/, '');
  return clean;
}

/**
 * Resuelve la URL pública de producción (Render / Cloud) priorizando:
 * 1. process.env.PUBLIC_BASE_URL o process.env.RENDER_EXTERNAL_URL
 * 2. cfg.publicBaseUrl (si no es IP privada)
 * 3. El Host público de la petición HTTP entrante (ej. https://*.onrender.com)
 * 4. data/tunnel-info.json (si existe y no es IP privada)
 */
function resolvePublicBaseUrl(req = null, cfg = {}) {
  const envUrl = sanitizePublicBaseUrl(
    process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || ''
  );
  if (envUrl && !isPrivateOrLocalUrl(envUrl)) {
    return envUrl;
  }

  const cfgUrl = sanitizePublicBaseUrl(cfg && cfg.publicBaseUrl);
  if (cfgUrl && !isPrivateOrLocalUrl(cfgUrl)) {
    return cfgUrl;
  }

  if (req && req.headers) {
    const rawHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    const rawProto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
    if (rawHost) {
      const candidate = sanitizePublicBaseUrl(`${rawProto}://${rawHost}`);
      if (candidate && !isPrivateOrLocalUrl(candidate)) {
        return candidate;
      }
    }
  }

  const tunnelInfoPath = path.join(ROOT_DIR, 'data', 'tunnel-info.json');
  if (fs.existsSync(tunnelInfoPath)) {
    try {
      const tdata = JSON.parse(fs.readFileSync(tunnelInfoPath, 'utf8'));
      const tUrl = sanitizePublicBaseUrl(tdata && tdata.publicUrl);
      if (tUrl && !isPrivateOrLocalUrl(tUrl)) {
        return tUrl;
      }
    } catch (_) {}
  }

  return envUrl || cfgUrl || '';
}

function normalizeTenantEstado(rawEstado) {
  const s = String(rawEstado || 'Activo').trim().toLowerCase();
  if (s === 'pendiente') return 'pendiente';
  if (s === 'suspendido') return 'Suspendido';
  return 'Activo';
}

/**
 * Calcula los días restantes de suscripción y si está dentro de la ventana de alerta de 7 días.
 */
function computeSubscriptionStatus(cfg = {}) {
  const nowMs = Date.now();
  let expDate = cfg.fechaVencimiento ? new Date(cfg.fechaVencimiento) : null;
  if (!expDate || Number.isNaN(expDate.getTime())) {
    const baseMs = cfg.ultimoPago ? new Date(cfg.ultimoPago).getTime() : nowMs;
    const validBase = Number.isNaN(baseMs) ? nowMs : baseMs;
    expDate = new Date(validBase + 30 * 86400000);
  }
  const fechaVencimiento = expDate.toISOString();
  const ultimoPago = cfg.ultimoPago || new Date(expDate.getTime() - 30 * 86400000).toISOString();
  const diasRestantes = Math.ceil((expDate.getTime() - nowMs) / 86400000);
  const porVencer = diasRestantes >= 0 && diasRestantes <= 7;
  const vencido = diasRestantes < 0;
  const salesWhatsapp = normalizeParaguayWhatsapp(
    cfg.salesWhatsapp,
    DEFAULT_SALES_WHATSAPP
  );

  return {
    ultimoPago,
    fechaVencimiento,
    diasRestantes,
    porVencer,
    vencido,
    salesWhatsapp
  };
}

try {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
} catch (_) {}

const AUDIT_LOG_PATH = path.join(LOGS_DIR, 'techapy-audit.log');
const REDACTED_AUDIT_KEYS = new Set([
  'pin',
  'adminpin',
  'waiterpin',
  'pinacceso',
  'password',
  'secret',
  'token',
  'key',
  'authorization',
  'cookie'
]);

function sanitizeAuditPayload(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const clean = {};
  for (const [k, v] of Object.entries(obj)) {
    if (REDACTED_AUDIT_KEYS.has(String(k).toLowerCase())) {
      clean[k] = '[REDACTED]';
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      clean[k] = sanitizeAuditPayload(v);
    } else {
      clean[k] = v;
    }
  }
  return clean;
}

/**
 * Logger de producción: escribe en consola y persiste en logs/techapy-prod.log
 */
function logProdEvent(level, message, extra = '') {
  const ts = new Date().toISOString();
  const detail = extra ? ` | ${typeof extra === 'string' ? extra : JSON.stringify(extra)}` : '';
  const line = `[${ts}] [${level}] ${message}${detail}`;
  if (level === 'ERROR' || level === 'WARN') {
    console.error(line);
  } else {
    console.log(line);
  }
  try {
    fs.appendFileSync(PROD_LOG_PATH, line + '\n', 'utf8');
  } catch (_) {}
}

/**
 * Registro de auditoría de seguridad (sin exponer PINs, tokens ni secretos).
 */
function logAuditEvent(action, details = {}) {
  const safeDetails = sanitizeAuditPayload(details);
  const record = {
    ts: new Date().toISOString(),
    action: String(action || 'SECURITY_EVENT'),
    ...safeDetails
  };
  logProdEvent('AUDIT', `[${record.action}]`, safeDetails);
  try {
    fs.appendFileSync(AUDIT_LOG_PATH, JSON.stringify(record) + '\n', 'utf8');
  } catch (_) {}
}

/**
 * Manejadores globales de errores para evitar que un mensaje WebSocket malformado
 * o excepción asíncrona tumbe el proceso en producción (sin filtrar stack traces al cliente).
 */
process.on('uncaughtException', (err) => {
  logProdEvent(
    'ERROR',
    'uncaughtException interceptada (proceso mantenido activo)',
    err && err.message ? err.message : 'Error interno no capturado'
  );
});

process.on('unhandledRejection', (reason) => {
  logProdEvent(
    'ERROR',
    'unhandledRejection interceptada (proceso mantenido activo)',
    reason && reason.message ? reason.message : String(reason)
  );
});

/**
 * Persistencia atómica centralizada de archivos JSON con bloqueo/cola por archivo,
 * escritura temporal, fsync y renombrado atómico (POSIX rename) para evitar corrupción ante concurrencia.
 */
const activeFileLocks = new Set();
const fileWriteChains = new Map();

function writeJsonAtomically(filePath, jsonContent) {
  const resolvedPath = path.resolve(filePath);
  const parsedCheck =
    typeof jsonContent === 'string' ? JSON.parse(jsonContent) : jsonContent;
  if (!parsedCheck || typeof parsedCheck !== 'object') {
    throw new Error('Contenido JSON inválido antes de escritura en disco');
  }
  const serialized =
    typeof jsonContent === 'string'
      ? jsonContent
      : JSON.stringify(parsedCheck, null, 2) + '\n';

  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  const randSuffix = crypto.randomBytes(4).toString('hex');
  const tmpPath = `${resolvedPath}.${process.pid}.${Date.now()}.${randSuffix}.tmp`;

  activeFileLocks.add(resolvedPath);
  let fd = null;
  try {
    fd = fs.openSync(tmpPath, 'w', 0o600);
    fs.writeFileSync(fd, serialized, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmpPath, resolvedPath);
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (_) {}
    }
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch (_) {}
    throw err;
  } finally {
    activeFileLocks.delete(resolvedPath);
  }
}

function enqueueAtomicJsonWrite(filePath, jsonContent) {
  const resolvedPath = path.resolve(filePath);
  const prev = fileWriteChains.get(resolvedPath) || Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(() => {
      writeJsonAtomically(resolvedPath, jsonContent);
    })
    .finally(() => {
      if (fileWriteChains.get(resolvedPath) === next) {
        fileWriteChains.delete(resolvedPath);
      }
    });
  fileWriteChains.set(resolvedPath, next);
  return next;
}

const SLUG_REGEX = /^[a-z0-9-]{1,36}$/;
const SAFE_FILENAME_REGEX = /^[a-zA-Z0-9._-]{1,96}$/;

function isValidTenantSlug(raw) {
  const s = String(raw || '').trim().toLowerCase();
  return SLUG_REGEX.test(s) && !s.includes('..');
}

function isValidSafeFilename(raw) {
  const s = String(raw || '').trim();
  return SAFE_FILENAME_REGEX.test(s) && !s.includes('..') && !s.startsWith('.');
}

function sanitizeTenantId(raw) {
  const clean = String(raw || DEFAULT_TENANT)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36);
  return clean && SLUG_REGEX.test(clean) ? clean : DEFAULT_TENANT;
}

/**
 * Obtiene la IP real del cliente respetando X-Forwarded-For (trust proxy en Render / Cloud).
 */
function getClientIp(req) {
  if (!req) return '0.0.0.0';
  const xff = req.headers && req.headers['x-forwarded-for'];
  if (xff) {
    const firstIp = String(xff).split(',')[0].trim();
    if (firstIp) return firstIp.replace(/^::ffff:/, '').slice(0, 64);
  }
  const rawAddr =
    (req.socket && req.socket.remoteAddress) ||
    (req.connection && req.connection.remoteAddress) ||
    '0.0.0.0';
  return String(rawAddr).replace(/^::ffff:/, '').slice(0, 64);
}

/**
 * Detecta si la petición llega sobre HTTPS directo o detrás de un proxy TLS (Render).
 */
function isSecureRequest(req) {
  if (!req) return false;
  if (req.socket && req.socket.encrypted) return true;
  const proto = String((req.headers && req.headers['x-forwarded-proto']) || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  return proto === 'https';
}

/**
 * Genera cabecera Set-Cookie con HttpOnly, SameSite=Lax y Secure automático en HTTPS.
 */
function buildAuthCookieHeader(req, cookieName, tokenValue, maxAgeSec = 43200) {
  const secureFlag = isSecureRequest(req) ? '; Secure' : '';
  return `${cookieName}=${tokenValue}; HttpOnly; Path=/; Max-Age=${maxAgeSec}; SameSite=Lax${secureFlag}`;
}

// ============================================================================
// FIREWALL DE APLICACIÓN (WAF), RATE LIMITING Y BLOQUEO ANTI-FUERZA BRUTA
// ============================================================================
const authBruteForceStore = new Map(); // ip -> { fails, firstFailAt, blockedUntil }
const rateLimitBuckets = new Map(); // `${bucket}:${ip}` -> { count, windowStart }

const AUTH_MAX_FAILS = 6;
const AUTH_FAIL_WINDOW_MS = 10 * 60 * 1000; // 10 minutos
const AUTH_LOCKOUT_MS = 12 * 60 * 1000; // 12 minutos de bloqueo tras superar intentos fallidos

// Limpieza periódica de memoria de los contadores de rate limit y bloqueo
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of authBruteForceStore.entries()) {
    if (rec.blockedUntil <= now && now - rec.firstFailAt > AUTH_FAIL_WINDOW_MS) {
      authBruteForceStore.delete(ip);
    }
  }
  for (const [key, bucket] of rateLimitBuckets.entries()) {
    if (now - bucket.windowStart > 15 * 60 * 1000) {
      rateLimitBuckets.delete(key);
    }
  }
}, 5 * 60 * 1000).unref();

function checkAuthLockout(ip) {
  const now = Date.now();
  const rec = authBruteForceStore.get(ip);
  if (!rec) return { blocked: false, retryAfterSec: 0 };
  if (rec.blockedUntil && rec.blockedUntil > now) {
    return {
      blocked: true,
      retryAfterSec: Math.max(1, Math.ceil((rec.blockedUntil - now) / 1000))
    };
  }
  if (now - rec.firstFailAt > AUTH_FAIL_WINDOW_MS) {
    authBruteForceStore.delete(ip);
  }
  return { blocked: false, retryAfterSec: 0 };
}

function recordAuthFailure(ip, contextInfo = '') {
  const now = Date.now();
  let rec = authBruteForceStore.get(ip);
  if (!rec || now - rec.firstFailAt > AUTH_FAIL_WINDOW_MS) {
    rec = { fails: 1, firstFailAt: now, blockedUntil: 0 };
  } else {
    rec.fails += 1;
  }

  if (rec.fails >= AUTH_MAX_FAILS) {
    rec.blockedUntil = now + AUTH_LOCKOUT_MS;
    logAuditEvent('AUTH_LOCKOUT', {
      ip,
      fails: rec.fails,
      lockoutMinutes: Math.round(AUTH_LOCKOUT_MS / 60000),
      context: contextInfo
    });
  }
  authBruteForceStore.set(ip, rec);
  return rec;
}

function resetAuthFailures(ip) {
  authBruteForceStore.delete(ip);
}

/**
 * Verifica límite de peticiones por IP y ventana de tiempo.
 */
function checkRateLimit(ip, bucketName, maxRequests, windowMs) {
  const now = Date.now();
  const key = `${bucketName}:${ip}`;
  let entry = rateLimitBuckets.get(key);
  if (!entry || now - entry.windowStart >= windowMs) {
    entry = { count: 1, windowStart: now };
    rateLimitBuckets.set(key, entry);
    return { allowed: true, remaining: maxRequests - 1, retryAfterSec: 0 };
  }
  entry.count += 1;
  if (entry.count > maxRequests) {
    const retryAfterSec = Math.max(1, Math.ceil((entry.windowStart + windowMs - now) / 1000));
    return { allowed: false, remaining: 0, retryAfterSec };
  }
  return { allowed: true, remaining: maxRequests - entry.count, retryAfterSec: 0 };
}

/**
 * Firewall de rutas sensibles, archivos ocultos y secuencias de Path Traversal.
 */
function isBlockedSensitivePath(pathname, rawUrl = '') {
  const rawLower = String(rawUrl || '').toLowerCase();
  const pathLower = String(pathname || '').toLowerCase();

  // Bloquear secuencias de Path Traversal o null bytes
  if (
    rawLower.includes('..') ||
    rawLower.includes('%2e%2e') ||
    rawLower.includes('%00') ||
    pathLower.includes('..') ||
    pathLower.includes('\0') ||
    pathLower.includes('\\')
  ) {
    return true;
  }

  // Bloquear cualquier archivo o directorio oculto (/.env, /.git, /.DS_Store, etc.)
  if (/(?:^|\/)\.[^/]+/.test(pathLower)) {
    return true;
  }

  // Bloquear archivos internos del servidor, código backend, backups, logs y scripts shell
  const blockedPatterns = [
    /^\/server\.js$/i,
    /^\/vite\.config\.js$/i,
    /^\/package(?:-lock)?\.json$/i,
    /^\/[a-z0-9_-]+\.sh$/i,
    /^\/scripts(?:\/|$)/i,
    /^\/logs(?:\/|$)/i,
    /^\/node_modules(?:\/|$)/i,
    /^\/data\/tunnel-info\.json$/i,
    /^\/data\/tenants\/[^/]+\/config\.json$/i,
    /\.backup\.json$/i,
    /\.tmp$/i,
    /\.log$/i,
    /\.env(?:\..+)?$/i
  ];

  return blockedPatterns.some((rx) => rx.test(pathLower));
}

/**
 * Aplica cabeceras HTTP de seguridad recomendadas (OWASP) compatibles con Three.js, WebGL,
 * @google/model-viewer, Google Fonts, cámara AR (camera=(self)) y WebSockets.
 */
function applySecurityHeaders(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader(
    'Permissions-Policy',
    'camera=(self), microphone=(), geolocation=(), payment=(), usb=(), xr-spatial-tracking=(self)'
  );
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self' blob: data:",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https://cdn.jsdelivr.net https://ajax.googleapis.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' data: https://fonts.gstatic.com",
      "img-src 'self' data: blob: https:",
      "media-src 'self' blob: mediastream:",
      "connect-src 'self' ws: wss: blob: data: https://cdn.jsdelivr.net https://ajax.googleapis.com https://fonts.googleapis.com https://fonts.gstatic.com",
      "worker-src 'self' blob: https://cdn.jsdelivr.net",
      "frame-ancestors 'self'",
      "base-uri 'self'",
      "object-src 'none'"
    ].join('; ')
  );
  if (isSecureRequest(req)) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

function getTenantPaths(rawTenant) {
  const tenant = sanitizeTenantId(rawTenant);
  const dataDir = path.join(TENANTS_DATA_DIR, tenant);
  const menuPath = path.join(dataDir, 'menu-data.json');
  const backupPath = path.join(dataDir, 'menu-data.backup.json');
  const configPath = path.join(dataDir, 'config.json');
  const modelsDir = path.join(TENANTS_ASSETS_DIR, tenant, 'models');

  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(modelsDir, { recursive: true });

  if (!fs.existsSync(menuPath)) {
    const demoMenu = path.join(TENANTS_DATA_DIR, DEFAULT_TENANT, 'menu-data.json');
    const sourceMenu = fs.existsSync(demoMenu) ? demoMenu : MENU_FILE_PATH;
    if (fs.existsSync(sourceMenu)) {
      fs.copyFileSync(sourceMenu, menuPath);
    }
  }

  if (!fs.existsSync(configPath)) {
    const defaultCfg = {
      tenant,
      nombre: tenant === 'demo' ? 'TechaPY · Casa de Autor' : `TechaPY · ${tenant.toUpperCase()}`,
      ciudad: 'Asunción, Paraguay',
      moneda: 'Gs.',
      adminPin: '1234',
      waiterPin: '5678',
      sectores: [
        { sector: 'Terraza', mesas: 4, meseroNombre: 'Juan Pérez', meseroId: 'juan' },
        { sector: 'Salón Principal', mesas: 6, meseroNombre: 'Lucía Gómez', meseroId: 'lucia' },
        { sector: 'Barra', mesas: 3, meseroNombre: 'Carlos Benítez', meseroId: 'carlos' },
        { sector: 'Patio', mesas: 4, meseroNombre: 'Mateo Duarte', meseroId: 'mateo' }
      ],
      credenciales: {
        usuario: `admin_${tenant}`,
        pinAcceso: '1234'
      }
    };
    writeJsonAtomically(configPath, JSON.stringify(defaultCfg, null, 2) + '\n');
  }

  return { tenant, dataDir, menuPath, backupPath, configPath, modelsDir };
}

/**
 * Obtiene los PINs de seguridad (adminPin y waiterPin) configurados para el tenant.
 */
function getTenantSecurityConfig(rawTenant) {
  const { tenant, configPath } = getTenantPaths(rawTenant);
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (_) {}

  const adminPin = String(
    cfg.adminPin || (cfg.credenciales && cfg.credenciales.pinAcceso) || '1234'
  ).trim();
  const waiterPin = String(cfg.waiterPin || '5678').trim();
  const nombre = cfg.nombre || `TechaPY · ${tenant.toUpperCase()}`;

  return { tenant, nombre, adminPin, waiterPin, rawConfig: cfg };
}

/**
 * Verifica si el tenant existe y se encuentra en estado operativo ("Activo").
 * Impide que un tenant "pendiente" o "Suspendido" reciba comandas o acciones operativas.
 */
function getTenantOperationalState(rawTenant) {
  const slug = sanitizeTenantId(rawTenant);
  const cfgPath = path.join(TENANTS_DATA_DIR, slug, 'config.json');
  if (!fs.existsSync(cfgPath) && slug !== DEFAULT_TENANT) {
    return { exists: false, operational: false, estado: 'inexistente', tenant: slug, nombre: slug };
  }
  const { tenant, nombre, rawConfig } = getTenantSecurityConfig(slug);
  const estado = normalizeTenantEstado(rawConfig && rawConfig.estado);
  return {
    exists: true,
    operational: estado === 'Activo',
    estado,
    tenant,
    nombre
  };
}

/**
 * Carga un mapa indexado por id de plato (y nombre en minúsculas) del menú real del tenant
 * para validar precios unitarios y subtotales en el backend.
 */
function loadTenantMenuDishMap(rawTenant) {
  const slug = sanitizeTenantId(rawTenant);
  const menuPath = path.join(TENANTS_DATA_DIR, slug, 'menu-data.json');
  const dishById = new Map();
  const dishByName = new Map();
  try {
    const fallbackPath = fs.existsSync(menuPath) ? menuPath : MENU_FILE_PATH;
    if (fs.existsSync(fallbackPath)) {
      const parsed = JSON.parse(fs.readFileSync(fallbackPath, 'utf8'));
      if (parsed && Array.isArray(parsed.platos)) {
        for (const p of parsed.platos) {
          if (p && p.id && typeof p.precio === 'number' && Number.isFinite(p.precio)) {
            dishById.set(String(p.id).trim(), p);
            if (p.nombre) {
              dishByName.set(String(p.nombre).trim().toLowerCase(), p);
            }
          }
        }
      }
    }
  } catch (_) {}
  return { dishById, dishByName };
}

function createRoleAuthToken(tenant, role, pin) {
  return crypto
    .createHmac('sha256', AUTH_SECRET)
    .update(`${tenant}:${role}:${pin}`)
    .digest('hex');
}

function safeSecretCompare(inputA, inputB) {
  const strA = String(inputA || '');
  const strB = String(inputB || '');
  if (!strA || !strB) return false;
  const hashA = crypto.createHash('sha256').update(strA).digest();
  const hashB = crypto.createHash('sha256').update(strB).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

function parseCookies(cookieHeader) {
  const map = {};
  if (!cookieHeader) return map;
  String(cookieHeader)
    .split(';')
    .forEach((pair) => {
      const idx = pair.indexOf('=');
      if (idx > 0) {
        const k = pair.slice(0, idx).trim();
        let v = pair.slice(idx + 1).trim();
        try {
          v = decodeURIComponent(v);
        } catch (_) {}
        map[k] = v;
      }
    });
  return map;
}

/**
 * Middleware de verificación de acceso por rol:
 * - role = 'waiter'     -> valida `waiterPin` del tenant (para /mesero.html)
 * - role = 'admin'      -> valida `adminPin` del tenant (para /admin-menu.html y /admin-qr.html)
 * - role = 'superadmin' -> valida `SUPERADMIN_MASTER_PIN` maestro (para /superadmin.html y /api/superadmin/*)
 * Soporta Cookie firmada HttpOnly, Basic Auth / Bearer header, X-Superadmin-Key, X-Auth-Pin o query ?pin=.
 */
function verifyRoleAuthentication(req, parsedUrl, rawTenant, requiredRole) {
  const clientIp = getClientIp(req);
  const lockout = checkAuthLockout(clientIp);
  if (lockout.blocked) {
    return {
      authorized: false,
      lockedOut: true,
      retryAfterSec: lockout.retryAfterSec,
      tenant: sanitizeTenantId(rawTenant),
      nombre: 'Acceso Temporalmente Bloqueado',
      requiredRole
    };
  }

  const isSuper = requiredRole === 'superadmin';
  const sec = isSuper
    ? {
        tenant: 'global',
        nombre: 'TechaPY · Plataforma Central SaaS',
        adminPin: SUPERADMIN_MASTER_PIN,
        waiterPin: SUPERADMIN_MASTER_PIN
      }
    : getTenantSecurityConfig(rawTenant);

  const tenant = sec.tenant;
  const nombre = sec.nombre;
  const expectedPin = isSuper
    ? SUPERADMIN_MASTER_PIN
    : requiredRole === 'admin'
    ? sec.adminPin
    : sec.waiterPin;
  const expectedToken = createRoleAuthToken(tenant, requiredRole, expectedPin);
  const cookieName = `techapy_auth_${tenant}_${requiredRole}`;
  const superCookieName = 'techapy_auth_global_superadmin';
  const superToken = createRoleAuthToken('global', 'superadmin', SUPERADMIN_MASTER_PIN);

  // 1. Verificar Cookie de sesión firmada (o cookie maestra de SuperAdmin que tiene acceso total)
  const cookies = parseCookies(req.headers.cookie);
  if (
    (cookies[cookieName] && safeSecretCompare(cookies[cookieName], expectedToken)) ||
    (cookies[superCookieName] && safeSecretCompare(cookies[superCookieName], superToken))
  ) {
    return { authorized: true, tenant, nombre, cookieHeader: null };
  }

  // 2. Verificar HTTP Basic Auth o Bearer Token
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.toLowerCase().startsWith('basic ')) {
    try {
      const decoded = Buffer.from(authHeader.slice(6).trim(), 'base64').toString('utf8');
      const colonIdx = decoded.indexOf(':');
      const providedPin = colonIdx !== -1 ? decoded.slice(colonIdx + 1).trim() : decoded.trim();
      if (safeSecretCompare(providedPin, expectedPin) || safeSecretCompare(providedPin, SUPERADMIN_MASTER_PIN)) {
        resetAuthFailures(clientIp);
        const setCookie = buildAuthCookieHeader(req, cookieName, expectedToken);
        return { authorized: true, tenant, nombre, cookieHeader: setCookie };
      }
      if (providedPin) {
        recordAuthFailure(clientIp, `BasicAuth ${requiredRole}@${tenant}`);
      }
    } catch (_) {}
  } else if (authHeader.toLowerCase().startsWith('bearer ')) {
    const bearerVal = authHeader.slice(7).trim();
    if (
      safeSecretCompare(bearerVal, expectedPin) ||
      safeSecretCompare(bearerVal, expectedToken) ||
      safeSecretCompare(bearerVal, SUPERADMIN_MASTER_PIN)
    ) {
      resetAuthFailures(clientIp);
      const setCookie = buildAuthCookieHeader(req, cookieName, expectedToken);
      return { authorized: true, tenant, nombre, cookieHeader: setCookie };
    }
    if (bearerVal) {
      recordAuthFailure(clientIp, `Bearer ${requiredRole}@${tenant}`);
    }
  }

  // 3. Verificar Header X-Superadmin-Key, X-Auth-Pin o parámetro ?pin= en la URL
  const providedInlinePin = String(
    req.headers['x-superadmin-key'] ||
      req.headers['x-auth-pin'] ||
      parsedUrl.searchParams.get('pin') ||
      ''
  ).trim();
  if (providedInlinePin) {
    if (
      safeSecretCompare(providedInlinePin, expectedPin) ||
      safeSecretCompare(providedInlinePin, SUPERADMIN_MASTER_PIN)
    ) {
      resetAuthFailures(clientIp);
      const setCookie = buildAuthCookieHeader(req, cookieName, expectedToken);
      return { authorized: true, tenant, nombre, cookieHeader: setCookie };
    }
    recordAuthFailure(clientIp, `InlinePin ${requiredRole}@${tenant}`);
  }

  return { authorized: false, tenant, nombre, requiredRole };
}

/**
 * Verifica que la petición provenga de personal autenticado (waiter o admin) perteneciente
 * específicamente al `tenant` consultado, o bien de `superadmin` global, bloqueando acceso cruzado entre tenants.
 */
function verifyTenantStaffAccess(req, parsedUrl, rawTenant) {
  const tenant = sanitizeTenantId(rawTenant);
  const waiterAuth = verifyRoleAuthentication(req, parsedUrl, tenant, 'waiter');
  if (waiterAuth.authorized) return { authorized: true, role: 'waiter', tenant };
  if (waiterAuth.lockedOut) return waiterAuth;

  const adminAuth = verifyRoleAuthentication(req, parsedUrl, tenant, 'admin');
  if (adminAuth.authorized) return { authorized: true, role: 'admin', tenant };
  if (adminAuth.lockedOut) return adminAuth;

  return { authorized: false, lockedOut: false, tenant };
}

/**
 * Lee y resume todos los tenants instalados en `data/tenants/`.
 */
function listAllTenantsSummary(req = null) {
  fs.mkdirSync(TENANTS_DATA_DIR, { recursive: true });
  const entries = fs.readdirSync(TENANTS_DATA_DIR, { withFileTypes: true });
  const tenants = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const slug = sanitizeTenantId(entry.name);
    const { configPath, menuPath } = getTenantPaths(slug);

    let cfg = {};
    try {
      cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (_) {}

    let platosCount = 0;
    try {
      const menuObj = JSON.parse(fs.readFileSync(menuPath, 'utf8'));
      if (menuObj && Array.isArray(menuObj.platos)) {
        platosCount = menuObj.platos.length;
      }
    } catch (_) {}

    const sectores = Array.isArray(cfg.sectores) ? cfg.sectores : [];
    const totalMesas = sectores.reduce((acc, s) => acc + (Number(s.mesas) || 0), 0);
    const adminPin = String(
      cfg.adminPin || (cfg.credenciales && cfg.credenciales.pinAcceso) || '1234'
    ).trim();
    const waiterPin = String(cfg.waiterPin || '5678').trim();
    const subInfo = computeSubscriptionStatus(cfg);
    const publicBaseUrl = resolvePublicBaseUrl(req, cfg);

    tenants.push({
      tenant: slug,
      nombre: cfg.nombre || `TechaPY · ${slug.toUpperCase()}`,
      ruc: cfg.ruc || '80000000-0',
      ciudad: cfg.ciudad || 'Asunción, Paraguay',
      moneda: cfg.moneda || 'Gs.',
      plan: cfg.plan || 'Plan Restaurante de Autor',
      estado: normalizeTenantEstado(cfg.estado),
      publicBaseUrl,
      fechaSolicitud: cfg.fechaSolicitud || null,
      contactoNombre: cfg.contactoNombre || '',
      contactoWhatsapp: cfg.contactoWhatsapp || '',
      ultimoPago: subInfo.ultimoPago,
      fechaVencimiento: subInfo.fechaVencimiento,
      diasRestantes: subInfo.diasRestantes,
      porVencer: subInfo.porVencer,
      vencido: subInfo.vencido,
      salesWhatsapp: subInfo.salesWhatsapp,
      adminPin,
      waiterPin,
      sectores,
      totalMesas,
      totalPlatos: platosCount
    });
  }

  tenants.sort((a, b) => a.tenant.localeCompare(b.tenant));
  return tenants;
}

/**
 * Aprovisiona un nuevo tenant creando sus carpetas data/tenants/{slug} y assets/tenants/{slug}/models
 * de forma atómica, copiando la carta inicial y modelos 3D base.
 */
function provisionNewTenantAtomically(payload, options = {}) {
  const slug = sanitizeTenantId(payload.tenant);
  if (!slug || slug === 'global') {
    throw new Error('Slug de tenant inválido.');
  }

  const targetDataDir = path.join(TENANTS_DATA_DIR, slug);
  const targetConfigPath = path.join(targetDataDir, 'config.json');
  if (fs.existsSync(targetConfigPath) && !options.allowIfPending) {
    const err = new Error(`El tenant "${slug}" ya existe.`);
    err.statusCode = 409;
    throw err;
  }

  const targetMenuPath = path.join(targetDataDir, 'menu-data.json');
  const targetModelsDir = path.join(TENANTS_ASSETS_DIR, slug, 'models');

  fs.mkdirSync(targetDataDir, { recursive: true });
  fs.mkdirSync(targetModelsDir, { recursive: true });

  // 1. Copiar modelos 3D base desde demo
  const demoModelsDir = path.join(TENANTS_ASSETS_DIR, DEFAULT_TENANT, 'models');
  if (fs.existsSync(demoModelsDir)) {
    for (const file of fs.readdirSync(demoModelsDir)) {
      const srcFile = path.join(demoModelsDir, file);
      const dstFile = path.join(targetModelsDir, file);
      if (fs.statSync(srcFile).isFile() && !fs.existsSync(dstFile)) {
        fs.copyFileSync(srcFile, dstFile);
      }
    }
  }

  // 2. Preparar menu-data.json inicial apuntando a ./assets/tenants/{slug}/models/
  const demoMenuPath = path.join(TENANTS_DATA_DIR, DEFAULT_TENANT, 'menu-data.json');
  const sourceMenuPath = fs.existsSync(demoMenuPath) ? demoMenuPath : MENU_FILE_PATH;
  let initialMenu = { platos: [] };
  if (fs.existsSync(sourceMenuPath)) {
    try {
      const rawMenu = fs.readFileSync(sourceMenuPath, 'utf8');
      const replaced = rawMenu.replace(
        /\.\/assets\/(?:tenants\/[a-z0-9_-]+\/)?models\//g,
        `./assets/tenants/${slug}/models/`
      );
      initialMenu = JSON.parse(replaced);
    } catch (_) {}
  }
  const formattedMenu = JSON.stringify(initialMenu, null, 2) + '\n';
  if (!fs.existsSync(targetMenuPath)) {
    writeJsonAtomically(targetMenuPath, formattedMenu);
  }

  // 3. Crear config.json del nuevo restaurante
  const sectores =
    Array.isArray(payload.sectores) && payload.sectores.length > 0
      ? payload.sectores
      : [
          { sector: 'Terraza', mesas: 4, meseroNombre: 'Juan Pérez', meseroId: 'juan' },
          { sector: 'Salón Principal', mesas: 6, meseroNombre: 'Lucía Gómez', meseroId: 'lucia' }
        ];

  const adminPin = String(payload.adminPin || '1234').trim();
  const waiterPin = String(payload.waiterPin || '5678').trim();
  const nowIso = new Date().toISOString();
  const defaultExpIso = new Date(Date.now() + 30 * 86400000).toISOString();
  const expIso = payload.fechaVencimiento
    ? new Date(payload.fechaVencimiento).toISOString()
    : defaultExpIso;

  const newConfig = {
    tenant: slug,
    nombre: String(payload.nombre || `TechaPY · ${slug.toUpperCase()}`).trim(),
    ruc: String(payload.ruc || '80000000-0').trim(),
    ciudad: String(payload.ciudad || 'Asunción, Paraguay').trim(),
    moneda: String(payload.moneda || 'Gs.').trim(),
    plan: String(payload.plan || 'Plan Restaurante de Autor').trim(),
    estado: normalizeTenantEstado(payload.estado),
    fechaSolicitud: payload.fechaSolicitud || nowIso,
    contactoNombre: String(payload.contactoNombre || '').trim(),
    contactoWhatsapp: String(payload.contactoWhatsapp || '').trim(),
    capacidadMesas: String(payload.capacidadMesas || '').trim(),
    ultimoPago: payload.ultimoPago || nowIso,
    fechaVencimiento: expIso,
    salesWhatsapp: DEFAULT_SALES_WHATSAPP,
    adminPin,
    waiterPin,
    sectores,
    credenciales: {
      usuario: `admin_${slug}`,
      pinAcceso: adminPin
    }
  };

  const formattedCfg = JSON.stringify(newConfig, null, 2) + '\n';
  writeJsonAtomically(targetConfigPath, formattedCfg);

  // 4. Sincronizar con dist/ si existe
  if (fs.existsSync(DIST_DIR)) {
    const distTenantDataDir = path.join(DIST_DIR, 'data', 'tenants', slug);
    const distTenantModelsDir = path.join(DIST_DIR, 'assets', 'tenants', slug, 'models');
    fs.mkdirSync(distTenantDataDir, { recursive: true });
    fs.mkdirSync(distTenantModelsDir, { recursive: true });
    writeJsonAtomically(path.join(distTenantDataDir, 'config.json'), formattedCfg);
    if (!fs.existsSync(path.join(distTenantDataDir, 'menu-data.json'))) {
      writeJsonAtomically(path.join(distTenantDataDir, 'menu-data.json'), formattedMenu);
    }
    if (fs.existsSync(targetModelsDir)) {
      for (const file of fs.readdirSync(targetModelsDir)) {
        const dst = path.join(distTenantModelsDir, file);
        if (!fs.existsSync(dst)) {
          fs.copyFileSync(path.join(targetModelsDir, file), dst);
        }
      }
    }
  }

  return newConfig;
}

/**
 * Actualiza de forma atómica la configuración, PINs, estado o ciclo de vencimiento de un tenant.
 */
function updateExistingTenantAtomically(rawSlug, payload) {
  const slug = sanitizeTenantId(rawSlug);
  const { configPath } = getTenantPaths(slug);
  let currentCfg = {};
  try {
    currentCfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (_) {}

  const adminPin = String(
    payload.adminPin !== undefined ? payload.adminPin : currentCfg.adminPin || '1234'
  ).trim();
  const waiterPin = String(
    payload.waiterPin !== undefined ? payload.waiterPin : currentCfg.waiterPin || '5678'
  ).trim();

  let nextEstado =
    payload.estado !== undefined
      ? normalizeTenantEstado(payload.estado)
      : normalizeTenantEstado(currentCfg.estado);

  let nextUltimoPago = payload.ultimoPago || currentCfg.ultimoPago || new Date().toISOString();
  let nextFechaVencimiento =
    payload.fechaVencimiento ||
    currentCfg.fechaVencimiento ||
    new Date(Date.now() + 30 * 86400000).toISOString();

  // Acción rápida: Activar cuenta pendiente (fija estado Activo + 30 días desde hoy)
  if (
    payload.action === 'activate' ||
    (normalizeTenantEstado(currentCfg.estado) === 'pendiente' && nextEstado === 'Activo' && !payload.fechaVencimiento)
  ) {
    nextEstado = 'Activo';
    nextUltimoPago = new Date().toISOString();
    nextFechaVencimiento = new Date(Date.now() + 30 * 86400000).toISOString();
  }

  // Acción rápida: Renovar cuota +30 días
  if (payload.action === 'renew30') {
    nextEstado = 'Activo';
    nextUltimoPago = new Date().toISOString();
    const currentExpMs = currentCfg.fechaVencimiento
      ? new Date(currentCfg.fechaVencimiento).getTime()
      : Date.now();
    const baseMs = Number.isNaN(currentExpMs) ? Date.now() : Math.max(Date.now(), currentExpMs);
    nextFechaVencimiento = new Date(baseMs + 30 * 86400000).toISOString();
  }

  const updatedCfg = {
    ...currentCfg,
    tenant: slug,
    nombre: String(payload.nombre || currentCfg.nombre || `TechaPY · ${slug.toUpperCase()}`).trim(),
    ruc: String(payload.ruc !== undefined ? payload.ruc : currentCfg.ruc || '80000000-0').trim(),
    ciudad: String(
      payload.ciudad !== undefined ? payload.ciudad : currentCfg.ciudad || 'Asunción, Paraguay'
    ).trim(),
    moneda: String(payload.moneda || currentCfg.moneda || 'Gs.').trim(),
    plan: String(
      payload.plan !== undefined ? payload.plan : currentCfg.plan || 'Plan Restaurante de Autor'
    ).trim(),
    estado: nextEstado,
    ultimoPago: nextUltimoPago,
    fechaVencimiento: new Date(nextFechaVencimiento).toISOString(),
    publicBaseUrl: sanitizePublicBaseUrl(
      payload.publicBaseUrl !== undefined ? payload.publicBaseUrl : currentCfg.publicBaseUrl || ''
    ),
    salesWhatsapp: currentCfg.salesWhatsapp || DEFAULT_SALES_WHATSAPP,
    adminPin,
    waiterPin,
    sectores: Array.isArray(payload.sectores) ? payload.sectores : currentCfg.sectores || [],
    credenciales: {
      usuario: `admin_${slug}`,
      pinAcceso: adminPin
    }
  };

  const formattedCfg = JSON.stringify(updatedCfg, null, 2) + '\n';
  writeJsonAtomically(configPath, formattedCfg);

  if (fs.existsSync(DIST_DIR)) {
    const distCfgPath = path.join(DIST_DIR, 'data', 'tenants', slug, 'config.json');
    fs.mkdirSync(path.dirname(distCfgPath), { recursive: true });
    writeJsonAtomically(distCfgPath, formattedCfg);
  }

  return updatedCfg;
}

/**
 * Renderiza el Modal de Login Unificado por Rol con código HTTP 401 Unauthorized
 * cuando se intenta acceder a /mesero.html, /admin-menu.html o /admin-qr.html sin autenticación.
 */
function sendUnifiedRoleLoginModal(res, { tenant, nombre, requiredRole, reqUrl }) {
  const isSuper = requiredRole === 'superadmin';
  const isWaiter = requiredRole === 'waiter';
  const roleBadge = isSuper
    ? 'SUPERADMIN · CONTROL CENTRAL MULTI-TENANT'
    : isWaiter
    ? 'ACCESO DE SALÓN · MESEROS'
    : 'ACCESO GERENCIAL · ADMINISTRADOR';
  const roleTitle = isSuper
    ? 'Consola Central SuperAdmin'
    : isWaiter
    ? 'Consola de Comandas (Mesero)'
    : 'Panel de Administración & Placas QR';
  const roleHint = isSuper
    ? 'Ingresa la contraseña maestra de SuperAdmin para gestionar todos los restaurantes (tenants), licencias y credenciales de TechaPY.'
    : isWaiter
    ? 'Ingresa el PIN de Mesero asignado a tu local para recibir comandas y llamados de mesa en tiempo real.'
    : 'Ingresa el PIN de Administrador del restaurante para gestionar precios, modelos 3D e imprimir placas QR.';
  const pinLabel = isSuper
    ? 'Contraseña Maestra SuperAdmin'
    : `PIN de Seguridad (${isWaiter ? 'waiterPin' : 'adminPin'})`;

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="theme-color" content="#0e1013" />
  <title>Autenticación Requerida (${roleBadge}) — TechaPY</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;700&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <style>
    :root {
      --bg-dark: #0e1013;
      --card-bg: rgba(21, 24, 30, 0.92);
      --gold: #c5a059;
      --gold-bright: #d4af37;
      --text-main: #f4f4f6;
      --text-muted: #989ea8;
      --border: rgba(197, 160, 89, 0.32);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      min-height: 100vh;
      min-height: 100dvh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: radial-gradient(circle at 50% 25%, #191d26 0%, var(--bg-dark) 80%);
      color: var(--text-main);
      font-family: 'Plus Jakarta Sans', system-ui, sans-serif;
      padding: 20px;
    }
    .auth-card {
      width: 100%;
      max-width: 420px;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 32px 28px;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.75);
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .brand-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .brand-name {
      font-family: 'Playfair Display', Georgia, serif;
      font-size: 1.25rem;
      color: #ffffff;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--gold);
      box-shadow: 0 0 10px var(--gold);
    }
    .tenant-pill {
      font-size: 0.7rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      padding: 4px 9px;
      border-radius: 999px;
      background: rgba(197, 160, 89, 0.14);
      color: var(--gold-bright);
      border: 1px solid var(--border);
    }
    .role-kicker {
      font-size: 0.68rem;
      font-weight: 700;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--gold);
    }
    h1 {
      font-family: 'Playfair Display', Georgia, serif;
      font-size: 1.45rem;
      font-weight: 600;
      color: #ffffff;
      line-height: 1.25;
    }
    .restaurant-label {
      font-size: 0.84rem;
      font-weight: 600;
      color: var(--gold-bright);
    }
    p.hint {
      font-size: 0.84rem;
      line-height: 1.5;
      color: var(--text-muted);
    }
    form {
      display: flex;
      flex-direction: column;
      gap: 14px;
      margin-top: 4px;
    }
    label {
      font-size: 0.74rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--text-muted);
    }
    input[type="password"] {
      width: 100%;
      background: #0b0d10;
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 10px;
      padding: 13px 14px;
      color: #ffffff;
      font-size: 1.15rem;
      font-weight: 700;
      letter-spacing: 0.28em;
      text-align: center;
      font-family: inherit;
    }
    input[type="password"]:focus {
      outline: none;
      border-color: var(--gold-bright);
    }
    .btn-submit {
      width: 100%;
      background: var(--gold);
      color: #0e1013;
      border: 1px solid var(--gold-bright);
      border-radius: 10px;
      padding: 12px 16px;
      font-size: 0.9rem;
      font-weight: 700;
      cursor: pointer;
      transition: background 0.2s ease;
    }
    .btn-submit:hover {
      background: var(--gold-bright);
    }
    .error-msg {
      display: none;
      font-size: 0.8rem;
      font-weight: 600;
      color: #fca5a5;
      background: rgba(153, 27, 27, 0.28);
      border: 1px solid rgba(248, 113, 113, 0.4);
      padding: 9px 12px;
      border-radius: 8px;
      text-align: center;
    }
    .public-links {
      margin-top: 6px;
      padding-top: 14px;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      display: flex;
      justify-content: space-between;
      font-size: 0.78rem;
    }
    .public-links a {
      color: var(--text-muted);
      text-decoration: none;
      font-weight: 500;
    }
    .public-links a:hover {
      color: var(--gold-bright);
    }
  </style>
</head>
<body>
  <main class="auth-card" role="dialog" aria-labelledby="auth-title">
    <div class="brand-row">
      <div class="brand-name"><span class="dot"></span><span>TechaPY</span></div>
      <span class="tenant-pill">LOCAL: ${tenant.toUpperCase()}</span>
    </div>

    <div>
      <span class="role-kicker">${roleBadge}</span>
      <h1 id="auth-title">${roleTitle}</h1>
      <div class="restaurant-label">${nombre}</div>
    </div>

    <p class="hint">${roleHint}</p>

    <form id="pin-auth-form">
      <div>
        <label for="pin-input">${pinLabel}</label>
        <input id="pin-input" type="password" autocomplete="current-password" placeholder="••••" required autofocus />
      </div>
      <div id="auth-error" class="error-msg" role="alert">PIN incorrecto. Verifica las credenciales del local.</div>
      <button type="submit" class="btn-submit">Desbloquear Acceso</button>
    </form>

    <div class="public-links">
      <a href="/index.html?tenant=${encodeURIComponent(tenant)}">← Ir a Carta Pública 3D (Cliente)</a>
      <a href="/landing.html">Inicio</a>
    </div>
  </main>

  <script>
    const form = document.getElementById('pin-auth-form');
    const pinInput = document.getElementById('pin-input');
    const errBox = document.getElementById('auth-error');
    const targetRedirect = ${JSON.stringify(reqUrl || '/')};

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errBox.style.display = 'none';
      const pin = pinInput.value.trim();
      if (!pin) return;

      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tenant: ${JSON.stringify(tenant)},
            role: ${JSON.stringify(requiredRole)},
            pin
          })
        });
        const data = await res.json();
        if (res.ok && data && data.ok) {
          window.location.replace(targetRedirect);
        } else {
          errBox.textContent = (data && data.error) || 'PIN inválido para este rol.';
          errBox.style.display = 'block';
          pinInput.select();
        }
      } catch (err) {
        errBox.textContent = 'Error de conexión verificando credenciales.';
        errBox.style.display = 'block';
      }
    });
  </script>
</body>
</html>`;

  res.writeHead(401, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(html);
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// Mapa de clientes WebSocket conectados: socket -> { role: 'cliente'|'mesero', sector, mesa, waiterId }
const clients = new Map();

// Lista en memoria de las órdenes activas del día e historial de mesas cobradas/cerradas del turno
let activeOrders = [];
let archivedHistoryOrders = [];

function recordServerOrderHistory(order) {
  if (!order || !order.id) return;
  const idx = archivedHistoryOrders.findIndex((h) => h.id === order.id);
  const copy = {
    ...order,
    cobradoAt: order.cobradoAt || new Date().toISOString()
  };
  if (idx !== -1) {
    archivedHistoryOrders[idx] = copy;
  } else {
    archivedHistoryOrders.unshift(copy);
    if (archivedHistoryOrders.length > 400) archivedHistoryOrders.pop();
  }
}

/**
 * Detecta la dirección IPv4 local (LAN Wi-Fi / Ethernet) de la máquina.
 */
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

/**
 * Lee el cuerpo completo de una petición HTTP como Buffer (hasta maxBytes).
 */
function readRequestBodyBuffer(req, maxBytes = 60 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('El archivo o cuerpo supera el límite permitido (60 MB)'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err) => reject(err));
  });
}

/**
 * Sanitiza un nombre de archivo .glb evitando rutas relativas o caracteres peligrosos.
 */
function sanitizeGlbFilename(rawName) {
  const base = path.basename(String(rawName || 'modelo.glb')).trim();
  const clean = base.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-');
  return clean.toLowerCase().endsWith('.glb') ? clean : `${clean}.glb`;
}

/**
 * Extrae el archivo binario y nombre desde un cuerpo multipart/form-data.
 */
function parseMultipartGlb(bodyBuffer, contentTypeHeader) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentTypeHeader || '');
  if (!match) {
    throw new Error('Falta boundary en multipart/form-data');
  }
  const boundary = `--${(match[1] || match[2]).trim()}`;
  const boundaryBuf = Buffer.from(boundary, 'utf8');
  const headerSep = Buffer.from('\r\n\r\n', 'utf8');

  let start = bodyBuffer.indexOf(boundaryBuf);
  while (start !== -1) {
    const partStart = start + boundaryBuf.length + 2; // saltar \r\n
    const nextBoundary = bodyBuffer.indexOf(boundaryBuf, partStart);
    if (nextBoundary === -1) break;

    const partHeadersEnd = bodyBuffer.indexOf(headerSep, partStart);
    if (partHeadersEnd !== -1 && partHeadersEnd < nextBoundary) {
      const headersText = bodyBuffer.subarray(partStart, partHeadersEnd).toString('utf8');
      const filenameMatch = /filename="([^"]+)"/i.exec(headersText);
      if (filenameMatch) {
        const fileStart = partHeadersEnd + 4;
        const fileEnd = nextBoundary - 2; // quitar \r\n final antes del boundary
        return {
          filename: filenameMatch[1],
          fileBuffer: bodyBuffer.subarray(fileStart, fileEnd)
        };
      }
    }
    start = nextBoundary;
  }

  throw new Error('No se encontró ningún archivo adjunto en el formulario multipart');
}

/**
 * Valida la estructura del JSON de la carta antes de guardarlo para evitar corrupción.
 */
function validateMenuJson(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.platos)) {
    return 'El JSON debe ser un objeto válido e incluir un arreglo "platos".';
  }
  if (data.platos.length === 0) {
    return 'El arreglo "platos" no puede estar vacío (debe contener al menos 1 plato).';
  }
  const seenIds = new Set();
  for (let i = 0; i < data.platos.length; i++) {
    const p = data.platos[i];
    if (!p || typeof p !== 'object' || Array.isArray(p)) {
      return `El plato en la posición ${i + 1} no es un objeto válido.`;
    }
    if (!p.id || !String(p.id).trim()) {
      return `El plato en la posición ${i + 1} requiere un campo "id".`;
    }
    const cleanId = String(p.id).trim();
    if (seenIds.has(cleanId)) {
      return `El identificador de plato "${cleanId}" está duplicado.`;
    }
    seenIds.add(cleanId);
    if (!p.nombre || !String(p.nombre).trim()) {
      return `El plato "${p.id}" requiere un campo "nombre".`;
    }
    if (!p.category || !String(p.category).trim()) {
      return `El plato "${p.nombre}" requiere un campo "category".`;
    }
    if (typeof p.precio !== 'number' || !Number.isFinite(p.precio) || p.precio < 0) {
      return `El plato "${p.nombre}" requiere un "precio" numérico válido.`;
    }
  }
  return null;
}

/**
 * Valida la estructura del archivo config.json de un tenant antes de guardarlo.
 */
function validateTenantConfigJson(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return 'La configuración del local debe ser un objeto JSON válido.';
  }
  if (cfg.sectores !== undefined && !Array.isArray(cfg.sectores)) {
    return 'El campo "sectores" debe ser un arreglo.';
  }
  return null;
}

/**
 * Codifica un objeto JSON en una trama (frame) de texto WebSocket RFC 6455.
 */
function encodeWsTextFrame(payloadObj) {
  const jsonStr = typeof payloadObj === 'string' ? payloadObj : JSON.stringify(payloadObj);
  const payload = Buffer.from(jsonStr, 'utf8');
  const len = payload.length;

  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  return Buffer.concat([header, payload]);
}

function sendWsJson(socket, data) {
  if (!socket || socket.destroyed || !socket.writable) return;
  try {
    const frame = encodeWsTextFrame(data);
    socket.write(frame);
  } catch (err) {
    console.warn('[WS] Error enviando trama:', err.message);
  }
}

function parseWsFrames(buffer) {
  const messages = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const firstByte = buffer[offset];
    const secondByte = buffer[offset + 1];

    const opcode = firstByte & 0x0f;
    const isMasked = (secondByte & 0x80) !== 0;
    let payloadLen = secondByte & 0x7f;
    let headerLen = 2;

    if (payloadLen === 126) {
      if (offset + 4 > buffer.length) break;
      payloadLen = buffer.readUInt16BE(offset + 2);
      headerLen = 4;
    } else if (payloadLen === 127) {
      if (offset + 10 > buffer.length) break;
      payloadLen = Number(buffer.readBigUInt64BE(offset + 2));
      headerLen = 10;
    }

    const maskLen = isMasked ? 4 : 0;
    const totalFrameLen = headerLen + maskLen + payloadLen;

    if (offset + totalFrameLen > buffer.length) {
      break;
    }

    const payloadStart = offset + headerLen + maskLen;
    const payload = Buffer.alloc(payloadLen);

    if (isMasked) {
      const maskKey = buffer.subarray(offset + headerLen, offset + headerLen + 4);
      for (let i = 0; i < payloadLen; i++) {
        payload[i] = buffer[payloadStart + i] ^ maskKey[i % 4];
      }
    } else {
      buffer.copy(payload, 0, payloadStart, payloadStart + payloadLen);
    }

    messages.push({ opcode, payload });
    offset += totalFrameLen;
  }

  return {
    messages,
    remaining: buffer.subarray(offset)
  };
}

function sanitizeOrderText(str, maxLen = 96) {
  return String(str || '')
    .replace(/[<>]/g, '')
    .trim()
    .slice(0, maxLen);
}

function validateAndSanitizeWsOrder(rawOrder, rawTenant = DEFAULT_TENANT) {
  if (!rawOrder || typeof rawOrder !== 'object' || Array.isArray(rawOrder)) return null;
  const id = sanitizeOrderText(rawOrder.id, 40);
  if (!id) return null;

  const tenant = sanitizeTenantId(rawTenant || rawOrder.tenant || DEFAULT_TENANT);
  const { dishById, dishByName } = loadTenantMenuDishMap(tenant);

  const rawItems = Array.isArray(rawOrder.items) ? rawOrder.items.slice(0, 100) : [];
  const cleanItems = rawItems.map((it) => {
    const itemId = sanitizeOrderText((it && it.id) || 'item', 48);
    const nombreBase = sanitizeOrderText((it && it.nombreBase) || (it && it.nombre) || 'Plato', 96);
    const catalogDish =
      dishById.get(itemId) || dishByName.get(nombreBase.toLowerCase()) || null;

    const qty = Math.min(200, Math.max(1, Math.round(Number(it && it.cantidad) || 1)));
    let unitPrice = Math.min(
      100000000,
      Math.max(0, Number(it && it.precioUnitario) || 0)
    );

    // Si el plato existe en el menú real del tenant, impedir manipulación de precios por debajo del catálogo
    if (catalogDish && typeof catalogDish.precio === 'number' && catalogDish.precio >= 0) {
      const hasOptions =
        (Array.isArray(it && it.opcionesDetalle) && it.opcionesDetalle.length > 0) ||
        Boolean(it && it.resumenOpciones);
      if (!hasOptions || unitPrice < catalogDish.precio) {
        unitPrice = catalogDish.precio;
      }
    }

    const subtotal = Math.min(200000000, Math.max(0, Math.round(unitPrice * qty)));
    return {
      id: itemId,
      cartKey: sanitizeOrderText((it && it.cartKey) || '', 120),
      subcuenta: sanitizeOrderText((it && it.subcuenta) || 'Cuenta 1 (Familia A)', 48),
      nombreBase: catalogDish && catalogDish.nombre ? sanitizeOrderText(catalogDish.nombre, 96) : nombreBase,
      nombre: sanitizeOrderText((it && it.nombre) || (catalogDish && catalogDish.nombre) || 'Plato', 140),
      resumenOpciones: sanitizeOrderText((it && it.resumenOpciones) || '', 180),
      opcionesDetalle: Array.isArray(it && it.opcionesDetalle)
        ? it.opcionesDetalle.slice(0, 20).map((d) => ({
            grupo: sanitizeOrderText(d && d.grupo, 48),
            valor: sanitizeOrderText(d && d.valor, 96)
          }))
        : [],
      precioUnitario: unitPrice,
      cantidad: qty,
      subtotal
    };
  });

  // Recalcular autoritativamente en el backend el total general y los subtotales de cuentas divididas
  const computedTotal = cleanItems.reduce((sum, item) => sum + (Number(item.subtotal) || 0), 0);
  const isWaiterCall = String(rawOrder.tipo || '').toUpperCase() === 'LLAMADO_MESERO' && cleanItems.length === 0;
  const total = isWaiterCall ? 0 : Math.min(500000000, Math.max(0, computedTotal));

  const subAccountMap = new Map();
  for (const item of cleanItems) {
    const accName = item.subcuenta || 'Cuenta 1 (Familia A)';
    const current = subAccountMap.get(accName) || {
      nombre: accName,
      itemsCount: 0,
      subtotal: 0
    };
    current.itemsCount += Number(item.cantidad) || 1;
    current.subtotal += Number(item.subtotal) || 0;
    subAccountMap.set(accName, current);
  }
  const cuentasDivididas = Array.from(subAccountMap.values());

  return {
    ...rawOrder,
    id,
    tenant,
    mesa: sanitizeOrderText(rawOrder.mesa || '1', 16),
    sector: sanitizeOrderText(rawOrder.sector || 'Terraza', 40),
    mesero_id: sanitizeOrderText(rawOrder.mesero_id || 'juan', 32).toLowerCase(),
    items: cleanItems,
    cuentasDivididas,
    total
  };
}

function handleWsMessage(socket, msg) {
  if (!msg || typeof msg !== 'object') return;
  const meta = clients.get(socket) || { role: 'unknown', tenant: DEFAULT_TENANT };

  // Rate limit por socket WebSocket (máx 120 mensajes/minuto) para mitigar inundación sin afectar el salón
  const now = Date.now();
  if (!meta.wsWindowStart || now - meta.wsWindowStart > 60000) {
    meta.wsWindowStart = now;
    meta.wsMsgCount = 1;
  } else {
    meta.wsMsgCount = (meta.wsMsgCount || 0) + 1;
    if (meta.wsMsgCount > 120) {
      logProdEvent('WARN', `[WS Firewall] Límite de mensajes excedido por socket (${meta.role})`);
      return;
    }
  }

  const type = msg.type || msg.eventType;

  if (type === 'REGISTER_WAITER') {
    const requestedTenant = sanitizeTenantId(msg.tenant || meta.boundTenant || meta.tenant);
    if (meta.boundTenant && meta.boundTenant !== requestedTenant) {
      logProdEvent('WARN', `[WS Isolation] Intento de cambio cruzado de tenant bloqueado (${meta.boundTenant} -> ${requestedTenant})`);
      return;
    }
    const opState = getTenantOperationalState(requestedTenant);
    if (!opState.operational) {
      sendWsJson(socket, {
        type: 'TENANT_NOT_OPERATIONAL',
        tenant: requestedTenant,
        estado: opState.estado,
        error: `El local "${opState.nombre}" se encuentra en estado "${opState.estado}".`
      });
      return;
    }

    meta.role = 'mesero';
    meta.tenant = requestedTenant;
    meta.boundTenant = requestedTenant;
    meta.waiterId = sanitizeOrderText(msg.id || 'juan', 32).toLowerCase();
    meta.sector = sanitizeOrderText(msg.sector || 'Terraza', 40);
    meta.tenantSectorKey = `${meta.tenant}:${meta.sector.toLowerCase()}`;
    clients.set(socket, meta);

    console.log(
      `[WS] 🛎️  Mesero conectado [${meta.tenant}]: ${meta.waiterId.toUpperCase()} (Sector: ${meta.sector})`
    );

    const tenantOrders = activeOrders.filter(
      (o) => sanitizeTenantId(o.tenant) === meta.tenant
    );

    sendWsJson(socket, {
      type: 'INITIAL_ORDERS',
      eventType: 'INITIAL_ORDERS',
      tenant: meta.tenant,
      orders: tenantOrders
    });
    return;
  }

  if (type === 'REGISTER_CLIENT') {
    const requestedTenant = sanitizeTenantId(msg.tenant || meta.boundTenant || meta.tenant);
    if (meta.boundTenant && meta.boundTenant !== requestedTenant) {
      logProdEvent('WARN', `[WS Isolation] Intento de cambio cruzado de tenant bloqueado (${meta.boundTenant} -> ${requestedTenant})`);
      return;
    }
    const opState = getTenantOperationalState(requestedTenant);
    if (!opState.operational) {
      sendWsJson(socket, {
        type: 'TENANT_NOT_OPERATIONAL',
        tenant: requestedTenant,
        estado: opState.estado,
        error: `El local "${opState.nombre}" no está habilitado para recibir pedidos (${opState.estado}).`
      });
      return;
    }

    meta.role = 'cliente';
    meta.tenant = requestedTenant;
    meta.boundTenant = requestedTenant;
    meta.mesa = sanitizeOrderText(msg.mesa || '1', 16);
    meta.sector = sanitizeOrderText(msg.sector || 'Terraza', 40);
    meta.waiterId = sanitizeOrderText(msg.mesero_id || 'juan', 32).toLowerCase();
    meta.tenantSectorKey = `${meta.tenant}:${meta.sector.toLowerCase()}`;
    clients.set(socket, meta);

    console.log(
      `[WS] 📱 Cliente conectado [${meta.tenant}]: Mesa ${meta.mesa} (${meta.sector})`
    );

    const tableOrders = activeOrders.filter(
      (o) =>
        sanitizeTenantId(o.tenant) === meta.tenant &&
        String(o.mesa) === meta.mesa &&
        String(o.sector).toLowerCase() === meta.sector.toLowerCase()
    );

    sendWsJson(socket, {
      type: 'CLIENT_SYNC',
      eventType: 'CLIENT_SYNC',
      tenant: meta.tenant,
      orders: tableOrders
    });
    return;
  }

  if (
    type === 'NEW_ORDER' ||
    type === 'NUEVA_COMANDA' ||
    type === 'COMANDA' ||
    type === 'LLAMADO_MESERO'
  ) {
    const rawOrder = msg.order || msg;
    const effectiveTenant = sanitizeTenantId(
      meta.boundTenant || rawOrder.tenant || msg.tenant || meta.tenant
    );
    if (
      meta.boundTenant &&
      rawOrder.tenant &&
      sanitizeTenantId(rawOrder.tenant) !== meta.boundTenant
    ) {
      logProdEvent('WARN', `[WS Isolation] Comanda rechazada por discrepancia de tenant (${rawOrder.tenant} != ${meta.boundTenant})`);
      return;
    }

    const opState = getTenantOperationalState(effectiveTenant);
    if (!opState.operational) {
      logProdEvent('WARN', `[WS Firewall] Comanda bloqueada en tenant no operativo [${effectiveTenant}] (estado=${opState.estado})`);
      sendWsJson(socket, {
        type: 'ORDER_REJECTED',
        tenant: effectiveTenant,
        estado: opState.estado,
        error: `El restaurante se encuentra en estado "${opState.estado}" y no puede recibir comandas.`
      });
      return;
    }

    const order = validateAndSanitizeWsOrder(rawOrder, effectiveTenant);
    if (!order || !order.id) return;

    meta.boundTenant = effectiveTenant;
    meta.tenant = effectiveTenant;
    order.tenant = effectiveTenant;
    const orderTenantSectorKey = `${order.tenant}:${String(order.sector || 'Terraza').toLowerCase()}`;

    const existingIdx = activeOrders.findIndex(
      (o) => o.id === order.id && sanitizeTenantId(o.tenant) === order.tenant
    );
    if (existingIdx === -1) {
      activeOrders.unshift(order);
      if (activeOrders.length > 300) activeOrders.pop();
    } else {
      activeOrders[existingIdx] = order;
    }

    console.log(
      `[WS] 🚀 ${order.tipo || 'COMANDA'} [${order.id}] (${orderTenantSectorKey}) — Mesa ${order.mesa} -> Mesero: ${order.mesero_id}`
    );

    for (const [clientSocket, info] of clients.entries()) {
      if (info.role === 'mesero' && sanitizeTenantId(info.tenant) === order.tenant) {
        const infoKey = `${sanitizeTenantId(info.tenant)}:${String(info.sector || '').toLowerCase()}`;
        const sectorMatch =
          !info.sector ||
          infoKey === orderTenantSectorKey ||
          String(info.waiterId).toLowerCase() === String(order.mesero_id).toLowerCase();

        sendWsJson(clientSocket, {
          type: 'NUEVA_COMANDA',
          eventType: 'NUEVA_COMANDA',
          tenant: order.tenant,
          tenantSector: orderTenantSectorKey,
          sectorMatch,
          order
        });
      }
    }

    sendWsJson(socket, {
      type: 'ORDER_ACK',
      eventType: 'COMANDA_CONFIRMADA',
      tenant: order.tenant,
      order
    });
    return;
  }

  if (type === 'UPDATE_ORDER_STATUS' || type === 'ESTADO_ACTUALIZADO') {
    const incomingOrder = msg.order;
    const orderId = sanitizeOrderText(msg.orderId || (incomingOrder && incomingOrder.id), 40);
    const newStatus = sanitizeOrderText(msg.estado || (incomingOrder && incomingOrder.estado), 32);

    if (!orderId) return;

    const effectiveTenant = sanitizeTenantId(
      meta.boundTenant || (incomingOrder && incomingOrder.tenant) || msg.tenant || meta.tenant
    );
    const opState = getTenantOperationalState(effectiveTenant);
    if (!opState.operational) return;

    let targetOrder = activeOrders.find(
      (o) => o.id === orderId && sanitizeTenantId(o.tenant) === effectiveTenant
    );
    if (targetOrder) {
      if (incomingOrder && typeof incomingOrder === 'object') {
        const sanitizedIncoming = validateAndSanitizeWsOrder(
          { ...targetOrder, ...incomingOrder, id: targetOrder.id },
          effectiveTenant
        );
        if (sanitizedIncoming) {
          targetOrder.items = sanitizedIncoming.items;
          targetOrder.cuentasDivididas = sanitizedIncoming.cuentasDivididas;
          targetOrder.total = sanitizedIncoming.total;
        }
        if (Array.isArray(incomingOrder.subAccountsCatalog)) {
          targetOrder.subAccountsCatalog = incomingOrder.subAccountsCatalog
            .slice(0, 12)
            .map((s) => sanitizeOrderText(s, 48));
        }
        if (incomingOrder.verificadoCaja !== undefined) {
          targetOrder.verificadoCaja = Boolean(incomingOrder.verificadoCaja);
        }
        if (incomingOrder.montoCorroborado !== undefined) {
          targetOrder.montoCorroborado = Math.max(0, Number(incomingOrder.montoCorroborado) || 0);
        }
        if (incomingOrder.cobradoAt) {
          targetOrder.cobradoAt = sanitizeOrderText(incomingOrder.cobradoAt, 40);
        }
      }
      if (newStatus) {
        targetOrder.estado = newStatus;
      }
      targetOrder.updatedAt = new Date().toISOString();
    } else if (incomingOrder) {
      const sanitizedNew = validateAndSanitizeWsOrder(incomingOrder, effectiveTenant);
      if (!sanitizedNew) return;
      targetOrder = sanitizedNew;
      activeOrders.unshift(targetOrder);
    }

    if (!targetOrder) return;
    const targetTenant = sanitizeTenantId(targetOrder.tenant);

    if (targetOrder.estado === 'Atendido') {
      recordServerOrderHistory(targetOrder);
    }

    console.log(
      `[WS] ✅ Estado actualizado [${targetTenant}:${targetOrder.sector}] [${targetOrder.id}] Mesa ${targetOrder.mesa} -> "${targetOrder.estado}"`
    );

    for (const [clientSocket, info] of clients.entries()) {
      if (sanitizeTenantId(info.tenant) !== targetTenant) continue;

      if (info.role === 'mesero') {
        sendWsJson(clientSocket, {
          type: 'ESTADO_ACTUALIZADO',
          eventType: 'ESTADO_ACTUALIZADO',
          tenant: targetTenant,
          order: targetOrder
        });
      } else if (
        info.role === 'cliente' &&
        String(info.mesa) === String(targetOrder.mesa) &&
        String(info.sector).toLowerCase() === String(targetOrder.sector).toLowerCase()
      ) {
        sendWsJson(clientSocket, {
          type: 'ESTADO_ACTUALIZADO',
          eventType: 'ESTADO_ACTUALIZADO',
          tenant: targetTenant,
          order: targetOrder
        });
      }
    }
    return;
  }

  if (type === 'CLEAR_SHIFT' || type === 'TURNO_ACTUALIZADO') {
    const targetTenant = sanitizeTenantId(meta.boundTenant || msg.tenant || meta.tenant);
    if (meta.boundTenant && msg.tenant && sanitizeTenantId(msg.tenant) !== meta.boundTenant) {
      return;
    }
    const opState = getTenantOperationalState(targetTenant);
    if (!opState.operational) return;

    const onlyAttended = msg.onlyAttended !== false;
    activeOrders.forEach((o) => {
      if (sanitizeTenantId(o.tenant) === targetTenant && (!onlyAttended || o.estado === 'Atendido')) {
        recordServerOrderHistory(o);
      }
    });

    if (onlyAttended) {
      activeOrders = activeOrders.filter(
        (o) => sanitizeTenantId(o.tenant) !== targetTenant || o.estado !== 'Atendido'
      );
    } else {
      activeOrders = activeOrders.filter((o) => sanitizeTenantId(o.tenant) !== targetTenant);
    }

    const remainingForTenant = activeOrders.filter(
      (o) => sanitizeTenantId(o.tenant) === targetTenant
    );

    for (const [clientSocket, info] of clients.entries()) {
      if (info.role === 'mesero' && sanitizeTenantId(info.tenant) === targetTenant) {
        sendWsJson(clientSocket, {
          type: 'TURNO_ACTUALIZADO',
          eventType: 'TURNO_ACTUALIZADO',
          tenant: targetTenant,
          orders: remainingForTenant
        });
      }
    }
  }
}

function sendJsonResponse(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(body);
}

/**
 * Servidor HTTP con WAF, Rate Limiting, Cabeceras de Seguridad OWASP, API REST y Archivos Estáticos.
 */
const server = http.createServer(async (req, res) => {
  applySecurityHeaders(req, res);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, X-Filename, X-Auth-Pin, X-Superadmin-Key, Authorization'
  );

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const clientIp = getClientIp(req);

  // Validar longitud de URL y formato básico
  if (!req.url || req.url.length > 2048) {
    sendJsonResponse(res, 414, { ok: false, error: 'URI demasiado larga.' });
    return;
  }

  let parsedUrl;
  let pathname;
  try {
    parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    pathname = decodeURIComponent(parsedUrl.pathname);
  } catch (_) {
    sendJsonResponse(res, 400, { ok: false, error: 'URL malformada.' });
    return;
  }

  // 1. Firewall de Rutas (WAF) y Prevención de Path Traversal / Archivos Sensibles
  if (isBlockedSensitivePath(pathname, req.url)) {
    logProdEvent('WARN', `[WAF] Acceso bloqueado a ruta restringida desde IP ${clientIp}: ${pathname}`);
    sendJsonResponse(res, 403, { ok: false, error: 'Acceso denegado por el firewall de seguridad.' });
    return;
  }

  // Validar parámetro ?tenant= si viene en la query para rechazar Path Traversal o caracteres inválidos
  if (parsedUrl.searchParams.has('tenant')) {
    const rawQueryTenant = parsedUrl.searchParams.get('tenant');
    if (rawQueryTenant && !isValidTenantSlug(rawQueryTenant)) {
      logProdEvent('WARN', `[WAF] Parámetro tenant inválido rechazado desde IP ${clientIp}: ${rawQueryTenant}`);
      sendJsonResponse(res, 400, { ok: false, error: 'Identificador de local (tenant) inválido.' });
      return;
    }
  }

  // 2. Rate Limiting por Categoría en Endpoints /api/*
  if (pathname.startsWith('/api/')) {
    if (pathname === '/api/auth/login') {
      const lockout = checkAuthLockout(clientIp);
      if (lockout.blocked) {
        sendJsonResponse(
          res,
          429,
          {
            ok: false,
            error: `Demasiados intentos fallidos. Acceso bloqueado temporalmente por seguridad (${Math.ceil(
              lockout.retryAfterSec / 60
            )} min).`
          },
          { 'Retry-After': String(lockout.retryAfterSec) }
        );
        return;
      }
      const loginRate = checkRateLimit(clientIp, 'auth-login', 15, 60 * 1000);
      if (!loginRate.allowed) {
        sendJsonResponse(
          res,
          429,
          { ok: false, error: 'Demasiadas solicitudes de inicio de sesión. Intenta en un minuto.' },
          { 'Retry-After': String(loginRate.retryAfterSec) }
        );
        return;
      }
    } else if (pathname === '/api/public/register-tenant') {
      const regRate = checkRateLimit(clientIp, 'public-register', 8, 10 * 60 * 1000);
      if (!regRate.allowed) {
        logProdEvent('WARN', `[RateLimit] Límite de registro público excedido desde IP ${clientIp}`);
        sendJsonResponse(
          res,
          429,
          { ok: false, error: 'Se alcanzó el límite de solicitudes de registro desde tu conexión. Intenta más tarde.' },
          { 'Retry-After': String(regRate.retryAfterSec) }
        );
        return;
      }
    } else if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
      const writeRate = checkRateLimit(clientIp, 'api-write', 45, 60 * 1000);
      if (!writeRate.allowed) {
        logProdEvent('WARN', `[RateLimit] Límite de escritura API excedido desde IP ${clientIp} en ${pathname}`);
        sendJsonResponse(
          res,
          429,
          { ok: false, error: 'Límite de operaciones de escritura alcanzado. Espera unos segundos.' },
          { 'Retry-After': String(writeRate.retryAfterSec) }
        );
        return;
      }
    } else {
      const generalRate = checkRateLimit(clientIp, 'api-general', 240, 60 * 1000);
      if (!generalRate.allowed) {
        sendJsonResponse(
          res,
          429,
          { ok: false, error: 'Límite de consultas por minuto excedido. Intenta nuevamente en breve.' },
          { 'Retry-After': String(generalRate.retryAfterSec) }
        );
        return;
      }
    }
  }

  // 0. Endpoints de Autenticación Unificada por Rol (Mesero / Admin / SuperAdmin)
  if (pathname === '/api/auth/login' && req.method === 'POST') {
    try {
      const bodyBuf = await readRequestBodyBuffer(req, 32 * 1024);
      const payload = JSON.parse(bodyBuf.toString('utf8'));
      const role =
        payload.role === 'superadmin'
          ? 'superadmin'
          : payload.role === 'admin'
          ? 'admin'
          : 'waiter';
      const rawTenantInput = payload.tenant || DEFAULT_TENANT;
      if (role !== 'superadmin' && !isValidTenantSlug(rawTenantInput)) {
        sendJsonResponse(res, 400, { ok: false, error: 'Slug de local inválido.' });
        return;
      }
      const tenant = role === 'superadmin' ? 'global' : sanitizeTenantId(rawTenantInput);
      const providedPin = String(payload.pin || '').trim().slice(0, 64);

      let expectedPin = SUPERADMIN_MASTER_PIN;
      if (role !== 'superadmin') {
        const sec = getTenantSecurityConfig(tenant);
        expectedPin = role === 'admin' ? sec.adminPin : sec.waiterPin;
      }

      if (
        !providedPin ||
        (!safeSecretCompare(providedPin, expectedPin) &&
          !safeSecretCompare(providedPin, SUPERADMIN_MASTER_PIN))
      ) {
        const failRec = recordAuthFailure(clientIp, `login:${role}@${tenant}`);
        logAuditEvent('AUTH_LOGIN_FAILED', {
          ip: clientIp,
          tenant,
          role,
          fails: failRec.fails
        });
        if (failRec.blockedUntil && failRec.blockedUntil > Date.now()) {
          const retrySec = Math.ceil((failRec.blockedUntil - Date.now()) / 1000);
          sendJsonResponse(
            res,
            429,
            {
              ok: false,
              error: 'Demasiados intentos fallidos consecutivos. Tu IP fue bloqueada por 12 minutos.'
            },
            { 'Retry-After': String(retrySec) }
          );
          return;
        }
        sendJsonResponse(res, 401, {
          ok: false,
          error:
            role === 'superadmin'
              ? 'Contraseña maestra de SuperAdmin inválida.'
              : `PIN de ${role === 'admin' ? 'Administrador' : 'Mesero'} inválido para el local "${tenant}".`
        });
        return;
      }

      resetAuthFailures(clientIp);
      const token = createRoleAuthToken(tenant, role, expectedPin);
      const cookieName = `techapy_auth_${tenant}_${role}`;
      const setCookie = buildAuthCookieHeader(req, cookieName, token, 43200);

      logAuditEvent('AUTH_LOGIN_SUCCESS', { ip: clientIp, tenant, role });
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': setCookie,
        'Cache-Control': 'no-store'
      });
      res.end(JSON.stringify({ ok: true, tenant, role }));
    } catch (err) {
      sendJsonResponse(res, 400, { ok: false, error: 'Solicitud de autenticación malformada.' });
    }
    return;
  }

  if (pathname === '/api/auth/logout' && (req.method === 'POST' || req.method === 'GET')) {
    const tenant = sanitizeTenantId(parsedUrl.searchParams.get('tenant') || DEFAULT_TENANT);
    const existingCookies = parseCookies(req.headers.cookie);
    const cookiesToClear = new Set([
      `techapy_auth_${tenant}_waiter`,
      `techapy_auth_${tenant}_admin`,
      'techapy_auth_global_superadmin'
    ]);
    for (const cookieKey of Object.keys(existingCookies)) {
      if (cookieKey.startsWith('techapy_auth_')) {
        cookiesToClear.add(cookieKey);
      }
    }
    logAuditEvent('AUTH_LOGOUT', { ip: clientIp, tenant });
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': Array.from(cookiesToClear).map((cName) =>
        buildAuthCookieHeader(req, cName, '', 0)
      ),
      'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // 0b. Endpoints de SuperAdmin (/api/superadmin/tenants y /api/superadmin/tenants/:tenant)
  if (pathname === '/api/superadmin/tenants' || pathname.startsWith('/api/superadmin/tenants/')) {
    const superAuth = verifyRoleAuthentication(req, parsedUrl, 'global', 'superadmin');
    if (!superAuth.authorized) {
      logProdEvent('WARN', `Acceso API SuperAdmin rechazado desde IP ${clientIp} en ${req.method} ${pathname}`);
      if (superAuth.lockedOut) {
        sendJsonResponse(
          res,
          429,
          { ok: false, error: 'IP bloqueada temporalmente por múltiples intentos fallidos.' },
          { 'Retry-After': String(superAuth.retryAfterSec || 600) }
        );
        return;
      }
      sendJsonResponse(res, 401, {
        ok: false,
        error: 'No autorizado. Se requiere autenticación de SuperAdmin (cookie o X-Superadmin-Key).'
      });
      return;
    }

    if (pathname === '/api/superadmin/tenants' && req.method === 'GET') {
      try {
        const tenants = listAllTenantsSummary(req);
        const publicBaseUrl = resolvePublicBaseUrl(req);
        sendJsonResponse(res, 200, { ok: true, count: tenants.length, publicBaseUrl, tenants });
      } catch (err) {
        logProdEvent('ERROR', 'Error listando tenants en SuperAdmin', err.message);
        sendJsonResponse(res, 500, { ok: false, error: 'Error interno al consultar los restaurantes.' });
      }
      return;
    }

    if (pathname === '/api/superadmin/tenants' && req.method === 'POST') {
      try {
        const bodyBuf = await readRequestBodyBuffer(req, 512 * 1024);
        const payload = JSON.parse(bodyBuf.toString('utf8'));
        if (payload.tenant && !isValidTenantSlug(payload.tenant)) {
          sendJsonResponse(res, 400, {
            ok: false,
            error: 'El slug del restaurante solo puede contener letras minúsculas, números y guiones.'
          });
          return;
        }
        const createdCfg = provisionNewTenantAtomically(payload);
        logAuditEvent('TENANT_PROVISIONED', {
          ip: clientIp,
          tenant: createdCfg.tenant,
          nombre: createdCfg.nombre,
          estado: createdCfg.estado
        });
        sendJsonResponse(res, 201, {
          ok: true,
          message: `Restaurante "${createdCfg.nombre}" (${createdCfg.tenant}) aprovisionado correctamente`,
          tenant: createdCfg
        });
      } catch (err) {
        const code = err.statusCode === 409 ? 409 : 400;
        logProdEvent('WARN', '[SuperAdmin] Error creando tenant', err.message);
        sendJsonResponse(res, code, {
          ok: false,
          error:
            code === 409
              ? 'El identificador (slug) del restaurante ya existe.'
              : 'No se pudo aprovisionar el restaurante. Verifica los datos enviados.'
        });
      }
      return;
    }

    const putMatch = pathname.match(/^\/api\/superadmin\/tenants\/([a-zA-Z0-9_-]+)$/);
    if (putMatch && req.method === 'PUT') {
      try {
        const rawSlug = putMatch[1];
        if (!isValidTenantSlug(rawSlug)) {
          sendJsonResponse(res, 400, { ok: false, error: 'Identificador de tenant inválido.' });
          return;
        }
        const targetSlug = sanitizeTenantId(rawSlug);
        const prevSec = getTenantSecurityConfig(targetSlug);
        const bodyBuf = await readRequestBodyBuffer(req, 512 * 1024);
        const payload = JSON.parse(bodyBuf.toString('utf8'));
        const updatedCfg = updateExistingTenantAtomically(targetSlug, payload);

        const pinChanged =
          (payload.adminPin !== undefined && String(payload.adminPin).trim() !== prevSec.adminPin) ||
          (payload.waiterPin !== undefined && String(payload.waiterPin).trim() !== prevSec.waiterPin);

        logAuditEvent('TENANT_UPDATED_BY_SUPERADMIN', {
          ip: clientIp,
          tenant: updatedCfg.tenant,
          action: payload.action || 'update',
          estado: updatedCfg.estado,
          fechaVencimiento: updatedCfg.fechaVencimiento,
          pinChanged
        });

        sendJsonResponse(res, 200, {
          ok: true,
          message: `Configuración de "${updatedCfg.nombre}" actualizada`,
          tenant: updatedCfg
        });
      } catch (err) {
        logProdEvent('ERROR', '[SuperAdmin] Error actualizando tenant', err.message);
        sendJsonResponse(res, 400, {
          ok: false,
          error: 'No se pudo actualizar la configuración del restaurante.'
        });
      }
      return;
    }
  }

  // 0c. Endpoint Público de Solicitud / Registro de Nuevo Restaurante desde Landing (Estado: "pendiente")
  if (pathname === '/api/public/register-tenant' && req.method === 'POST') {
    try {
      const bodyBuf = await readRequestBodyBuffer(req, 128 * 1024);
      const payload = JSON.parse(bodyBuf.toString('utf8'));
      const rawName = sanitizeOrderText(payload.nombre || payload.restaurant || '', 90);
      if (!rawName || rawName.length < 2) {
        sendJsonResponse(res, 400, { ok: false, error: 'El nombre del restaurante es obligatorio (mín. 2 caracteres).' });
        return;
      }

      let baseSlug = String(payload.tenant || rawName)
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 26);

      if (!baseSlug || baseSlug === 'demo' || baseSlug === 'global' || !isValidTenantSlug(baseSlug)) {
        baseSlug = `local-${Date.now().toString().slice(-4)}`;
      }

      // Protección estricta contra colisión o sobrescritura de cuentas existentes (activas, suspendidas o pendientes)
      let finalSlug = baseSlug;
      let attempt = 0;
      while (
        fs.existsSync(path.join(TENANTS_DATA_DIR, finalSlug, 'config.json')) &&
        attempt < 10
      ) {
        attempt += 1;
        const suffix = `${Date.now().toString().slice(-3)}${crypto.randomBytes(1).toString('hex')}`.slice(0, 5);
        finalSlug = `${baseSlug.slice(0, 28)}-${suffix}`;
      }

      const createdCfg = provisionNewTenantAtomically(
        {
          tenant: finalSlug,
          nombre: rawName,
          ruc: sanitizeOrderText(payload.ruc || '80000000-0', 28),
          ciudad: sanitizeOrderText(payload.ciudad || 'Asunción, Paraguay', 80),
          plan: sanitizeOrderText(payload.plan || 'Plan Restaurante de Autor', 80),
          estado: 'pendiente',
          fechaSolicitud: new Date().toISOString(),
          contactoNombre: sanitizeOrderText(payload.contactoNombre || '', 80),
          contactoWhatsapp: sanitizeOrderText(payload.contactoWhatsapp || '', 28),
          capacidadMesas: sanitizeOrderText(payload.capacidadMesas || '', 24)
        },
        { allowIfPending: false }
      );

      logAuditEvent('TENANT_REGISTERED_PENDING', {
        ip: clientIp,
        tenant: createdCfg.tenant,
        nombre: createdCfg.nombre,
        estado: 'pendiente'
      });

      sendJsonResponse(res, 201, {
        ok: true,
        tenant: createdCfg.tenant,
        estado: 'pendiente',
        salesWhatsapp: DEFAULT_SALES_WHATSAPP,
        config: {
          tenant: createdCfg.tenant,
          nombre: createdCfg.nombre,
          ruc: createdCfg.ruc,
          ciudad: createdCfg.ciudad,
          plan: createdCfg.plan,
          estado: createdCfg.estado,
          fechaSolicitud: createdCfg.fechaSolicitud
        }
      });
    } catch (err) {
      logProdEvent('ERROR', 'Error en POST /api/public/register-tenant', err.message);
      sendJsonResponse(res, 400, { ok: false, error: 'Datos de solicitud inválidos.' });
    }
    return;
  }

  // 1. Endpoint de información del servidor local y URL pública Cloud (Render)
  if (pathname === '/api/server-info' && req.method === 'GET') {
    const lanIp = getLocalLanIp();
    const lanBaseUrl = `http://${lanIp}:${PORT}`;
    const publicBaseUrl = resolvePublicBaseUrl(req);
    const publicUrl = publicBaseUrl || null;
    const effectiveBase = publicBaseUrl || lanBaseUrl;
    const effectiveWs = publicBaseUrl
      ? `${publicBaseUrl.startsWith('https') ? 'wss' : 'ws'}://${publicBaseUrl.replace(/^https?:\/\//, '')}/ws`
      : `ws://${lanIp}:${PORT}/ws`;

    sendJsonResponse(res, 200, {
      lanIp,
      port: PORT,
      lanBaseUrl,
      publicUrl,
      publicBaseUrl: publicBaseUrl || null,
      baseUrl: effectiveBase,
      wsUrl: effectiveWs,
      activeOrdersCount: activeOrders.length
    });
    return;
  }

  // Resolver rutas Multi-Tenant: /api/:tenant/menu, /api/:tenant/upload-model, /api/:tenant/config, /api/:tenant/orders-history
  const tenantRouteMatch = pathname.match(/^\/api\/([a-zA-Z0-9_-]+)\/(menu|upload-model|config|orders-history)$/);
  if (tenantRouteMatch && !isValidTenantSlug(tenantRouteMatch[1])) {
    logProdEvent('WARN', `[WAF] Slug inválido en ruta API desde IP ${clientIp}: ${tenantRouteMatch[1]}`);
    sendJsonResponse(res, 400, { ok: false, error: 'Identificador de local (tenant) inválido.' });
    return;
  }
  const routeTenant = tenantRouteMatch
    ? sanitizeTenantId(tenantRouteMatch[1])
    : sanitizeTenantId(parsedUrl.searchParams.get('tenant') || DEFAULT_TENANT);
  const routeAction = tenantRouteMatch ? tenantRouteMatch[2] : null;

  // 1a. GET /api/:tenant/orders-history -> Historial de mesas cobradas/cerradas (Requiere sesión de Mesero/Admin del tenant o SuperAdmin)
  if ((routeAction === 'orders-history' || pathname === '/api/orders-history') && req.method === 'GET') {
    const staffAuth = verifyTenantStaffAccess(req, parsedUrl, routeTenant);
    if (!staffAuth.authorized) {
      sendJsonResponse(res, staffAuth.lockedOut ? 429 : 401, {
        ok: false,
        error: staffAuth.lockedOut
          ? 'IP bloqueada temporalmente por intentos fallidos.'
          : 'No autorizado. Se requiere sesión activa de Mesero o Administrador del local.'
      });
      return;
    }

    const attendedActive = activeOrders.filter(
      (o) => sanitizeTenantId(o.tenant) === routeTenant && o.estado === 'Atendido'
    );
    const archivedForTenant = archivedHistoryOrders.filter(
      (o) => sanitizeTenantId(o.tenant) === routeTenant
    );
    const byId = new Map();
    attendedActive.forEach((o) => {
      if (o && o.id) byId.set(o.id, o);
    });
    archivedForTenant.forEach((o) => {
      if (o && o.id && !byId.has(o.id)) byId.set(o.id, o);
    });
    const history = Array.from(byId.values()).sort(
      (a, b) => new Date(b.cobradoAt || b.timestamp || 0) - new Date(a.cobradoAt || a.timestamp || 0)
    );
    sendJsonResponse(res, 200, { ok: true, tenant: routeTenant, history });
    return;
  }

  // 1b. GET /api/:tenant/config (o GET /api/config?tenant=...) -> Oculta los PINs de seguridad e incluye estado de vencimiento y publicBaseUrl
  if ((routeAction === 'config' || pathname === '/api/config') && req.method === 'GET') {
    const { configPath } = getTenantPaths(routeTenant);
    fs.readFile(configPath, 'utf8', (err, content) => {
      if (err) {
        sendJsonResponse(res, 500, { ok: false, error: 'No se pudo leer la configuración del local.' });
        return;
      }
      try {
        const publicCfg = JSON.parse(content);
        const subInfo = computeSubscriptionStatus(publicCfg);
        const resolvedPublicUrl = resolvePublicBaseUrl(req, publicCfg);
        publicCfg.estado = normalizeTenantEstado(publicCfg.estado);
        publicCfg.ultimoPago = subInfo.ultimoPago;
        publicCfg.fechaVencimiento = subInfo.fechaVencimiento;
        publicCfg.diasRestantes = subInfo.diasRestantes;
        publicCfg.porVencer = subInfo.porVencer;
        publicCfg.vencido = subInfo.vencido;
        publicCfg.salesWhatsapp = subInfo.salesWhatsapp;
        publicCfg.publicBaseUrl = resolvedPublicUrl || publicCfg.publicBaseUrl || null;
        delete publicCfg.adminPin;
        delete publicCfg.waiterPin;
        if (publicCfg.credenciales) {
          delete publicCfg.credenciales.pinAcceso;
        }
        sendJsonResponse(res, 200, publicCfg);
      } catch (_) {
        sendJsonResponse(res, 500, { ok: false, error: 'Error procesando configuración del local.' });
      }
    });
    return;
  }

  // POST /api/:tenant/config (o POST /api/config?tenant=...) -> Requiere autenticación de Admin o SuperAdmin
  if ((routeAction === 'config' || pathname === '/api/config') && req.method === 'POST') {
    const adminAuth = verifyRoleAuthentication(req, parsedUrl, routeTenant, 'admin');
    if (!adminAuth.authorized) {
      logProdEvent('WARN', `Acceso rechazado en POST /api/${routeTenant}/config desde IP ${clientIp}`);
      sendJsonResponse(res, adminAuth.lockedOut ? 429 : 401, {
        ok: false,
        error: adminAuth.lockedOut
          ? 'IP bloqueada temporalmente por intentos fallidos.'
          : 'No autorizado. Inicia sesión como Administrador del local.'
      });
      return;
    }

    try {
      const { tenant, configPath } = getTenantPaths(routeTenant);
      const existingSec = getTenantSecurityConfig(tenant);
      const bodyBuf = await readRequestBodyBuffer(req, 512 * 1024);
      const parsed = JSON.parse(bodyBuf.toString('utf8'));
      const cfgError = validateTenantConfigJson(parsed);
      if (cfgError) {
        logProdEvent('WARN', `Validación fallida en POST /api/${tenant}/config`, cfgError);
        sendJsonResponse(res, 400, { ok: false, error: cfgError });
        return;
      }
      parsed.tenant = tenant;
      parsed.adminPin = String(parsed.adminPin || existingSec.adminPin || '1234').trim().slice(0, 32);
      parsed.waiterPin = String(parsed.waiterPin || existingSec.waiterPin || '5678').trim().slice(0, 32);
      const formattedCfg = JSON.stringify(parsed, null, 2) + '\n';
      writeJsonAtomically(configPath, formattedCfg);

      const distConfigPath = path.join(DIST_DIR, 'data', 'tenants', tenant, 'config.json');
      if (fs.existsSync(DIST_DIR)) {
        fs.mkdirSync(path.dirname(distConfigPath), { recursive: true });
        writeJsonAtomically(distConfigPath, formattedCfg);
      }

      const pinChanged =
        parsed.adminPin !== existingSec.adminPin || parsed.waiterPin !== existingSec.waiterPin;

      logAuditEvent('TENANT_CONFIG_UPDATED', {
        ip: clientIp,
        tenant,
        pinChanged
      });
      sendJsonResponse(res, 200, { ok: true, tenant, config: parsed });
    } catch (err) {
      logProdEvent('ERROR', `Error en POST /api/${routeTenant}/config`, err.message);
      sendJsonResponse(res, 400, { ok: false, error: 'Formato JSON de configuración inválido.' });
    }
    return;
  }

  // 2. GET /api/:tenant/menu o GET /api/menu -> Devuelve menu-data.json del tenant
  if ((routeAction === 'menu' || pathname === '/api/menu') && req.method === 'GET') {
    const { menuPath } = getTenantPaths(routeTenant);
    fs.readFile(menuPath, 'utf8', (err, content) => {
      if (err) {
        sendJsonResponse(res, 500, { ok: false, error: 'No se pudo leer el catálogo del local.' });
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(content);
    });
    return;
  }

  // 3. POST /api/:tenant/menu o POST /api/menu -> Requiere Admin/SuperAdmin, valida, crea backup y guarda atómicamente
  if ((routeAction === 'menu' || pathname === '/api/menu') && req.method === 'POST') {
    const adminAuth = verifyRoleAuthentication(req, parsedUrl, routeTenant, 'admin');
    if (!adminAuth.authorized) {
      logProdEvent('WARN', `Acceso rechazado en POST /api/${routeTenant}/menu desde IP ${clientIp}`);
      sendJsonResponse(res, adminAuth.lockedOut ? 429 : 401, {
        ok: false,
        error: adminAuth.lockedOut
          ? 'IP bloqueada temporalmente por intentos fallidos.'
          : 'No autorizado. Inicia sesión como Administrador del local para editar la carta.'
      });
      return;
    }

    try {
      const { tenant, menuPath, backupPath } = getTenantPaths(routeTenant);
      const bodyBuf = await readRequestBodyBuffer(req, 4 * 1024 * 1024);
      const parsed = JSON.parse(bodyBuf.toString('utf8'));
      const validationError = validateMenuJson(parsed);

      if (validationError) {
        logProdEvent('WARN', `Validación rechazada en POST /api/${tenant}/menu`, validationError);
        sendJsonResponse(res, 400, { ok: false, error: validationError });
        return;
      }

      if (fs.existsSync(menuPath)) {
        fs.copyFileSync(menuPath, backupPath);
      }

      const formattedJson = JSON.stringify(parsed, null, 2) + '\n';
      writeJsonAtomically(menuPath, formattedJson);
      if (tenant === DEFAULT_TENANT) {
        writeJsonAtomically(MENU_FILE_PATH, formattedJson);
      }

      if (fs.existsSync(DIST_DIR)) {
        const distTenantMenuPath = path.join(DIST_DIR, 'data', 'tenants', tenant, 'menu-data.json');
        fs.mkdirSync(path.dirname(distTenantMenuPath), { recursive: true });
        writeJsonAtomically(distTenantMenuPath, formattedJson);
        if (tenant === DEFAULT_TENANT) {
          const distDefaultMenuPath = path.join(DIST_DIR, 'data', 'menu-data.json');
          fs.mkdirSync(path.dirname(distDefaultMenuPath), { recursive: true });
          writeJsonAtomically(distDefaultMenuPath, formattedJson);
        }
      }

      logAuditEvent('TENANT_MENU_UPDATED', {
        ip: clientIp,
        tenant,
        platosCount: parsed.platos.length
      });

      for (const [clientSocket, info] of clients.entries()) {
        if (sanitizeTenantId(info.tenant) === tenant) {
          sendWsJson(clientSocket, {
            type: 'MENU_UPDATED',
            eventType: 'MENU_UPDATED',
            tenant,
            platosCount: parsed.platos.length
          });
        }
      }

      sendJsonResponse(res, 200, {
        ok: true,
        tenant,
        message: 'Carta guardada correctamente y copia de seguridad creada',
        platosCount: parsed.platos.length
      });
    } catch (err) {
      logProdEvent('ERROR', `Error procesando JSON en POST /api/${routeTenant}/menu`, err.message);
      sendJsonResponse(res, 400, {
        ok: false,
        error: 'El contenido enviado para la carta no es un JSON válido.'
      });
    }
    return;
  }

  // 4. POST /api/:tenant/upload-model o POST /api/upload-model -> Requiere Admin/SuperAdmin y valida binario .glb
  if ((routeAction === 'upload-model' || pathname === '/api/upload-model') && req.method === 'POST') {
    const adminAuth = verifyRoleAuthentication(req, parsedUrl, routeTenant, 'admin');
    if (!adminAuth.authorized) {
      logProdEvent('WARN', `Acceso rechazado en POST /api/${routeTenant}/upload-model desde IP ${clientIp}`);
      sendJsonResponse(res, adminAuth.lockedOut ? 429 : 401, {
        ok: false,
        error: adminAuth.lockedOut
          ? 'IP bloqueada temporalmente por intentos fallidos.'
          : 'No autorizado. Inicia sesión como Administrador del local para subir modelos 3D.'
      });
      return;
    }

    try {
      const { tenant, modelsDir } = getTenantPaths(routeTenant);
      fs.mkdirSync(modelsDir, { recursive: true });
      const contentType = (req.headers['content-type'] || '').toLowerCase();
      const bodyBuf = await readRequestBodyBuffer(req, 50 * 1024 * 1024);

      let filename = '';
      let fileBuffer = null;

      if (contentType.includes('application/json')) {
        const payload = JSON.parse(bodyBuf.toString('utf8'));
        filename = sanitizeGlbFilename(payload.filename || 'modelo.glb');
        const rawBase64 = String(payload.dataBase64 || payload.data || '').replace(
          /^data:[^;]+;base64,/,
          ''
        );
        if (!rawBase64) {
          sendJsonResponse(res, 400, { ok: false, error: 'El campo dataBase64 está vacío.' });
          return;
        }
        fileBuffer = Buffer.from(rawBase64, 'base64');
      } else if (contentType.includes('multipart/form-data')) {
        const parsedPart = parseMultipartGlb(bodyBuf, req.headers['content-type']);
        filename = sanitizeGlbFilename(parsedPart.filename);
        fileBuffer = parsedPart.fileBuffer;
      } else {
        const rawHeaderName =
          req.headers['x-filename'] || parsedUrl.searchParams.get('filename') || 'modelo.glb';
        filename = sanitizeGlbFilename(rawHeaderName);
        fileBuffer = bodyBuf;
      }

      if (!fileBuffer || fileBuffer.length < 12) {
        sendJsonResponse(res, 400, {
          ok: false,
          error: 'El archivo .glb recibido está vacío o incompleto.'
        });
        return;
      }

      // Validar firma binaria glTF ('glTF' = 0x67 0x6C 0x54 0x46) para evitar subida de archivos ejecutables o scripts disfrazados
      const magicHeader = fileBuffer.subarray(0, 4).toString('ascii');
      if (magicHeader !== 'glTF') {
        sendJsonResponse(res, 400, {
          ok: false,
          error: 'El archivo subido no tiene una cabecera binaria glTF (.glb) válida.'
        });
        return;
      }

      if (!isValidSafeFilename(filename)) {
        sendJsonResponse(res, 400, { ok: false, error: 'Nombre de archivo .glb inválido.' });
        return;
      }

      const targetDiskPath = path.resolve(modelsDir, filename);
      if (!targetDiskPath.startsWith(path.resolve(modelsDir) + path.sep)) {
        sendJsonResponse(res, 403, { ok: false, error: 'Nombre de archivo no permitido.' });
        return;
      }
      fs.writeFileSync(targetDiskPath, fileBuffer);

      if (fs.existsSync(DIST_DIR)) {
        const distModelDir = path.join(DIST_DIR, 'assets', 'tenants', tenant, 'models');
        fs.mkdirSync(distModelDir, { recursive: true });
        fs.writeFileSync(path.join(distModelDir, filename), fileBuffer);
      }

      const relativeModelPath = `./assets/tenants/${tenant}/models/${filename}`;
      logAuditEvent('TENANT_MODEL_UPLOADED', {
        ip: clientIp,
        tenant,
        filename,
        sizeKB: Number((fileBuffer.length / 1024).toFixed(1))
      });

      sendJsonResponse(res, 200, {
        ok: true,
        tenant,
        filename,
        path: relativeModelPath,
        sizeBytes: fileBuffer.length
      });
    } catch (err) {
      logProdEvent('ERROR', `Error subiendo modelo .glb en [${routeTenant}]`, err.message);
      sendJsonResponse(res, 400, {
        ok: false,
        error: 'No se pudo procesar el archivo .glb subido.'
      });
    }
    return;
  }

  // 5. Archivos estáticos, Landing por Defecto en `/` y Separación Automática de Roles
  if (pathname === '/') {
    const hasTableParams =
      parsedUrl.searchParams.has('mesa') || parsedUrl.searchParams.has('sector');
    pathname = hasTableParams ? '/index.html' : '/landing.html';
  } else if (pathname === '/menu.html') {
    pathname = '/index.html';
  }

  // Bloquear lectura estática directa de config.json o cualquier archivo restringido
  if (isBlockedSensitivePath(pathname, req.url)) {
    sendJsonResponse(res, 403, { ok: false, error: 'Acceso prohibido por seguridad.' });
    return;
  }

  const activeTenant = sanitizeTenantId(parsedUrl.searchParams.get('tenant') || DEFAULT_TENANT);
  let requiredRole = null;

  if (pathname === '/superadmin.html') {
    requiredRole = 'superadmin';
  } else if (pathname === '/mesero.html') {
    requiredRole = 'waiter';
  } else if (pathname === '/admin-menu.html' || pathname === '/admin-qr.html') {
    requiredRole = 'admin';
  }

  // Verificar si el servicio del tenant se encuentra en estado "pendiente" o "Suspendido"
  if (
    pathname === '/index.html' ||
    pathname === '/mesero.html' ||
    pathname === '/admin-menu.html' ||
    pathname === '/admin-qr.html'
  ) {
    const { rawConfig, nombre } = getTenantSecurityConfig(activeTenant);
    const tenantEstado = normalizeTenantEstado(rawConfig && rawConfig.estado);

    if (tenantEstado === 'pendiente') {
      const waMsg = encodeURIComponent(
        `Hola TechaPY, solicito la activación de mi cuenta para el local "${nombre}" (Tenant: ${activeTenant}).`
      );
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/><title>Cuenta Pendiente de Activación — TechaPY</title><style>body{background:#0e1013;color:#f4f4f6;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;text-align:center}.box{max-width:480px;background:#15181e;border:1px solid rgba(197,160,89,0.45);border-radius:16px;padding:34px 28px;box-shadow:0 24px 60px rgba(0,0,0,0.75)}.badge{display:inline-block;font-size:0.7rem;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#d4af37;background:rgba(197,160,89,0.14);border:1px solid rgba(197,160,89,0.35);padding:4px 10px;border-radius:999px;margin-bottom:14px}h1{color:#ffffff;font-size:1.35rem;margin:0 0 10px}p{color:#989ea8;font-size:0.9rem;line-height:1.55;margin-bottom:20px}.actions{display:flex;flex-direction:column;gap:10px}.btn{display:inline-block;text-decoration:none;font-weight:700;font-size:0.86rem;padding:11px 16px;border-radius:10px}.btn-gold{background:#c5a059;color:#0e1013}.btn-outline{border:1px solid rgba(255,255,255,0.15);color:#f4f4f6}</style></head><body><div class="box"><span class="badge">ESTADO: PENDIENTE DE ACTIVACIÓN</span><h1>Cuenta pendiente de activación por SuperAdmin</h1><p>El entorno multi-tenant de <strong>${nombre}</strong> (<code>?tenant=${activeTenant}</code>) fue registrado correctamente, pero aún requiere validación y activación comercial en el panel de <strong>SuperAdmin</strong>.</p><div class="actions"><a class="btn btn-gold" href="https://wa.me/${DEFAULT_SALES_WHATSAPP}?text=${waMsg}" target="_blank" rel="noopener">Solicitar Activación por WhatsApp</a><a class="btn btn-outline" href="/landing.html">← Volver a la Página Principal</a></div></div></body></html>`);
      return;
    }

    if (
      tenantEstado === 'Suspendido' &&
      (pathname === '/index.html' || pathname === '/mesero.html')
    ) {
      res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/><title>Servicio Suspendido — TechaPY</title><style>body{background:#0e1013;color:#f4f4f6;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;text-align:center}.box{max-width:440px;background:#15181e;border:1px solid rgba(197,160,89,0.35);border-radius:14px;padding:30px}h1{color:#d4af37;font-size:1.3rem;margin-bottom:10px}p{color:#989ea8;font-size:0.9rem;line-height:1.5}</style></head><body><div class="box"><h1>Servicio Temporalmente Suspendido</h1><p>La carta digital 3D del establecimiento <strong>${nombre}</strong> se encuentra temporalmente en mantenimiento o pausa administrativa.</p></div></body></html>`);
      return;
    }
  }

  let authCookieToSet = null;
  if (requiredRole) {
    const authResult = verifyRoleAuthentication(req, parsedUrl, activeTenant, requiredRole);
    if (!authResult.authorized) {
      if (authResult.lockedOut) {
        res.writeHead(429, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Retry-After': String(authResult.retryAfterSec || 600)
        });
        res.end('429 Too Many Requests — Acceso bloqueado temporalmente por intentos fallidos.');
        return;
      }
      logProdEvent(
        'WARN',
        `Acceso no autenticado interceptado en ${pathname} [tenant=${activeTenant}, rol=${requiredRole}] -> HTTP 401 Modal Login`
      );
      sendUnifiedRoleLoginModal(res, {
        tenant: authResult.tenant,
        nombre: authResult.nombre,
        requiredRole,
        reqUrl: req.url
      });
      return;
    }
    authCookieToSet = authResult.cookieHeader;
  }

  // Priorizar servicio estático desde la carpeta compilada `dist/` con prevención estricta de Path Traversal
  const staticRoot = path.resolve(fs.existsSync(DIST_DIR) ? DIST_DIR : ROOT_DIR);
  const relativeTarget = pathname.replace(/^\/+/, '');
  let safePath = path.resolve(staticRoot, relativeTarget);
  if (safePath !== staticRoot && !safePath.startsWith(staticRoot + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }

  // Fallback seguro a ROOT_DIR únicamente para recursos dinámicos permitidos (/assets/tenants o /data/tenants)
  if (!fs.existsSync(safePath) && staticRoot === path.resolve(DIST_DIR)) {
    const resolvedRoot = path.resolve(ROOT_DIR);
    const fallbackRootPath = path.resolve(resolvedRoot, relativeTarget);
    if (
      fallbackRootPath.startsWith(resolvedRoot + path.sep) &&
      !isBlockedSensitivePath(pathname, req.url) &&
      fs.existsSync(fallbackRootPath)
    ) {
      safePath = fallbackRootPath;
    }
  }

  fs.stat(safePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Recurso no encontrado');
      return;
    }

    const ext = path.extname(safePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const headers = {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache'
    };
    if (authCookieToSet) {
      headers['Set-Cookie'] = authCookieToSet;
    }

    res.writeHead(200, headers);

    const stream = fs.createReadStream(safePath);
    stream.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      res.end('Error al servir recurso');
    });
    stream.pipe(res);
  });
});

/**
 * Valida la cabecera Origin en conexiones WebSocket cuando viene presente,
 * permitiendo mismo host, red local (LAN/localhost) o el dominio público en Render.
 */
function isAllowedWsOrigin(req) {
  const originHeader = String((req && req.headers && req.headers.origin) || '').trim();
  if (!originHeader || originHeader === 'null') return true;
  try {
    const originUrl = new URL(originHeader);
    const reqHost = String(
      (req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || ''
    )
      .split(',')[0]
      .trim()
      .toLowerCase();
    const originHost = originUrl.host.toLowerCase();
    const originHostname = originUrl.hostname.toLowerCase();
    if (reqHost && (originHost === reqHost || originHostname === reqHost.split(':')[0])) {
      return true;
    }
    if (isPrivateOrLocalUrl(originHeader)) {
      return true;
    }
    if (originHostname.endsWith('.onrender.com')) {
      return true;
    }
    const pubBase = resolvePublicBaseUrl(req);
    if (pubBase) {
      const pubUrl = new URL(pubBase);
      if (originUrl.hostname.toLowerCase() === pubUrl.hostname.toLowerCase()) {
        return true;
      }
    }
    return false;
  } catch (_) {
    return false;
  }
}

const MAX_WS_FRAME_BYTES = 64 * 1024;

/**
 * Upgrade HTTP -> WebSocket RFC 6455 en `/ws`.
 */
server.on('upgrade', (req, socket) => {
  const clientIp = getClientIp(req);
  const wsUpgradeRate = checkRateLimit(clientIp, 'ws-upgrade', 60, 60 * 1000);
  if (!wsUpgradeRate.allowed) {
    socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
    socket.destroy();
    return;
  }

  if (!isAllowedWsOrigin(req)) {
    logAuditEvent('WS_ORIGIN_REJECTED', {
      ip: clientIp,
      origin: String((req.headers && req.headers.origin) || '')
    });
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  const upgradeHeader = (req.headers['upgrade'] || '').toLowerCase();
  const key = req.headers['sec-websocket-key'];

  if (upgradeHeader !== 'websocket' || !key) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  const acceptKey = crypto
    .createHash('sha1')
    .update(key + WS_MAGIC_GUID, 'binary')
    .digest('base64');

  const responseHeaders = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey}`,
    '\r\n'
  ];

  socket.write(responseHeaders.join('\r\n'));
  socket.setNoDelay(true);

  clients.set(socket, {
    role: 'connected',
    ip: clientIp,
    connectedAt: new Date().toISOString()
  });

  let recvBuffer = Buffer.alloc(0);

  socket.on('data', (chunk) => {
    try {
      recvBuffer = Buffer.concat([recvBuffer, chunk]);
      if (recvBuffer.length > 512 * 1024) {
        logProdEvent('WARN', `Buffer WebSocket excedió 512KB desde IP ${clientIp}; cerrando conexión`);
        socket.destroy();
        return;
      }
      const { messages, remaining } = parseWsFrames(recvBuffer);
      recvBuffer = remaining;

      for (const frame of messages) {
        if (frame.payload && frame.payload.length > MAX_WS_FRAME_BYTES) {
          logProdEvent('WARN', `[WS Firewall] Frame supera ${MAX_WS_FRAME_BYTES} bytes desde IP ${clientIp}`);
          // RFC 6455 Close code 1009 (Message Too Big)
          const closeFrame = Buffer.from([0x88, 0x02, 0x03, 0xf1]);
          try {
            socket.write(closeFrame);
          } catch (_) {}
          socket.end();
          return;
        }
        if (frame.opcode === 0x08) {
          socket.end();
          return;
        }
        if (frame.opcode === 0x09) {
          const pongPayload = frame.payload.subarray(0, 125);
          const pong = Buffer.concat([Buffer.from([0x8a, pongPayload.length]), pongPayload]);
          socket.write(pong);
          continue;
        }
        if (frame.opcode === 0x01) {
          try {
            const text = frame.payload.toString('utf8');
            const parsed = JSON.parse(text);
            handleWsMessage(socket, parsed);
          } catch (err) {
            logProdEvent('WARN', '[WS] JSON inválido recibido y descartado', err.message);
          }
        }
      }
    } catch (frameErr) {
      logProdEvent('ERROR', '[WS] Error procesando trama WebSocket', frameErr.message);
      recvBuffer = Buffer.alloc(0);
    }
  });

  socket.on('close', () => {
    clients.delete(socket);
  });

  socket.on('error', (err) => {
    logProdEvent('WARN', '[WS] Error en socket de cliente', err ? err.message : '');
    clients.delete(socket);
  });
});

server.on('error', (err) => {
  logProdEvent('ERROR', 'Error en servidor HTTP principal', err ? err.message : '');
});

/**
 * Cierre limpio y resiliente ante señales del sistema (SIGTERM / SIGINT en Render o contenedor).
 */
let isShuttingDown = false;
function handleGracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logProdEvent('INFO', `Señal ${signal} recibida. Cerrando conexiones WebSocket y servidor HTTP...`);
  for (const [clientSocket] of clients.entries()) {
    try {
      clientSocket.end();
      clientSocket.destroy();
    } catch (_) {}
  }
  clients.clear();
  server.close(() => {
    logProdEvent('INFO', 'Servidor TechaPY detenido limpiamente.');
    process.exit(0);
  });
  setTimeout(() => {
    process.exit(0);
  }, 4000).unref();
}

process.on('SIGTERM', () => handleGracefulShutdown('SIGTERM'));
process.on('SIGINT', () => handleGracefulShutdown('SIGINT'));

server.listen(PORT, '0.0.0.0', () => {
  const lanIp = getLocalLanIp();
  logProdEvent('INFO', `Servidor TechaPY iniciado en 0.0.0.0:${PORT} (LAN: ${lanIp})`);
  console.log('==================================================================');
  console.log(' 🏛️  TECHAPY 3D & AR — SERVIDOR INTEGRADO HTTP + API + WEBSOCKET');
  console.log('==================================================================');
  console.log(` • Red Local Wi-Fi (Para QR y Celulares): http://${lanIp}:${PORT}`);
  console.log(` • Acceso Local en esta máquina:          http://localhost:${PORT}`);
  console.log(` • Endpoint WebSocket en Tiempo Real:     ws://${lanIp}:${PORT}/ws`);
  console.log(` • Registro de Producción:                logs/techapy-prod.log`);
  console.log('------------------------------------------------------------------');
  console.log(` 📱 Menú 3D Cliente:   http://${lanIp}:${PORT}/index.html?mesa=4&sector=Terraza&mesero=juan`);
  console.log(` 🛎️  Panel del Mesero:  http://${lanIp}:${PORT}/mesero.html?id=juan&sector=Terraza`);
  console.log(` 📋 Gestión de Carta:  http://${lanIp}:${PORT}/admin-menu.html`);
  console.log(` 🖨️  Generador QR:      http://${lanIp}:${PORT}/admin-qr.html`);
  console.log('==================================================================');
});
