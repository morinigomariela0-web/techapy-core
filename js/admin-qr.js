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
      this.updateNavLinks(tenant);
      await this.generateAllQRCards();
    } catch (_) {}
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

    return baseUrl || origin.replace(/\/+$/, '');
  }

  /**
   * Construye invariablemente la URL del menú del cliente (`/index.html`) para una mesa.
   */
  buildTableUrl({ tenant, mesa, sector, mesero }) {
    const origin = window.location.origin;
    let baseUrl = (this.baseUrlInput && this.baseUrlInput.value) || origin;

    // Limpiar si baseUrl termina accidentalmente en admin-qr.html o incluye parámetros
    baseUrl = this.sanitizeBaseUrl(baseUrl);

    const qrUrl = `${baseUrl}/index.html?tenant=${encodeURIComponent(
      tenant
    )}&mesa=${encodeURIComponent(mesa)}&sector=${encodeURIComponent(
      sector
    )}&mesero=${encodeURIComponent(mesero)}`;

    return qrUrl;
  }

  /**
   * Consulta `/api/server-info` del servidor integrado (`server.js` / `server.py`)
   * para obtener la URL pública HTTPS del túnel (`cloudflared`) o la IP LAN Wi-Fi real.
   */
  async detectLanIpFromServer() {
    const hintEl = document.getElementById('detected-ip-hint');
    const embeddedTunnelUrl = this.sanitizeBaseUrl(this.baseUrlInput.dataset.tunnelUrl || '');

    if (embeddedTunnelUrl && embeddedTunnelUrl.startsWith('https://')) {
      this.baseUrlInput.value = embeddedTunnelUrl;
      this.saveConfiguration();
      await this.generateAllQRCards();
    }

    try {
      const res = await fetch('./api/server-info');
      if (!res.ok) return;
      const info = await res.json();
      if (info && info.publicUrl) {
        const cleanPublic = this.sanitizeBaseUrl(info.publicUrl);
        this.baseUrlInput.value = cleanPublic;
        this.saveConfiguration();
        await this.generateAllQRCards();
        if (hintEl) {
          hintEl.innerHTML = `Túnel HTTPS Público Activo (WebXR / AR Ready): <strong>${cleanPublic}</strong> · LAN: <code>${info.lanBaseUrl || info.lanIp}</code>`;
        }
        return;
      }

      if (info && info.baseUrl) {
        const currentVal = this.sanitizeBaseUrl(this.baseUrlInput.value);
        const isLocalhost =
          !currentVal ||
          currentVal.includes('localhost') ||
          currentVal.includes('127.0.0.1');

        const preferredBase =
          window.location.protocol === 'https:' && info.lanIp
            ? `https://${info.lanIp}:${window.location.port || 5173}`
            : this.sanitizeBaseUrl(info.baseUrl);

        if (isLocalhost) {
          this.baseUrlInput.value = preferredBase;
          await this.generateAllQRCards();
        }
        if (hintEl) {
          hintEl.innerHTML = `IP Wi-Fi Local detectada automáticamente: <strong>${preferredBase}</strong> (Host actual: <code>${window.location.origin}</code>)`;
        }
      }
    } catch (_) {
      if (hintEl) {
        hintEl.innerHTML = `Host detectado: <strong>${window.location.origin}</strong>. Para escanear desde celulares, usa el túnel HTTPS o la IP local.`;
      }
    }
  }

  loadSavedConfiguration() {
    const embeddedTunnelUrl = this.sanitizeBaseUrl(this.baseUrlInput.dataset.tunnelUrl || '');
    const currentOrigin = embeddedTunnelUrl || this.getDetectedBaseUrl();
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
        if (embeddedTunnelUrl && embeddedTunnelUrl.startsWith('https://')) {
          this.baseUrlInput.value = embeddedTunnelUrl;
        } else if (
          parsed.baseUrl &&
          !parsed.baseUrl.includes('localhost') &&
          !parsed.baseUrl.includes('127.0.0.1')
        ) {
          this.baseUrlInput.value = this.sanitizeBaseUrl(parsed.baseUrl);
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
            <a class="qr-url-preview" href="${targetUrl}" target="_blank" rel="noopener">${targetUrl}</a>
          </div>
        `;

        this.cardsGridEl.appendChild(card);

        const canvas = card.querySelector('canvas.qr-canvas');
        await this.renderQRCodeOnCanvas(canvas, targetUrl);
      }
    }

    if (this.summaryTextEl) {
      this.summaryTextEl.textContent = `✓ ${totalCards} placas QR generadas para ${this.sectors.length} sector(es) en "${restaurantName}".`;
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

window.addEventListener('DOMContentLoaded', () => {
  window.adminQRGenerator = new AdminQRGenerator();
});
