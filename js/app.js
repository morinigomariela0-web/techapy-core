import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

const CHANNEL_NAME = 'kuroshio_comandas_channel';
const STORAGE_KEY = 'kuroshio_comandas_store';
const CART_SESSION_KEY = 'kuroshio_cart_session';
const LAST_ORDER_SESSION_KEY = 'kuroshio_last_order_id';

/**
 * Clase principal del Menú Digital 3D & AR con Variantes, Cota 3D de Dimensiones y Comandas en Tiempo Real.
 * - Visor 3D Three.js optimizado con pixelRatio <= 2, cerámica PBR (clearcoat: 0.4, roughness: 0.18) y limpieza de VRAM.
 * - Rotación 360° con pausa suave al interactuar y reanudación progresiva tras 3 segundos de inactividad.
 * - Guía visual 3D de escala y dimensiones ("📏 Dimensiones") con líneas de cota y etiquetas en escena.
 * - Sistema de variantes, opciones y extras con cálculo dinámico de precio y desglose para el mesero.
 */
export class Menu3DApp {
  constructor() {
    this.container = document.getElementById('canvas-container');
    this.loadingOverlay = document.getElementById('loading-overlay');
    this.loadingText = document.getElementById('loading-text');

    this.dishes = [];
    this.filteredDishes = [];
    this.currentCategory = 'Todos';
    this.currentDish = null;
    this.currentModel = null;
    this.currentArBlobUrl = null;
    this.loadRequestId = 0;

    //Selección activa de variantes del plato actual: Map(groupId -> Set(optionValueId))
    this.activeSelections = new Map();

    // Indicador visual 3D de dimensiones (📏 Dimensiones)
    this.showDimensionsGuide = false;
    this.dimensionsGuideGroup = null;

    // Estado del Modo Cámara Directa (AR Passthrough 1:1 con getUserMedia)
    this.isARPassthroughActive = false;
    this.arMediaStream = null;
    this.arVideoElement = document.getElementById('ar-camera-feed');

    // Estado del carrito / comanda: cartKey -> { cartKey, dishId, nombreBase, nombre, resumenOpciones, opcionesDetalle, precioUnitario, cantidad }
    this.cart = new Map();
    this.lastOrderId = null;

    // Contexto de tenant/mesa/sector/mesero desde URL (?tenant=demo&mesa=4&sector=Terraza&mesero=juan)
    const params = new URLSearchParams(window.location.search);
    this.sessionContext = {
      tenant: (params.get('tenant') || 'demo').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'demo',
      mesa: params.get('mesa') || '4',
      sector: params.get('sector') || 'Terraza',
      mesero_id: params.get('mesero') || 'juan'
    };
    this.currencySymbol = 'Gs.';

    // Vectores para transición suave (lerp) de cámara
    this.targetCameraPos = new THREE.Vector3(0, 2.2, 3.2);
    this.targetControlsLookAt = new THREE.Vector3(0, 0.2, 0);
    this.isCameraTransitioning = false;

    // Control de rotación automática suave con pausa de 3s tras interacción
    this.isUserInteracting = false;
    this.lastInteractionTime = 0;
    this.currentRotationSpeed = 0.18;
    this.baseRotationSpeed = 0.18;

    this.clock = new THREE.Clock();

    this.initScene();
    this.initLights();
    this.initContactShadow();
    this.initLoaders();
    this.initRealtimeComandaBus();
    this.bindUIEvents();
    this.syncSessionContextUI();
    this.loadMenuData();
    this.animate();
  }

  /**
   * a) Inicializa la escena Three.js limitando el pixelRatio a máximo 2
   * para ahorrar memoria y batería en dispositivos móviles.
   */
  initScene() {
    this.scene = new THREE.Scene();

    const width = (this.container && this.container.clientWidth) || window.innerWidth;
    const height = (this.container && this.container.clientHeight) || Math.round(window.innerHeight * 0.58);

    this.camera = new THREE.PerspectiveCamera(
      42,
      width / Math.max(height, 1),
      0.02,
      50
    );
    this.camera.position.copy(this.targetCameraPos);

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance'
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;

    this.container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.enablePan = false;
    this.controls.minDistance = 0.25;
    this.controls.maxDistance = 5.5;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.04;
    this.controls.target.copy(this.targetControlsLookAt);

    // Pausar rotación suavemente cuando el usuario interactúa y registrar timestamp
    this.controls.addEventListener('start', () => {
      this.isCameraTransitioning = false;
      this.isUserInteracting = true;
      this.lastInteractionTime = performance.now();
    });

    this.controls.addEventListener('change', () => {
      if (this.isUserInteracting) {
        this.lastInteractionTime = performance.now();
      }
    });

    this.controls.addEventListener('end', () => {
      this.isUserInteracting = false;
      this.lastInteractionTime = performance.now();
    });

    window.addEventListener('resize', () => this.onWindowResize());
    if (typeof ResizeObserver !== 'undefined' && this.container) {
      this.stageResizeObserver = new ResizeObserver(() => this.onWindowResize());
      this.stageResizeObserver.observe(this.container);
    }
  }

  /**
   * Configura iluminación de estudio gastronómico sin shadow maps costosos.
   */
  initLights() {
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.88);
    this.scene.add(ambientLight);

    const keyLight = new THREE.DirectionalLight(0xfff4e6, 2.2);
    keyLight.position.set(3, 5, 3);
    this.scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0x90b4ff, 0.9);
    fillLight.position.set(-3, 3, -2);
    this.scene.add(fillLight);

    const rimLight = new THREE.DirectionalLight(0xff9d5c, 1.15);
    rimLight.position.set(0, 2, -4);
    this.scene.add(rimLight);
  }

  /**
   * b) Crea una sombra radial precalculada (fake contact shadow) mediante un plano
   * con CanvasTexture para evitar el costo de mapas de sombras dinámicos.
   */
  initContactShadow() {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    const gradient = ctx.createRadialGradient(
      size / 2,
      size / 2,
      size * 0.08,
      size / 2,
      size / 2,
      size * 0.48
    );
    gradient.addColorStop(0, 'rgba(0, 0, 0, 0.62)');
    gradient.addColorStop(0.55, 'rgba(0, 0, 0, 0.24)');
    gradient.addColorStop(1, 'rgba(0, 0, 0, 0.0)');

    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);

    const shadowTexture = new THREE.CanvasTexture(canvas);
    const shadowGeo = new THREE.PlaneGeometry(2.7, 2.7);
    const shadowMat = new THREE.MeshBasicMaterial({
      map: shadowTexture,
      transparent: true,
      depthWrite: false
    });

    this.contactShadow = new THREE.Mesh(shadowGeo, shadowMat);
    this.contactShadow.rotation.x = -Math.PI / 2;
    this.contactShadow.position.y = 0.001;
    this.scene.add(this.contactShadow);
  }

  /**
   * Inicializa GLTFLoader, DRACOLoader y GLTFExporter para AR 1:1.
   */
  initLoaders() {
    this.dracoLoader = new DRACOLoader();
    this.dracoLoader.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.164.1/examples/jsm/libs/draco/');

    this.gltfLoader = new GLTFLoader();
    this.gltfLoader.setDRACOLoader(this.dracoLoader);

    this.gltfExporter = new GLTFExporter();
  }

  /**
   * Inicializa el canal de comunicación en tiempo real cliente <-> mesero:
   * - WebSocket directo a ws://<host>/ws con reconexión exponencial suave.
   * - Respaldo automático en BroadcastChannel y localStorage.
   */
  initRealtimeComandaBus() {
    this.ws = null;
    this.wsReconnectAttempts = 0;
    this.wsReconnectTimer = null;
    this.pendingWsQueue = [];

    this.comandaChannel = new BroadcastChannel(CHANNEL_NAME);

    this.comandaChannel.addEventListener('message', (event) => {
      this.handleIncomingBusMessage(event.data);
    });

    window.addEventListener('storage', (event) => {
      if (event.key === STORAGE_KEY && event.newValue) {
        try {
          const orders = JSON.parse(event.newValue);
          if (this.lastOrderId) {
            const updated = orders.find((o) => o.id === this.lastOrderId);
            if (updated) {
              this.renderLiveOrderStatus(updated);
            }
          }
        } catch (err) {
          console.warn('Error leyendo estado de comanda en storage:', err);
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
   * Conecta mediante WebSocket al host actual (`ws://<ip-local>:8080/ws`)
   * e implementa reconexión con backoff exponencial suave si se pierde la señal Wi-Fi.
   */
  connectWebSocket() {
    clearTimeout(this.wsReconnectTimer);

    if (!window.location.host) {
      this.updateConnectionBadge(false);
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

    this.updateConnectionBadge(false);

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.addEventListener('open', () => {
        this.wsReconnectAttempts = 0;
        this.updateConnectionBadge(true);
        this.sendClientRegistration();

        // Despachar órdenes encoladas mientras estuvo reconectando
        while (this.pendingWsQueue.length > 0) {
          const queuedMsg = this.pendingWsQueue.shift();
          this.ws.send(JSON.stringify(queuedMsg));
        }
      });

      this.ws.addEventListener('message', (event) => {
        try {
          const payload = JSON.parse(event.data);
          this.handleIncomingBusMessage(payload);
        } catch (_) {}
      });

      this.ws.addEventListener('close', () => {
        this.updateConnectionBadge(false);
        this.scheduleWsReconnect();
      });

      this.ws.addEventListener('error', () => {
        this.updateConnectionBadge(false);
      });
    } catch (err) {
      this.updateConnectionBadge(false);
      this.scheduleWsReconnect();
    }
  }

  scheduleWsReconnect() {
    clearTimeout(this.wsReconnectTimer);
    const delay = Math.min(1000 * Math.pow(1.8, this.wsReconnectAttempts), 12000);
    this.wsReconnectAttempts += 1;
    this.wsReconnectTimer = setTimeout(() => {
      this.connectWebSocket();
    }, delay);
  }

  /**
   * Formatea importes en Guaraníes de Paraguay sin decimales (ej: Gs. 45.000).
   */
  formatGuaranies(amount, symbol = this.currencySymbol || 'Gs.') {
    const num = Math.round(Number(amount) || 0);
    const formatted = num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return `${symbol} ${formatted}`;
  }

  sendClientRegistration() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: 'REGISTER_CLIENT',
          tenant: this.sessionContext.tenant,
          mesa: this.sessionContext.mesa,
          sector: this.sessionContext.sector,
          mesero_id: this.sessionContext.mesero_id
        })
      );
    }
  }

  updateConnectionBadge(isOnline) {
    const badge = document.getElementById('ws-status-badge');
    if (!badge) return;

    badge.classList.toggle('online', isOnline);
    badge.classList.toggle('reconnecting', !isOnline);
    badge.textContent = isOnline ? '● En línea' : '● Reconectando';
  }

  handleIncomingBusMessage(payload) {
    if (!payload) return;
    const type = payload.type || payload.eventType;

    if (type === 'CLIENT_SYNC' && Array.isArray(payload.orders) && payload.orders.length > 0) {
      const latest = this.lastOrderId
        ? payload.orders.find((o) => o.id === this.lastOrderId) || payload.orders[0]
        : payload.orders[0];
      if (latest) {
        this.lastOrderId = latest.id;
        this.renderLiveOrderStatus(latest);
      }
      return;
    }

    if (type === 'ORDER_ACK' || type === 'COMANDA_CONFIRMADA') {
      if (payload.order) {
        this.renderLiveOrderStatus(payload.order);
      }
      return;
    }

    if (type === 'MENU_UPDATED') {
      this.loadMenuData();
      this.showToast('Carta actualizada por el restaurante');
      return;
    }

    if (type === 'ESTADO_ACTUALIZADO' && payload.order) {
      const { order } = payload;
      if (
        order.id === this.lastOrderId ||
        (String(order.mesa) === String(this.sessionContext.mesa) &&
          String(order.sector).toLowerCase() === String(this.sessionContext.sector).toLowerCase())
      ) {
        this.renderLiveOrderStatus(order);
        this.showToast(`Mesa ${order.mesa}: Tu pedido fue marcado como "${order.estado}"`);
      }
    }
  }

  syncSessionContextUI() {
    const badge = document.getElementById('table-context-badge');
    const sectorInput = document.getElementById('input-sector');
    const mesaInput = document.getElementById('input-mesa');
    const meseroInput = document.getElementById('input-mesero');

    if (sectorInput) {
      let match = Array.from(sectorInput.options).find(
        (opt) => opt.value.toLowerCase() === this.sessionContext.sector.toLowerCase()
      );
      if (!match && this.sessionContext.sector) {
        const customOpt = document.createElement('option');
        customOpt.value = this.sessionContext.sector;
        customOpt.textContent = this.sessionContext.sector;
        sectorInput.appendChild(customOpt);
        match = customOpt;
      }
      if (match) {
        sectorInput.value = match.value;
        this.sessionContext.sector = match.value;
      }
    }
    if (mesaInput) mesaInput.value = this.sessionContext.mesa;
    if (meseroInput) meseroInput.value = this.sessionContext.mesero_id;

    const updateContextFromInputs = () => {
      this.sessionContext.sector = sectorInput.value.trim() || 'Terraza';
      this.sessionContext.mesa = mesaInput.value.trim() || '1';
      this.sessionContext.mesero_id = meseroInput.value.trim().toLowerCase() || 'juan';
      if (badge) {
        badge.textContent = `Mesa ${this.sessionContext.mesa} · ${this.sessionContext.sector}`;
      }
      this.sendClientRegistration();
    };

    if (sectorInput) sectorInput.addEventListener('change', updateContextFromInputs);
    if (mesaInput) mesaInput.addEventListener('input', updateContextFromInputs);
    if (meseroInput) meseroInput.addEventListener('input', updateContextFromInputs);

    updateContextFromInputs();
  }

  /**
   * Carga el catálogo JSON de platos del tenant activo e inicializa la interfaz.
   */
  async loadMenuData() {
    const tenant = this.sessionContext.tenant || 'demo';
    try {
      this.setLoading(true, 'Cargando carta digital 3D...');

      // Consultar configuración del tenant si está disponible
      fetch(`./api/${encodeURIComponent(tenant)}/config`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((cfg) => {
          if (cfg && cfg.moneda) {
            this.currencySymbol = cfg.moneda;
          }
        })
        .catch(() => {});

      let response = await fetch(`./api/${encodeURIComponent(tenant)}/menu`, {
        cache: 'no-store'
      }).catch(() => null);
      if (!response || !response.ok) {
        response = await fetch(`./data/tenants/${encodeURIComponent(tenant)}/menu-data.json`, {
          cache: 'no-store'
        }).catch(() => null);
      }
      if (!response || !response.ok) {
        response = await fetch('./data/menu-data.json', { cache: 'no-store' });
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = await response.json();
      if (data.restaurante && data.restaurante.monedaSimbolo) {
        this.currencySymbol = data.restaurante.monedaSimbolo;
      }
      const brandTitleEl = document.getElementById('restaurant-brand-title');
      if (brandTitleEl && data.restaurante && data.restaurante.nombre) {
        const restName = data.restaurante.nombre.replace(/Moopio 3D/gi, 'TechaPY');
        const displayBrand = restName.includes('TechaPY') ? restName : `TechaPY · ${restName}`;
        brandTitleEl.innerHTML = `<span class="brand-serif">${displayBrand}</span> <span class="brand-badge">VISUALIZACIÓN GASTRONÓMICA 3D &amp; AR</span>`;
      }
      this.dishes = data.platos || [];
      this.filteredDishes = [...this.dishes];

      this.restoreCartFromSession();
      this.restoreLastOrderFromSession();
      this.renderCategories();
      this.renderCarousel();

      if (this.filteredDishes.length > 0) {
        await this.selectDish(this.filteredDishes[0].id);
      }
    } catch (error) {
      console.error('Error cargando menu-data.json:', error);
      this.showToast('Error al cargar el catálogo de platos');
    } finally {
      this.setLoading(false);
    }
  }

  /**
   * d) Libera de la memoria VRAM todas las geometrías, materiales y texturas
   * del modelo anterior antes de cargar el siguiente plato.
   */
  disposeCurrentModel() {
    if (!this.currentModel) return;

    this.scene.remove(this.currentModel);
    this.disposeObjectResources(this.currentModel);
    this.currentModel = null;
  }

  disposeDimensionsGuide() {
    if (!this.dimensionsGuideGroup) return;
    this.scene.remove(this.dimensionsGuideGroup);
    this.disposeObjectResources(this.dimensionsGuideGroup);
    this.dimensionsGuideGroup = null;
  }

  disposeObjectResources(rootObj) {
    rootObj.traverse((child) => {
      if (child.geometry) {
        child.geometry.dispose();
      }
      if (child.material) {
        const materials = Array.isArray(child.material)
          ? child.material
          : [child.material];

        materials.forEach((mat) => {
          Object.keys(mat).forEach((prop) => {
            const value = mat[prop];
            if (value && value.isTexture) {
              value.dispose();
            }
          });
          mat.dispose();
        });
      }
    });
  }

  /**
   * Selecciona un plato por ID, inicializa sus variantes por defecto, actualiza la UI,
   * dispara la transición de cámara y carga el modelo 3D.
   */
  async selectDish(dishId) {
    const dish = this.dishes.find((item) => item.id === dishId);
    if (!dish) return;

    this.currentDish = dish;
    const requestId = ++this.loadRequestId;

    this.initDishDefaultOptions(dish);
    this.updateDishUI(dish);
    this.highlightActiveCard(dish.id);
    this.transitionCameraTo(dish.cameraConfig);

    this.setLoading(true, `Preparando ${dish.nombre}...`);
    this.disposeCurrentModel();

    try {
      const { modelGroup, cameFromGLB } = await this.loadGLBOrFallback(dish);

      if (requestId !== this.loadRequestId) {
        this.disposeObjectResources(modelGroup);
        return;
      }

      const scale = dish.escala || 1.0;
      modelGroup.scale.setScalar(scale);

      this.currentModel = modelGroup;
      this.currentModelCameFromGLB = cameFromGLB;
      this.scene.add(this.currentModel);

      if (this.isARPassthroughActive) {
        this.applyARMetricScaleAndCamera(dish);
      }

      // Actualizar guía 3D de dimensiones si está activa
      this.updateDimensionsGuide(dish);

      // Preparar modelo GLB en escala real 1:1 para el visor AR (@google/model-viewer)
      await this.prepareARModelSource(dish, modelGroup, cameFromGLB);
    } finally {
      if (requestId === this.loadRequestId) {
        this.setLoading(false);
      }
    }
  }

  /**
   * Inicializa las opciones por defecto definidas en `dish.opciones`.
   */
  initDishDefaultOptions(dish) {
    this.activeSelections.clear();
    const groups = dish.opciones || [];

    groups.forEach((group) => {
      const selectedSet = new Set();
      (group.valores || []).forEach((val) => {
        if (val.porDefecto) {
          selectedSet.add(val.id);
        }
      });

      if (group.obligatorio && selectedSet.size === 0 && group.valores && group.valores.length > 0) {
        selectedSet.add(group.valores[0].id);
      }

      this.activeSelections.set(group.id, selectedSet);
    });
  }

  /**
   * Renderiza los selectores visuales de variantes y extras en `#dish-options-container`.
   */
  renderDishOptions(dish) {
    const container = document.getElementById('dish-options-container');
    if (!container) return;

    container.innerHTML = '';
    const groups = dish.opciones || [];

    if (groups.length === 0) {
      container.style.display = 'none';
      return;
    }
    container.style.display = 'flex';

    groups.forEach((group) => {
      const groupEl = document.createElement('div');
      groupEl.className = 'option-group';

      let hintText = '';
      if (group.tipo === 'multiselect' && group.maxSeleccion) {
        const currentCount = (this.activeSelections.get(group.id) || new Set()).size;
        hintText = `Elige hasta ${group.maxSeleccion} (${currentCount}/${group.maxSeleccion})`;
      } else if (group.tipo === 'checkbox') {
        hintText = 'Opcional';
      }

      groupEl.innerHTML = `
        <div class="option-group-header">
          <span>${group.nombre}</span>
          <span class="option-group-hint">${hintText}</span>
        </div>
        <div class="option-pills-row"></div>
      `;

      const pillsRow = groupEl.querySelector('.option-pills-row');
      const selectedSet = this.activeSelections.get(group.id) || new Set();

      (group.valores || []).forEach((val) => {
        const isSelected = selectedSet.has(val.id);
        const pill = document.createElement('button');
        pill.type = 'button';
        const isCheckStyle = group.tipo === 'checkbox' || group.tipo === 'multiselect';
        pill.className = `option-pill ${isCheckStyle ? 'checkbox' : 'radio'} ${isSelected ? 'selected' : ''}`;
        pill.setAttribute('aria-pressed', String(isSelected));

        const extraBadge =
          val.precioExtra && val.precioExtra > 0
            ? `<span class="option-extra-price">+${this.formatGuaranies(val.precioExtra)}</span>`
            : '';

        pill.innerHTML = `
          <span class="option-pill-indicator">${isSelected ? '✓' : ''}</span>
          <span>${val.etiqueta}</span>
          ${extraBadge}
        `;

        pill.addEventListener('click', () => {
          this.handleOptionToggle(dish, group, val.id);
        });

        pillsRow.appendChild(pill);
      });

      container.appendChild(groupEl);
    });
  }

  /**
   * Gestiona la selección de una variante (radio, checkbox o multiselect con límite)
   * y recalcula el precio final dinámicamente.
   */
  handleOptionToggle(dish, group, valueId) {
    const selectedSet = this.activeSelections.get(group.id) || new Set();

    if (group.tipo === 'radio') {
      selectedSet.clear();
      selectedSet.add(valueId);
    } else if (group.tipo === 'checkbox') {
      if (selectedSet.has(valueId)) {
        selectedSet.delete(valueId);
      } else {
        selectedSet.add(valueId);
      }
    } else if (group.tipo === 'multiselect') {
      const max = group.maxSeleccion || 3;
      if (selectedSet.has(valueId)) {
        if (!group.obligatorio || selectedSet.size > 1) {
          selectedSet.delete(valueId);
        } else {
          this.showToast(`Selecciona al menos 1 opción en "${group.nombre}"`);
        }
      } else {
        if (selectedSet.size >= max) {
          // Reemplaza la primera opción seleccionada para mantener fluidez táctil
          const first = selectedSet.values().next().value;
          selectedSet.delete(first);
        }
        selectedSet.add(valueId);
      }
    }

    this.activeSelections.set(group.id, selectedSet);
    this.renderDishOptions(dish);
    this.updateDynamicPriceUI(dish);
  }

  /**
   * Calcula el precio unitario final (`precio_base + extras`) y genera el desglose legible
   * de variantes para el carrito y el panel del mesero.
   */
  getConfiguredDishSummary(dish) {
    if (!dish) {
      return {
        unitPrice: 0,
        signature: 'default',
        resumenOpciones: '',
        opcionesDetalle: [],
        nombreCompleto: ''
      };
    }

    let extraCost = 0;
    const parts = [];
    const opcionesDetalle = [];
    const sigParts = [];

    (dish.opciones || []).forEach((group) => {
      const selectedSet = this.activeSelections.get(group.id) || new Set();
      const chosenValues = (group.valores || []).filter((v) => selectedSet.has(v.id));

      if (chosenValues.length > 0) {
        sigParts.push(`${group.id}:${chosenValues.map((v) => v.id).sort().join(',')}`);

        chosenValues.forEach((v) => {
          extraCost += Number(v.precioExtra || 0);
        });

        if (group.tipo === 'checkbox') {
          const labels = chosenValues.map((v) => `+${v.etiqueta}`);
          parts.push(labels.join(', '));
          opcionesDetalle.push({
            grupo: group.nombre,
            valor: chosenValues.map((v) => v.etiqueta).join(', ')
          });
        } else {
          const shortGroupName = group.nombre
            .replace('Nivel de picante', 'Picante')
            .replace('Tipo de cocción', 'Cocción')
            .replace('Selección de 3 sabores', 'Sabores');
          const joined = chosenValues.map((v) => v.etiqueta).join(', ');
          parts.push(`${shortGroupName}: ${joined}`);
          opcionesDetalle.push({
            grupo: shortGroupName,
            valor: joined
          });
        }
      }
    });

    const unitPrice = Number((dish.precio + extraCost).toFixed(2));
    const resumenOpciones = parts.join(' · ');
    const nombreCompleto = resumenOpciones
      ? `${dish.nombre} (${resumenOpciones})`
      : dish.nombre;

    return {
      unitPrice,
      signature: sigParts.join('|') || 'base',
      resumenOpciones,
      opcionesDetalle,
      nombreCompleto
    };
  }

  updateDynamicPriceUI(dish) {
    const { unitPrice } = this.getConfiguredDishSummary(dish);
    const priceEl = document.getElementById('dish-price');
    const btnLabelEl = document.getElementById('add-to-order-label');
    const formattedPrice = this.formatGuaranies(unitPrice);

    if (priceEl) {
      priceEl.textContent = formattedPrice;
    }
    if (btnLabelEl) {
      btnLabelEl.textContent = `+ Añadir a comanda (${formattedPrice})`;
    }
  }

  /**
   * 2. Construye o actualiza la guía visual 3D de escala y dimensiones ("📏 Dimensiones")
   * sobre la escena 3D con líneas de cota elegantes (diámetro y altura en centímetros).
   */
  updateDimensionsGuide(dish = this.currentDish) {
    this.disposeDimensionsGuide();

    const hudBadge = document.getElementById('dimensions-hud-badge');
    const hudText = document.getElementById('dimensions-hud-text');
    const toggleBtn = document.getElementById('toggle-dimensions-btn');

    if (!dish) return;

    const diamCm = dish.diametro_cm || 24;
    const heightCm = dish.altura_cm || 6;
    const summaryLabel = `⌀ ${diamCm} cm · Altura ${heightCm} cm`;

    if (hudText) hudText.textContent = summaryLabel;
    if (hudBadge) hudBadge.classList.toggle('hidden', !this.showDimensionsGuide);
    if (toggleBtn) {
      toggleBtn.classList.toggle('active', this.showDimensionsGuide);
      toggleBtn.setAttribute('aria-pressed', String(this.showDimensionsGuide));
    }

    if (!this.showDimensionsGuide) return;

    const group = new THREE.Group();
    group.name = 'dimensions-guide-3d';

    const radius = 1.08 * (dish.escala || 1.0);
    const visualHeight = Math.max(0.42, (heightCm / 24) * 2.05);

    const lineMat = new THREE.LineBasicMaterial({
      color: 0xd4af37,
      transparent: true,
      opacity: 0.88
    });

    const subtleRingMat = new THREE.LineBasicMaterial({
      color: 0xc5a059,
      transparent: true,
      opacity: 0.45
    });

    // Anillo perimetral de referencia sobre la mesa
    const ringPts = [];
    const segments = 64;
    for (let i = 0; i <= segments; i++) {
      const theta = (i / segments) * Math.PI * 2;
      ringPts.push(new THREE.Vector3(Math.cos(theta) * radius, 0.015, Math.sin(theta) * radius));
    }
    const ringGeo = new THREE.BufferGeometry().setFromPoints(ringPts);
    group.add(new THREE.Line(ringGeo, subtleRingMat));

    // Cota frontal de Diámetro (⌀ X cm)
    const zFront = radius + 0.22;
    const diamPoints = [
      new THREE.Vector3(-radius, 0.02, zFront - 0.12),
      new THREE.Vector3(-radius, 0.02, zFront + 0.06),
      new THREE.Vector3(-radius, 0.02, zFront),
      new THREE.Vector3(radius, 0.02, zFront),
      new THREE.Vector3(radius, 0.02, zFront + 0.06),
      new THREE.Vector3(radius, 0.02, zFront - 0.12)
    ];
    const diamGeo = new THREE.BufferGeometry().setFromPoints(diamPoints);
    group.add(new THREE.Line(diamGeo, lineMat));

    const diamSprite = this.createDimensionLabelSprite(`⌀ ${diamCm} cm`, '#d4af37');
    diamSprite.position.set(0, 0.14, zFront + 0.08);
    group.add(diamSprite);

    // Cota lateral vertical de Altura (Altura Y cm)
    const xSide = radius + 0.22;
    const heightPoints = [
      new THREE.Vector3(xSide - 0.08, 0.02, 0),
      new THREE.Vector3(xSide + 0.08, 0.02, 0),
      new THREE.Vector3(xSide, 0.02, 0),
      new THREE.Vector3(xSide, visualHeight, 0),
      new THREE.Vector3(xSide - 0.08, visualHeight, 0),
      new THREE.Vector3(xSide + 0.08, visualHeight, 0)
    ];
    const heightGeo = new THREE.BufferGeometry().setFromPoints(heightPoints);
    group.add(new THREE.Line(heightGeo, lineMat));

    const heightSprite = this.createDimensionLabelSprite(`Altura ${heightCm} cm`, '#c5a059');
    heightSprite.position.set(xSide + 0.28, visualHeight * 0.55, 0);
    group.add(heightSprite);

    if (this.isARPassthroughActive) {
      const targetMeters = THREE.MathUtils.clamp(diamCm / 100, 0.14, 0.38);
      const studioDiameter = Math.max(radius * 2, 0.01);
      group.scale.setScalar(targetMeters / studioDiameter);
    }

    this.dimensionsGuideGroup = group;
    this.scene.add(this.dimensionsGuideGroup);
  }

  /**
   * Crea un Sprite ligero con CanvasTexture para mostrar etiquetas de cota nítidas en 3D.
   */
  createDimensionLabelSprite(text, borderColor = '#c5a059') {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = 'rgba(14, 16, 19, 0.92)';
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 3;

    const r = 16;
    ctx.beginPath();
    ctx.roundRect(6, 6, 244, 52, r);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#f4f4f6';
    ctx.font = '600 22px "Plus Jakarta Sans", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 128, 33);

    const texture = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false
    });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(0.88, 0.22, 1);
    return sprite;
  }

  /**
   * Intenta cargar el modelo .glb local y, si aún no existe en disco,
   * genera automáticamente el modelo 3D estilizado procedural.
   */
  loadGLBOrFallback(dish) {
    return new Promise((resolve) => {
      if (!dish.ruta_modelo_glb) {
        resolve({ modelGroup: this.createProceduralDish(dish), cameFromGLB: false });
        return;
      }

      this.gltfLoader.load(
        dish.ruta_modelo_glb,
        (gltf) => {
          const root = gltf.scene;
          const box = new THREE.Box3().setFromObject(root);
          const center = box.getCenter(new THREE.Vector3());
          root.position.x -= center.x;
          root.position.z -= center.z;
          root.position.y -= box.min.y;
          resolve({ modelGroup: root, cameFromGLB: true });
        },
        undefined,
        () => {
          const proceduralModel = this.createProceduralDish(dish);
          resolve({ modelGroup: proceduralModel, cameFromGLB: false });
        }
      );
    });
  }

  /**
   * Genera o asigna el archivo .glb en escala física 1:1 (metros reales)
   * para el componente <model-viewer ar ar-scale="fixed">.
   */
  async prepareARModelSource(dish, modelGroup, cameFromGLB) {
    const modelViewer = document.getElementById('ar-model-viewer');
    if (!modelViewer) return;

    if (this.currentArBlobUrl) {
      URL.revokeObjectURL(this.currentArBlobUrl);
      this.currentArBlobUrl = null;
    }

    const realWorldScale = dish.escala_ar_metros || 0.12;

    if (cameFromGLB && dish.ruta_modelo_glb) {
      modelViewer.src = dish.ruta_modelo_glb;
      modelViewer.scale = `${realWorldScale} ${realWorldScale} ${realWorldScale}`;
      return;
    }

    modelViewer.scale = '1 1 1';
    const arClone = modelGroup.clone(true);
    arClone.scale.setScalar(realWorldScale);
    arClone.rotation.set(0, 0, 0);
    arClone.updateMatrixWorld(true);

    return new Promise((resolve) => {
      this.gltfExporter.parse(
        arClone,
        (glbBuffer) => {
          const blob = new Blob([glbBuffer], { type: 'model/gltf-binary' });
          this.currentArBlobUrl = URL.createObjectURL(blob);
          modelViewer.src = this.currentArBlobUrl;
          this.disposeObjectResources(arClone);
          resolve();
        },
        (error) => {
          console.warn('Error exportando GLB para AR:', error);
          this.disposeObjectResources(arClone);
          resolve();
        },
        { binary: true }
      );
    });
  }

  /**
   * Activa el Modo Cámara Directa (AR Passthrough 1:1) usando `navigator.mediaDevices.getUserMedia`:
   * - Enciende la cámara trasera (`facingMode: 'environment'`) detrás del canvas transparente (`alpha: true`).
   * - Ajusta el plato 3D a su escala métrica real correspondiente (ej. 24 cm de diámetro).
   * - Activa automáticamente la guía 3D de cotas dimensionales (`📏 Dimensiones`).
   * - Muestra el botón flotante `❌ Salir de AR` y la opción secundaria `📲 AR Nativo`.
   */
  async startARPassthroughMode() {
    if (this.isARPassthroughActive) {
      return;
    }

    // Asegurar que exista un plato y modelo 3D activo en escena (sin depender jamás del carrito/comanda)
    if (!this.currentDish && this.dishes && this.dishes.length > 0) {
      await this.selectDish(this.dishes[0].id);
    } else if (this.currentDish && !this.currentModel) {
      await this.selectDish(this.currentDish.id);
    }

    const activeDish = this.currentDish || (this.dishes && this.dishes[0]) || null;

    const videoEl = this.arVideoElement || document.getElementById('ar-camera-feed');
    const openArBtn = document.getElementById('open-ar-btn');
    const exitArBtn = document.getElementById('exit-ar-btn');
    const secondaryNativeBtn = document.getElementById('secondary-native-ar-btn');

    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      this.showToast('La cámara requiere conexión HTTPS. Abriendo visor AR secundario...');
      const arModal = document.getElementById('ar-modal');
      if (arModal) arModal.classList.remove('hidden');
      return;
    }

    try {
      let stream = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 }
          },
          audio: false
        });
      } catch (_) {
        stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: false
        });
      }

      this.arMediaStream = stream;
      this.isARPassthroughActive = true;

      if (videoEl) {
        videoEl.srcObject = stream;
        videoEl.classList.remove('hidden');
        await videoEl.play().catch(() => {});
      }

      document.body.classList.add('ar-passthrough-active');
      this.renderer.setClearColor(0x000000, 0);

      if (openArBtn) openArBtn.classList.add('hidden');
      if (exitArBtn) exitArBtn.classList.remove('hidden');
      if (secondaryNativeBtn) secondaryNativeBtn.classList.remove('hidden');

      // Activar cota dimensional 3D y fijar escala métrica 1:1 y cámara de comensal sobre la mesa
      this.showDimensionsGuide = true;
      this.applyARMetricScaleAndCamera(activeDish);
      if (activeDish) {
        this.updateDimensionsGuide(activeDish);
        const dimsLabel = activeDish.dimensiones_reales || `⌀ ${activeDish.diametro_cm || 24} cm`;
        this.showToast(`AR 1:1 Activo (${dimsLabel}) · Apunta a tu mesa`);
      }
    } catch (err) {
      console.error('[AR Passthrough] Error accediendo a la cámara:', err);
      this.showToast('Permiso de cámara no disponible. Mostrando visor AR alternativo.');
      const arModal = document.getElementById('ar-modal');
      if (arModal) arModal.classList.remove('hidden');
    }
  }

  /**
   * Calibra la escala métrica real 1:1 del plato 3D (ej. 24 cm = 0.24 m) y fuerza la posición
   * de la cámara virtual para simular la vista de un comensal sentado (40cm altura, 60cm distancia)
   * evitando clipping dentro de la geometría.
   */
  applyARMetricScaleAndCamera(dish = this.currentDish) {
    this.renderer.setClearColor(0x000000, 0);

    // Detener cualquier interpolación previa de cámara y posicionar al comensal sentado (0, 0.4, 0.6)
    this.isCameraTransitioning = false;
    this.targetCameraPos.set(0, 0.4, 0.6);
    this.targetControlsLookAt.set(0, 0, 0);

    this.camera.position.set(0, 0.4, 0.6); // 40cm de altura, 60cm de distancia
    this.camera.lookAt(0, 0, 0);
    if (this.controls) {
      this.controls.minDistance = 0.2;
      this.controls.target.set(0, 0, 0);
      this.controls.update();
    }

    if (!this.currentModel) return;

    const diametroCm =
      (dish && Number(dish.diametro_cm)) ||
      (dish && dish.dimensiones_cm && Number(dish.dimensiones_cm.diametro)) ||
      24;

    // Medir el diámetro base sin escala del modelo activo para normalizarlo a metros reales (ej. 0.24m)
    this.currentModel.scale.setScalar(1);
    this.currentModel.position.set(0, 0, 0);
    this.currentModel.visible = true;
    this.currentModel.updateMatrixWorld(true);

    const box = new THREE.Box3().setFromObject(this.currentModel);
    const size = box.getSize(new THREE.Vector3());
    const rawSpan = Math.max(size.x, size.z, 0.01);

    const targetMeters = THREE.MathUtils.clamp(diametroCm / 100, 0.14, 0.38);
    const metricScale = targetMeters / rawSpan;
    this.currentModel.scale.setScalar(metricScale);

    if (this.contactShadow) {
      this.contactShadow.scale.setScalar(targetMeters / 2.1);
    }
  }

  /**
   * Detiene los tracks de video de la cámara (`track.stop()`), apaga el fondo de video
   * y restaura la vista 3D de estudio normal.
   */
  stopARPassthroughMode() {
    if (this.arMediaStream) {
      this.arMediaStream.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch (_) {}
      });
      this.arMediaStream = null;
    }

    const videoEl = this.arVideoElement || document.getElementById('ar-camera-feed');
    if (videoEl) {
      videoEl.pause();
      videoEl.srcObject = null;
      videoEl.classList.add('hidden');
    }

    this.isARPassthroughActive = false;
    document.body.classList.remove('ar-passthrough-active');

    const openArBtn = document.getElementById('open-ar-btn');
    const exitArBtn = document.getElementById('exit-ar-btn');
    const secondaryNativeBtn = document.getElementById('secondary-native-ar-btn');

    if (openArBtn) openArBtn.classList.remove('hidden');
    if (exitArBtn) exitArBtn.classList.add('hidden');
    if (secondaryNativeBtn) secondaryNativeBtn.classList.add('hidden');

    if (this.contactShadow) {
      this.contactShadow.scale.setScalar(1);
    }

    if (this.currentDish && this.currentModel) {
      this.currentModel.scale.setScalar(this.currentDish.escala || 1.0);
      this.transitionCameraTo(this.currentDish.cameraConfig);
      this.updateDimensionsGuide(this.currentDish);
    }

    this.showToast('Visor 3D de estudio restaurado');
  }

  /**
   * 3. Construye un plato 3D estilizado procedural con base cerámica PBR de alta calidad
   * (`MeshPhysicalMaterial` con `roughness: 0.18` y `clearcoat: 0.4`).
   */
  createProceduralDish(dish) {
    const group = new THREE.Group();
    group.name = `procedural-${dish.id}`;

    // Material PBR cerámico esmaltado de bajo costo y alto realismo
    const ceramicDarkMat = new THREE.MeshPhysicalMaterial({
      color: 0x1b2029,
      roughness: 0.18,
      metalness: 0.06,
      clearcoat: 0.4,
      clearcoatRoughness: 0.14,
      reflectivity: 0.7
    });

    const ceramicRimMat = new THREE.MeshPhysicalMaterial({
      color: 0x2e3646,
      roughness: 0.18,
      metalness: 0.1,
      clearcoat: 0.4,
      clearcoatRoughness: 0.12
    });

    const accentColor = new THREE.Color(dish.fallbackColor || '#e6b87d');
    const mainFoodMat = new THREE.MeshStandardMaterial({
      color: accentColor,
      roughness: 0.38,
      metalness: 0.04
    });

    // Base cerámica principal con esmalte PBR
    const plateBase = new THREE.Mesh(
      new THREE.CylinderGeometry(1.04, 0.82, 0.12, 48),
      ceramicDarkMat
    );
    plateBase.position.y = 0.06;
    group.add(plateBase);

    const plateRim = new THREE.Mesh(
      new THREE.TorusGeometry(0.96, 0.046, 18, 64),
      ceramicRimMat
    );
    plateRim.rotation.x = Math.PI / 2;
    plateRim.position.y = 0.12;
    group.add(plateRim);

    const type = dish.fallbackGeometry || 'gyozas';

    if (type === 'gyozas') {
      const toastedMat = new THREE.MeshStandardMaterial({
        color: 0xb86b28,
        roughness: 0.48
      });

      for (let i = 0; i < 5; i++) {
        const gyozaGroup = new THREE.Group();
        const body = new THREE.Mesh(
          new THREE.CapsuleGeometry(0.13, 0.26, 8, 16),
          mainFoodMat
        );
        body.rotation.z = Math.PI / 2;
        body.scale.set(1, 0.85, 0.72);

        const crest = new THREE.Mesh(
          new THREE.BoxGeometry(0.38, 0.04, 0.03),
          toastedMat
        );
        crest.position.y = 0.11;

        gyozaGroup.add(body, crest);

        const angle = -0.55 + i * 0.27;
        gyozaGroup.position.set(
          Math.sin(angle) * 0.42,
          0.22,
          Math.cos(angle) * 0.28 - 0.12
        );
        gyozaGroup.rotation.y = -angle * 0.6;
        group.add(gyozaGroup);
      }

      const sauceBowl = new THREE.Mesh(
        new THREE.CylinderGeometry(0.22, 0.16, 0.14, 24),
        ceramicRimMat
      );
      sauceBowl.position.set(0.45, 0.18, -0.35);
      const soyLiquid = new THREE.Mesh(
        new THREE.CylinderGeometry(0.19, 0.19, 0.02, 24),
        new THREE.MeshPhysicalMaterial({
          color: 0x2a1208,
          roughness: 0.1,
          clearcoat: 0.6
        })
      );
      soyLiquid.position.set(0.45, 0.24, -0.35);
      group.add(sauceBowl, soyLiquid);
    } else if (type === 'ramen') {
      const bowl = new THREE.Mesh(
        new THREE.CylinderGeometry(0.88, 0.52, 0.52, 40),
        new THREE.MeshPhysicalMaterial({
          color: 0x8f1d1d,
          roughness: 0.18,
          clearcoat: 0.4,
          clearcoatRoughness: 0.15
        })
      );
      bowl.position.y = 0.34;
      group.add(bowl);

      const broth = new THREE.Mesh(
        new THREE.CylinderGeometry(0.82, 0.82, 0.04, 40),
        new THREE.MeshPhysicalMaterial({
          color: accentColor,
          roughness: 0.16,
          clearcoat: 0.5
        })
      );
      broth.position.y = 0.56;
      group.add(broth);

      const eggWhite = new THREE.Mesh(
        new THREE.SphereGeometry(0.16, 20, 20),
        new THREE.MeshStandardMaterial({ color: 0xf7efe2, roughness: 0.32 })
      );
      eggWhite.scale.set(1, 0.65, 1.2);
      eggWhite.position.set(-0.28, 0.6, 0.15);

      const eggYolk = new THREE.Mesh(
        new THREE.SphereGeometry(0.09, 16, 16),
        new THREE.MeshPhysicalMaterial({ color: 0xff6f00, roughness: 0.15, clearcoat: 0.4 })
      );
      eggYolk.scale.set(1, 0.5, 1);
      eggYolk.position.set(-0.28, 0.66, 0.15);
      group.add(eggWhite, eggYolk);

      const naruto = new THREE.Mesh(
        new THREE.CylinderGeometry(0.15, 0.15, 0.04, 24),
        new THREE.MeshStandardMaterial({ color: 0xffd6e7, roughness: 0.4 })
      );
      naruto.position.set(0.24, 0.6, 0.22);

      const chashu = new THREE.Mesh(
        new THREE.CylinderGeometry(0.24, 0.24, 0.05, 24),
        new THREE.MeshStandardMaterial({ color: 0x9c4a2d, roughness: 0.52 })
      );
      chashu.position.set(0.18, 0.6, -0.2);
      group.add(naruto, chashu);

      const chopstickMat = new THREE.MeshStandardMaterial({ color: 0xd7a86e, roughness: 0.38 });
      for (let i = 0; i < 2; i++) {
        const stick = new THREE.Mesh(
          new THREE.CylinderGeometry(0.016, 0.026, 1.65, 12),
          chopstickMat
        );
        stick.rotation.z = Math.PI / 2;
        stick.rotation.y = 0.25 + i * 0.08;
        stick.position.set(0.1, 0.64, -0.45 + i * 0.1);
        group.add(stick);
      }
    } else if (type === 'torusKnot') {
      const knot = new THREE.Mesh(
        new THREE.TorusKnotGeometry(0.34, 0.11, 80, 16),
        new THREE.MeshPhysicalMaterial({
          color: accentColor,
          roughness: 0.24,
          clearcoat: 0.45
        })
      );
      knot.position.y = 0.42;
      knot.rotation.x = Math.PI / 2;
      group.add(knot);
    } else if (type === 'cylinder') {
      const mainCyl = new THREE.Mesh(
        new THREE.CylinderGeometry(0.45, 0.48, 0.36, 36),
        mainFoodMat
      );
      mainCyl.position.y = 0.3;
      const topGlaze = new THREE.Mesh(
        new THREE.CylinderGeometry(0.42, 0.44, 0.05, 36),
        new THREE.MeshPhysicalMaterial({
          color: accentColor.clone().offsetHSL(0, 0.1, 0.12),
          roughness: 0.15,
          clearcoat: 0.6
        })
      );
      topGlaze.position.y = 0.49;
      group.add(mainCyl, topGlaze);
    } else if (type === 'sphere') {
      const dome = new THREE.Mesh(
        new THREE.SphereGeometry(0.42, 36, 28),
        new THREE.MeshPhysicalMaterial({
          color: accentColor,
          roughness: 0.22,
          clearcoat: 0.4
        })
      );
      dome.scale.set(1, 0.78, 1);
      dome.position.y = 0.34;
      group.add(dome);
    } else {
      // Trío de Mochis artesanales (Fresa/Sakura, Matcha y Yuzu)
      const sakuraMochi = new THREE.Mesh(
        new THREE.SphereGeometry(0.28, 32, 24),
        mainFoodMat
      );
      sakuraMochi.scale.set(1, 0.68, 1);
      sakuraMochi.position.set(-0.34, 0.26, 0.14);

      const matchaMochi = new THREE.Mesh(
        new THREE.SphereGeometry(0.28, 32, 24),
        new THREE.MeshStandardMaterial({
          color: 0x76a04b,
          roughness: 0.46
        })
      );
      matchaMochi.scale.set(1, 0.68, 1);
      matchaMochi.position.set(0.32, 0.26, 0.12);

      const yuzuMochi = new THREE.Mesh(
        new THREE.SphereGeometry(0.27, 32, 24),
        new THREE.MeshStandardMaterial({
          color: 0xf6cf57,
          roughness: 0.44
        })
      );
      yuzuMochi.scale.set(1, 0.68, 1);
      yuzuMochi.position.set(0, 0.26, -0.28);

      const goldLeaf = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.05, 0),
        new THREE.MeshStandardMaterial({
          color: 0xffd700,
          metalness: 0.85,
          roughness: 0.15
        })
      );
      goldLeaf.position.set(-0.34, 0.47, 0.14);

      group.add(sakuraMochi, matchaMochi, yuzuMochi, goldLeaf);
    }

    return group;
  }

  /**
   * e) Configura los vectores destino para interpolar suavemente la cámara (lerp).
   */
  transitionCameraTo(cameraConfig) {
    if (!cameraConfig) return;

    const { position, target } = cameraConfig;
    if (position) {
      this.targetCameraPos.set(position.x, position.y, position.z);
    }
    if (target) {
      this.targetControlsLookAt.set(target.x, target.y, target.z);
    }
    this.isCameraTransitioning = true;
  }

  renderCategories() {
    const container = document.getElementById('category-tabs');
    const uniqueCategories = ['Todos', ...new Set(this.dishes.map((d) => d.category))];

    container.innerHTML = '';
    uniqueCategories.forEach((cat) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `category-tab ${cat === this.currentCategory ? 'active' : ''}`;
      btn.textContent = cat;
      btn.addEventListener('click', () => this.filterByCategory(cat));
      container.appendChild(btn);
    });
  }

  filterByCategory(category) {
    this.currentCategory = category;
    this.filteredDishes =
      category === 'Todos'
        ? [...this.dishes]
        : this.dishes.filter((d) => d.category === category);

    this.renderCategories();
    this.renderCarousel();

    if (this.filteredDishes.length > 0) {
      const stillVisible = this.filteredDishes.some(
        (d) => this.currentDish && d.id === this.currentDish.id
      );
      if (!stillVisible) {
        this.selectDish(this.filteredDishes[0].id);
      } else {
        this.highlightActiveCard(this.currentDish.id);
      }
    }
  }

  renderCarousel() {
    const carousel = document.getElementById('dishes-carousel');
    carousel.innerHTML = '';

    const svgIcons = {
      gyozas: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15c0-5.5 3.6-9 8-9s8 3.5 8 9H4z"/><path d="M2 18h20"/></svg>`,
      ramen: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11h16a1 1 0 0 1 1 1v.5a8.5 8.5 0 0 1-17 0V12a1 1 0 0 1 1-1Z"/><path d="M7 21h10"/><path d="M5 6h14"/></svg>`,
      mochi: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="14" r="4"/><circle cx="16" cy="14" r="4"/><circle cx="12" cy="8" r="3.5"/></svg>`,
      torusKnot: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/></svg>`,
      cylinder: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="7" rx="8" ry="3"/><path d="M4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7"/></svg>`,
      sphere: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4a8 8 0 0 0-8 8h16a8 8 0 0 0-8-8Z"/><path d="M3 15h18"/><path d="M8 19h8"/></svg>`
    };
    const defaultSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/></svg>`;

    this.filteredDishes.forEach((dish) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'carousel-card';
      card.dataset.id = dish.id;

      const iconSvg = svgIcons[dish.fallbackGeometry] || defaultSvg;
      const swatchColor = dish.fallbackColor || '#c5a059';

      card.innerHTML = `
        <div class="carousel-swatch" style="background: ${swatchColor}1f; color: ${swatchColor}">
          ${iconSvg}
        </div>
        <div class="carousel-info">
          <div class="carousel-title">${dish.nombre}</div>
          <div class="carousel-price">${this.formatGuaranies(dish.precio)}</div>
        </div>
      `;

      card.addEventListener('click', () => this.selectDish(dish.id));
      carousel.appendChild(card);
    });
  }

  highlightActiveCard(dishId) {
    const cards = document.querySelectorAll('.carousel-card');
    cards.forEach((card) => {
      card.classList.toggle('active', card.dataset.id === dishId);
    });
  }

  /**
   * Actualiza los textos del plato seleccionado, opciones interactivas, tabla nutricional y metadatos AR.
   */
  updateDishUI(dish) {
    document.getElementById('dish-category').textContent = dish.category;
    document.getElementById('dish-title').textContent = dish.nombre;
    document.getElementById('dish-description').textContent = dish.descripcion;

    // Renderizar selectores de variantes y calcular precio dinámico
    this.renderDishOptions(dish);
    this.updateDynamicPriceUI(dish);

    // Panel nutricional y dimensiones reales 1:1
    document.getElementById('nutrition-dish-title').textContent = dish.nombre;
    const nutri = dish.nutricion || {};
    document.getElementById('nutri-calorias').textContent = nutri.calorias || '—';
    document.getElementById('nutri-proteinas').textContent = nutri.proteinas || '—';
    document.getElementById('nutri-carbohidratos').textContent = nutri.carbohidratos || '—';
    document.getElementById('nutri-grasas').textContent = nutri.grasas || '—';

    const dims = dish.dimensiones_reales || `⌀ ${dish.diametro_cm || 24} cm · Altura ${dish.altura_cm || 6} cm`;
    const realDimsEl = document.getElementById('dish-real-dimensions');
    if (realDimsEl) realDimsEl.textContent = dims;

    // Modal AR
    const arTitle = document.getElementById('ar-dish-title');
    const arDims = document.getElementById('ar-dimensions-label');
    if (arTitle) arTitle.textContent = `${dish.nombre} (Escala 1:1)`;
    if (arDims) arDims.textContent = dims;

    // Alérgenos
    const allergensContainer = document.getElementById('allergens-list');
    allergensContainer.innerHTML = '';
    (dish.alergenos || []).forEach((alergeno) => {
      const span = document.createElement('span');
      span.className = 'allergen-pill';
      span.textContent = alergeno;
      allergensContainer.appendChild(span);
    });
  }

  /**
   * Añade el plato actual con sus opciones y extras seleccionados al carrito.
   */
  addConfiguredCurrentDishToCart() {
    if (!this.currentDish) return;

    const dish = this.currentDish;
    const {
      unitPrice,
      signature,
      resumenOpciones,
      opcionesDetalle,
      nombreCompleto
    } = this.getConfiguredDishSummary(dish);

    const cartKey = `${dish.id}::${signature}`;
    const existing = this.cart.get(cartKey);

    if (existing) {
      existing.cantidad += 1;
    } else {
      this.cart.set(cartKey, {
        cartKey,
        dishId: dish.id,
        nombreBase: dish.nombre,
        nombre: nombreCompleto,
        resumenOpciones,
        opcionesDetalle,
        precioUnitario: unitPrice,
        cantidad: 1
      });
    }

    this.saveCartToSession();
    this.renderCartState();
    this.showToast(`✓ ${nombreCompleto} añadido a tu comanda`);
  }

  /**
   * Modifica la cantidad de un ítem específico del carrito por su clave compuesta `cartKey`.
   */
  updateCartEntryByKey(cartKey, delta) {
    const existing = this.cart.get(cartKey);
    if (!existing) return;

    const nextQty = existing.cantidad + delta;
    if (nextQty <= 0) {
      this.cart.delete(cartKey);
    } else {
      existing.cantidad = nextQty;
    }

    this.saveCartToSession();
    this.renderCartState();
  }

  /**
   * Guarda el carrito actual (incluyendo opciones personalizadas) en sessionStorage.
   */
  saveCartToSession() {
    try {
      const serialized = Array.from(this.cart.values());
      sessionStorage.setItem(CART_SESSION_KEY, JSON.stringify(serialized));
    } catch (err) {
      console.warn('No se pudo guardar el carrito en sessionStorage:', err);
    }
  }

  /**
   * Restaura el carrito desde sessionStorage tras recargar la página.
   */
  restoreCartFromSession() {
    try {
      const raw = sessionStorage.getItem(CART_SESSION_KEY);
      if (!raw) return;
      const items = JSON.parse(raw);
      if (!Array.isArray(items)) return;

      this.cart.clear();
      items.forEach((entry) => {
        if (entry && entry.cartKey && entry.cantidad > 0) {
          this.cart.set(entry.cartKey, entry);
        } else if (entry && entry.dishId && entry.cantidad > 0) {
          const dish = this.dishes.find((d) => d.id === entry.dishId);
          if (dish) {
            const key = `${dish.id}::base`;
            this.cart.set(key, {
              cartKey: key,
              dishId: dish.id,
              nombreBase: dish.nombre,
              nombre: dish.nombre,
              resumenOpciones: '',
              opcionesDetalle: [],
              precioUnitario: dish.precio,
              cantidad: Number(entry.cantidad)
            });
          }
        }
      });
      this.renderCartState();
    } catch (err) {
      console.warn('No se pudo restaurar el carrito desde sessionStorage:', err);
    }
  }

  restoreLastOrderFromSession() {
    try {
      const savedOrderId = sessionStorage.getItem(LAST_ORDER_SESSION_KEY);
      if (!savedOrderId) return;
      this.lastOrderId = savedOrderId;

      const rawOrders = localStorage.getItem(STORAGE_KEY);
      if (!rawOrders) return;
      const orders = JSON.parse(rawOrders);
      const found = Array.isArray(orders) ? orders.find((o) => o.id === savedOrderId) : null;
      if (found) {
        this.renderLiveOrderStatus(found);
      }
    } catch (_) {}
  }

  getCartTotals() {
    let totalItems = 0;
    let totalAmount = 0;
    const itemsPayload = [];

    this.cart.forEach((entry) => {
      totalItems += entry.cantidad;
      const subtotal = Number((entry.precioUnitario * entry.cantidad).toFixed(2));
      totalAmount += subtotal;
      itemsPayload.push({
        id: entry.dishId,
        cartKey: entry.cartKey,
        nombreBase: entry.nombreBase,
        nombre: entry.nombre,
        resumenOpciones: entry.resumenOpciones || '',
        opcionesDetalle: entry.opcionesDetalle || [],
        precioUnitario: entry.precioUnitario,
        cantidad: entry.cantidad,
        subtotal
      });
    });

    return {
      totalItems,
      totalAmount: Number(totalAmount.toFixed(2)),
      itemsPayload
    };
  }

  renderCartState() {
    const { totalItems, totalAmount } = this.getCartTotals();
    document.getElementById('cart-count').textContent = String(totalItems);
    document.getElementById('order-total-amount').textContent = this.formatGuaranies(totalAmount);

    const listEl = document.getElementById('order-items-list');
    if (!listEl) return;

    listEl.innerHTML = '';
    if (this.cart.size === 0) {
      listEl.innerHTML = `
        <div class="order-empty-msg">
          Aún no has añadido platos a tu comanda.<br/>
          Personaliza tu plato y pulsa <strong>"+ Añadir a comanda"</strong>.
        </div>
      `;
      return;
    }

    this.cart.forEach((entry) => {
      const row = document.createElement('div');
      row.className = 'order-item-row';
      const optionsLine = entry.resumenOpciones
        ? `<span class="order-item-options">${entry.resumenOpciones}</span>`
        : '';

      row.innerHTML = `
        <div class="order-item-info">
          <span class="order-item-name">${entry.nombreBase || entry.nombre}</span>
          ${optionsLine}
          <span class="order-item-sub">${this.formatGuaranies(entry.precioUnitario)} × ${entry.cantidad} = ${this.formatGuaranies(entry.precioUnitario * entry.cantidad)}</span>
        </div>
        <div class="order-qty-controls">
          <button type="button" class="qty-btn" data-action="dec" aria-label="Restar unidad">−</button>
          <strong>${entry.cantidad}</strong>
          <button type="button" class="qty-btn" data-action="inc" aria-label="Sumar unidad">+</button>
        </div>
      `;

      row.querySelector('[data-action="dec"]').addEventListener('click', () => {
        this.updateCartEntryByKey(entry.cartKey, -1);
      });
      row.querySelector('[data-action="inc"]').addEventListener('click', () => {
        this.updateCartEntryByKey(entry.cartKey, 1);
      });

      listEl.appendChild(row);
    });
  }

  /**
   * Emite una comanda o llamado al mesero en tiempo real a través de BroadcastChannel,
   * persiste en localStorage para sincronización entre pestañas y despacha por WS si está activo.
   */
  dispatchRealtimeEvent(tipo = 'COMANDA') {
    const { itemsPayload, totalAmount } = this.getCartTotals();

    if (tipo === 'COMANDA' && itemsPayload.length === 0) {
      this.showToast('Añade al menos un plato antes de enviar la comanda');
      return;
    }

    const orderPayload = {
      id: `CMD-${Date.now().toString().slice(-6)}`,
      tenant: this.sessionContext.tenant,
      tipo,
      sector: this.sessionContext.sector,
      mesa: this.sessionContext.mesa,
      mesero_id: this.sessionContext.mesero_id,
      items:
        tipo === 'LLAMADO_MESERO' && itemsPayload.length === 0
          ? [
              {
                id: 'asistencia',
                nombreBase: 'Solicitud de atención en mesa',
                nombre: 'Solicitud de atención en mesa',
                resumenOpciones: '',
                opcionesDetalle: [],
                precioUnitario: 0,
                cantidad: 1,
                subtotal: 0
              }
            ]
          : itemsPayload,
      total: tipo === 'LLAMADO_MESERO' && itemsPayload.length === 0 ? 0 : totalAmount,
      timestamp: new Date().toISOString(),
      estado: 'Pendiente'
    };

    this.lastOrderId = orderPayload.id;
    try {
      sessionStorage.setItem(LAST_ORDER_SESSION_KEY, this.lastOrderId);
    } catch (_) {}

    const wsMessage = {
      type: 'NEW_ORDER',
      eventType: 'NUEVA_COMANDA',
      order: orderPayload
    };

    // 1. Enviar por WebSocket al servidor local Wi-Fi (con cola de respaldo si está reconectando)
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(wsMessage));
    } else {
      this.pendingWsQueue.push(wsMessage);
      this.connectWebSocket();
    }

    // 2. Respaldo automático en localStorage y BroadcastChannel
    try {
      const existingRaw = localStorage.getItem(STORAGE_KEY);
      const orders = existingRaw ? JSON.parse(existingRaw) : [];
      orders.unshift(orderPayload);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(orders.slice(0, 150)));
    } catch (err) {
      console.warn('No se pudo persistir en localStorage:', err);
    }

    this.comandaChannel.postMessage(wsMessage);

    this.renderLiveOrderStatus(orderPayload);

    if (tipo === 'COMANDA') {
      this.cart.clear();
      this.saveCartToSession();
      this.renderCartState();
      this.showToast(`Comanda enviada a ${orderPayload.mesero_id.toUpperCase()} (${orderPayload.sector} · Mesa ${orderPayload.mesa})`);
    } else {
      this.showToast(`Solicitud enviada a ${orderPayload.mesero_id.toUpperCase()} · ${orderPayload.sector} (Mesa ${orderPayload.mesa})`);
    }
  }

  renderLiveOrderStatus(order) {
    const statusBox = document.getElementById('live-order-status');
    if (!statusBox) return;

    statusBox.classList.remove('hidden');
    statusBox.innerHTML = `
      <div><strong>Último envío (${order.id}):</strong> Estado actual → <span>${order.estado}</span></div>
      <small>Sector: ${order.sector} · Mesa ${order.mesa} · Mesero: ${order.mesero_id}</small>
    `;
  }

  /**
   * Conecta los controles de UI: AR 1:1, Toggle "📏 Dimensiones", Nutrición, Carrito y Comanda.
   */
  bindUIEvents() {
    const nutritionPanel = document.getElementById('nutrition-panel');
    const arModal = document.getElementById('ar-modal');
    const orderModal = document.getElementById('order-modal');

    const closeAllModals = () => {
      nutritionPanel.classList.add('hidden');
      arModal.classList.add('hidden');
      orderModal.classList.add('hidden');
    };

    // Toggle "📏 Dimensiones" en el visor 3D
    const toggleDimsBtn = document.getElementById('toggle-dimensions-btn');
    if (toggleDimsBtn) {
      toggleDimsBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.showDimensionsGuide = !this.showDimensionsGuide;
        this.updateDimensionsGuide(this.currentDish);
      });
    }

    // Nutrición
    document.getElementById('toggle-nutrition-btn').addEventListener('click', () => {
      const wasHidden = nutritionPanel.classList.contains('hidden');
      closeAllModals();
      if (wasHidden) {
        nutritionPanel.classList.remove('hidden');
      }
    });

    document.getElementById('close-nutrition-btn').addEventListener('click', () => {
      nutritionPanel.classList.add('hidden');
    });

    // Vista AR Escala Real 1:1 -> Activa Modo Cámara Directa (AR Passthrough) exclusivamente
    const openArBtn = document.getElementById('open-ar-btn');
    if (openArBtn) {
      openArBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeAllModals();
        await this.startARPassthroughMode();
      });
    }

    const exitArBtn = document.getElementById('exit-ar-btn');
    if (exitArBtn) {
      exitArBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.stopARPassthroughMode();
      });
    }

    const secondaryNativeArBtn = document.getElementById('secondary-native-ar-btn');
    if (secondaryNativeArBtn) {
      secondaryNativeArBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const modelViewer = document.getElementById('ar-model-viewer');
        arModal.classList.remove('hidden');
        if (modelViewer && typeof modelViewer.activateAR === 'function') {
          try {
            modelViewer.activateAR();
          } catch (_) {}
        }
      });
    }

    document.getElementById('close-ar-btn').addEventListener('click', () => {
      arModal.classList.add('hidden');
    });

    document.getElementById('trigger-native-ar-btn').addEventListener('click', () => {
      const modelViewer = document.getElementById('ar-model-viewer');
      if (modelViewer && typeof modelViewer.activateAR === 'function') {
        try {
          modelViewer.activateAR();
        } catch (err) {
          arModal.classList.add('hidden');
          this.startARPassthroughMode();
        }
      } else {
        arModal.classList.add('hidden');
        this.startARPassthroughMode();
      }
    });

    // Añadir plato personalizado a la comanda
    document.getElementById('add-to-order-btn').addEventListener('click', () => {
      this.addConfiguredCurrentDishToCart();
    });

    // Abrir modal de comanda
    document.getElementById('cart-button').addEventListener('click', () => {
      const wasHidden = orderModal.classList.contains('hidden');
      closeAllModals();
      if (wasHidden) {
        this.renderCartState();
        orderModal.classList.remove('hidden');
      }
    });

    document.getElementById('close-order-btn').addEventListener('click', () => {
      orderModal.classList.add('hidden');
    });

    // Botones de Enviar Comanda y Llamar Mesero
    document.getElementById('send-comanda-btn').addEventListener('click', () => {
      this.dispatchRealtimeEvent('COMANDA');
    });

    document.getElementById('call-waiter-btn').addEventListener('click', () => {
      this.dispatchRealtimeEvent('LLAMADO_MESERO');
    });

    document.getElementById('modal-call-waiter-btn').addEventListener('click', () => {
      this.dispatchRealtimeEvent('LLAMADO_MESERO');
    });
  }

  setLoading(isLoading, message = 'Cargando...') {
    if (this.loadingText) {
      this.loadingText.textContent = message;
    }
    this.loadingOverlay.classList.toggle('hidden', !isLoading);
  }

  showToast(message) {
    const toast = document.getElementById('toast-notification');
    toast.textContent = message;
    toast.classList.remove('hidden');

    clearTimeout(this.toastTimeout);
    this.toastTimeout = setTimeout(() => {
      toast.classList.add('hidden');
    }, 2800);
  }

  onWindowResize() {
    const width = (this.container && this.container.clientWidth) || window.innerWidth;
    const height = (this.container && this.container.clientHeight) || Math.round(window.innerHeight * 0.58);
    if (!width || !height) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  }

  /**
   * Bucle principal de renderizado:
   * - Interpola la cámara (lerp) al cambiar de plato.
   * - Pausa suavemente la rotación automática cuando el usuario interactúa
   *   y la reanuda progresivamente tras 3 segundos (3000 ms) de inactividad.
   */
  animate() {
    requestAnimationFrame(() => this.animate());

    const delta = Math.min(this.clock.getDelta(), 0.1);
    const now = performance.now();

    if (this.isCameraTransitioning) {
      const lerpFactor = 1 - Math.exp(-5.5 * delta);
      this.camera.position.lerp(this.targetCameraPos, lerpFactor);
      this.controls.target.lerp(this.targetControlsLookAt, lerpFactor);

      if (
        this.camera.position.distanceTo(this.targetCameraPos) < 0.01 &&
        this.controls.target.distanceTo(this.targetControlsLookAt) < 0.01
      ) {
        this.isCameraTransitioning = false;
      }
    }

    // Pausa suave al interactuar y reanudación tras 3 segundos de inactividad
    const timeSinceInteraction = now - this.lastInteractionTime;
    const shouldPauseRotation =
      this.isUserInteracting ||
      this.isCameraTransitioning ||
      (this.lastInteractionTime > 0 && timeSinceInteraction < 3000);

    const targetSpeed = shouldPauseRotation ? 0 : this.baseRotationSpeed;
    this.currentRotationSpeed = THREE.MathUtils.lerp(
      this.currentRotationSpeed,
      targetSpeed,
      1 - Math.exp(-4.5 * delta)
    );

    if (this.currentModel && this.currentRotationSpeed > 0.001) {
      this.currentModel.rotation.y += delta * this.currentRotationSpeed;
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.menu3DApp = new Menu3DApp();
});
