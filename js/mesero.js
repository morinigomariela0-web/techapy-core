const CHANNEL_NAME = 'kuroshio_comandas_channel';
const STORAGE_KEY = 'kuroshio_comandas_store';
const ARCHIVE_KEY = 'kuroshio_turnos_archivados';
const TABLE_HISTORY_KEY = 'kuroshio_historial_mesas';
const WAITER_PREFS_KEY = 'kuroshio_mesero_prefs';

/**
 * Controlador en Tiempo Real para el Panel del Mesero (mesero.html).
 * - Lee ?id=juan&sector=Terraza desde la URL.
 * - Soporta Cuentas Divididas por Familias/Grupos en la misma mesa (reasignación en vivo y subtotales).
 * - Incluye Verificación de Totales antes de cobrar (corroboración contra caja / anotación del mozo).
 * - Incluye Historial de Mesas consultable del turno para conteo y cierre de caja.
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
    this.tableHistory = [];

    this.loadWaiterPreferences();
    this.initHeaderUI();
    this.loadStoredOrders();
    this.loadTableHistory();
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
   * Carga y sincroniza el Historial de Mesas cobradas/cerradas del turno desde localStorage y backend.
   */
  loadTableHistory() {
    try {
      const raw = localStorage.getItem(`${TABLE_HISTORY_KEY}_${this.tenant}`);
      if (raw) {
        const parsed = JSON.parse(raw);
        this.tableHistory = Array.isArray(parsed) ? parsed : [];
      } else {
        this.tableHistory = [];
      }
    } catch (_) {
      this.tableHistory = [];
    }

    // Consultar también el historial persistido en servidor si está disponible
    fetch(`./api/${encodeURIComponent(this.tenant)}/orders-history`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && Array.isArray(data.history)) {
          const byId = new Map();
          this.tableHistory.forEach((h) => {
            if (h && h.id) byId.set(h.id, h);
          });
          data.history.forEach((h) => {
            if (h && h.id && !byId.has(h.id)) byId.set(h.id, h);
          });
          this.tableHistory = Array.from(byId.values()).sort(
            (a, b) => new Date(b.cobradoAt || b.timestamp || 0) - new Date(a.cobradoAt || a.timestamp || 0)
          );
          this.saveTableHistory();
          this.renderTablesHistory();
        }
      })
      .catch(() => {});
  }

  saveTableHistory() {
    try {
      localStorage.setItem(
        `${TABLE_HISTORY_KEY}_${this.tenant}`,
        JSON.stringify(this.tableHistory.slice(0, 200))
      );
    } catch (_) {}
  }

  /**
   * Registra o actualiza una orden cobrada/cerrada dentro del Historial de Mesas del turno.
   */
  recordOrderInTableHistory(order) {
    if (!order || !order.id) return;
    const subAccounts = this.computeOrderSubAccounts(order);
    const entry = {
      ...order,
      cuentasDivididas: subAccounts,
      cobradoAt: order.cobradoAt || new Date().toISOString(),
      verificadoCaja: Boolean(order.verificadoCaja),
      montoCorroborado:
        order.montoCorroborado !== null && order.montoCorroborado !== undefined
          ? Number(order.montoCorroborado)
          : Number(order.total || 0)
    };

    const existingIdx = this.tableHistory.findIndex((h) => h.id === entry.id);
    if (existingIdx !== -1) {
      this.tableHistory[existingIdx] = entry;
    } else {
      this.tableHistory.unshift(entry);
    }
    this.saveTableHistory();
  }

  /**
   * Calcula y sincroniza las Cuentas Divididas (subcuentas por familia/grupo) de una comanda.
   */
  computeOrderSubAccounts(order) {
    if (!order) return [];
    const items = Array.isArray(order.items) ? order.items : [];
    const subMap = new Map();

    items.forEach((item) => {
      const subName = item.subcuenta || 'Cuenta 1 (Familia A)';
      const lineTotal = Number(
        item.subtotal !== undefined
          ? item.subtotal
          : Number(item.precioUnitario || 0) * Number(item.cantidad || 1)
      );
      const stat = subMap.get(subName) || {
        nombre: subName,
        subtotal: 0,
        cantidadItems: 0
      };
      stat.subtotal = Number((stat.subtotal + lineTotal).toFixed(2));
      stat.cantidadItems += Number(item.cantidad || 1);
      subMap.set(subName, stat);
    });

    const list = Array.from(subMap.values());
    order.cuentasDivididas = list;
    return list;
  }

  /**
   * Obtiene todas las opciones de subcuentas disponibles en una orden para el selector del mozo.
   */
  getAvailableSubAccountNames(order) {
    const set = new Set(['Cuenta 1 (Familia A)', 'Cuenta 2 (Familia B)']);
    if (Array.isArray(order.subAccountsCatalog)) {
      order.subAccountsCatalog.forEach((name) => set.add(name));
    }
    (order.items || []).forEach((item) => {
      if (item && item.subcuenta) set.add(item.subcuenta);
    });
    (order.cuentasDivididas || []).forEach((acc) => {
      if (acc && acc.nombre) set.add(acc.nombre);
    });
    return Array.from(set);
  }

  /**
   * Permite al mozo crear una nueva Cuenta / Familia dentro de la comanda de una mesa.
   */
  addOrderSubAccount(orderId) {
    const order = this.orders.find((o) => o.id === orderId);
    if (!order) return;

    const existingNames = this.getAvailableSubAccountNames(order);
    const nextIdx = existingNames.length + 1;
    const letter = String.fromCharCode(64 + Math.min(nextIdx, 26));
    const defaultName = `Cuenta ${nextIdx} (Familia ${letter})`;
    const custom = window.prompt(
      `Mesa ${order.mesa} — Nombre de la nueva Cuenta o Familia:`,
      defaultName
    );
    if (custom === null) return;
    const cleanName = custom.trim() || defaultName;

    order.subAccountsCatalog = Array.from(new Set([...existingNames, cleanName]));
    this.saveOrdersToStorage();
    this.broadcastOrderUpdate(order);
    this.renderAll();
    this.showAlertBanner(`✓ ${cleanName} habilitada en Mesa ${order.mesa}`);
  }

  /**
   * Permite al mozo reasignar cualquier ítem de la comanda a otra Cuenta / Familia en la misma mesa.
   */
  reassignItemSubAccount(orderId, itemIndex, newSubAccount) {
    const order = this.orders.find((o) => o.id === orderId);
    if (!order || !Array.isArray(order.items) || !order.items[itemIndex]) return;

    order.items[itemIndex].subcuenta = newSubAccount;
    this.computeOrderSubAccounts(order);
    order.updatedAt = new Date().toISOString();

    if (order.estado === 'Atendido') {
      this.recordOrderInTableHistory(order);
    }

    this.saveOrdersToStorage();
    this.broadcastOrderUpdate(order);
    this.renderAll();
    this.showAlertBanner(`✓ Ítem asignado a ${newSubAccount} en Mesa ${order.mesa}`);
  }

  /**
   * Actualiza los datos de corroboración del total antes de cobrar (monto en caja y check del mozo).
   */
  updateOrderVerification(orderId, { montoCorroborado, verificadoCaja }) {
    const order = this.orders.find((o) => o.id === orderId);
    if (!order) return;

    if (montoCorroborado !== undefined) {
      order.montoCorroborado = montoCorroborado;
    }
    if (verificadoCaja !== undefined) {
      order.verificadoCaja = Boolean(verificadoCaja);
    }
    order.updatedAt = new Date().toISOString();

    if (order.estado === 'Atendido') {
      this.recordOrderInTableHistory(order);
    }

    this.saveOrdersToStorage();
    this.broadcastOrderUpdate(order);
    this.renderAll();
  }

  broadcastOrderUpdate(order) {
    const statusEvent = {
      type: 'UPDATE_ORDER_STATUS',
      eventType: 'ESTADO_ACTUALIZADO',
      orderId: order.id,
      estado: order.estado,
      order
    };

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(statusEvent));
    }
    this.channel.postMessage(statusEvent);
  }

  /**
   * Actualiza el estado de una comanda ("Cargado en Caja" o "Atendido"),
   * verifica que el total haya sido corroborado antes de cobrar y registra en el Historial de Mesas.
   */
  updateOrderStatus(orderId, newStatus) {
    const order = this.orders.find((o) => o.id === orderId);
    if (!order) return;

    const totalExpected = Number(order.total || 0);
    if (newStatus === 'Atendido' && totalExpected > 0) {
      const currentCorroborated =
        order.montoCorroborado !== null && order.montoCorroborado !== undefined && order.montoCorroborado !== ''
          ? Number(order.montoCorroborado)
          : totalExpected;

      if (Math.abs(currentCorroborated - totalExpected) > 1) {
        const diff = Math.abs(currentCorroborated - totalExpected);
        const proceed = window.confirm(
          `Mesa ${order.mesa}: El monto anotado en caja (${this.formatGuaranies(
            currentCorroborated
          )}) tiene una diferencia de ${this.formatGuaranies(
            diff
          )} respecto al total de la mesa (${this.formatGuaranies(
            totalExpected
          )}). ¿Confirmas cobrar y cerrar la mesa de todos modos?`
        );
        if (!proceed) return;
      }

      order.montoCorroborado = currentCorroborated;
      order.verificadoCaja = true;
      order.cobradoAt = new Date().toISOString();
    }

    order.estado = newStatus;
    order.updatedAt = new Date().toISOString();

    if (newStatus === 'Atendido') {
      this.recordOrderInTableHistory(order);
    }

    this.saveOrdersToStorage();
    this.broadcastOrderUpdate(order);
    this.renderAll();

    this.showAlertBanner(
      newStatus === 'Atendido'
        ? `✓ Mesa ${order.mesa} cobrada (${this.formatGuaranies(totalExpected)}) y guardada en Historial`
        : `✓ Mesa ${order.mesa} marcada como "${newStatus}"`
    );
  }

  /**
   * Archiva órdenes en localStorage bajo `kuroshio_turnos_archivados` y en el Historial de Mesas al cerrar turno/caja.
   */
  archiveOrders(onlyAttended = true) {
    const toArchive = onlyAttended
      ? this.orders.filter((o) => o.estado === 'Atendido')
      : [...this.orders];

    if (toArchive.length > 0) {
      toArchive.forEach((o) => this.recordOrderInTableHistory(o));
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
    this.renderTablesHistory();
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

  /**
   * Renderiza el panel consultable de Historial de Mesas y Conteo para Cierre de Caja.
   */
  renderTablesHistory() {
    const listEl = document.getElementById('tables-history-list');
    const badgeEl = document.getElementById('history-count-badge');
    const closedCountEl = document.getElementById('hist-closed-count');
    const collectedTotalEl = document.getElementById('hist-collected-total');
    const pendingTotalEl = document.getElementById('hist-pending-total');

    // Unificar mesas cobradas en memoria + historial persistido del turno sin duplicar IDs
    const combinedMap = new Map();
    this.orders
      .filter((o) => o && o.estado === 'Atendido')
      .forEach((o) => combinedMap.set(o.id, o));
    (this.tableHistory || []).forEach((h) => {
      if (h && h.id && !combinedMap.has(h.id)) {
        combinedMap.set(h.id, h);
      }
    });

    const historyItems = Array.from(combinedMap.values()).sort(
      (a, b) => new Date(b.cobradoAt || b.timestamp || 0) - new Date(a.cobradoAt || a.timestamp || 0)
    );

    const collectedTotal = historyItems.reduce((acc, o) => acc + Number(o.total || 0), 0);
    const pendingTotal = this.orders
      .filter((o) => o && o.estado !== 'Atendido')
      .reduce((acc, o) => acc + Number(o.total || 0), 0);

    if (badgeEl) badgeEl.textContent = String(historyItems.length);
    if (closedCountEl) closedCountEl.textContent = String(historyItems.length);
    if (collectedTotalEl) collectedTotalEl.textContent = this.formatGuaranies(collectedTotal);
    if (pendingTotalEl) pendingTotalEl.textContent = this.formatGuaranies(pendingTotal);

    if (!listEl) return;

    if (historyItems.length === 0) {
      listEl.innerHTML = `
        <div class="empty-orders-box" style="padding: 20px;">
          <p>Aún no hay mesas cobradas o cerradas en el historial de este turno.<br/>
          <small>Cuando marques una comanda como <strong>"Atendido / Cobrar Mesa"</strong> aparecerá aquí con sus subcuentas y hora exacta para el arqueo de caja.</small></p>
        </div>
      `;
      return;
    }

    listEl.innerHTML = historyItems
      .map((item) => {
        const subAccounts = this.computeOrderSubAccounts(item);
        const closedTime = new Date(item.cobradoAt || item.updatedAt || item.timestamp).toLocaleTimeString(
          'es-ES',
          { hour: '2-digit', minute: '2-digit', second: '2-digit' }
        );
        const subPillsHtml = subAccounts
          .filter((s) => s.subtotal > 0)
          .map(
            (s) =>
              `<span class="history-sub-pill">${s.nombre}: ${this.formatGuaranies(s.subtotal)}</span>`
          )
          .join('');
        const verifiedAmount =
          item.montoCorroborado !== null && item.montoCorroborado !== undefined
            ? Number(item.montoCorroborado)
            : Number(item.total || 0);

        return `
          <div class="history-table-row">
            <div class="history-row-top">
              <div>
                <span class="history-row-title">MESA ${item.mesa} · ${item.sector}</span>
                <span class="history-row-time"> · ID ${item.id} · Hora cobro: ${closedTime} · Mozo: ${(
          item.mesero_id || this.waiterId
        ).toUpperCase()}</span>
              </div>
              <span class="history-row-total">${this.formatGuaranies(item.total || 0)}</span>
            </div>
            <div class="history-row-subaccounts">
              ${subPillsHtml || '<span class="history-sub-pill">Sin consumo monetario</span>'}
              <span class="history-verified-tag">✓ Corroborado en Caja: ${this.formatGuaranies(
                verifiedAmount
              )}</span>
            </div>
          </div>
        `;
      })
      .join('');
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

      const subAccounts = this.computeOrderSubAccounts(order);
      const availableSubNames = this.getAvailableSubAccountNames(order);

      const itemsHtml = (order.items || [])
        .map((item, idx) => {
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

          const currentSub = item.subcuenta || 'Cuenta 1 (Familia A)';
          const subOptionsHtml = availableSubNames
            .map(
              (accName) =>
                `<option value="${accName}" ${accName === currentSub ? 'selected' : ''}>${accName}</option>`
            )
            .join('');

          const subSelectorHtml =
            order.tipo !== 'LLAMADO_MESERO'
              ? `
              <div class="waiter-item-subaccount-row">
                <span class="waiter-item-subaccount-label">Cuenta / Familia:</span>
                <select class="waiter-item-subaccount-select" data-item-index="${idx}" aria-label="Asignar ítem a cuenta o familia">
                  ${subOptionsHtml}
                </select>
              </div>
            `
              : '';

          return `
          <li class="comanda-item-li">
            <div class="comanda-item-main">
              <div class="comanda-item-title-row">
                <span class="item-qty-badge">${item.cantidad}x</span>
                <span>${baseName}</span>
              </div>
              ${detailsHtml}
              ${subSelectorHtml}
            </div>
            <span class="comanda-item-subtotal">${item.subtotal > 0 ? this.formatGuaranies(item.subtotal) : ''}</span>
          </li>
        `;
        })
        .join('');

      // Bloque de Cuentas Divididas (Subtotales por Familia / Grupo)
      const splitRowsHtml = subAccounts
        .map(
          (acc) => `
          <div class="comanda-split-row">
            <span>${acc.nombre} <small>(${acc.cantidadItems} ítem${acc.cantidadItems === 1 ? '' : 's'})</small></span>
            <strong>${this.formatGuaranies(acc.subtotal)}</strong>
          </div>
        `
        )
        .join('');

      const splitBoxHtml =
        order.tipo !== 'LLAMADO_MESERO' && Number(order.total || 0) > 0
          ? `
          <div class="comanda-split-box">
            <div class="comanda-split-header">
              <span>Cuentas Divididas en Mesa (Subtotales)</span>
              <button type="button" class="comanda-split-add-btn" data-action="add-subaccount">+ Dividir / Nueva Familia</button>
            </div>
            ${splitRowsHtml}
          </div>
        `
          : '';

      // Bloque de Verificación de Totales Antes de Cobrar (Corroboración Caja / Mozo)
      const orderTotal = Number(order.total || 0);
      const currentVal =
        order.montoCorroborado !== null && order.montoCorroborado !== undefined && order.montoCorroborado !== ''
          ? Number(order.montoCorroborado)
          : orderTotal;
      const diff = currentVal - orderTotal;
      const isExactMatch = Math.abs(diff) <= 1;

      const verifyBoxHtml =
        order.tipo !== 'LLAMADO_MESERO' && orderTotal > 0
          ? `
          <div class="comanda-verify-box ${order.verificadoCaja ? 'verified' : ''}">
            <div class="verify-box-title">Verificación de Total Antes de Cobrar (Caja / Mozo)</div>
            <div class="verify-input-row">
              <input
                type="number"
                class="verify-amount-input"
                data-action="verify-input"
                value="${Math.round(currentVal)}"
                min="0"
                step="500"
                aria-label="Monto en caja o anotación del mozo"
              />
              <button type="button" class="verify-equal-btn" data-action="verify-equal">
                = Igualar (${this.formatGuaranies(orderTotal)})
              </button>
            </div>
            <div class="verify-diff-badge ${isExactMatch ? 'match' : 'mismatch'}" data-role="verify-badge">
              ${
                isExactMatch
                  ? `✓ Monto corroborado: Coincide exacto con el total (${this.formatGuaranies(orderTotal)})`
                  : `⚠ Diferencia: ${this.formatGuaranies(Math.abs(diff))} (${
                      diff > 0 ? 'Sobra' : 'Falta'
                    } respecto a ${this.formatGuaranies(orderTotal)})`
              }
            </div>
            <label class="verify-checkbox-label">
              <input
                type="checkbox"
                data-action="verify-check"
                ${order.verificadoCaja ? 'checked' : ''}
              />
              <span>Total corroborado por el mozo contra caja antes de cobrar</span>
            </label>
          </div>
        `
          : '';

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

        ${splitBoxHtml}

        <div class="comanda-total-row">
          <span>Total General Mesa ${order.mesa}</span>
          <strong>${this.formatGuaranies(orderTotal)}</strong>
        </div>

        ${verifyBoxHtml}

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
            <span>${orderTotal > 0 ? 'Cobrar / Atendido' : 'Atendido'}</span>
          </button>
        </div>
      `;

      // Eventos de reasignación de subcuenta por ítem
      card.querySelectorAll('.waiter-item-subaccount-select').forEach((sel) => {
        sel.addEventListener('change', (e) => {
          const idx = Number(sel.dataset.itemIndex);
          this.reassignItemSubAccount(order.id, idx, e.target.value);
        });
      });

      const addSubBtn = card.querySelector('[data-action="add-subaccount"]');
      if (addSubBtn) {
        addSubBtn.addEventListener('click', () => {
          this.addOrderSubAccount(order.id);
        });
      }

      // Eventos de verificación de total antes de cobrar
      const verifyInput = card.querySelector('[data-action="verify-input"]');
      const verifyEqualBtn = card.querySelector('[data-action="verify-equal"]');
      const verifyCheck = card.querySelector('[data-action="verify-check"]');

      if (verifyInput) {
        verifyInput.addEventListener('change', (e) => {
          const val = Math.max(0, Number(e.target.value) || 0);
          this.updateOrderVerification(order.id, {
            montoCorroborado: val,
            verificadoCaja: Math.abs(val - orderTotal) <= 1 ? true : order.verificadoCaja
          });
        });
      }

      if (verifyEqualBtn) {
        verifyEqualBtn.addEventListener('click', () => {
          this.updateOrderVerification(order.id, {
            montoCorroborado: orderTotal,
            verificadoCaja: true
          });
          this.showAlertBanner(`✓ Total de Mesa ${order.mesa} corroborado (${this.formatGuaranies(orderTotal)})`);
        });
      }

      if (verifyCheck) {
        verifyCheck.addEventListener('change', (e) => {
          this.updateOrderVerification(order.id, {
            montoCorroborado: verifyInput ? Number(verifyInput.value) || orderTotal : orderTotal,
            verificadoCaja: e.target.checked
          });
        });
      }

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

    // Botón para abrir/cerrar el Historial de Mesas y Conteo de Caja
    const toggleHistBtn = document.getElementById('toggle-history-btn');
    const closeHistBtn = document.getElementById('close-history-section-btn');
    const histSection = document.getElementById('tables-history-section');
    if (toggleHistBtn && histSection) {
      toggleHistBtn.addEventListener('click', () => {
        const isHidden = histSection.classList.toggle('hidden');
        toggleHistBtn.classList.toggle('active', !isHidden);
        if (!isHidden) {
          this.renderTablesHistory();
        }
      });
    }
    if (closeHistBtn && histSection) {
      closeHistBtn.addEventListener('click', () => {
        histSection.classList.add('hidden');
        if (toggleHistBtn) toggleHistBtn.classList.remove('active');
      });
    }

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
        • Pendientes: <strong>${pendientes}</strong> | Cargadas en Caja: <strong>${enCaja}</strong> | Atendidas / Cobradas: <strong>${atendidas}</strong><br/>
        • Recaudación en salón: <strong>${this.formatGuaranies(total)}</strong><br/>
        • Mesas en Historial del Turno: <strong>${this.tableHistory.length}</strong><br/><br/>
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
      this.showAlertBanner('Órdenes atendidas archivadas en Historial. Pedidos pendientes conservados.');
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
      this.showAlertBanner('Turno cerrado y guardado en Historial de Mesas.');
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

const bootWaiterPanelApp = () => {
  if (!window.waiterPanelApp) {
    window.waiterPanelApp = new WaiterPanelApp();
  }
};

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', bootWaiterPanelApp, { once: true });
} else {
  bootWaiterPanelApp();
}
