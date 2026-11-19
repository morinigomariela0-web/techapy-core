/**
 * Controlador del Panel Central SuperAdmin (superadmin.html) — TechaPY SaaS Multi-Tenant.
 * - Lista todos los restaurantes instalados (GET /api/superadmin/tenants).
 * - Aprovisiona nuevos tenants atómicamente (POST /api/superadmin/tenants).
 * - Edita configuración, sectores, PINs de seguridad y estado Activo/Suspendido (PUT /api/superadmin/tenants/:tenant).
 * - Genera y descarga el paquete masivo de placas QR listas para imprimir por restaurante.
 */

class SuperAdminController {
  constructor() {
    this.tenants = [];
    this.editingTenantSlug = null;

    this.tbody = document.getElementById('sa-tenants-tbody');
    this.searchInput = document.getElementById('sa-search-input');
    this.statusFilter = document.getElementById('sa-status-filter');
    this.modal = document.getElementById('sa-tenant-modal');
    this.form = document.getElementById('sa-tenant-form');
    this.sectorsListEl = document.getElementById('sa-modal-sectors-list');

    this.bindEvents();
    this.fetchTenants();
  }

  bindEvents() {
    document.getElementById('sa-new-tenant-btn').addEventListener('click', () => {
      this.openModalForNew();
    });

    document.getElementById('sa-close-modal-btn').addEventListener('click', () => {
      this.closeModal();
    });

    document.getElementById('sa-cancel-modal-btn').addEventListener('click', () => {
      this.closeModal();
    });

    document.getElementById('sa-refresh-btn').addEventListener('click', () => {
      this.fetchTenants();
    });

    document.getElementById('sa-logout-btn').addEventListener('click', async () => {
      try {
        await fetch('./api/auth/logout?role=superadmin', { method: 'POST' });
      } catch (_) {}
      window.location.reload();
    });

    this.searchInput.addEventListener('input', () => this.renderTable());
    this.statusFilter.addEventListener('change', () => this.renderTable());

    // Autocompletar slug al escribir el nombre del local (solo en modo creación)
    const nameInput = document.getElementById('f-tenant-nombre');
    const slugInput = document.getElementById('f-tenant-slug');
    nameInput.addEventListener('input', () => {
      if (this.editingTenantSlug) return;
      const suggested = nameInput.value
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 28);
      slugInput.value = suggested;
    });

    document.getElementById('sa-add-sector-row-btn').addEventListener('click', () => {
      this.addSectorRow({
        sector: `Sector ${this.sectorsListEl.children.length + 1}`,
        mesas: 4,
        meseroNombre: 'Mesero Asignado',
        meseroId: `mesero${this.sectorsListEl.children.length + 1}`
      });
    });

    this.form.addEventListener('submit', async (e) => {
      e.preventDefault();
      await this.handleFormSubmit();
    });
  }

  async fetchTenants() {
    try {
      const res = await fetch('./api/superadmin/tenants', { cache: 'no-store' });
      if (res.status === 401) {
        window.location.reload();
        return;
      }
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error((data && data.error) || 'No se pudo cargar el listado de tenants');
      }
      this.tenants = Array.isArray(data.tenants) ? data.tenants : [];
      this.updateKPIs();
      this.renderTable();
    } catch (err) {
      this.showToast(`Error: ${err.message}`);
    }
  }

  updateKPIs() {
    const total = this.tenants.length;
    const active = this.tenants.filter((t) => t.estado !== 'Suspendido').length;
    const suspended = total - active;
    const totalTables = this.tenants.reduce((acc, t) => acc + (Number(t.totalMesas) || 0), 0);
    const totalDishes = this.tenants.reduce((acc, t) => acc + (Number(t.totalPlatos) || 0), 0);

    document.getElementById('kpi-total-tenants').textContent = String(total);
    document.getElementById('kpi-active-tenants').textContent = String(active);
    document.getElementById('kpi-suspended-sub').textContent = `${suspended} suspendido(s)`;
    document.getElementById('kpi-total-tables').textContent = String(totalTables);
    document.getElementById('kpi-total-dishes').textContent = String(totalDishes);
  }

  renderTable() {
    const q = (this.searchInput.value || '').trim().toLowerCase();
    const statusFilter = this.statusFilter.value;

    const filtered = this.tenants.filter((t) => {
      const estado = t.estado || 'Activo';
      if (statusFilter !== 'ALL' && estado !== statusFilter) return false;
      if (!q) return true;
      const haystack = `${t.tenant} ${t.nombre} ${t.ruc || ''} ${t.ciudad || ''} ${t.plan || ''}`.toLowerCase();
      return haystack.includes(q);
    });

    this.tbody.replaceChildren();

    if (filtered.length === 0) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td colspan="8" class="sa-empty-cell">No se encontraron restaurantes que coincidan con el filtro actual.</td>`;
      this.tbody.appendChild(tr);
      return;
    }

    filtered.forEach((t) => {
      const isSuspended = t.estado === 'Suspendido';
      const sectorsCount = Array.isArray(t.sectores) ? t.sectores.length : 0;
      const tr = document.createElement('tr');

      tr.innerHTML = `
        <td>
          <span class="sa-slug-pill">${this.escapeHtml(t.tenant)}</span>
        </td>
        <td>
          <div class="sa-local-name">${this.escapeHtml(t.nombre)}</div>
          <span class="sa-local-sub">${this.escapeHtml(t.ciudad || 'Asunción, Paraguay')} · ${this.escapeHtml(t.plan || 'Plan Restaurante de Autor')}</span>
        </td>
        <td>
          <span class="sa-ruc-code">${this.escapeHtml(t.ruc || '80000000-0')}</span>
        </td>
        <td>
          <span class="sa-status-badge ${isSuspended ? 'suspended' : 'active'}">
            ● ${isSuspended ? 'Suspendido' : 'Activo'}
          </span>
        </td>
        <td>
          <strong>${Number(t.totalMesas) || 0} mesas</strong>
          <span class="sa-local-sub">${sectorsCount} sector(es) · ${Number(t.totalPlatos) || 0} platos 3D</span>
        </td>
        <td>
          <span class="sa-pin-chip" title="PIN de Administrador">🔑 ${this.escapeHtml(t.adminPin || '1234')}</span>
        </td>
        <td>
          <span class="sa-pin-chip" title="PIN de Meseros">🛎️ ${this.escapeHtml(t.waiterPin || '5678')}</span>
        </td>
        <td>
          <div class="sa-actions-cell">
            <a href="./index.html?tenant=${encodeURIComponent(t.tenant)}" target="_blank" class="sa-btn-outline sa-btn-sm" title="Abrir Carta 3D del Cliente">Carta 3D</a>
            <a href="./admin-menu.html?tenant=${encodeURIComponent(t.tenant)}&pin=${encodeURIComponent(t.adminPin || '1234')}" target="_blank" class="sa-btn-outline sa-btn-sm" title="Abrir Gestión de Carta">Admin Carta</a>
            <button type="button" class="sa-btn-outline sa-btn-sm" data-action="qr-pack" title="Descargar paquete masivo de códigos QR listo para imprimir">Paquete QR</button>
            <button type="button" class="sa-btn-outline sa-btn-sm" data-action="edit" title="Editar configuración y PINs">Editar / PINs</button>
            <button type="button" class="${isSuspended ? 'sa-btn-gold' : 'sa-btn-danger'} sa-btn-sm" data-action="toggle-status">
              ${isSuspended ? 'Reactivar' : 'Suspender'}
            </button>
          </div>
        </td>
      `;

      tr.querySelector('[data-action="edit"]').addEventListener('click', () => {
        this.openModalForEdit(t);
      });

      tr.querySelector('[data-action="toggle-status"]').addEventListener('click', () => {
        this.toggleTenantStatus(t);
      });

      tr.querySelector('[data-action="qr-pack"]').addEventListener('click', () => {
        this.downloadMassiveQRPackage(t);
      });

      this.tbody.appendChild(tr);
    });
  }

  openModalForNew() {
    this.editingTenantSlug = null;
    document.getElementById('sa-modal-kicker').textContent = 'APROVISIONAMIENTO AUTOMÁTICO MULTI-TENANT';
    document.getElementById('sa-modal-title').textContent = 'Nuevo Restaurante';
    document.getElementById('sa-save-btn-label').textContent = 'Aprovisionar y Crear Restaurante';

    const slugInput = document.getElementById('f-tenant-slug');
    slugInput.disabled = false;
    slugInput.value = '';

    document.getElementById('f-tenant-nombre').value = '';
    document.getElementById('f-tenant-ruc').value = '80095400-1';
    document.getElementById('f-tenant-ciudad').value = 'Asunción, Paraguay';
    document.getElementById('f-tenant-plan').value = 'Plan Restaurante de Autor';
    document.getElementById('f-tenant-estado').value = 'Activo';
    document.getElementById('f-admin-pin').value = '1234';
    document.getElementById('f-waiter-pin').value = '5678';

    this.sectorsListEl.replaceChildren();
    [
      { sector: 'Terraza', mesas: 4, meseroNombre: 'Juan Pérez', meseroId: 'juan' },
      { sector: 'Salón Principal', mesas: 6, meseroNombre: 'Lucía Gómez', meseroId: 'lucia' }
    ].forEach((s) => this.addSectorRow(s));

    this.modal.classList.remove('hidden');
  }

  openModalForEdit(tenantObj) {
    this.editingTenantSlug = tenantObj.tenant;
    document.getElementById('sa-modal-kicker').textContent = `EDICIÓN DE TENANT · ${tenantObj.tenant.toUpperCase()}`;
    document.getElementById('sa-modal-title').textContent = `Configurar ${tenantObj.nombre}`;
    document.getElementById('sa-save-btn-label').textContent = 'Guardar Cambios';

    const slugInput = document.getElementById('f-tenant-slug');
    slugInput.value = tenantObj.tenant;
    slugInput.disabled = true;

    document.getElementById('f-tenant-nombre').value = tenantObj.nombre || '';
    document.getElementById('f-tenant-ruc').value = tenantObj.ruc || '80000000-0';
    document.getElementById('f-tenant-ciudad').value = tenantObj.ciudad || 'Asunción, Paraguay';
    document.getElementById('f-tenant-plan').value = tenantObj.plan || 'Plan Restaurante de Autor';
    document.getElementById('f-tenant-estado').value = tenantObj.estado || 'Activo';
    document.getElementById('f-admin-pin').value = tenantObj.adminPin || '1234';
    document.getElementById('f-waiter-pin').value = tenantObj.waiterPin || '5678';

    this.sectorsListEl.replaceChildren();
    const sectors =
      Array.isArray(tenantObj.sectores) && tenantObj.sectores.length > 0
        ? tenantObj.sectores
        : [{ sector: 'Salón Principal', mesas: 5, meseroNombre: 'Juan Pérez', meseroId: 'juan' }];
    sectors.forEach((s) => this.addSectorRow(s));

    this.modal.classList.remove('hidden');
  }

  closeModal() {
    this.modal.classList.add('hidden');
  }

  addSectorRow(item) {
    const row = document.createElement('div');
    row.className = 'sa-sector-row';
    row.innerHTML = `
      <input type="text" data-field="sector" value="${this.escapeHtml(item.sector)}" placeholder="Nombre Sector (ej. Terraza)" required />
      <input type="number" data-field="mesas" min="1" max="150" value="${Number(item.mesas) || 4}" placeholder="Mesas" required />
      <input type="text" data-field="meseroNombre" value="${this.escapeHtml(item.meseroNombre)}" placeholder="Nombre del Mesero" required />
      <input type="text" data-field="meseroId" value="${this.escapeHtml(item.meseroId)}" placeholder="ID Mesero (ej. juan)" required />
      <button type="button" class="sa-icon-btn" title="Quitar sector">✕</button>
    `;

    row.querySelector('button').addEventListener('click', () => {
      if (this.sectorsListEl.children.length <= 1) {
        this.showToast('El restaurante debe tener al menos 1 sector configurado.');
        return;
      }
      row.remove();
    });

    this.sectorsListEl.appendChild(row);
  }

  collectSectorsFromModal() {
    const rows = this.sectorsListEl.querySelectorAll('.sa-sector-row');
    const list = [];
    rows.forEach((r) => {
      const sector = r.querySelector('[data-field="sector"]').value.trim() || 'Salón';
      const mesas = Math.max(1, parseInt(r.querySelector('[data-field="mesas"]').value, 10) || 1);
      const meseroNombre = r.querySelector('[data-field="meseroNombre"]').value.trim() || 'Mesero';
      const meseroId =
        r.querySelector('[data-field="meseroId"]').value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '') ||
        'juan';
      list.push({ sector, mesas, meseroNombre, meseroId });
    });
    return list;
  }

  async handleFormSubmit() {
    const payload = {
      tenant: document.getElementById('f-tenant-slug').value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, ''),
      nombre: document.getElementById('f-tenant-nombre').value.trim(),
      ruc: document.getElementById('f-tenant-ruc').value.trim(),
      ciudad: document.getElementById('f-tenant-ciudad').value.trim() || 'Asunción, Paraguay',
      plan: document.getElementById('f-tenant-plan').value,
      estado: document.getElementById('f-tenant-estado').value,
      adminPin: document.getElementById('f-admin-pin').value.trim() || '1234',
      waiterPin: document.getElementById('f-waiter-pin').value.trim() || '5678',
      sectores: this.collectSectorsFromModal()
    };

    if (!payload.tenant || !payload.nombre) {
      this.showToast('Completa el Nombre del Local y el Slug único.');
      return;
    }

    try {
      const isEdit = Boolean(this.editingTenantSlug);
      const url = isEdit
        ? `./api/superadmin/tenants/${encodeURIComponent(this.editingTenantSlug)}`
        : './api/superadmin/tenants';
      const method = isEdit ? 'PUT' : 'POST';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error((data && data.error) || 'No se pudo guardar el restaurante');
      }

      this.closeModal();
      this.showToast(
        isEdit
          ? `✓ Restaurante "${payload.nombre}" (${payload.tenant}) actualizado.`
          : `✓ Restaurante "${payload.nombre}" (${payload.tenant}) aprovisionado con carta 3D y modelos.`
      );
      await this.fetchTenants();
    } catch (err) {
      this.showToast(`Error: ${err.message}`);
    }
  }

  async toggleTenantStatus(tenantObj) {
    const nextStatus = tenantObj.estado === 'Suspendido' ? 'Activo' : 'Suspendido';
    try {
      const res = await fetch(`./api/superadmin/tenants/${encodeURIComponent(tenantObj.tenant)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...tenantObj,
          estado: nextStatus
        })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error((data && data.error) || 'No se pudo cambiar el estado');
      }
      this.showToast(
        `Estado de "${tenantObj.nombre}" cambiado a: ${nextStatus.toUpperCase()}`
      );
      await this.fetchTenants();
    } catch (err) {
      this.showToast(`Error: ${err.message}`);
    }
  }

  /**
   * Genera un paquete HTML autónomo con todas las placas QR de todas las mesas y sectores
   * del tenant seleccionado (con imágenes PNG Base64 incrustadas generadas offline) y lo descarga.
   */
  async downloadMassiveQRPackage(tenantObj) {
    try {
      const baseOrigin = window.location.origin.replace(/\/+$/, '');
      const sectors = Array.isArray(tenantObj.sectores) ? tenantObj.sectores : [];
      const cardsHtml = [];
      let globalTable = 1;

      for (const sec of sectors) {
        const count = Math.max(1, Number(sec.mesas) || 1);
        for (let i = 1; i <= count; i++) {
          const tableNum = globalTable++;
          const padded = String(tableNum).padStart(2, '0');
          const qrTargetUrl = `${baseOrigin}/index.html?tenant=${encodeURIComponent(
            tenantObj.tenant
          )}&mesa=${encodeURIComponent(tableNum)}&sector=${encodeURIComponent(
            sec.sector
          )}&mesero=${encodeURIComponent(sec.meseroId || 'juan')}`;

          let qrDataUrl = '';
          if (window.QRCode && typeof window.QRCode.toDataURL === 'function') {
            qrDataUrl = await window.QRCode.toDataURL(qrTargetUrl, {
              width: 220,
              margin: 2,
              errorCorrectionLevel: 'M'
            });
          }

          cardsHtml.push(`
            <article class="plaque">
              <div class="plaque-top">
                <strong>${this.escapeHtml(tenantObj.nombre)}</strong>
                <span class="sector">${this.escapeHtml(sec.sector)}</span>
              </div>
              <div class="table-num">MESA ${padded}</div>
              <div class="qr-box">
                <img src="${qrDataUrl}" alt="QR Mesa ${tableNum}" width="180" height="180" />
              </div>
              <div class="badge">TECHAPY · MENÚ 3D &amp; AR ESCALA 1:1</div>
              <div class="url">${this.escapeHtml(qrTargetUrl)}</div>
            </article>
          `);
        }
      }

      const printableDoc = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <title>Paquete QR Masivo — ${this.escapeHtml(tenantObj.nombre)} (${this.escapeHtml(tenantObj.tenant)})</title>
  <style>
    body { font-family: 'Plus Jakarta Sans', sans-serif; background: #0e1013; color: #f4f4f6; margin: 0; padding: 24px; }
    .toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; padding: 14px 20px; background: #15181e; border: 1px solid rgba(197,160,89,0.35); border-radius: 10px; }
    .btn { background: #c5a059; color: #0e1013; border: none; padding: 10px 18px; border-radius: 8px; font-weight: 700; cursor: pointer; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 18px; }
    .plaque { background: #15181e; border: 1px solid rgba(197,160,89,0.45); border-radius: 14px; padding: 18px; text-align: center; page-break-inside: avoid; }
    .plaque-top { display: flex; justify-content: space-between; font-size: 0.78rem; color: #d4af37; margin-bottom: 8px; }
    .table-num { font-size: 1.5rem; font-weight: 700; margin-bottom: 10px; color: #ffffff; }
    .qr-box { background: #ffffff; padding: 10px; border-radius: 10px; display: inline-block; margin-bottom: 10px; }
    .badge { font-size: 0.65rem; font-weight: 700; letter-spacing: 0.1em; color: #d4af37; margin-bottom: 6px; }
    .url { font-size: 0.62rem; color: #989ea8; word-break: break-all; }
    @media print { .toolbar { display: none; } body { background: #ffffff; color: #000000; } }
  </style>
</head>
<body>
  <div class="toolbar">
    <div>
      <strong>${this.escapeHtml(tenantObj.nombre)}</strong> · RUC: ${this.escapeHtml(tenantObj.ruc || '—')} · ${cardsHtml.length} Placas QR Generadas
    </div>
    <button class="btn" onclick="window.print()">Imprimir Todas las Placas</button>
  </div>
  <div class="grid">${cardsHtml.join('\n')}</div>
</body>
</html>`;

      const blob = new Blob([printableDoc], { type: 'text/html;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `techapy-qr-pack-${tenantObj.tenant}.html`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      this.showToast(`✓ Paquete QR masivo descargado: techapy-qr-pack-${tenantObj.tenant}.html`);
    } catch (err) {
      this.showToast(`Error generando paquete QR: ${err.message}`);
    }
  }

  showToast(msg) {
    const el = document.getElementById('sa-toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      el.classList.add('hidden');
    }, 3200);
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
  window.superAdminController = new SuperAdminController();
});
