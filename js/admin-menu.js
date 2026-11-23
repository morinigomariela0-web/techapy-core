const COMMON_ALLERGENS = [
  'Gluten',
  'Soja',
  'Sésamo',
  'Huevo',
  'Lácteos',
  'Pescado',
  'Crustáceos',
  'Frutos secos',
  'Cacahuetes',
  'Moluscos'
];

const GEO_ICONS = {
  gyozas: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15c0-5.5 3.6-9 8-9s8 3.5 8 9H4z"/><path d="M2 18h20"/></svg>`,
  ramen: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11h16a1 1 0 0 1 1 1v.5a8.5 8.5 0 0 1-17 0V12a1 1 0 0 1 1-1Z"/><path d="M7 21h10"/><path d="M5 6h14"/></svg>`,
  mochi: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="14" r="4"/><circle cx="16" cy="14" r="4"/><circle cx="12" cy="8" r="3.5"/></svg>`,
  torusKnot: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/></svg>`,
  cylinder: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="7" rx="8" ry="3"/><path d="M4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7"/></svg>`,
  sphere: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4a8 8 0 0 0-8 8h16a8 8 0 0 0-8-8Z"/><path d="M3 15h18"/><path d="M8 19h8"/></svg>`
};
const DEFAULT_GEO_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/></svg>`;

/**
 * Controlador de la Interfaz Administrativa de Gestión de Carta (`admin-menu.html`).
 * - Consume `GET /api/menu` y `POST /api/menu` (creando backup automático en `data/menu-data.backup.json`).
 * - Sube archivos binarios `.glb` directamente a `assets/models/` mediante `POST /api/upload-model`.
 * - Permite crear, editar y eliminar platos con sus alérgenos, tabla nutricional,
 *   cotas 3D / escala AR 1:1 y grupos dinámicos de variantes y extras.
 */
class AdminMenuManager {
  constructor() {
    const params = new URLSearchParams(window.location.search);
    this.tenant = (params.get('tenant') || 'demo').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'demo';

    this.menuData = {
      restaurante: {
        tenant: this.tenant,
        nombre: 'TechaPY · Casa de Autor',
        monedaSimbolo: 'Gs.',
        sectores: ['Terraza', 'Salón Principal', 'Barra', 'Patio']
      },
      platos: []
    };

    this.hasUnsavedChanges = false;
    this.editingDishIndex = -1; // -1 = Nuevo plato, >= 0 = Editando existente
    this.activeAllergens = new Set();
    this.draftOptionGroups = [];

    this.catalogContainer = document.getElementById('categories-catalog-container');
    this.modal = document.getElementById('dish-editor-modal');
    this.form = document.getElementById('dish-editor-form');
    this.unsavedIndicator = document.getElementById('unsaved-indicator');
    this.tenantInput = document.getElementById('global-tenant-id');
    if (this.tenantInput) {
      this.tenantInput.value = this.tenant;
    }

    this.bindEvents();
    this.loadMenuFromServer();
  }

  formatGuaranies(amount) {
    const num = Math.round(Number(amount) || 0);
    return `Gs. ${num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
  }

  getActiveTenant() {
    const raw = this.tenantInput ? this.tenantInput.value : this.tenant;
    return String(raw || 'demo').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'demo';
  }

  /**
   * Carga la carta actual desde `GET /api/:tenant/menu` (o `./data/menu-data.json` como respaldo).
   */
  async loadMenuFromServer() {
    this.tenant = this.getActiveTenant();
    try {
      let res = await fetch(`./api/${encodeURIComponent(this.tenant)}/menu`, {
        cache: 'no-store'
      }).catch(() => null);
      if (!res || !res.ok) {
        res = await fetch('./data/menu-data.json', { cache: 'no-store' });
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      this.menuData = data;

      const restNameInput = document.getElementById('global-restaurant-name');
      if (restNameInput && data.restaurante && data.restaurante.nombre) {
        restNameInput.value = data.restaurante.nombre;
      }

      this.setUnsavedState(false);
      this.renderCatalogByCategories();
      this.checkSubscriptionExpirationWarning(this.tenant);
    } catch (err) {
      console.error('Error cargando carta:', err);
      this.showToast('Error al cargar data/menu-data.json', true);
    }
  }

  /**
   * Consulta `/api/:tenant/config` y muestra un banner de alerta en el panel de Admin
   * si faltan entre 0 y 7 días para el vencimiento de la cuota mensual (o si está vencida).
   */
  async checkSubscriptionExpirationWarning(tenant) {
    try {
      const res = await fetch(`./api/${encodeURIComponent(tenant)}/config`, { cache: 'no-store' });
      if (!res.ok) return;
      const cfg = await res.json();
      const existingBanner = document.getElementById('subscription-expiry-banner');
      if (existingBanner) existingBanner.remove();

      if (!cfg || typeof cfg.diasRestantes !== 'number') return;

      const days = cfg.diasRestantes;
      if (days > 7) return;

      const expDate = cfg.fechaVencimiento ? new Date(cfg.fechaVencimiento) : null;
      const dateStr =
        expDate && !Number.isNaN(expDate.getTime())
          ? `${String(expDate.getDate()).padStart(2, '0')}/${String(expDate.getMonth() + 1).padStart(2, '0')}/${expDate.getFullYear()}`
          : '';

      const isExpired = days < 0;
      const statusText = isExpired
        ? `Tu cuota mensual venció hace ${Math.abs(days)} día(s) (${dateStr}).`
        : days === 0
        ? `Tu cuota mensual de TechaPY vence HOY (${dateStr}).`
        : `Tu cuota mensual de TechaPY vence en ${days} día(s) (${dateStr}).`;

      const salesWa = String(cfg.salesWhatsapp || '595972736447').replace(/[^0-9]/g, '') || '595972736447';
      const waMsg = encodeURIComponent(
        `Hola TechaPY, deseo regularizar/renovar la cuota mensual del local "${cfg.nombre || tenant}" (Tenant: ${tenant}).`
      );

      const banner = document.createElement('div');
      banner.id = 'subscription-expiry-banner';
      banner.style.cssText =
        'background:rgba(180,83,9,0.24);border:1px solid rgba(251,191,36,0.55);color:#fde68a;padding:13px 18px;border-radius:12px;margin-bottom:18px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;font-size:0.84rem;';
      banner.innerHTML = `
        <div>
          <strong>⚠️ Aviso de Vencimiento de Suscripción:</strong> ${statusText}
          <span style="color:#f4f4f6;">Regulariza tu abono para mantener activo el visor 3D/AR y las comandas en salón.</span>
        </div>
        <a href="https://wa.me/${salesWa}?text=${waMsg}" target="_blank" rel="noopener" style="background:#c5a059;color:#0e1013;text-decoration:none;font-weight:700;padding:8px 14px;border-radius:8px;white-space:nowrap;">
          Regularizar Cuota por WhatsApp
        </a>
      `;

      const container =
        document.querySelector('.admin-menu-layout') ||
        document.querySelector('.admin-container');
      const header =
        document.querySelector('.admin-topbar') ||
        document.querySelector('.admin-header');
      if (container && header && header.nextSibling) {
        container.insertBefore(banner, header.nextSibling);
      } else if (container) {
        container.prepend(banner);
      }
    } catch (_) {}
  }

  /**
   * Envía la carta completa actualizada a `POST /api/:tenant/menu`.
   */
  async saveMenuToServer() {
    this.tenant = this.getActiveTenant();
    const restNameInput = document.getElementById('global-restaurant-name');
    if (!this.menuData.restaurante) {
      this.menuData.restaurante = { tenant: this.tenant, nombre: 'TechaPY · Casa de Autor', monedaSimbolo: 'Gs.' };
    }
    this.menuData.restaurante.tenant = this.tenant;
    if (restNameInput) {
      this.menuData.restaurante.nombre = restNameInput.value.trim() || 'TechaPY · Casa de Autor';
    }

    try {
      const response = await fetch(`./api/${encodeURIComponent(this.tenant)}/menu`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.menuData)
      });

      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) {
        throw new Error(result.error || `HTTP ${response.status}`);
      }

      this.setUnsavedState(false);
      this.showToast(
        `Carta guardada (${result.platosCount} platos). Backup creado en ${result.backupPath}`
      );
    } catch (err) {
      console.error('Error guardando carta en /api/menu:', err);
      this.showToast(`Error al guardar en servidor: ${err.message}`, true);
    }
  }

  setUnsavedState(unsaved) {
    this.hasUnsavedChanges = unsaved;
    if (this.unsavedIndicator) {
      this.unsavedIndicator.classList.toggle('hidden', !unsaved);
    }
  }

  /**
   * Renderiza la lista visual de platos agrupados por categoría.
   */
  renderCatalogByCategories() {
    this.catalogContainer.innerHTML = '';
    const dishes = this.menuData.platos || [];

    if (dishes.length === 0) {
      this.catalogContainer.innerHTML = `
        <div class="category-section">
          <p>No hay platos en la carta todavía. Pulsa <strong>"＋ Nuevo Plato"</strong> para crear el primero.</p>
        </div>
      `;
      return;
    }

    const categoriesMap = new Map();
    dishes.forEach((dish, index) => {
      const cat = dish.category || 'General';
      if (!categoriesMap.has(cat)) {
        categoriesMap.set(cat, []);
      }
      categoriesMap.get(cat).push({ dish, index });
    });

    categoriesMap.forEach((items, categoryName) => {
      const section = document.createElement('section');
      section.className = 'category-section';

      section.innerHTML = `
        <div class="category-section-header">
          <h2>
            <span>${this.escapeHtml(categoryName)}</span>
            <span class="category-count-pill">${items.length} plato(s)</span>
          </h2>
        </div>
        <div class="dishes-cards-grid"></div>
      `;

      const grid = section.querySelector('.dishes-cards-grid');

      items.forEach(({ dish, index }) => {
        const card = document.createElement('article');
        card.className = 'admin-dish-card';

        const icon = GEO_ICONS[dish.fallbackGeometry] || DEFAULT_GEO_ICON;
        const color = dish.fallbackColor || '#c5a059';
        const dims =
          dish.dimensiones_reales ||
          `⌀ ${dish.diametro_cm || 24} cm · Altura ${dish.altura_cm || 6} cm`;
        const optionGroupsCount = Array.isArray(dish.opciones) ? dish.opciones.length : 0;

        card.innerHTML = `
          <div>
            <div class="dish-card-top">
              <div class="dish-swatch-row">
                <div class="dish-color-swatch" style="background: ${color}25; color: ${color}">
                  ${icon}
                </div>
                <div>
                  <h3 class="dish-card-title">${this.escapeHtml(dish.nombre)}</h3>
                  <span class="dish-card-id">ID: ${this.escapeHtml(dish.id)}</span>
                </div>
              </div>
              <span class="dish-card-price">${this.formatGuaranies(dish.precio)}</span>
            </div>

            <p class="dish-card-desc" style="margin-top: 10px;">
              ${this.escapeHtml(dish.descripcion || '')}
            </p>
          </div>

          <div>
            <div class="dish-card-badges" style="margin-bottom: 10px;">
              <span class="meta-pill ar">${this.escapeHtml(dims)}</span>
              <span class="meta-pill variants">${optionGroupsCount} grupo(s) de opciones</span>
              <span class="meta-pill">${this.escapeHtml(
                dish.ruta_modelo_glb || dish.fallbackGeometry || 'procedural'
              )}</span>
            </div>

            <div class="dish-card-actions">
              <button type="button" class="btn-card-edit" data-action="edit">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
                <span>Editar</span>
              </button>
              <button type="button" class="btn-card-delete" data-action="delete">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                <span>Eliminar</span>
              </button>
            </div>
          </div>
        `;

        card.querySelector('[data-action="edit"]').addEventListener('click', () => {
          this.openDishEditor(index);
        });

        card.querySelector('[data-action="delete"]').addEventListener('click', () => {
          this.deleteDish(index);
        });

        grid.appendChild(card);
      });

      this.catalogContainer.appendChild(section);
    });
  }

  /**
   * Elimina un plato del catálogo con confirmación y guarda en el servidor.
   */
  async deleteDish(index) {
    const dish = this.menuData.platos[index];
    if (!dish) return;

    const confirmed = window.confirm(
      `¿Confirmas eliminar el plato "${dish.nombre}" de la carta?`
    );
    if (!confirmed) return;

    this.menuData.platos.splice(index, 1);
    this.setUnsavedState(true);
    this.renderCatalogByCategories();
    await this.saveMenuToServer();
  }

  /**
   * Abre el modal de edición para un plato existente (`index >= 0`) o nuevo (`index = -1`).
   */
  openDishEditor(index = -1) {
    this.editingDishIndex = index;
    const isNew = index === -1;

    const defaultDish = {
      id: '',
      category: 'Principales',
      nombre: '',
      precio: 12.5,
      moneda: 'EUR',
      descripcion: '',
      alergenos: ['Gluten', 'Soja'],
      nutricion: {
        calorias: '420 kcal',
        proteinas: '18 g',
        carbohidratos: '45 g',
        grasas: '14 g'
      },
      opciones: [],
      ruta_modelo_glb: '',
      escala: 1.0,
      escala_ar_metros: 0.12,
      diametro_cm: 24,
      altura_cm: 7,
      dimensiones_reales: '⌀ 24 cm · Altura 7 cm',
      fallbackGeometry: 'torusKnot',
      fallbackColor: '#ff7a3d',
      cameraConfig: {
        position: { x: 0, y: 2.1, z: 3.2 },
        target: { x: 0, y: 0.2, z: 0 }
      }
    };

    const dish = isNew
      ? defaultDish
      : JSON.parse(JSON.stringify(this.menuData.platos[index]));

    document.getElementById('editor-modal-title').textContent = isNew
      ? 'Crear Nuevo Plato 3D'
      : `Editar: ${dish.nombre}`;

    document.getElementById('field-nombre').value = dish.nombre || '';
    document.getElementById('field-categoria').value = dish.category || 'Principales';
    document.getElementById('field-precio').value = Number(dish.precio || 0).toFixed(2);
    document.getElementById('field-moneda').value = dish.moneda || 'EUR';
    document.getElementById('field-descripcion').value = dish.descripcion || '';

    // Nutrición
    const nutri = dish.nutricion || {};
    document.getElementById('field-calorias').value = nutri.calorias || '';
    document.getElementById('field-proteinas').value = nutri.proteinas || '';
    document.getElementById('field-carbohidratos').value = nutri.carbohidratos || '';
    document.getElementById('field-grasas').value = nutri.grasas || '';

    // Dimensiones y modelo 3D
    document.getElementById('field-diametro').value = dish.diametro_cm || 24;
    document.getElementById('field-altura').value = dish.altura_cm || 6;
    document.getElementById('field-fallback-geo').value = dish.fallbackGeometry || 'torusKnot';
    const colorHex = dish.fallbackColor || '#e6b87d';
    document.getElementById('field-fallback-color').value = colorHex;
    document.getElementById('field-fallback-color-hex').value = colorHex;
    document.getElementById('field-ruta-glb').value = dish.ruta_modelo_glb || '';
    document.getElementById('glb-upload-status').innerHTML =
      'Guarda directamente en <code>assets/models/</code>';

    // Alérgenos
    this.activeAllergens = new Set(dish.alergenos || []);
    this.renderAllergenChips();

    // Grupos de variantes y extras
    this.draftOptionGroups = Array.isArray(dish.opciones)
      ? JSON.parse(JSON.stringify(dish.opciones))
      : [];
    this.renderOptionGroupsEditor();

    this.modal.classList.remove('hidden');
    this.modal.setAttribute('aria-hidden', 'false');
  }

  closeDishEditor() {
    this.modal.classList.add('hidden');
    this.modal.setAttribute('aria-hidden', 'true');
  }

  /**
   * Renderiza los chips interactivos de alérgenos.
   */
  renderAllergenChips() {
    const container = document.getElementById('allergens-chips-box');
    container.innerHTML = '';

    const allTags = new Set([...COMMON_ALLERGENS, ...this.activeAllergens]);
    allTags.forEach((allergen) => {
      const isSelected = this.activeAllergens.has(allergen);
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `allergen-chip ${isSelected ? 'active' : ''}`;
      chip.textContent = `${isSelected ? '✓ ' : ''}${allergen}`;

      chip.addEventListener('click', () => {
        if (this.activeAllergens.has(allergen)) {
          this.activeAllergens.delete(allergen);
        } else {
          this.activeAllergens.add(allergen);
        }
        this.renderAllergenChips();
      });

      container.appendChild(chip);
    });
  }

  /**
   * Renderiza el editor dinámico de grupos de opciones (radio / checkbox / multiselect) y sus valores.
   */
  renderOptionGroupsEditor() {
    const container = document.getElementById('option-groups-editor');
    container.innerHTML = '';

    if (this.draftOptionGroups.length === 0) {
      container.innerHTML = `
        <p class="hint-text">Sin variantes adicionales. Pulsa <strong>"+ Añadir Grupo de Opciones"</strong> para agregar punto de cocción, picante, salsas o extras.</p>
      `;
      return;
    }

    this.draftOptionGroups.forEach((group, gIdx) => {
      const card = document.createElement('div');
      card.className = 'option-group-card';

      card.innerHTML = `
        <div class="option-group-top">
          <div class="field-col">
            <label>Nombre del Grupo (Ej. Nivel de picante, Extras)</label>
            <input type="text" data-gfield="nombre" value="${this.escapeHtml(group.nombre || '')}" placeholder="Ej. Extras" />
          </div>
          <div class="field-col">
            <label>Tipo de Selector</label>
            <select data-gfield="tipo">
              <option value="radio" ${group.tipo === 'radio' ? 'selected' : ''}>Selección única (Radio)</option>
              <option value="checkbox" ${group.tipo === 'checkbox' ? 'selected' : ''}>Extras múltiples (Checkbox)</option>
              <option value="multiselect" ${group.tipo === 'multiselect' ? 'selected' : ''}>Multiselección limitada (3 sabores)</option>
            </select>
          </div>
          <button type="button" class="btn-remove-sm" data-action="remove-group">Eliminar Grupo</button>
        </div>

        <div class="option-values-list"></div>

        <div>
          <button type="button" class="btn-secondary-sm" data-action="add-value">+ Añadir Opción / Extra</button>
        </div>
      `;

      const nameInput = card.querySelector('[data-gfield="nombre"]');
      const typeSelect = card.querySelector('[data-gfield="tipo"]');

      nameInput.addEventListener('input', (e) => {
        group.nombre = e.target.value;
        group.id = this.slugify(group.nombre || `grupo-${gIdx + 1}`);
      });

      typeSelect.addEventListener('change', (e) => {
        group.tipo = e.target.value;
        group.obligatorio = group.tipo !== 'checkbox';
        if (group.tipo === 'multiselect') {
          group.maxSeleccion = 3;
        }
      });

      card.querySelector('[data-action="remove-group"]').addEventListener('click', () => {
        this.draftOptionGroups.splice(gIdx, 1);
        this.renderOptionGroupsEditor();
      });

      card.querySelector('[data-action="add-value"]').addEventListener('click', () => {
        if (!Array.isArray(group.valores)) group.valores = [];
        group.valores.push({
          id: `op-${Date.now().toString().slice(-4)}`,
          etiqueta: 'Nueva opción',
          precioExtra: 0,
          porDefecto: group.valores.length === 0 && group.tipo === 'radio'
        });
        this.renderOptionGroupsEditor();
      });

      const valuesList = card.querySelector('.option-values-list');
      (group.valores || []).forEach((val, vIdx) => {
        const row = document.createElement('div');
        row.className = 'option-value-row';
        row.innerHTML = `
          <input type="text" data-vfield="etiqueta" value="${this.escapeHtml(val.etiqueta || '')}" placeholder="Etiqueta (ej. Huevo extra)" />
          <input type="number" step="0.10" min="0" data-vfield="precioExtra" value="${Number(val.precioExtra || 0).toFixed(2)}" title="Suplemento de precio (+€)" />
          <label class="default-check-label">
            <input type="checkbox" data-vfield="porDefecto" ${val.porDefecto ? 'checked' : ''} />
            Por defecto
          </label>
          <button type="button" class="btn-remove-sm" title="Quitar opción">✕</button>
        `;

        row.querySelector('[data-vfield="etiqueta"]').addEventListener('input', (e) => {
          val.etiqueta = e.target.value;
          val.id = this.slugify(val.etiqueta || `val-${vIdx + 1}`);
        });

        row.querySelector('[data-vfield="precioExtra"]').addEventListener('input', (e) => {
          val.precioExtra = Math.max(0, parseFloat(e.target.value) || 0);
        });

        row.querySelector('[data-vfield="porDefecto"]').addEventListener('change', (e) => {
          if (group.tipo === 'radio' && e.target.checked) {
            group.valores.forEach((other) => {
              other.porDefecto = false;
            });
          }
          val.porDefecto = e.target.checked;
          if (group.tipo === 'radio') {
            this.renderOptionGroupsEditor();
          }
        });

        row.querySelector('.btn-remove-sm').addEventListener('click', () => {
          group.valores.splice(vIdx, 1);
          this.renderOptionGroupsEditor();
        });

        valuesList.appendChild(row);
      });

      container.appendChild(card);
    });
  }

  /**
   * Sube un archivo binario `.glb` seleccionado del equipo hacia `POST /api/upload-model`.
   */
  async handleGlbFileUpload(file) {
    if (!file) return;
    const statusEl = document.getElementById('glb-upload-status');
    statusEl.textContent = `Subiendo ${file.name}...`;

    try {
      const dataBase64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('No se pudo leer el archivo .glb'));
        reader.readAsDataURL(file);
      });

      const tenant = this.getActiveTenant();
      const response = await fetch(`./api/${encodeURIComponent(tenant)}/upload-model`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: file.name,
          dataBase64
        })
      });

      const result = await response.json();
      if (!response.ok || !result.ok) {
        throw new Error(result.error || `HTTP ${response.status}`);
      }

      document.getElementById('field-ruta-glb').value = result.path;
      statusEl.innerHTML = `Subido: <code>${result.path}</code> (${(result.sizeBytes / 1024).toFixed(1)} KB)`;
      this.showToast(`Modelo 3D guardado en ${result.path}`);
    } catch (err) {
      statusEl.textContent = `Error al subir: ${err.message}`;
      this.showToast(`Error subiendo modelo .glb: ${err.message}`, true);
    }
  }

  /**
   * Procesa el formulario del modal, actualiza `this.menuData.platos` y persiste en `/api/menu`.
   */
  async handleFormSubmit(event) {
    event.preventDefault();

    const nombre = document.getElementById('field-nombre').value.trim();
    const category = document.getElementById('field-categoria').value.trim() || 'Principales';
    const precio = Math.max(0, parseFloat(document.getElementById('field-precio').value) || 0);
    const moneda = document.getElementById('field-moneda').value || 'EUR';
    const descripcion = document.getElementById('field-descripcion').value.trim();

    const diametroCm = Math.max(5, parseInt(document.getElementById('field-diametro').value, 10) || 24);
    const alturaCm = Math.max(1, parseInt(document.getElementById('field-altura').value, 10) || 6);
    const fallbackGeometry = document.getElementById('field-fallback-geo').value || 'torusKnot';
    const fallbackColor = document.getElementById('field-fallback-color-hex').value.trim() || '#e6b87d';
    const rutaModeloGlb =
      document.getElementById('field-ruta-glb').value.trim() ||
      `./assets/models/${this.slugify(nombre)}.glb`;

    const existingDish =
      this.editingDishIndex >= 0 ? this.menuData.platos[this.editingDishIndex] : null;

    const dishId =
      existingDish && existingDish.id
        ? existingDish.id
        : this.slugify(nombre || `plato-${Date.now()}`);

    const updatedDish = {
      id: dishId,
      category,
      nombre,
      precio: Number(precio.toFixed(2)),
      moneda,
      descripcion,
      alergenos: Array.from(this.activeAllergens),
      nutricion: {
        calorias: document.getElementById('field-calorias').value.trim() || '—',
        proteinas: document.getElementById('field-proteinas').value.trim() || '—',
        carbohidratos: document.getElementById('field-carbohidratos').value.trim() || '—',
        grasas: document.getElementById('field-grasas').value.trim() || '—'
      },
      opciones: this.draftOptionGroups.filter(
        (g) => g.nombre && Array.isArray(g.valores) && g.valores.length > 0
      ),
      ruta_modelo_glb: rutaModeloGlb,
      escala: existingDish && existingDish.escala ? existingDish.escala : 1.0,
      escala_ar_metros: Number((diametroCm / 200).toFixed(3)),
      diametro_cm: diametroCm,
      altura_cm: alturaCm,
      dimensiones_reales: `⌀ ${diametroCm} cm · Altura ${alturaCm} cm`,
      fallbackGeometry,
      fallbackColor,
      cameraConfig:
        existingDish && existingDish.cameraConfig
          ? existingDish.cameraConfig
          : {
              position: { x: 0, y: 2.1, z: 3.2 },
              target: { x: 0, y: 0.2, z: 0 }
            }
    };

    if (this.editingDishIndex >= 0) {
      this.menuData.platos[this.editingDishIndex] = updatedDish;
    } else {
      this.menuData.platos.push(updatedDish);
    }

    this.closeDishEditor();
    this.setUnsavedState(true);
    this.renderCatalogByCategories();
    await this.saveMenuToServer();
  }

  bindEvents() {
    document.getElementById('new-dish-btn').addEventListener('click', () => {
      this.openDishEditor(-1);
    });

    document.getElementById('save-menu-server-btn').addEventListener('click', () => {
      this.saveMenuToServer();
    });

    if (this.tenantInput) {
      this.tenantInput.addEventListener('change', () => {
        this.loadMenuFromServer();
      });
    }

    document.getElementById('global-restaurant-name').addEventListener('input', () => {
      this.setUnsavedState(true);
    });

    document.getElementById('close-editor-x').addEventListener('click', () => {
      this.closeDishEditor();
    });

    document.getElementById('cancel-editor-btn').addEventListener('click', () => {
      this.closeDishEditor();
    });

    // Sincronizar selector de color visual y campo hexadecimal
    const colorPicker = document.getElementById('field-fallback-color');
    const colorHex = document.getElementById('field-fallback-color-hex');

    colorPicker.addEventListener('input', (e) => {
      colorHex.value = e.target.value;
    });

    colorHex.addEventListener('input', (e) => {
      if (/^#[0-9a-fA-F]{6}$/.test(e.target.value.trim())) {
        colorPicker.value = e.target.value.trim();
      }
    });

    // Añadir alérgeno personalizado
    const customAllergenInput = document.getElementById('custom-allergen-input');
    document.getElementById('add-custom-allergen-btn').addEventListener('click', () => {
      const val = customAllergenInput.value.trim();
      if (!val) return;
      this.activeAllergens.add(val);
      customAllergenInput.value = '';
      this.renderAllergenChips();
    });

    // Subida de archivo .glb
    document.getElementById('glb-file-input').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) {
        this.handleGlbFileUpload(file);
      }
    });

    // Añadir grupo de opciones
    document.getElementById('add-option-group-btn').addEventListener('click', () => {
      this.draftOptionGroups.push({
        id: `grupo-${Date.now().toString().slice(-4)}`,
        nombre: 'Nuevo Grupo de Opciones',
        tipo: 'radio',
        obligatorio: true,
        valores: [
          { id: 'estandar', etiqueta: 'Estándar', precioExtra: 0, porDefecto: true },
          { id: 'especial', etiqueta: 'Especial', precioExtra: 1.0, porDefecto: false }
        ]
      });
      this.renderOptionGroupsEditor();
    });

    this.form.addEventListener('submit', (e) => this.handleFormSubmit(e));
  }

  slugify(text) {
    return String(text || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'item';
  }

  showToast(message, isError = false) {
    const toast = document.getElementById('admin-toast');
    toast.textContent = message;
    toast.classList.toggle('error', isError);
    toast.classList.remove('hidden');

    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      toast.classList.add('hidden');
    }, 3400);
  }

  escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}

const bootAdminMenu = () => {
  if (!window.adminMenuManager) {
    window.adminMenuManager = new AdminMenuManager();
  }
};

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', bootAdminMenu, { once: true });
} else {
  bootAdminMenu();
}
