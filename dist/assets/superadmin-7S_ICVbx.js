import"./modulepreload-polyfill-B5Qt9EMX.js";class b{constructor(){this.tenants=[],this.editingTenantSlug=null,this.tbody=document.getElementById("sa-tenants-tbody"),this.searchInput=document.getElementById("sa-search-input"),this.statusFilter=document.getElementById("sa-status-filter"),this.modal=document.getElementById("sa-tenant-modal"),this.form=document.getElementById("sa-tenant-form"),this.sectorsListEl=document.getElementById("sa-modal-sectors-list"),this.bindEvents(),this.fetchTenants()}bindEvents(){document.getElementById("sa-new-tenant-btn").addEventListener("click",()=>{this.openModalForNew()}),document.getElementById("sa-close-modal-btn").addEventListener("click",()=>{this.closeModal()}),document.getElementById("sa-cancel-modal-btn").addEventListener("click",()=>{this.closeModal()}),document.getElementById("sa-refresh-btn").addEventListener("click",()=>{this.fetchTenants()}),document.getElementById("sa-logout-btn").addEventListener("click",async()=>{try{await fetch("./api/auth/logout?role=superadmin",{method:"POST"})}catch{}window.location.reload()}),this.searchInput.addEventListener("input",()=>this.renderTable()),this.statusFilter.addEventListener("change",()=>this.renderTable());const e=document.getElementById("f-tenant-nombre"),t=document.getElementById("f-tenant-slug");e.addEventListener("input",()=>{if(this.editingTenantSlug)return;const n=e.value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,28);t.value=n}),document.getElementById("sa-add-sector-row-btn").addEventListener("click",()=>{this.addSectorRow({sector:`Sector ${this.sectorsListEl.children.length+1}`,mesas:4,meseroNombre:"Mesero Asignado",meseroId:`mesero${this.sectorsListEl.children.length+1}`})}),this.form.addEventListener("submit",async n=>{n.preventDefault(),await this.handleFormSubmit()})}async fetchTenants(){try{const e=await fetch("./api/superadmin/tenants",{cache:"no-store"});if(e.status===401){window.location.reload();return}const t=await e.json();if(!e.ok||!t.ok)throw new Error(t&&t.error||"No se pudo cargar el listado de tenants");this.tenants=Array.isArray(t.tenants)?t.tenants:[],this.updateKPIs(),this.renderTable()}catch(e){this.showToast(`Error: ${e.message}`)}}updateKPIs(){const e=this.tenants.length,t=this.tenants.filter(s=>s.estado!=="Suspendido").length,n=e-t,a=this.tenants.reduce((s,r)=>s+(Number(r.totalMesas)||0),0),o=this.tenants.reduce((s,r)=>s+(Number(r.totalPlatos)||0),0);document.getElementById("kpi-total-tenants").textContent=String(e),document.getElementById("kpi-active-tenants").textContent=String(t),document.getElementById("kpi-suspended-sub").textContent=`${n} suspendido(s)`,document.getElementById("kpi-total-tables").textContent=String(a),document.getElementById("kpi-total-dishes").textContent=String(o)}renderTable(){const e=(this.searchInput.value||"").trim().toLowerCase(),t=this.statusFilter.value,n=this.tenants.filter(a=>{const o=a.estado||"Activo";return t!=="ALL"&&o!==t?!1:e?`${a.tenant} ${a.nombre} ${a.ruc||""} ${a.ciudad||""} ${a.plan||""}`.toLowerCase().includes(e):!0});if(this.tbody.replaceChildren(),n.length===0){const a=document.createElement("tr");a.innerHTML='<td colspan="8" class="sa-empty-cell">No se encontraron restaurantes que coincidan con el filtro actual.</td>',this.tbody.appendChild(a);return}n.forEach(a=>{const o=a.estado==="Suspendido",s=Array.isArray(a.sectores)?a.sectores.length:0,r=document.createElement("tr");r.innerHTML=`
        <td>
          <span class="sa-slug-pill">${this.escapeHtml(a.tenant)}</span>
        </td>
        <td>
          <div class="sa-local-name">${this.escapeHtml(a.nombre)}</div>
          <span class="sa-local-sub">${this.escapeHtml(a.ciudad||"Asunción, Paraguay")} · ${this.escapeHtml(a.plan||"Plan Restaurante de Autor")}</span>
        </td>
        <td>
          <span class="sa-ruc-code">${this.escapeHtml(a.ruc||"80000000-0")}</span>
        </td>
        <td>
          <span class="sa-status-badge ${o?"suspended":"active"}">
            ● ${o?"Suspendido":"Activo"}
          </span>
        </td>
        <td>
          <strong>${Number(a.totalMesas)||0} mesas</strong>
          <span class="sa-local-sub">${s} sector(es) · ${Number(a.totalPlatos)||0} platos 3D</span>
        </td>
        <td>
          <span class="sa-pin-chip" title="PIN de Administrador">🔑 ${this.escapeHtml(a.adminPin||"1234")}</span>
        </td>
        <td>
          <span class="sa-pin-chip" title="PIN de Meseros">🛎️ ${this.escapeHtml(a.waiterPin||"5678")}</span>
        </td>
        <td>
          <div class="sa-actions-cell">
            <a href="./index.html?tenant=${encodeURIComponent(a.tenant)}" target="_blank" class="sa-btn-outline sa-btn-sm" title="Abrir Carta 3D del Cliente">Carta 3D</a>
            <a href="./admin-menu.html?tenant=${encodeURIComponent(a.tenant)}&pin=${encodeURIComponent(a.adminPin||"1234")}" target="_blank" class="sa-btn-outline sa-btn-sm" title="Abrir Gestión de Carta">Admin Carta</a>
            <button type="button" class="sa-btn-outline sa-btn-sm" data-action="qr-pack" title="Descargar paquete masivo de códigos QR listo para imprimir">Paquete QR</button>
            <button type="button" class="sa-btn-outline sa-btn-sm" data-action="edit" title="Editar configuración y PINs">Editar / PINs</button>
            <button type="button" class="${o?"sa-btn-gold":"sa-btn-danger"} sa-btn-sm" data-action="toggle-status">
              ${o?"Reactivar":"Suspender"}
            </button>
          </div>
        </td>
      `,r.querySelector('[data-action="edit"]').addEventListener("click",()=>{this.openModalForEdit(a)}),r.querySelector('[data-action="toggle-status"]').addEventListener("click",()=>{this.toggleTenantStatus(a)}),r.querySelector('[data-action="qr-pack"]').addEventListener("click",()=>{this.downloadMassiveQRPackage(a)}),this.tbody.appendChild(r)})}openModalForNew(){this.editingTenantSlug=null,document.getElementById("sa-modal-kicker").textContent="APROVISIONAMIENTO AUTOMÁTICO MULTI-TENANT",document.getElementById("sa-modal-title").textContent="Nuevo Restaurante",document.getElementById("sa-save-btn-label").textContent="Aprovisionar y Crear Restaurante";const e=document.getElementById("f-tenant-slug");e.disabled=!1,e.value="",document.getElementById("f-tenant-nombre").value="",document.getElementById("f-tenant-ruc").value="80095400-1",document.getElementById("f-tenant-ciudad").value="Asunción, Paraguay",document.getElementById("f-tenant-plan").value="Plan Restaurante de Autor",document.getElementById("f-tenant-estado").value="Activo",document.getElementById("f-admin-pin").value="1234",document.getElementById("f-waiter-pin").value="5678",this.sectorsListEl.replaceChildren(),[{sector:"Terraza",mesas:4,meseroNombre:"Juan Pérez",meseroId:"juan"},{sector:"Salón Principal",mesas:6,meseroNombre:"Lucía Gómez",meseroId:"lucia"}].forEach(t=>this.addSectorRow(t)),this.modal.classList.remove("hidden")}openModalForEdit(e){this.editingTenantSlug=e.tenant,document.getElementById("sa-modal-kicker").textContent=`EDICIÓN DE TENANT · ${e.tenant.toUpperCase()}`,document.getElementById("sa-modal-title").textContent=`Configurar ${e.nombre}`,document.getElementById("sa-save-btn-label").textContent="Guardar Cambios";const t=document.getElementById("f-tenant-slug");t.value=e.tenant,t.disabled=!0,document.getElementById("f-tenant-nombre").value=e.nombre||"",document.getElementById("f-tenant-ruc").value=e.ruc||"80000000-0",document.getElementById("f-tenant-ciudad").value=e.ciudad||"Asunción, Paraguay",document.getElementById("f-tenant-plan").value=e.plan||"Plan Restaurante de Autor",document.getElementById("f-tenant-estado").value=e.estado||"Activo",document.getElementById("f-admin-pin").value=e.adminPin||"1234",document.getElementById("f-waiter-pin").value=e.waiterPin||"5678",this.sectorsListEl.replaceChildren(),(Array.isArray(e.sectores)&&e.sectores.length>0?e.sectores:[{sector:"Salón Principal",mesas:5,meseroNombre:"Juan Pérez",meseroId:"juan"}]).forEach(a=>this.addSectorRow(a)),this.modal.classList.remove("hidden")}closeModal(){this.modal.classList.add("hidden")}addSectorRow(e){const t=document.createElement("div");t.className="sa-sector-row",t.innerHTML=`
      <input type="text" data-field="sector" value="${this.escapeHtml(e.sector)}" placeholder="Nombre Sector (ej. Terraza)" required />
      <input type="number" data-field="mesas" min="1" max="150" value="${Number(e.mesas)||4}" placeholder="Mesas" required />
      <input type="text" data-field="meseroNombre" value="${this.escapeHtml(e.meseroNombre)}" placeholder="Nombre del Mesero" required />
      <input type="text" data-field="meseroId" value="${this.escapeHtml(e.meseroId)}" placeholder="ID Mesero (ej. juan)" required />
      <button type="button" class="sa-icon-btn" title="Quitar sector">✕</button>
    `,t.querySelector("button").addEventListener("click",()=>{if(this.sectorsListEl.children.length<=1){this.showToast("El restaurante debe tener al menos 1 sector configurado.");return}t.remove()}),this.sectorsListEl.appendChild(t)}collectSectorsFromModal(){const e=this.sectorsListEl.querySelectorAll(".sa-sector-row"),t=[];return e.forEach(n=>{const a=n.querySelector('[data-field="sector"]').value.trim()||"Salón",o=Math.max(1,parseInt(n.querySelector('[data-field="mesas"]').value,10)||1),s=n.querySelector('[data-field="meseroNombre"]').value.trim()||"Mesero",r=n.querySelector('[data-field="meseroId"]').value.trim().toLowerCase().replace(/[^a-z0-9_-]/g,"")||"juan";t.push({sector:a,mesas:o,meseroNombre:s,meseroId:r})}),t}async handleFormSubmit(){const e={tenant:document.getElementById("f-tenant-slug").value.trim().toLowerCase().replace(/[^a-z0-9_-]/g,""),nombre:document.getElementById("f-tenant-nombre").value.trim(),ruc:document.getElementById("f-tenant-ruc").value.trim(),ciudad:document.getElementById("f-tenant-ciudad").value.trim()||"Asunción, Paraguay",plan:document.getElementById("f-tenant-plan").value,estado:document.getElementById("f-tenant-estado").value,adminPin:document.getElementById("f-admin-pin").value.trim()||"1234",waiterPin:document.getElementById("f-waiter-pin").value.trim()||"5678",sectores:this.collectSectorsFromModal()};if(!e.tenant||!e.nombre){this.showToast("Completa el Nombre del Local y el Slug único.");return}try{const t=!!this.editingTenantSlug,n=t?`./api/superadmin/tenants/${encodeURIComponent(this.editingTenantSlug)}`:"./api/superadmin/tenants",o=await fetch(n,{method:t?"PUT":"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(e)}),s=await o.json();if(!o.ok||!s.ok)throw new Error(s&&s.error||"No se pudo guardar el restaurante");this.closeModal(),this.showToast(t?`✓ Restaurante "${e.nombre}" (${e.tenant}) actualizado.`:`✓ Restaurante "${e.nombre}" (${e.tenant}) aprovisionado con carta 3D y modelos.`),await this.fetchTenants()}catch(t){this.showToast(`Error: ${t.message}`)}}async toggleTenantStatus(e){const t=e.estado==="Suspendido"?"Activo":"Suspendido";try{const n=await fetch(`./api/superadmin/tenants/${encodeURIComponent(e.tenant)}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({...e,estado:t})}),a=await n.json();if(!n.ok||!a.ok)throw new Error(a&&a.error||"No se pudo cambiar el estado");this.showToast(`Estado de "${e.nombre}" cambiado a: ${t.toUpperCase()}`),await this.fetchTenants()}catch(n){this.showToast(`Error: ${n.message}`)}}async downloadMassiveQRPackage(e){try{const t=window.location.origin.replace(/\/+$/,""),n=Array.isArray(e.sectores)?e.sectores:[],a=[];let o=1;for(const i of n){const h=Math.max(1,Number(i.mesas)||1);for(let m=1;m<=h;m++){const l=o++,g=String(l).padStart(2,"0"),u=`${t}/index.html?tenant=${encodeURIComponent(e.tenant)}&mesa=${encodeURIComponent(l)}&sector=${encodeURIComponent(i.sector)}&mesero=${encodeURIComponent(i.meseroId||"juan")}`;let p="";window.QRCode&&typeof window.QRCode.toDataURL=="function"&&(p=await window.QRCode.toDataURL(u,{width:220,margin:2,errorCorrectionLevel:"M"})),a.push(`
            <article class="plaque">
              <div class="plaque-top">
                <strong>${this.escapeHtml(e.nombre)}</strong>
                <span class="sector">${this.escapeHtml(i.sector)}</span>
              </div>
              <div class="table-num">MESA ${g}</div>
              <div class="qr-box">
                <img src="${p}" alt="QR Mesa ${l}" width="180" height="180" />
              </div>
              <div class="badge">TECHAPY · MENÚ 3D &amp; AR ESCALA 1:1</div>
              <div class="url">${this.escapeHtml(u)}</div>
            </article>
          `)}}const s=`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <title>Paquete QR Masivo — ${this.escapeHtml(e.nombre)} (${this.escapeHtml(e.tenant)})</title>
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
      <strong>${this.escapeHtml(e.nombre)}</strong> · RUC: ${this.escapeHtml(e.ruc||"—")} · ${a.length} Placas QR Generadas
    </div>
    <button class="btn" onclick="window.print()">Imprimir Todas las Placas</button>
  </div>
  <div class="grid">${a.join(`
`)}</div>
</body>
</html>`,r=new Blob([s],{type:"text/html;charset=utf-8"}),c=URL.createObjectURL(r),d=document.createElement("a");d.href=c,d.download=`techapy-qr-pack-${e.tenant}.html`,document.body.appendChild(d),d.click(),d.remove(),URL.revokeObjectURL(c),this.showToast(`✓ Paquete QR masivo descargado: techapy-qr-pack-${e.tenant}.html`)}catch(t){this.showToast(`Error generando paquete QR: ${t.message}`)}}showToast(e){const t=document.getElementById("sa-toast");t&&(t.textContent=e,t.classList.remove("hidden"),clearTimeout(this.toastTimer),this.toastTimer=setTimeout(()=>{t.classList.add("hidden")},3200))}escapeHtml(e){return String(e||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}}window.addEventListener("DOMContentLoaded",()=>{window.superAdminController=new b});
