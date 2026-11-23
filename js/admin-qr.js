const ADMIN_CONFIG_KEY = 'kuroshio_admin_qr_config';

/**
 * Controlador del Generador e Imprimidor de Códigos QR para Mesas (admin-qr.html).
 * - Permite definir Nombre del Restaurante, URL base, lista dinámica de Sectores,
 *   cantidad de mesas por sector y mesero asignado (nombre e ID).
 * - Genera códigos QR de alta nitidez usando `qrcode@1.5.3` apuntando a:
 *   http://<ip-o-dominio>/index.html?mesa=X&sector=Y&mesero=Z
 * - Optimizado para impresión directa en papel o PDF (@media print).
 */
class AdminQRGenerator {
  constructor() {
    this.tenantInput = document.getElementById('tenant-id');
    this.restaurantNameInput = document.getElementById('restaurant-name');
    this.baseUrlInput = document.getElementById('base-url');
    this.numberingModeSelect = document.getElementById('numbering-mode');
    this.sectorsListEl = document.getElementById('sectors-list');
    this.cardsGridEl = document.getElementById('qr-cards-grid');
    this.summaryTextEl = document.getElementById('summary-text');

    this.defaultSectors = [
      { sector: 'Terraza', mesas: 4, meseroNombre: 'Juan Pérez', meseroId: 'juan' },
      { sector: 'Salón Principal', mesas: 6, meseroNombre: 'Lucía Gómez', meseroId: 'lucia' },
      { sector: 'Barra', mesas: 3, meseroNombre: 'Carlos Benítez', meseroId: 'carlos' },
      { sector: 'Patio', mesas: 4, meseroNombre: 'Mateo Duarte', meseroId: 'mateo' }
    ];

    this.sectors = [];

    const params = new URLSearchParams(window.location.search);
    if (params.get('tenant') && this.tenantInput) {
      this.tenantInput.value = params.get('tenant').trim().toLowerCase();
    }

    this.loadSavedConfiguration();
    this.renderSectorRows();
    this.bindEvents();
    this.generateAllQRCards();
    this.detectLanIpFromServer();
    this.loadTenantConfigFromServer(this.getActiveTenant());
  }

  getActiveTenant() {
    const raw = this.tenantInput ? this.tenantInput.value : 'demo';
    return String(raw || 'demo').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'demo';
  }

  async loadTenantConfigFromServer(tenant) {
    try {
      const res = await fetch(`./api/${encodeURIComponent(tenant)}/config`, { cache: 'no-store' });
      if (!res.ok) return;
      const cfg = await res.json();
      if (cfg && cfg.nombre) {
        this.restaurantNameInput.value = cfg.nombre;
      }
      if (cfg && Array.isArray(cfg.sectores) && cfg.sectores.length > 0) {
        this.sectors = cfg.sectores;
        this.renderSectorRows();
      }
      // Si el tenant o Render provee publicBaseUrl y el input actual tiene una IP privada (192.168.* / localhost), priorizar la URL pública Cloud
      if (cfg && cfg.publicBaseUrl && !this.isPrivateOrLocalUrl(cfg.publicBaseUrl)) {
        const currentVal = this.sanitizeBaseUrl(this.baseUrlInput.value);
        if (!currentVal || this.isPrivateOrLocalUrl(currentVal)) {
          this.baseUrlInput.value = this.sanitizeBaseUrl(cfg.publicBaseUrl);
        }
      }
      this.updateNavLinks(tenant);
      this.renderSubscriptionExpirationBanner(cfg);
      await this.generateAllQRCards();
    } catch (_) {}
  }

  /**
   * Muestra un banner de alerta si faltan entre 0 y 7 días para el vencimiento de la cuota (o si está vencida).
   */
  renderSubscriptionExpirationBanner(cfg) {
    const existing = document.getElementById('subscription-expiry-banner');
    if (existing) existing.remove();
    if (!cfg || typeof cfg.diasRestantes !== 'number' || cfg.diasRestantes > 7) return;

    const days = cfg.diasRestantes;
    const expDate = cfg.fechaVencimiento ? new Date(cfg.fechaVencimiento) : null;
    const dateStr =
      expDate && !Number.isNaN(expDate.getTime())
        ? `${String(expDate.getDate()).padStart(2, '0')}/${String(expDate.getMonth() + 1).padStart(2, '0')}/${expDate.getFullYear()}`
        : '';

    const statusText =
      days < 0
        ? `Tu cuota mensual venció hace ${Math.abs(days)} día(s) (${dateStr}).`
        : days === 0
        ? `Tu cuota mensual de TechaPY vence HOY (${dateStr}).`
        : `Tu cuota mensual de TechaPY vence en ${days} día(s) (${dateStr}).`;

    const salesWa = String(cfg.salesWhatsapp || '595972736447').replace(/[^0-9]/g, '') || '595972736447';
    const waMsg = encodeURIComponent(
      `Hola TechaPY, deseo regularizar/renovar la cuota mensual del local "${cfg.nombre || cfg.tenant}" (Tenant: ${cfg.tenant}).`
    );

    const banner = document.createElement('div');
    banner.id = 'subscription-expiry-banner';
    banner.className = 'no-print';
    banner.style.cssText =
      'background:rgba(180,83,9,0.24);border:1px solid rgba(251,191,36,0.55);color:#fde68a;padding:13px 18px;border-radius:12px;margin-bottom:18px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;font-size:0.84rem;';
    banner.innerHTML = `
      <div>
        <strong>⚠️ Aviso de Vencimiento de Suscripción:</strong> ${statusText}
        <span style="color:#f4f4f6;">Regulariza tu abono para mantener activo el servicio en salón.</span>
      </div>
      <a href="https://wa.me/${salesWa}?text=${waMsg}" target="_blank" rel="noopener" style="background:#c5a059;color:#0e1013;text-decoration:none;font-weight:700;padding:8px 14px;border-radius:8px;white-space:nowrap;">
        Regularizar Cuota por WhatsApp
      </a>
    `;

    const container = document.querySelector('.admin-container');
    const header = document.querySelector('.admin-header');
    if (container && header && header.nextSibling) {
      container.insertBefore(banner, header.nextSibling);
    } else if (container) {
      container.prepend(banner);
    }
  }

  updateNavLinks(tenant) {
    const firstSector = (this.sectors[0] && this.sectors[0].sector) || 'Terraza';
    const firstWaiter = (this.sectors[0] && this.sectors[0].meseroId) || 'juan';
    const menuLink = document.getElementById('nav-admin-menu');
    const clientLink = document.getElementById('nav-client-preview');
    const waiterLink = document.getElementById('nav-waiter-preview');

    if (menuLink) menuLink.href = `./admin-menu.html?tenant=${encodeURIComponent(tenant)}`;
    if (clientLink) clientLink.href = `./index.html?tenant=${encodeURIComponent(tenant)}&mesa=1&sector=${encodeURIComponent(firstSector)}&mesero=${encodeURIComponent(firstWaiter)}`;
    if (waiterLink) waiterLink.href = `./mesero.html?tenant=${encodeURIComponent(tenant)}&id=${encodeURIComponent(firstWaiter)}&sector=${encodeURIComponent(firstSector)}`;
  }

  /**
   * Detecta el origen limpio del host actual (`window.location.origin`).
   */
  getDetectedBaseUrl() {
    return window.location.origin.replace(/\/+$/, '');
  }

  /**
   * Detecta si una URL apunta a una IP privada de red local (192.168.*, 10.*, 172.16-31.*) o localhost.
   */
  isPrivateOrLocalUrl(rawUrl) {
    const s = String(rawUrl || '').trim().toLowerCase();
    if (!s) return true;
    return /(?:^|\/\/)(?:localhost|127\.0\.0\.1|0\.0\.0\.0|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)(?::\d+)?(?:\/|$)/i.test(
      s
    );
  }

  /**
   * Limpia cualquier URL base para garantizar que nunca incluya `admin-qr.html`,
   * otros archivos `.html`, parámetros `?query` residuales ni barras finales.
   */
  sanitizeBaseUrl(rawUrl) {
    const origin = window.location.origin;
    let baseUrl = String(rawUrl || origin).trim() || origin;

    // Limpiar si baseUrl contiene accidentalmente admin-qr.html u otro archivo .html
    baseUrl = baseUrl.replace(/\/admin-qr\.html.*/i, '');
    baseUrl = baseUrl.replace(/\/[a-z0-9_-]+\.html.*/i, '');
    // Eliminar cualquier query string o hash pegado por error en la URL base
    baseUrl = baseUrl.replace(/[?#].*$/, '');
    // Asegurar que termine sin barra para concatenar correctamente
    baseUrl = baseUrl.replace(/\/+$/, '');

    // Si estamos corriendo en producción (ej. Render https://*.onrender.com) y baseUrl es una IP privada 192.168.*, forzar el origen público
    if (!this.isPrivateOrLocalUrl(origin) && this.isPrivateOrLocalUrl(baseUrl)) {
      baseUrl = origin.replace(/\/+$/, '');
    }

    return baseUrl || origin.replace(/\/+$/, '');
  }

  /**
   * Construye invariablemente la URL del menú del cliente (`/index.html`) para una mesa.
   */
  buildTableUrl({ tenant, mesa, sector, mesero }) {
    const origin = window.location.origin;
    let baseUrl = (this.baseUrlInput && this.baseUrlInput.value) || origin;

    // Limpiar si baseUrl termina accidentalmente en admin-qr.html o incluye parámetros o IP privada en producción
    baseUrl = this.sanitizeBaseUrl(baseUrl);

    const qrUrl = `${baseUrl}/index.html?tenant=${encodeURIComponent(
      tenant
    )}&mesa=${encodeURIComponent(mesa)}&sector=${encodeURIComponent(
      sector
    )}&mesero=${encodeURIComponent(mesero)}`;

    return qrUrl;
  }

  /**
   * Consulta `/api/server-info` del servidor integrado (`server.js`)
   * para obtener la URL pública de Render (`PUBLIC_BASE_URL` / `RENDER_EXTERNAL_URL`) o dominio cloud.
   */
  async detectLanIpFromServer() {
    const hintEl = document.getElementById('detected-ip-hint');
    const origin = this.getDetectedBaseUrl();

    // Si ya estamos en un dominio público Cloud (ej. Render), fijarlo de inmediato y descartar cualquier 192.168.*
    if (!this.isPrivateOrLocalUrl(origin)) {
      if (this.isPrivateOrLocalUrl(this.baseUrlInput.value)) {
        this.baseUrlInput.value = origin;
        this.saveConfiguration();
        await this.generateAllQRCards();
      }
      if (hintEl) {
        hintEl.innerHTML = `✓ Producción Cloud Activa (Independiente de PC): <strong>${this.sanitizeBaseUrl(this.baseUrlInput.value)}</strong>`;
      }
    }

    try {
      const res = await fetch('./api/server-info', { cache: 'no-store' });
      if (!res.ok) return;
      const info = await res.json();
      const cloudUrl = this.sanitizeBaseUrl(info && (info.publicBaseUrl || info.publicUrl || ''));

      if (cloudUrl && !this.isPrivateOrLocalUrl(cloudUrl)) {
        if (!this.baseUrlInput.value || this.isPrivateOrLocalUrl(this.baseUrlInput.value)) {
          this.baseUrlInput.value = cloudUrl;
          this.saveConfiguration();
          await this.generateAllQRCards();
        }
        if (hintEl) {
          hintEl.innerHTML = `✓ URL Pública Cloud (Render / Estática) activa: <strong>${this.sanitizeBaseUrl(this.baseUrlInput.value)}</strong> (Los QR funcionan 24/7 sin depender de la PC)`;
        }
        return;
      }

      if (info && info.baseUrl) {
        const currentVal = this.sanitizeBaseUrl(this.baseUrlInput.value);
        // Nunca sobrescribir una URL pública de Render con una IP local 192.168.*
        if (!currentVal || currentVal.includes('localhost') || currentVal.includes('127.0.0.1')) {
          const preferredBase =
            window.location.protocol === 'https:' && info.lanIp
              ? `https://${info.lanIp}:${window.location.port || 5173}`
              : this.sanitizeBaseUrl(info.baseUrl);
          this.baseUrlInput.value = preferredBase;
          await this.generateAllQRCards();
        }
        if (hintEl) {
          if (!this.isPrivateOrLocalUrl(this.baseUrlInput.value)) {
            hintEl.innerHTML = `✓ URL Pública Cloud configurada: <strong>${this.sanitizeBaseUrl(this.baseUrlInput.value)}</strong> (Independiente de la PC)`;
          } else {
            hintEl.innerHTML = `⚠️ Modo Red Local (${this.sanitizeBaseUrl(this.baseUrlInput.value)}). Para que los QR no dependan de tu PC, pega arriba tu URL de Render (ej. <code>https://tu-app.onrender.com</code>).`;
          }
        }
      }
    } catch (_) {
      if (hintEl) {
        hintEl.innerHTML = `URL activa para QR: <strong>${this.sanitizeBaseUrl(this.baseUrlInput.value || origin)}</strong>.`;
      }
    }
  }

  loadSavedConfiguration() {
    const currentOrigin = this.getDetectedBaseUrl();
    this.baseUrlInput.value = currentOrigin;

    try {
      const raw = localStorage.getItem(ADMIN_CONFIG_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.restaurantName) {
          this.restaurantNameInput.value = parsed.restaurantName
            .replace(/Moopio 3D · Demo Bistró/gi, 'TechaPY · Casa de Autor')
            .replace(/Moopio 3D/gi, 'TechaPY')
            .replace(/Kuroshio 3D Izakaya/gi, 'TechaPY · Casa de Autor');
        }
        const savedBase = parsed.baseUrl ? this.sanitizeBaseUrl(parsed.baseUrl) : '';
        // Si estamos en Render/Cloud, ignorar cualquier IP privada 192.168.* guardada previamente en localStorage
        if (savedBase && !this.isPrivateOrLocalUrl(savedBase)) {
          this.baseUrlInput.value = savedBase;
        } else if (this.isPrivateOrLocalUrl(currentOrigin) && savedBase && !savedBase.includes('localhost') && !savedBase.includes('127.0.0.1')) {
          this.baseUrlInput.value = savedBase;
        } else {
          this.baseUrlInput.value = currentOrigin;
        }
        if (parsed.numberingMode) this.numberingModeSelect.value = parsed.numberingMode;
        if (Array.isArray(parsed.sectors) && parsed.sectors.length > 0) {
          this.sectors = parsed.sectors;
          return;
        }
      }
    } catch (err) {
      console.warn('No se pudo cargar la configuración QR previa:', err);
    }

    this.sectors = [...this.defaultSectors];
  }

  saveConfiguration() {
    this.syncSectorsFromInputs();
    const cleanBase = this.sanitizeBaseUrl(this.baseUrlInput.value || this.getDetectedBaseUrl());
    this.baseUrlInput.value = cleanBase;

    const config = {
      restaurantName: this.restaurantNameInput.value.trim() || 'TechaPY · Casa de Autor',
      baseUrl: cleanBase,
      numberingMode: this.numberingModeSelect.value,
      sectors: this.sectors
    };

    try {
      localStorage.setItem(ADMIN_CONFIG_KEY, JSON.stringify(config));
    } catch (err) {
      console.warn('No se pudo guardar la configuración QR:', err);
    }
  }

  /**
   * Renderiza las filas de configuración de sectores.
   */
  renderSectorRows() {
    this.sectorsListEl.innerHTML = '';

    this.sectors.forEach((item, index) => {
      const row = document.createElement('div');
      row.className = 'sector-row';
      row.innerHTML = `
        <div class="sector-field">
          <label>Nombre del Sector</label>
          <input type="text" data-field="sector" value="${this.escapeHtml(item.sector)}" placeholder="Ej. Terraza" />
        </div>
        <div class="sector-field">
          <label>Cantidad de Mesas</label>
          <input type="number" data-field="mesas" min="1" max="100" value="${Number(item.mesas) || 1}" />
        </div>
        <div class="sector-field">
          <label>Nombre del Mesero</label>
          <input type="text" data-field="meseroNombre" value="${this.escapeHtml(item.meseroNombre)}" placeholder="Ej. Juan Pérez" />
        </div>
        <div class="sector-field">
          <label>ID del Mesero (URL)</label>
          <input type="text" data-field="meseroId" value="${this.escapeHtml(item.meseroId)}" placeholder="Ej. juan" />
        </div>
        <button type="button" class="btn-remove-sector" title="Eliminar sector">✕</button>
      `;

      row.querySelector('.btn-remove-sector').addEventListener('click', () => {
        if (this.sectors.length <= 1) return;
        this.syncSectorsFromInputs();
        this.sectors.splice(index, 1);
        this.renderSectorRows();
        this.generateAllQRCards();
      });

      this.sectorsListEl.appendChild(row);
    });
  }

  /**
   * Lee los valores actuales de las filas de sectores en el DOM.
   */
  syncSectorsFromInputs() {
    const rows = this.sectorsListEl.querySelectorAll('.sector-row');
    const updated = [];

    rows.forEach((row) => {
      const sector = row.querySelector('[data-field="sector"]').value.trim() || 'Salón';
      const mesas = Math.max(1, parseInt(row.querySelector('[data-field="mesas"]').value, 10) || 1);
      const meseroNombre = row.querySelector('[data-field="meseroNombre"]').value.trim() || 'Mesero';
      const meseroId =
        row.querySelector('[data-field="meseroId"]').value.trim().toLowerCase().replace(/\s+/g, '') ||
        'juan';

      updated.push({ sector, mesas, meseroNombre, meseroId });
    });

    this.sectors = updated;
  }

  /**
   * Genera la cuadrícula de tarjetas QR listas para imprimir.
   */
  async generateAllQRCards() {
    this.saveConfiguration();

    const tenant = this.getActiveTenant();
    this.updateNavLinks(tenant);
    const restaurantName = this.restaurantNameInput.value.trim() || 'TechaPY · Casa de Autor';
    const numberingMode = this.numberingModeSelect.value;

    // Limpiar el contenedor completo de tarjetas antes de regenerar
    this.cardsGridEl.replaceChildren();

    let globalTableCounter = 1;
    let totalCards = 0;

    for (const sectorCfg of this.sectors) {
      for (let i = 1; i <= sectorCfg.mesas; i++) {
        const tableNumber = numberingMode === 'global' ? globalTableCounter++ : i;
        const paddedTable = String(tableNumber).padStart(2, '0');
        totalCards++;

        const targetUrl = this.buildTableUrl({
          tenant,
          mesa: tableNumber,
          sector: sectorCfg.sector,
          mesero: sectorCfg.meseroId
        });

        const card = document.createElement('article');
        card.className = 'qr-table-card';

        card.innerHTML = `
          <div class="qr-card-top-bar">
            <div class="qr-restaurant-brand">
              <span class="qr-brand-dot"></span>
              <span>${this.escapeHtml(restaurantName)}</span>
            </div>
            <span class="qr-sector-pill">${this.escapeHtml(sectorCfg.sector)}</span>
          </div>

          <div class="qr-plaque-coordinates">
            <span class="qr-table-kicker">UBICACIÓN DE SALÓN</span>
            <div class="qr-table-number">MESA ${paddedTable}</div>
          </div>

          <div class="qr-canvas-box">
            <canvas class="qr-canvas" width="180" height="180" aria-label="Código QR Mesa ${tableNumber}"></canvas>
          </div>

          <span class="qr-ar-badge">TECHAPY · VISUALIZACIÓN 3D &amp; ESCALA 1:1</span>

          <p class="qr-cta-instruction">
            Escanee con su cámara para observar el tamaño exacto de cada plato sobre su mesa
          </p>

          <div class="qr-card-footer">
            <div class="qr-coords-row">
              <span>SECTOR: <strong>${this.escapeHtml(sectorCfg.sector)}</strong></span>
              <span>STAFF: <strong>${this.escapeHtml(sectorCfg.meseroId.toUpperCase())}</strong></span>
            </div>
            <div style="font-size:0.62rem;color:#c5a059;font-weight:700;letter-spacing:0.05em;margin-top:2px;">URL GRABADA EN QR:</div>
            <a class="qr-url-preview" href="${targetUrl}" target="_blank" rel="noopener">${targetUrl}</a>
          </div>
        `;

        this.cardsGridEl.appendChild(card);

        const canvas = card.querySelector('canvas.qr-canvas');
        await this.renderQRCodeOnCanvas(canvas, targetUrl);
      }
    }

    const activeBase = this.sanitizeBaseUrl(this.baseUrlInput.value);
    if (this.summaryTextEl) {
      const modeTag = this.isPrivateOrLocalUrl(activeBase)
        ? '⚠️ IP Local'
        : '☁️ URL Pública Cloud (Render)';
      this.summaryTextEl.textContent = `✓ ${totalCards} placas QR generadas para "${restaurantName}" → ${modeTag}: ${activeBase}/index.html`;
    }
  }

  /**
   * Renderiza el código QR directamente sobre `<canvas class="qr-canvas" width="180" height="180">`
   * reemplazando/limpiando el nodo antes de dibujar para evitar superposiciones de imágenes residuales.
   */
  async renderQRCodeOnCanvas(canvas, text) {
    if (!canvas) {
      console.error('[AdminQR] No se encontró el elemento <canvas class="qr-canvas"> en la tarjeta.');
      return;
    }

    // Reemplazar el nodo <canvas> por uno limpio y despejar su contexto 2D antes de dibujar
    let targetCanvas = canvas;
    if (canvas.parentNode) {
      const freshCanvas = canvas.cloneNode(false);
      freshCanvas.width = 180;
      freshCanvas.height = 180;
      canvas.parentNode.replaceChild(freshCanvas, canvas);
      targetCanvas = freshCanvas;
    } else {
      targetCanvas.width = 180;
      targetCanvas.height = 180;
    }

    const ctx = targetCanvas.getContext('2d');
    if (ctx) {
      ctx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
    }

    try {
      if (!window.QRCode || typeof window.QRCode.toCanvas !== 'function') {
        throw new Error('window.QRCode.toCanvas no está disponible. Verifica js/vendor/qrcode.min.js');
      }

      await window.QRCode.toCanvas(targetCanvas, text, {
        width: 180,
        margin: 2,
        color: {
          dark: '#0f172a',
          light: '#ffffff'
        },
        errorCorrectionLevel: 'M'
      });
    } catch (err) {
      console.error('[AdminQR] Error generando QR en canvas para URL:', text, err);
      this.drawFallbackQROnCanvas(targetCanvas, text, err);
    }
  }

  /**
   * Fallback inmediato en caso de URL excesivamente larga o error inesperado,
   * garantizando que el canvas de 180x180 nunca quede en blanco.
   */
  drawFallbackQROnCanvas(canvas, text, err) {
    try {
      // Intentar versión compacta con corrección L si el texto superó capacidad en M
      if (window.QRCode && typeof window.QRCode.toCanvas === 'function') {
        const shortUrl = String(text).slice(0, 180);
        window.QRCode.toCanvas(canvas, shortUrl, {
          width: 180,
          margin: 1,
          color: { dark: '#0f172a', light: '#ffffff' },
          errorCorrectionLevel: 'L'
        });
        return;
      }
    } catch (retryErr) {
      console.error('[AdminQR] Error en reintento de fallback QR:', retryErr);
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 180, 180);
    ctx.strokeStyle = '#dc2626';
    ctx.lineWidth = 3;
    ctx.strokeRect(4, 4, 172, 172);
    ctx.fillStyle = '#dc2626';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Error al renderizar QR', 90, 78);
    ctx.fillStyle = '#0f172a';
    ctx.font = '10px monospace';
    ctx.fillText(String((err && err.message) || 'Revisar consola').slice(0, 26), 90, 102);
  }

  bindEvents() {
    document.getElementById('add-sector-btn').addEventListener('click', () => {
      this.syncSectorsFromInputs();
      this.sectors.push({
        sector: `Sector ${this.sectors.length + 1}`,
        mesas: 4,
        meseroNombre: 'Nuevo Mesero',
        meseroId: `mesero${this.sectors.length + 1}`
      });
      this.renderSectorRows();
      this.generateAllQRCards();
    });

    if (this.tenantInput) {
      this.tenantInput.addEventListener('change', () => {
        this.loadTenantConfigFromServer(this.getActiveTenant());
      });
    }

    if (this.baseUrlInput) {
      this.baseUrlInput.addEventListener('change', () => {
        this.baseUrlInput.value = this.sanitizeBaseUrl(this.baseUrlInput.value);
        this.generateAllQRCards();
      });
    }

    if (this.numberingModeSelect) {
      this.numberingModeSelect.addEventListener('change', () => {
        this.generateAllQRCards();
      });
    }

    document.getElementById('generate-qr-btn').addEventListener('click', () => {
      this.generateAllQRCards();
    });

    document.getElementById('print-qr-btn').addEventListener('click', () => {
      this.generateAllQRCards().then(() => {
        window.print();
      });
    });
  }

  escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}

const bootAdminQR = () => {
  if (!window.adminQRGenerator) {
    window.adminQRGenerator = new AdminQRGenerator();
  }
};

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', bootAdminQR, { once: true });
} else {
  bootAdminQR();
}
