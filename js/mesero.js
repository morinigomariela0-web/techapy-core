const CHANNEL_NAME = 'kuroshio_comandas_channel';
const STORAGE_KEY = 'kuroshio_comandas_store';
const ARCHIVE_KEY = 'kuroshio_turnos_archivados';
const WAITER_PREFS_KEY = 'kuroshio_mesero_prefs';

/**
 * Controlador en Tiempo Real para el Panel del Mesero (mesero.html).
 * - Lee ?id=juan&sector=Terraza desde la URL.
 * - Persistencia y recuperación completa en localStorage: si el mesero recarga la pestaña
 *   o se apaga la pantalla de su móvil, al volver a abrir recupera todas las órdenes y sus
 *   estados ("Pendiente", "Cargado en Caja", "Atendido") sin perder pedidos pendientes.
 * - Incluye cierre de caja / limpieza de turno con confirmación y archivado histórico.
 */
class WaiterPanelApp {
  constructor() {
    const params = new URLSearchParams(window.location.search);
    this.tenant = (params.get('tenant') || 'demo').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'demo';
    this.waiterId = (params.get('id') || 'juan').toLowerCase();
    this.assignedSector = params.get('sector') || 'Terraza';
    this.currencySymbol = 'Gs.';

    this.sectorFilter = 'ASSIGNED';
    this.statusFilter = 'ALL';
    this.soundEnabled = true;
    this.audioCtx = null;

    this.orders = [];

    this.loadWaiterPreferences();
    this.initHeaderUI();
    this.loadStoredOrders();
    this.initRealtimeBus();
    this.initScreenWakeRecovery();
    this.bindUIEvents();
    this.renderAll();
  }

  /**
   * Recupera preferencias de filtro del mesero desde localStorage.
   */
  loadWaiterPreferences() {
    try {
      const raw = localStorage.getItem(`${WAITER_PREFS_KEY}_${this.waiterId}`);
      if (raw) {
        const prefs = JSON.parse(raw);
        if (prefs.sectorFilter) this.sectorFilter = prefs.sectorFilter;
        if (prefs.statusFilter) this.statusFilter = prefs.statusFilter;
      }
    } catch (_) {}
  }

  saveWaiterPreferences() {
    try {
      localStorage.setItem(
        `${WAITER_PREFS_KEY}_${this.waiterId}`,
        JSON.stringify({
          sectorFilter: this.sectorFilter,
          statusFilter: this.statusFilter
        })
      );
    } catch (_) {}
  }

  /**
   * Configura el encabezado con el ID del mesero y su sector asignado por URL.
   */
  initHeaderUI() {
    const waiterTitle = document.getElementById('waiter-title');
    const sectorSubtitle = document.getElementById('sector-subtitle');
    const sectorSelect = document.getElementById('sector-filter');

    if (waiterTitle) {
      waiterTitle.textContent = `TechaPY · Mesero: ${this.waiterId.toUpperCase()}`;
    }
    if (sectorSubtitle) {
      sectorSubtitle.innerHTML = `Local: <strong>${this.tenant.toUpperCase()}</strong> · Sector: <strong>${this.assignedSector}</strong>`;
    }
    if (sectorSelect) {
      const assignedOption = sectorSelect.querySelector('option[value="ASSIGNED"]');
      if (assignedOption) {
        assignedOption.textContent = `Mi Sector (${this.assignedSector})`;
      }
      sectorSelect.value = this.sectorFilter;
    }

    const statusPills = document.querySelectorAll('.status-pill');
    statusPills.forEach((pill) => {
      pill.classList.toggle('active', pill.dataset.status === this.statusFilter);
    });
  }

  formatGuaranies(amount) {
    const num = Math.round(Number(amount) || 0);
    return `${this.currencySymbol} ${num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
  }

  /**
   * Carga comandas activas desde localStorage garantizando que nunca se pierdan
   * pedidos al recargar o reabrir el navegador.
   */
  loadStoredOrders() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        const all = Array.isArray(parsed) ? parsed : [];
        this.orders = all.filter((o) => (o.tenant || 'demo') === this.tenant);
      } else {
        this.orders = [];
      }
    } catch (err) {
      console.warn('Error leyendo comandas almacenadas:', err);
      this.orders = [];
    }
  }

  saveOrdersToStorage() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.orders.slice(0, 150)));
    } catch (err) {
      console.warn('Error guardando comandas en storage:', err);
    }
  }

  /**
   * Recupera y sincroniza automáticamente el historial de órdenes cuando el celular
   * del mesero vuelve a encender la pantalla o la pestaña recupera el foco.
   */
  initScreenWakeRecovery() {
    const syncOnWake = () => {
      if (document.visibilityState === 'visible') {
        const previousPendingIds = new Set(
          this.orders.filter((o) => o.estado === 'Pendiente').map((o) => o.id)
        );
        this.loadStoredOrders();
        this.renderAll();

        const newPending = this.orders.find(
          (o) => o.estado === 'Pendiente' && !previousPendingIds.has(o.id)
        );
        if (newPending) {
          this.notifyIfRelevant(newPending);
        }
        this.connectWebSocket();
      }
    };

    document.addEventListener('visibilitychange', syncOnWake);
    window.addEventListener('focus', syncOnWake);
    window.addEventListener('pageshow', syncOnWake);
  }

  /**
   * Conecta WebSocket en red local Wi-Fi (`ws://<ip-local>:8080/ws`),
   * además de BroadcastChannel y eventos de localStorage como respaldo.
   */
  initRealtimeBus() {
    this.ws = null;
    this.wsReconnectAttempts = 0;
    this.wsReconnectTimer = null;

    this.channel = new BroadcastChannel(CHANNEL_NAME);

    this.channel.addEventListener('message', (event) => {
      this.handleRealtimePayload(event.data);
    });

    window.addEventListener('storage', (event) => {
      if (event.key === STORAGE_KEY) {
        try {
          const updatedOrders = event.newValue ? JSON.parse(event.newValue) : [];
          const hadCount = this.orders.length;
          this.orders = Array.isArray(updatedOrders) ? updatedOrders : [];
          this.renderAll();

          if (this.orders.length > hadCount && this.orders[0]) {
            this.notifyIfRelevant(this.orders[0]);
          }
        } catch (err) {
          console.warn('Error sincronizando storage en mesero:', err);
        }
      }
    });

    window.addEventListener('online', () => {
      this.wsReconnectAttempts = 0;
      this.connectWebSocket();
    });

    this.connectWebSocket();
  }

  /**
   * Establece conexión WebSocket enviando `{ type: "REGISTER_WAITER", id, sector }`
   * y reconecta con backoff exponencial si se pierde la señal Wi-Fi.
   */
  connectWebSocket() {
    clearTimeout(this.wsReconnectTimer);

    if (!window.location.host) {
      this.updateLiveConnectionBadge(false);
      return;
    }

    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = window.KUROSHIO_WS_URL || `${protocol}//${window.location.host}/ws`;

    this.updateLiveConnectionBadge(false);

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.addEventListener('open', () => {
        this.wsReconnectAttempts = 0;
        this.updateLiveConnectionBadge(true);

        // Mensaje inicial de registro del mesero, su tenant y su sector
        this.ws.send(
          JSON.stringify({
            type: 'REGISTER_WAITER',
            tenant: this.tenant,
            id: this.waiterId,
            sector: this.assignedSector
          })
        );
      });

      this.ws.addEventListener('message', (event) => {
        try {
          const payload = JSON.parse(event.data);
          this.handleRealtimePayload(payload);
        } catch (_) {}
      });

      this.ws.addEventListener('close', () => {
        this.updateLiveConnectionBadge(false);
        this.scheduleWsReconnect();
      });

      this.ws.addEventListener('error', () => {
        this.updateLiveConnectionBadge(false);
      });
    } catch (err) {
      this.updateLiveConnectionBadge(false);
      this.scheduleWsReconnect();
    }
  }

  scheduleWsReconnect() {
    clearTimeout(this.wsReconnectTimer);
    const delay = Math.min(1000 * Math.pow(1.8, this.wsReconnectAttempts), 10000);
    this.wsReconnectAttempts += 1;
    this.wsReconnectTimer = setTimeout(() => {
      this.connectWebSocket();
    }, delay);
  }

  updateLiveConnectionBadge(isConnected) {
    const indicator = document.getElementById('ws-live-indicator');
    const textEl = document.getElementById('ws-live-text');
    if (!indicator || !textEl) return;

    indicator.classList.toggle('reconnecting', !isConnected);
    textEl.textContent = isConnected ? 'EN LÍNEA (WS)' : 'RECONECTANDO';
  }

  /**
   * Integra una lista de órdenes activas enviadas por el servidor sin duplicar IDs.
   */
  mergeOrdersWithoutDuplicates(serverOrders) {
    if (!Array.isArray(serverOrders)) return;

    const byId = new Map();
    serverOrders.forEach((o) => {
      if (o && o.id) byId.set(o.id, o);
    });
    this.orders.forEach((o) => {
      if (o && o.id && !byId.has(o.id)) {
        byId.set(o.id, o);
      }
    });

    this.orders = Array.from(byId.values()).sort(
      (a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0)
    );
    this.saveOrdersToStorage();
  }

  handleRealtimePayload(payload) {
    if (!payload) return;
    const type = payload.type || payload.eventType;

    if (type === 'INITIAL_ORDERS' && Array.isArray(payload.orders)) {
      this.mergeOrdersWithoutDuplicates(payload.orders);
      this.renderAll();
      return;
    }

    if (type === 'NUEVA_COMANDA' && payload.order) {
      const incoming = payload.order;
      const exists = this.orders.some((o) => o.id === incoming.id);
      if (!exists) {
        this.orders.unshift(incoming);
        this.saveOrdersToStorage();
      }
      this.renderAll();
      this.notifyIfRelevant(incoming);
    } else if (type === 'ESTADO_ACTUALIZADO' && payload.order) {
      const idx = this.orders.findIndex((o) => o.id === payload.order.id);
      if (idx !== -1) {
        this.orders[idx] = payload.order;
      } else {
        this.orders.unshift(payload.order);
      }
      this.saveOrdersToStorage();
      this.renderAll();
    } else if (type === 'TURNO_ACTUALIZADO') {
      if (Array.isArray(payload.orders)) {
        this.orders = payload.orders;
        this.saveOrdersToStorage();
      } else {
        this.loadStoredOrders();
      }
      this.renderAll();
    }
  }

  /**
   * Verifica si la comanda entrante corresponde al sector o ID del mesero actual
   * y dispara el sonido de campana + alerta visual.
   */
  notifyIfRelevant(order) {
    const matchesSector =
      this.sectorFilter === 'ALL' ||
      order.sector.toLowerCase() === this.assignedSector.toLowerCase() ||
      (order.mesero_id && order.mesero_id.toLowerCase() === this.waiterId);

    if (matchesSector) {
      this.playBellAlert(order.tipo === 'LLAMADO_MESERO');
      const label =
        order.tipo === 'LLAMADO_MESERO'
          ? `Mesa ${order.mesa} (${order.sector}) solicita atención del mesero`
          : `Nueva comanda en Mesa ${order.mesa} (${order.sector}) — ${this.formatGuaranies(order.total || 0)}`;
      this.showAlertBanner(label);
    }
  }

  /**
   * Sintetiza un sonido de campana de recepción/comanda usando Web Audio API.
   */
  playBellAlert(isUrgentCall = false) {
    if (!this.soundEnabled) return;

    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;

      if (!this.audioCtx) {
        this.audioCtx = new AudioContextClass();
      }
      if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume();
      }

      const now = this.audioCtx.currentTime;
      const playTone = (freq, startOffset, duration, gainPeak) => {
        const osc = this.audioCtx.createOscillator();
        const gain = this.audioCtx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now + startOffset);

        gain.gain.setValueAtTime(0.0001, now + startOffset);
        gain.gain.exponentialRampToValueAtTime(gainPeak, now + startOffset + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + startOffset + duration);

        osc.connect(gain);
        gain.connect(this.audioCtx.destination);

        osc.start(now + startOffset);
        osc.stop(now + startOffset + duration + 0.02);
      };

      playTone(987.77, 0.0, 0.55, 0.28);
      playTone(1975.53, 0.0, 0.35, 0.12);
      playTone(1318.51, 0.18, 0.75, 0.32);
      playTone(2637.02, 0.18, 0.45, 0.14);

      if (isUrgentCall) {
        playTone(1318.51, 0.42, 0.65, 0.3);
      }

      if (navigator.vibrate) {
        navigator.vibrate(isUrgentCall ? [180, 80, 180, 80, 220] : [200, 100, 200]);
      }
    } catch (err) {
      console.warn('Web Audio API bloqueada hasta interacción del usuario:', err);
    }
  }

  /**
   * Actualiza el estado de una comanda ("Cargado en Caja" o "Atendido"),
   * persiste en localStorage y notifica en tiempo real al cliente.
   */
  updateOrderStatus(orderId, newStatus) {
    const order = this.orders.find((o) => o.id === orderId);
    if (!order) return;

    order.estado = newStatus;
    order.updatedAt = new Date().toISOString();

    this.saveOrdersToStorage();
    this.renderAll();

    const statusEvent = {
      type: 'UPDATE_ORDER_STATUS',
      eventType: 'ESTADO_ACTUALIZADO',
      orderId: order.id,
      estado: newStatus,
      order
    };

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(statusEvent));
    }

    this.channel.postMessage(statusEvent);

    this.showAlertBanner(`✓ Mesa ${order.mesa} marcada como "${newStatus}"`);
  }

  /**
   * Archiva órdenes en localStorage bajo `kuroshio_turnos_archivados` al cerrar turno/caja.
   */
  archiveOrders(onlyAttended = true) {
    const toArchive = onlyAttended
      ? this.orders.filter((o) => o.estado === 'Atendido')
      : [...this.orders];

    if (toArchive.length > 0) {
      try {
        const rawArchive = localStorage.getItem(ARCHIVE_KEY);
        const history = rawArchive ? JSON.parse(rawArchive) : [];
        history.unshift({
          closedAt: new Date().toISOString(),
          closedBy: this.waiterId,
          sector: this.assignedSector,
          ordersCount: toArchive.length,
          totalRevenue: toArchive.reduce((acc, o) => acc + Number(o.total || 0), 0),
          orders: toArchive
        });
        localStorage.setItem(ARCHIVE_KEY, JSON.stringify(history.slice(0, 30)));
      } catch (err) {
        console.warn('No se pudo guardar archivo histórico del turno:', err);
      }
    }

    if (onlyAttended) {
      this.orders = this.orders.filter((o) => o.estado !== 'Atendido');
    } else {
      this.orders = [];
    }

    this.saveOrdersToStorage();

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: 'CLEAR_SHIFT',
          eventType: 'TURNO_ACTUALIZADO',
          onlyAttended
        })
      );
    }

    this.channel.postMessage({ eventType: 'TURNO_ACTUALIZADO' });
    this.renderAll();
  }

  /**
   * Filtra las órdenes según el sector asignado al mesero y el estado seleccionado.
   */
  getFilteredOrders() {
    return this.orders.filter((order) => {
      let matchesSector = true;
      if (this.sectorFilter === 'ASSIGNED') {
        matchesSector = order.sector.toLowerCase() === this.assignedSector.toLowerCase();
      } else if (this.sectorFilter !== 'ALL') {
        matchesSector = order.sector.toLowerCase() === this.sectorFilter.toLowerCase();
      }

      const matchesStatus =
        this.statusFilter === 'ALL' || order.estado === this.statusFilter;

      return matchesSector && matchesStatus;
    });
  }

  renderAll() {
    this.renderMetrics();
    this.renderOrderCards();
  }

  renderMetrics() {
    const sectorOrders = this.orders.filter((order) =>
      this.sectorFilter === 'ASSIGNED'
        ? order.sector.toLowerCase() === this.assignedSector.toLowerCase()
        : this.sectorFilter === 'ALL'
        ? true
        : order.sector.toLowerCase() === this.sectorFilter.toLowerCase()
    );

    const pendientes = sectorOrders.filter((o) => o.estado === 'Pendiente').length;
    const enCaja = sectorOrders.filter((o) => o.estado === 'Cargado en Caja').length;
    const atendidos = sectorOrders.filter((o) => o.estado === 'Atendido').length;
    const totalRevenue = sectorOrders.reduce((sum, o) => sum + Number(o.total || 0), 0);

    document.getElementById('count-pendientes').textContent = String(pendientes);
    document.getElementById('count-caja').textContent = String(enCaja);
    document.getElementById('count-atendidos').textContent = String(atendidos);

    const revEl = document.getElementById('total-shift-revenue');
    if (revEl) {
      revEl.textContent = this.formatGuaranies(totalRevenue);
    }
  }

  renderOrderCards() {
    const grid = document.getElementById('orders-grid');
    if (!grid) return;

    const filtered = this.getFilteredOrders();
    grid.innerHTML = '';

    if (filtered.length === 0) {
      grid.innerHTML = `
        <div class="empty-orders-box">
          <h3>Sin comandas en esta vista</h3>
          <p>Esperando nuevos pedidos en tiempo real para <strong>${
            this.sectorFilter === 'ASSIGNED' ? this.assignedSector : this.sectorFilter
          }</strong>...<br/><small>El historial del turno permanece guardado en este dispositivo aunque recargues o se apague la pantalla.</small></p>
        </div>
      `;
      return;
    }

    filtered.forEach((order) => {
      const statusClass =
        order.estado === 'Pendiente'
          ? 'status-pendiente'
          : order.estado === 'Cargado en Caja'
          ? 'status-caja'
          : 'status-atendido';

      const badgeClass =
        order.estado === 'Pendiente'
          ? 'pendiente'
          : order.estado === 'Cargado en Caja'
          ? 'caja'
          : 'atendido';

      const timeStr = new Date(order.timestamp).toLocaleTimeString('es-ES', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });

      const itemsHtml = (order.items || [])
        .map((item) => {
          const baseName = item.nombreBase || item.nombre;
          let detailsHtml = '';

          if (Array.isArray(item.opcionesDetalle) && item.opcionesDetalle.length > 0) {
            const tags = item.opcionesDetalle
              .map(
                (det) =>
                  `<span class="item-variant-tag"><strong>${det.grupo}:</strong> ${det.valor}</span>`
              )
              .join('');
            detailsHtml = `<div class="item-variants-wrap">${tags}</div>`;
          } else if (item.resumenOpciones) {
            detailsHtml = `<div class="item-variants-wrap"><span class="item-variant-tag">${item.resumenOpciones}</span></div>`;
          }

          return `
          <li class="comanda-item-li">
            <div class="comanda-item-main">
              <div class="comanda-item-title-row">
                <span class="item-qty-badge">${item.cantidad}x</span>
                <span>${baseName}</span>
              </div>
              ${detailsHtml}
            </div>
            <span class="comanda-item-subtotal">${item.subtotal > 0 ? this.formatGuaranies(item.subtotal) : ''}</span>
          </li>
        `;
        })
        .join('');

      const card = document.createElement('article');
      card.className = `comanda-card ${statusClass}`;
      card.innerHTML = `
        <div class="comanda-top">
          <div class="mesa-huge-badge">
            <span class="mesa-number">MESA ${order.mesa}</span>
            <span class="mesa-sector">Sector: ${order.sector} · Mesero: ${(order.mesero_id || 'juan').toUpperCase()}</span>
          </div>
          <span class="status-badge ${badgeClass}">${order.estado}</span>
        </div>

        <div class="comanda-meta">
          <span>ID: <strong>${order.id}</strong> (${order.tipo === 'LLAMADO_MESERO' ? 'Llamado de Mesa' : 'Comanda'})</span>
          <span>Hora: ${timeStr}</span>
        </div>

        <ul class="comanda-items">
          ${itemsHtml}
        </ul>

        <div class="comanda-total-row">
          <span>Total Comanda</span>
          <strong>${this.formatGuaranies(order.total || 0)}</strong>
        </div>

        <div class="comanda-actions">
          <button
            type="button"
            class="action-btn btn-pos"
            data-action="pos"
            ${order.estado === 'Cargado en Caja' || order.estado === 'Atendido' ? 'disabled' : ''}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
            <span>Cargado en Caja</span>
          </button>
          <button
            type="button"
            class="action-btn btn-attended"
            data-action="attended"
            ${order.estado === 'Atendido' ? 'disabled' : ''}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
            <span>Atendido</span>
          </button>
        </div>
      `;

      card.querySelector('[data-action="pos"]').addEventListener('click', () => {
        this.updateOrderStatus(order.id, 'Cargado en Caja');
      });

      card.querySelector('[data-action="attended"]').addEventListener('click', () => {
        this.updateOrderStatus(order.id, 'Atendido');
      });

      grid.appendChild(card);
    });
  }

  bindUIEvents() {
    const sectorSelect = document.getElementById('sector-filter');
    sectorSelect.addEventListener('change', (e) => {
      this.sectorFilter = e.target.value;
      this.saveWaiterPreferences();
      this.renderAll();
    });

    const statusPills = document.querySelectorAll('.status-pill');
    statusPills.forEach((pill) => {
      pill.addEventListener('click', () => {
        statusPills.forEach((p) => p.classList.remove('active'));
        pill.classList.add('active');
        this.statusFilter = pill.dataset.status;
        this.saveWaiterPreferences();
        this.renderAll();
      });
    });

    const soundBtn = document.getElementById('sound-toggle-btn');
    soundBtn.addEventListener('click', () => {
      this.soundEnabled = true;
      soundBtn.classList.add('active');
      this.playBellAlert(false);
      this.showAlertBanner('Sonido de campana verificado y activo');
    });

    // Modal de confirmación "Cerrar Turno / Arqueo"
    const shiftModal = document.getElementById('close-shift-modal');
    const summaryEl = document.getElementById('shift-modal-summary');

    const closeShiftModal = () => {
      shiftModal.classList.add('hidden');
      shiftModal.setAttribute('aria-hidden', 'true');
    };

    document.getElementById('close-shift-btn').addEventListener('click', () => {
      const pendientes = this.orders.filter((o) => o.estado === 'Pendiente').length;
      const enCaja = this.orders.filter((o) => o.estado === 'Cargado en Caja').length;
      const atendidas = this.orders.filter((o) => o.estado === 'Atendido').length;
      const total = this.orders.reduce((acc, o) => acc + Number(o.total || 0), 0);

      summaryEl.innerHTML = `
        <strong>Resumen actual en memoria:</strong><br/>
        • Pendientes: <strong>${pendientes}</strong> | Cargadas en Caja: <strong>${enCaja}</strong> | Atendidas: <strong>${atendidas}</strong><br/>
        • Recaudación registrada: <strong>${this.formatGuaranies(total)}</strong><br/><br/>
        Selecciona cómo deseas cerrar o limpiar el turno:
      `;

      shiftModal.classList.remove('hidden');
      shiftModal.setAttribute('aria-hidden', 'false');
    });

    document.getElementById('cancel-shift-modal-x').addEventListener('click', closeShiftModal);
    document.getElementById('cancel-shift-btn').addEventListener('click', closeShiftModal);

    document.getElementById('archive-attended-btn').addEventListener('click', () => {
      this.archiveOrders(true);
      closeShiftModal();
      this.showAlertBanner('Órdenes atendidas archivadas. Pedidos pendientes conservados.');
    });

    document.getElementById('reset-full-shift-btn').addEventListener('click', () => {
      const pendingCount = this.orders.filter((o) => o.estado !== 'Atendido').length;
      if (pendingCount > 0) {
        const ok = window.confirm(
          `Aún existen ${pendingCount} comanda(s) sin marcar como Atendidas. ¿Confirmas cerrar la caja completa y archivar todo el turno?`
        );
        if (!ok) return;
      }
      this.archiveOrders(false);
      closeShiftModal();
      this.showAlertBanner('Turno cerrado y caja reiniciada correctamente.');
    });
  }

  showAlertBanner(text) {
    const banner = document.getElementById('alert-banner');
    const bannerText = document.getElementById('alert-banner-text');
    if (!banner || !bannerText) return;

    bannerText.textContent = text;
    banner.classList.remove('hidden');

    clearTimeout(this.bannerTimeout);
    this.bannerTimeout = setTimeout(() => {
      banner.classList.add('hidden');
    }, 3200);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.waiterPanelApp = new WaiterPanelApp();
});
