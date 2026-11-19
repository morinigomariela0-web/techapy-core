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
 * Manejadores globales de errores para evitar que un mensaje WebSocket malformado
 * o excepción asíncrona tumbe el proceso en producción.
 */
process.on('uncaughtException', (err) => {
  logProdEvent(
    'ERROR',
    'uncaughtException interceptada (proceso mantenido activo)',
    err && err.stack ? err.stack : String(err)
  );
});

process.on('unhandledRejection', (reason) => {
  logProdEvent(
    'ERROR',
    'unhandledRejection interceptada (proceso mantenido activo)',
    reason && reason.stack ? reason.stack : String(reason)
  );
});

/**
 * Escritura atómica en disco mediante archivo temporal (.tmp + renameSync)
 * para evitar corrupción de menu-data.json o config.json ante cortes o errores.
 */
function writeJsonAtomically(filePath, jsonContent) {
  const parsedCheck = JSON.parse(jsonContent);
  if (!parsedCheck || typeof parsedCheck !== 'object') {
    throw new Error('Contenido JSON inválido antes de escritura en disco');
  }
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, jsonContent, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function sanitizeTenantId(raw) {
  const clean = String(raw || DEFAULT_TENANT)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '');
  return clean || DEFAULT_TENANT;
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
    fs.writeFileSync(configPath, JSON.stringify(defaultCfg, null, 2) + '\n', 'utf8');
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

function createRoleAuthToken(tenant, role, pin) {
  return crypto
    .createHmac('sha256', AUTH_SECRET)
    .update(`${tenant}:${role}:${pin}`)
    .digest('hex');
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
        const v = decodeURIComponent(pair.slice(idx + 1).trim());
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
    (cookies[cookieName] && cookies[cookieName] === expectedToken) ||
    (cookies[superCookieName] && cookies[superCookieName] === superToken)
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
      if (providedPin === expectedPin || providedPin === SUPERADMIN_MASTER_PIN) {
        const setCookie = `${cookieName}=${expectedToken}; HttpOnly; Path=/; Max-Age=43200; SameSite=Lax`;
        return { authorized: true, tenant, nombre, cookieHeader: setCookie };
      }
    } catch (_) {}
  } else if (authHeader.toLowerCase().startsWith('bearer ')) {
    const bearerVal = authHeader.slice(7).trim();
    if (bearerVal === expectedPin || bearerVal === expectedToken || bearerVal === SUPERADMIN_MASTER_PIN) {
      const setCookie = `${cookieName}=${expectedToken}; HttpOnly; Path=/; Max-Age=43200; SameSite=Lax`;
      return { authorized: true, tenant, nombre, cookieHeader: setCookie };
    }
  }

  // 3. Verificar Header X-Superadmin-Key, X-Auth-Pin o parámetro ?pin= en la URL
  const providedInlinePin = String(
    req.headers['x-superadmin-key'] ||
      req.headers['x-auth-pin'] ||
      parsedUrl.searchParams.get('pin') ||
      ''
  ).trim();
  if (
    providedInlinePin &&
    (providedInlinePin === expectedPin || providedInlinePin === SUPERADMIN_MASTER_PIN)
  ) {
    const setCookie = `${cookieName}=${expectedToken}; HttpOnly; Path=/; Max-Age=43200; SameSite=Lax`;
    return { authorized: true, tenant, nombre, cookieHeader: setCookie };
  }

  return { authorized: false, tenant, nombre, requiredRole };
}

/**
 * Lee y resume todos los tenants instalados en `data/tenants/`.
 */
function listAllTenantsSummary() {
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

    tenants.push({
      tenant: slug,
      nombre: cfg.nombre || `TechaPY · ${slug.toUpperCase()}`,
      ruc: cfg.ruc || '80000000-0',
      ciudad: cfg.ciudad || 'Asunción, Paraguay',
      moneda: cfg.moneda || 'Gs.',
      plan: cfg.plan || 'Plan Restaurante de Autor',
      estado: normalizeTenantEstado(cfg.estado),
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

// Lista en memoria de las órdenes activas del día
let activeOrders = [];

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

function handleWsMessage(socket, msg) {
  if (!msg || typeof msg !== 'object') return;
  const meta = clients.get(socket) || { role: 'unknown', tenant: DEFAULT_TENANT };
  const type = msg.type || msg.eventType;

  if (type === 'REGISTER_WAITER') {
    meta.role = 'mesero';
    meta.tenant = sanitizeTenantId(msg.tenant || meta.tenant);
    meta.waiterId = String(msg.id || 'juan').toLowerCase();
    meta.sector = String(msg.sector || 'Terraza');
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
    meta.role = 'cliente';
    meta.tenant = sanitizeTenantId(msg.tenant || meta.tenant);
    meta.mesa = String(msg.mesa || '1');
    meta.sector = String(msg.sector || 'Terraza');
    meta.waiterId = String(msg.mesero_id || 'juan').toLowerCase();
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
    const order = msg.order || msg;
    if (!order || !order.id) return;

    order.tenant = sanitizeTenantId(order.tenant || msg.tenant || meta.tenant);
    const orderTenantSectorKey = `${order.tenant}:${String(order.sector || 'Terraza').toLowerCase()}`;

    const existingIdx = activeOrders.findIndex((o) => o.id === order.id);
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
    const orderId = msg.orderId || (incomingOrder && incomingOrder.id);
    const newStatus = msg.estado || (incomingOrder && incomingOrder.estado);

    if (!orderId) return;

    let targetOrder = activeOrders.find((o) => o.id === orderId);
    if (targetOrder && newStatus) {
      targetOrder.estado = newStatus;
      targetOrder.updatedAt = new Date().toISOString();
    } else if (incomingOrder) {
      incomingOrder.tenant = sanitizeTenantId(incomingOrder.tenant || msg.tenant || meta.tenant);
      targetOrder = incomingOrder;
      activeOrders.unshift(targetOrder);
    }

    if (!targetOrder) return;
    const targetTenant = sanitizeTenantId(targetOrder.tenant);

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
    const targetTenant = sanitizeTenantId(msg.tenant || meta.tenant);
    const onlyAttended = msg.onlyAttended !== false;
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

function sendJsonResponse(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

/**
 * Servidor HTTP para API REST (`/api/menu`, `/api/upload-model`, `/api/server-info`) y archivos estáticos.
 */
const server = http.createServer(async (req, res) => {
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

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname = decodeURIComponent(parsedUrl.pathname);

  // 0. Endpoints de Autenticación Unificada por Rol (Mesero / Admin / SuperAdmin)
  if (pathname === '/api/auth/login' && req.method === 'POST') {
    try {
      const bodyBuf = await readRequestBodyBuffer(req, 64 * 1024);
      const payload = JSON.parse(bodyBuf.toString('utf8'));
      const role =
        payload.role === 'superadmin'
          ? 'superadmin'
          : payload.role === 'admin'
          ? 'admin'
          : 'waiter';
      const tenant = role === 'superadmin' ? 'global' : sanitizeTenantId(payload.tenant || DEFAULT_TENANT);
      const providedPin = String(payload.pin || '').trim();

      let expectedPin = SUPERADMIN_MASTER_PIN;
      if (role !== 'superadmin') {
        const sec = getTenantSecurityConfig(tenant);
        expectedPin = role === 'admin' ? sec.adminPin : sec.waiterPin;
      }

      if (!providedPin || (providedPin !== expectedPin && providedPin !== SUPERADMIN_MASTER_PIN)) {
        logProdEvent('WARN', `Intento de login fallido para rol [${role}] en tenant [${tenant}]`);
        sendJsonResponse(res, 401, {
          ok: false,
          error:
            role === 'superadmin'
              ? 'Contraseña maestra de SuperAdmin inválida.'
              : `PIN de ${role === 'admin' ? 'Administrador' : 'Mesero'} inválido para el local "${tenant}".`
        });
        return;
      }

      const token = createRoleAuthToken(tenant, role, expectedPin);
      const cookieName = `techapy_auth_${tenant}_${role}`;
      const setCookie = `${cookieName}=${token}; HttpOnly; Path=/; Max-Age=43200; SameSite=Lax`;

      logProdEvent('INFO', `Login exitoso para rol [${role}] en tenant [${tenant}]`);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': setCookie,
        'Cache-Control': 'no-store'
      });
      res.end(JSON.stringify({ ok: true, tenant, role }));
    } catch (err) {
      sendJsonResponse(res, 400, { ok: false, error: 'Solicitud de autenticación malformada' });
    }
    return;
  }

  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    const tenant = sanitizeTenantId(parsedUrl.searchParams.get('tenant') || DEFAULT_TENANT);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': [
        `techapy_auth_${tenant}_waiter=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`,
        `techapy_auth_${tenant}_admin=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`,
        `techapy_auth_global_superadmin=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`
      ],
      'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // 0b. Endpoints de SuperAdmin (/api/superadmin/tenants y /api/superadmin/tenants/:tenant)
  if (pathname === '/api/superadmin/tenants' || pathname.startsWith('/api/superadmin/tenants/')) {
    const superAuth = verifyRoleAuthentication(req, parsedUrl, 'global', 'superadmin');
    if (!superAuth.authorized) {
      logProdEvent('WARN', `Acceso API SuperAdmin rechazado en ${req.method} ${pathname}`);
      sendJsonResponse(res, 401, {
        ok: false,
        error: 'No autorizado. Se requiere autenticación de SuperAdmin (cookie o X-Superadmin-Key).'
      });
      return;
    }

    if (pathname === '/api/superadmin/tenants' && req.method === 'GET') {
      try {
        const tenants = listAllTenantsSummary();
        sendJsonResponse(res, 200, { ok: true, count: tenants.length, tenants });
      } catch (err) {
        logProdEvent('ERROR', 'Error listando tenants en SuperAdmin', err.message);
        sendJsonResponse(res, 500, { ok: false, error: err.message });
      }
      return;
    }

    if (pathname === '/api/superadmin/tenants' && req.method === 'POST') {
      try {
        const bodyBuf = await readRequestBodyBuffer(req, 2 * 1024 * 1024);
        const payload = JSON.parse(bodyBuf.toString('utf8'));
        const createdCfg = provisionNewTenantAtomically(payload);
        logProdEvent(
          'INFO',
          `[SuperAdmin] Nuevo tenant aprovisionado: [${createdCfg.tenant}] (${createdCfg.nombre})`
        );
        sendJsonResponse(res, 201, {
          ok: true,
          message: `Restaurante "${createdCfg.nombre}" (${createdCfg.tenant}) aprovisionado correctamente`,
          tenant: createdCfg
        });
      } catch (err) {
        const code = err.statusCode || 400;
        logProdEvent('WARN', '[SuperAdmin] Error creando tenant', err.message);
        sendJsonResponse(res, code, { ok: false, error: err.message });
      }
      return;
    }

    const putMatch = pathname.match(/^\/api\/superadmin\/tenants\/([a-zA-Z0-9_-]+)$/);
    if (putMatch && req.method === 'PUT') {
      try {
        const targetSlug = sanitizeTenantId(putMatch[1]);
        const bodyBuf = await readRequestBodyBuffer(req, 2 * 1024 * 1024);
        const payload = JSON.parse(bodyBuf.toString('utf8'));
        const updatedCfg = updateExistingTenantAtomically(targetSlug, payload);
        logProdEvent(
          'INFO',
          `[SuperAdmin] Tenant actualizado: [${updatedCfg.tenant}] (estado=${updatedCfg.estado})`
        );
        sendJsonResponse(res, 200, {
          ok: true,
          message: `Configuración de "${updatedCfg.nombre}" actualizada`,
          tenant: updatedCfg
        });
      } catch (err) {
        logProdEvent('ERROR', '[SuperAdmin] Error actualizando tenant', err.message);
        sendJsonResponse(res, 400, { ok: false, error: err.message });
      }
      return;
    }
  }

  // 0c. Endpoint Público de Solicitud / Registro de Nuevo Restaurante desde Landing (Estado: "pendiente")
  if (pathname === '/api/public/register-tenant' && req.method === 'POST') {
    try {
      const bodyBuf = await readRequestBodyBuffer(req, 512 * 1024);
      const payload = JSON.parse(bodyBuf.toString('utf8'));
      const rawName = String(payload.nombre || payload.restaurant || '').trim();
      if (!rawName) {
        sendJsonResponse(res, 400, { ok: false, error: 'El nombre del restaurante es obligatorio.' });
        return;
      }

      let baseSlug = String(payload.tenant || rawName)
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 26);

      if (!baseSlug || baseSlug === 'demo' || baseSlug === 'global') {
        baseSlug = `local-${Date.now().toString().slice(-4)}`;
      }

      // Si el slug ya existe y está Activo, añadir sufijo único; si ya existe como pendiente, actualizarlo
      let finalSlug = baseSlug;
      const candidateCfgPath = path.join(TENANTS_DATA_DIR, finalSlug, 'config.json');
      if (fs.existsSync(candidateCfgPath)) {
        try {
          const existing = JSON.parse(fs.readFileSync(candidateCfgPath, 'utf8'));
          if (normalizeTenantEstado(existing.estado) !== 'pendiente') {
            finalSlug = `${baseSlug}-${Date.now().toString().slice(-3)}`;
          }
        } catch (_) {}
      }

      const createdCfg = provisionNewTenantAtomically(
        {
          tenant: finalSlug,
          nombre: rawName,
          ruc: String(payload.ruc || '80000000-0').trim(),
          ciudad: String(payload.ciudad || 'Asunción, Paraguay').trim(),
          plan: String(payload.plan || 'Plan Restaurante de Autor').trim(),
          estado: 'pendiente',
          fechaSolicitud: new Date().toISOString(),
          contactoNombre: String(payload.contactoNombre || '').trim(),
          contactoWhatsapp: String(payload.contactoWhatsapp || '').trim(),
          capacidadMesas: String(payload.capacidadMesas || '').trim()
        },
        { allowIfPending: true }
      );

      logProdEvent(
        'INFO',
        `[Landing Lead] Nuevo restaurante registrado en estado PENDIENTE: [${createdCfg.tenant}] (${createdCfg.nombre})`
      );

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
      sendJsonResponse(res, 400, { ok: false, error: err.message });
    }
    return;
  }

  // 1. Endpoint de información del servidor local y túnel HTTPS
  if (pathname === '/api/server-info' && req.method === 'GET') {
    const lanIp = getLocalLanIp();
    const lanBaseUrl = `http://${lanIp}:${PORT}`;
    let publicUrl = null;
    const tunnelInfoPath = path.join(ROOT_DIR, 'data', 'tunnel-info.json');
    if (fs.existsSync(tunnelInfoPath)) {
      try {
        const tdata = JSON.parse(fs.readFileSync(tunnelInfoPath, 'utf8'));
        if (tdata && tdata.publicUrl) {
          publicUrl = String(tdata.publicUrl).replace(/\/+$/, '');
        }
      } catch (_) {}
    }
    const effectiveBase = publicUrl || lanBaseUrl;
    const effectiveWs = publicUrl
      ? `wss://${publicUrl.replace(/^https?:\/\//, '')}/ws`
      : `ws://${lanIp}:${PORT}/ws`;

    sendJsonResponse(res, 200, {
      lanIp,
      port: PORT,
      lanBaseUrl,
      publicUrl,
      baseUrl: effectiveBase,
      wsUrl: effectiveWs,
      activeOrdersCount: activeOrders.length
    });
    return;
  }

  // Resolver rutas Multi-Tenant: /api/:tenant/menu, /api/:tenant/upload-model, /api/:tenant/config
  const tenantRouteMatch = pathname.match(/^\/api\/([a-zA-Z0-9_-]+)\/(menu|upload-model|config)$/);
  const routeTenant = tenantRouteMatch
    ? sanitizeTenantId(tenantRouteMatch[1])
    : sanitizeTenantId(parsedUrl.searchParams.get('tenant') || DEFAULT_TENANT);
  const routeAction = tenantRouteMatch ? tenantRouteMatch[2] : null;

  // 1b. GET /api/:tenant/config (o GET /api/config?tenant=...) -> Oculta los PINs de seguridad e incluye estado de vencimiento
  if ((routeAction === 'config' || pathname === '/api/config') && req.method === 'GET') {
    const { configPath } = getTenantPaths(routeTenant);
    fs.readFile(configPath, 'utf8', (err, content) => {
      if (err) {
        sendJsonResponse(res, 500, { ok: false, error: 'No se pudo leer config.json del tenant' });
        return;
      }
      try {
        const publicCfg = JSON.parse(content);
        const subInfo = computeSubscriptionStatus(publicCfg);
        publicCfg.estado = normalizeTenantEstado(publicCfg.estado);
        publicCfg.ultimoPago = subInfo.ultimoPago;
        publicCfg.fechaVencimiento = subInfo.fechaVencimiento;
        publicCfg.diasRestantes = subInfo.diasRestantes;
        publicCfg.porVencer = subInfo.porVencer;
        publicCfg.vencido = subInfo.vencido;
        publicCfg.salesWhatsapp = subInfo.salesWhatsapp;
        delete publicCfg.adminPin;
        delete publicCfg.waiterPin;
        if (publicCfg.credenciales) {
          delete publicCfg.credenciales.pinAcceso;
        }
        sendJsonResponse(res, 200, publicCfg);
      } catch (_) {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store'
        });
        res.end(content);
      }
    });
    return;
  }

  // POST /api/:tenant/config (o POST /api/config?tenant=...)
  if ((routeAction === 'config' || pathname === '/api/config') && req.method === 'POST') {
    try {
      const { tenant, configPath } = getTenantPaths(routeTenant);
      const existingSec = getTenantSecurityConfig(tenant);
      const bodyBuf = await readRequestBodyBuffer(req, 2 * 1024 * 1024);
      const parsed = JSON.parse(bodyBuf.toString('utf8'));
      const cfgError = validateTenantConfigJson(parsed);
      if (cfgError) {
        logProdEvent('WARN', `Validación fallida en POST /api/${tenant}/config`, cfgError);
        sendJsonResponse(res, 400, { ok: false, error: cfgError });
        return;
      }
      parsed.tenant = tenant;
      parsed.adminPin = String(parsed.adminPin || existingSec.adminPin || '1234').trim();
      parsed.waiterPin = String(parsed.waiterPin || existingSec.waiterPin || '5678').trim();
      const formattedCfg = JSON.stringify(parsed, null, 2) + '\n';
      writeJsonAtomically(configPath, formattedCfg);

      // Sincronizar con dist/data/tenants/{tenant}/config.json si dist/ existe
      const distConfigPath = path.join(DIST_DIR, 'data', 'tenants', tenant, 'config.json');
      if (fs.existsSync(DIST_DIR)) {
        fs.mkdirSync(path.dirname(distConfigPath), { recursive: true });
        writeJsonAtomically(distConfigPath, formattedCfg);
      }

      logProdEvent('INFO', `Configuración actualizada para tenant [${tenant}]`);
      sendJsonResponse(res, 200, { ok: true, tenant, config: parsed });
    } catch (err) {
      logProdEvent('ERROR', `Error en POST /api/${routeTenant}/config`, err.message);
      sendJsonResponse(res, 400, { ok: false, error: err.message });
    }
    return;
  }

  // 2. GET /api/:tenant/menu o GET /api/menu -> Devuelve menu-data.json del tenant
  if ((routeAction === 'menu' || pathname === '/api/menu') && req.method === 'GET') {
    const { menuPath } = getTenantPaths(routeTenant);
    fs.readFile(menuPath, 'utf8', (err, content) => {
      if (err) {
        sendJsonResponse(res, 500, { ok: false, error: 'No se pudo leer menu-data.json del tenant' });
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

  // 3. POST /api/:tenant/menu o POST /api/menu -> Valida, crea backup y sobrescribe atómicamente menu-data.json del tenant
  if ((routeAction === 'menu' || pathname === '/api/menu') && req.method === 'POST') {
    try {
      const { tenant, menuPath, backupPath } = getTenantPaths(routeTenant);
      const bodyBuf = await readRequestBodyBuffer(req, 5 * 1024 * 1024);
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

      // Sincronizar con dist/data/tenants/{tenant}/menu-data.json si dist/ existe
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

      logProdEvent(
        'INFO',
        `Carta actualizada [${tenant}] en data/tenants/${tenant}/menu-data.json (${parsed.platos.length} platos)`
      );

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
        backupPath: `data/tenants/${tenant}/menu-data.backup.json`,
        platosCount: parsed.platos.length
      });
    } catch (err) {
      logProdEvent('ERROR', `Error procesando JSON en POST /api/${routeTenant}/menu`, err.message);
      sendJsonResponse(res, 400, {
        ok: false,
        error: `Error procesando JSON de la carta: ${err.message}`
      });
    }
    return;
  }

  // 4. POST /api/:tenant/upload-model o POST /api/upload-model -> Guarda .glb en assets/tenants/{tenant}/models/
  if ((routeAction === 'upload-model' || pathname === '/api/upload-model') && req.method === 'POST') {
    try {
      const { tenant, modelsDir } = getTenantPaths(routeTenant);
      fs.mkdirSync(modelsDir, { recursive: true });
      const contentType = (req.headers['content-type'] || '').toLowerCase();
      const bodyBuf = await readRequestBodyBuffer(req, 60 * 1024 * 1024);

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
          sendJsonResponse(res, 400, { ok: false, error: 'El campo dataBase64 está vacío' });
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
          error: 'El archivo .glb recibido está vacío o incompleto'
        });
        return;
      }

      const targetDiskPath = path.join(modelsDir, filename);
      fs.writeFileSync(targetDiskPath, fileBuffer);

      // Sincronizar modelo 3D en dist/assets/tenants/{tenant}/models/ si dist/ existe
      if (fs.existsSync(DIST_DIR)) {
        const distModelDir = path.join(DIST_DIR, 'assets', 'tenants', tenant, 'models');
        fs.mkdirSync(distModelDir, { recursive: true });
        fs.writeFileSync(path.join(distModelDir, filename), fileBuffer);
      }

      const relativeModelPath = `./assets/tenants/${tenant}/models/${filename}`;
      logProdEvent(
        'INFO',
        `Modelo 3D guardado [${tenant}]: ${relativeModelPath} (${(fileBuffer.length / 1024).toFixed(1)} KB)`
      );

      sendJsonResponse(res, 200, {
        ok: true,
        tenant,
        filename,
        path: relativeModelPath,
        sizeBytes: fileBuffer.length
      });
    } catch (err) {
      sendJsonResponse(res, 400, {
        ok: false,
        error: `Error subiendo modelo .glb: ${err.message}`
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

  // Bloquear lectura estática directa de config.json para proteger adminPin y waiterPin
  if (/^\/data\/tenants\/[^/]+\/config\.json$/i.test(pathname)) {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'Acceso directo a config.json prohibido por seguridad' }));
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

  // Priorizar servicio estático desde la carpeta compilada `dist/` (Cloud Production Ready)
  const staticRoot = fs.existsSync(DIST_DIR) ? DIST_DIR : ROOT_DIR;
  let safePath = path.normalize(path.join(staticRoot, pathname));
  if (!safePath.startsWith(staticRoot)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }

  // Fallback a ROOT_DIR si un recurso dinámico (/assets/tenants o /data/tenants) no está aún en dist/
  if (!fs.existsSync(safePath) && staticRoot === DIST_DIR) {
    const fallbackRootPath = path.normalize(path.join(ROOT_DIR, pathname));
    if (fallbackRootPath.startsWith(ROOT_DIR) && fs.existsSync(fallbackRootPath)) {
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
        res.writeHead(500);
      }
      res.end();
    });
    stream.pipe(res);
  });
});

/**
 * Upgrade HTTP -> WebSocket RFC 6455 en `/ws`.
 */
server.on('upgrade', (req, socket) => {
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
    connectedAt: new Date().toISOString()
  });

  let recvBuffer = Buffer.alloc(0);

  socket.on('data', (chunk) => {
    try {
      recvBuffer = Buffer.concat([recvBuffer, chunk]);
      if (recvBuffer.length > 5 * 1024 * 1024) {
        logProdEvent('WARN', 'Buffer WebSocket excedió 5MB; cerrando conexión anómala');
        socket.destroy();
        return;
      }
      const { messages, remaining } = parseWsFrames(recvBuffer);
      recvBuffer = remaining;

      for (const frame of messages) {
        if (frame.opcode === 0x08) {
          socket.end();
          return;
        }
        if (frame.opcode === 0x09) {
          const pong = Buffer.concat([Buffer.from([0x8a, frame.payload.length]), frame.payload]);
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
