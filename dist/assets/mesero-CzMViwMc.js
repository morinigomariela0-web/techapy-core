import"./modulepreload-polyfill-B5Qt9EMX.js";const R="kuroshio_comandas_channel",w="kuroshio_comandas_store",O="kuroshio_turnos_archivados",$="kuroshio_historial_mesas",T="kuroshio_mesero_prefs";class k{constructor(){const e=new URLSearchParams(window.location.search);this.tenant=(e.get("tenant")||"demo").trim().toLowerCase().replace(/[^a-z0-9_-]/g,"")||"demo",this.waiterId=(e.get("id")||"juan").toLowerCase(),this.assignedSector=e.get("sector")||"Terraza",this.currencySymbol="Gs.",this.sectorFilter="ASSIGNED",this.statusFilter="ALL",this.soundEnabled=!0,this.audioCtx=null,this.orders=[],this.tableHistory=[],this.loadWaiterPreferences(),this.initHeaderUI(),this.loadStoredOrders(),this.loadTableHistory(),this.initRealtimeBus(),this.initScreenWakeRecovery(),this.bindUIEvents(),this.renderAll()}loadWaiterPreferences(){try{const e=localStorage.getItem(`${T}_${this.waiterId}`);if(e){const s=JSON.parse(e);s.sectorFilter&&(this.sectorFilter=s.sectorFilter),s.statusFilter&&(this.statusFilter=s.statusFilter)}}catch{}}saveWaiterPreferences(){try{localStorage.setItem(`${T}_${this.waiterId}`,JSON.stringify({sectorFilter:this.sectorFilter,statusFilter:this.statusFilter}))}catch{}}initHeaderUI(){const e=document.getElementById("waiter-title"),s=document.getElementById("sector-subtitle"),t=document.getElementById("sector-filter");if(e&&(e.textContent=`TechaPY · Mesero: ${this.waiterId.toUpperCase()}`),s&&(s.innerHTML=`Local: <strong>${this.tenant.toUpperCase()}</strong> · Sector: <strong>${this.assignedSector}</strong>`),t){const i=t.querySelector('option[value="ASSIGNED"]');i&&(i.textContent=`Mi Sector (${this.assignedSector})`),t.value=this.sectorFilter}document.querySelectorAll(".status-pill").forEach(i=>{i.classList.toggle("active",i.dataset.status===this.statusFilter)})}formatGuaranies(e){const s=Math.round(Number(e)||0);return`${this.currencySymbol} ${s.toString().replace(/\B(?=(\d{3})+(?!\d))/g,".")}`}loadStoredOrders(){try{const e=localStorage.getItem(w);if(e){const s=JSON.parse(e),t=Array.isArray(s)?s:[];this.orders=t.filter(a=>(a.tenant||"demo")===this.tenant)}else this.orders=[]}catch(e){console.warn("Error leyendo comandas almacenadas:",e),this.orders=[]}}saveOrdersToStorage(){try{localStorage.setItem(w,JSON.stringify(this.orders.slice(0,150)))}catch(e){console.warn("Error guardando comandas en storage:",e)}}initScreenWakeRecovery(){const e=()=>{if(document.visibilityState==="visible"){const s=new Set(this.orders.filter(a=>a.estado==="Pendiente").map(a=>a.id));this.loadStoredOrders(),this.renderAll();const t=this.orders.find(a=>a.estado==="Pendiente"&&!s.has(a.id));t&&this.notifyIfRelevant(t),this.connectWebSocket()}};document.addEventListener("visibilitychange",e),window.addEventListener("focus",e),window.addEventListener("pageshow",e)}initRealtimeBus(){this.ws=null,this.wsReconnectAttempts=0,this.wsReconnectTimer=null,this.channel=new BroadcastChannel(R),this.channel.addEventListener("message",e=>{this.handleRealtimePayload(e.data)}),window.addEventListener("storage",e=>{if(e.key===w)try{const s=e.newValue?JSON.parse(e.newValue):[],t=this.orders.length;this.orders=Array.isArray(s)?s:[],this.renderAll(),this.orders.length>t&&this.orders[0]&&this.notifyIfRelevant(this.orders[0])}catch(s){console.warn("Error sincronizando storage en mesero:",s)}}),window.addEventListener("online",()=>{this.wsReconnectAttempts=0,this.connectWebSocket()}),this.connectWebSocket()}connectWebSocket(){if(clearTimeout(this.wsReconnectTimer),!window.location.host){this.updateLiveConnectionBadge(!1);return}if(this.ws&&(this.ws.readyState===WebSocket.OPEN||this.ws.readyState===WebSocket.CONNECTING))return;const e=window.location.protocol==="https:"?"wss:":"ws:",s=window.KUROSHIO_WS_URL||`${e}//${window.location.host}/ws`;this.updateLiveConnectionBadge(!1);try{this.ws=new WebSocket(s),this.ws.addEventListener("open",()=>{this.wsReconnectAttempts=0,this.updateLiveConnectionBadge(!0),this.ws.send(JSON.stringify({type:"REGISTER_WAITER",tenant:this.tenant,id:this.waiterId,sector:this.assignedSector}))}),this.ws.addEventListener("message",t=>{try{const a=JSON.parse(t.data);this.handleRealtimePayload(a)}catch{}}),this.ws.addEventListener("close",()=>{this.updateLiveConnectionBadge(!1),this.scheduleWsReconnect()}),this.ws.addEventListener("error",()=>{this.updateLiveConnectionBadge(!1)})}catch{this.updateLiveConnectionBadge(!1),this.scheduleWsReconnect()}}scheduleWsReconnect(){clearTimeout(this.wsReconnectTimer);const e=Math.min(1e3*Math.pow(1.8,this.wsReconnectAttempts),1e4);this.wsReconnectAttempts+=1,this.wsReconnectTimer=setTimeout(()=>{this.connectWebSocket()},e)}updateLiveConnectionBadge(e){const s=document.getElementById("ws-live-indicator"),t=document.getElementById("ws-live-text");!s||!t||(s.classList.toggle("reconnecting",!e),t.textContent=e?"EN LÍNEA (WS)":"RECONECTANDO")}mergeOrdersWithoutDuplicates(e){if(!Array.isArray(e))return;const s=new Map;e.forEach(t=>{t&&t.id&&s.set(t.id,t)}),this.orders.forEach(t=>{t&&t.id&&!s.has(t.id)&&s.set(t.id,t)}),this.orders=Array.from(s.values()).sort((t,a)=>new Date(a.timestamp||0)-new Date(t.timestamp||0)),this.saveOrdersToStorage()}handleRealtimePayload(e){if(!e)return;const s=e.type||e.eventType;if(s==="INITIAL_ORDERS"&&Array.isArray(e.orders)){this.mergeOrdersWithoutDuplicates(e.orders),this.renderAll();return}if(s==="NUEVA_COMANDA"&&e.order){const t=e.order;this.orders.some(i=>i.id===t.id)||(this.orders.unshift(t),this.saveOrdersToStorage()),this.renderAll(),this.notifyIfRelevant(t)}else if(s==="ESTADO_ACTUALIZADO"&&e.order){const t=this.orders.findIndex(a=>a.id===e.order.id);t!==-1?this.orders[t]=e.order:this.orders.unshift(e.order),this.saveOrdersToStorage(),this.renderAll()}else s==="TURNO_ACTUALIZADO"&&(Array.isArray(e.orders)?(this.orders=e.orders,this.saveOrdersToStorage()):this.loadStoredOrders(),this.renderAll())}notifyIfRelevant(e){if(this.sectorFilter==="ALL"||e.sector.toLowerCase()===this.assignedSector.toLowerCase()||e.mesero_id&&e.mesero_id.toLowerCase()===this.waiterId){this.playBellAlert(e.tipo==="LLAMADO_MESERO");const t=e.tipo==="LLAMADO_MESERO"?`Mesa ${e.mesa} (${e.sector}) solicita atención del mesero`:`Nueva comanda en Mesa ${e.mesa} (${e.sector}) — ${this.formatGuaranies(e.total||0)}`;this.showAlertBanner(t)}}playBellAlert(e=!1){if(this.soundEnabled)try{const s=window.AudioContext||window.webkitAudioContext;if(!s)return;this.audioCtx||(this.audioCtx=new s),this.audioCtx.state==="suspended"&&this.audioCtx.resume();const t=this.audioCtx.currentTime,a=(i,r,n,c)=>{const h=this.audioCtx.createOscillator(),o=this.audioCtx.createGain();h.type="sine",h.frequency.setValueAtTime(i,t+r),o.gain.setValueAtTime(1e-4,t+r),o.gain.exponentialRampToValueAtTime(c,t+r+.02),o.gain.exponentialRampToValueAtTime(1e-4,t+r+n),h.connect(o),o.connect(this.audioCtx.destination),h.start(t+r),h.stop(t+r+n+.02)};a(987.77,0,.55,.28),a(1975.53,0,.35,.12),a(1318.51,.18,.75,.32),a(2637.02,.18,.45,.14),e&&a(1318.51,.42,.65,.3),navigator.vibrate&&navigator.vibrate(e?[180,80,180,80,220]:[200,100,200])}catch(s){console.warn("Web Audio API bloqueada hasta interacción del usuario:",s)}}loadTableHistory(){try{const e=localStorage.getItem(`${$}_${this.tenant}`);if(e){const s=JSON.parse(e);this.tableHistory=Array.isArray(s)?s:[]}else this.tableHistory=[]}catch{this.tableHistory=[]}fetch(`./api/${encodeURIComponent(this.tenant)}/orders-history`,{cache:"no-store"}).then(e=>e.ok?e.json():null).then(e=>{if(e&&Array.isArray(e.history)){const s=new Map;this.tableHistory.forEach(t=>{t&&t.id&&s.set(t.id,t)}),e.history.forEach(t=>{t&&t.id&&!s.has(t.id)&&s.set(t.id,t)}),this.tableHistory=Array.from(s.values()).sort((t,a)=>new Date(a.cobradoAt||a.timestamp||0)-new Date(t.cobradoAt||t.timestamp||0)),this.saveTableHistory(),this.renderTablesHistory()}}).catch(()=>{})}saveTableHistory(){try{localStorage.setItem(`${$}_${this.tenant}`,JSON.stringify(this.tableHistory.slice(0,200)))}catch{}}recordOrderInTableHistory(e){if(!e||!e.id)return;const s=this.computeOrderSubAccounts(e),t={...e,cuentasDivididas:s,cobradoAt:e.cobradoAt||new Date().toISOString(),verificadoCaja:!!e.verificadoCaja,montoCorroborado:e.montoCorroborado!==null&&e.montoCorroborado!==void 0?Number(e.montoCorroborado):Number(e.total||0)},a=this.tableHistory.findIndex(i=>i.id===t.id);a!==-1?this.tableHistory[a]=t:this.tableHistory.unshift(t),this.saveTableHistory()}computeOrderSubAccounts(e){if(!e)return[];const s=Array.isArray(e.items)?e.items:[],t=new Map;s.forEach(i=>{const r=i.subcuenta||"Cuenta 1 (Familia A)",n=Number(i.subtotal!==void 0?i.subtotal:Number(i.precioUnitario||0)*Number(i.cantidad||1)),c=t.get(r)||{nombre:r,subtotal:0,cantidadItems:0};c.subtotal=Number((c.subtotal+n).toFixed(2)),c.cantidadItems+=Number(i.cantidad||1),t.set(r,c)});const a=Array.from(t.values());return e.cuentasDivididas=a,a}getAvailableSubAccountNames(e){const s=new Set(["Cuenta 1 (Familia A)","Cuenta 2 (Familia B)"]);return Array.isArray(e.subAccountsCatalog)&&e.subAccountsCatalog.forEach(t=>s.add(t)),(e.items||[]).forEach(t=>{t&&t.subcuenta&&s.add(t.subcuenta)}),(e.cuentasDivididas||[]).forEach(t=>{t&&t.nombre&&s.add(t.nombre)}),Array.from(s)}addOrderSubAccount(e){const s=this.orders.find(h=>h.id===e);if(!s)return;const t=this.getAvailableSubAccountNames(s),a=t.length+1,i=String.fromCharCode(64+Math.min(a,26)),r=`Cuenta ${a} (Familia ${i})`,n=window.prompt(`Mesa ${s.mesa} — Nombre de la nueva Cuenta o Familia:`,r);if(n===null)return;const c=n.trim()||r;s.subAccountsCatalog=Array.from(new Set([...t,c])),this.saveOrdersToStorage(),this.broadcastOrderUpdate(s),this.renderAll(),this.showAlertBanner(`✓ ${c} habilitada en Mesa ${s.mesa}`)}reassignItemSubAccount(e,s,t){const a=this.orders.find(i=>i.id===e);!a||!Array.isArray(a.items)||!a.items[s]||(a.items[s].subcuenta=t,this.computeOrderSubAccounts(a),a.updatedAt=new Date().toISOString(),a.estado==="Atendido"&&this.recordOrderInTableHistory(a),this.saveOrdersToStorage(),this.broadcastOrderUpdate(a),this.renderAll(),this.showAlertBanner(`✓ Ítem asignado a ${t} en Mesa ${a.mesa}`))}updateOrderVerification(e,{montoCorroborado:s,verificadoCaja:t}){const a=this.orders.find(i=>i.id===e);a&&(s!==void 0&&(a.montoCorroborado=s),t!==void 0&&(a.verificadoCaja=!!t),a.updatedAt=new Date().toISOString(),a.estado==="Atendido"&&this.recordOrderInTableHistory(a),this.saveOrdersToStorage(),this.broadcastOrderUpdate(a),this.renderAll())}broadcastOrderUpdate(e){const s={type:"UPDATE_ORDER_STATUS",eventType:"ESTADO_ACTUALIZADO",orderId:e.id,estado:e.estado,order:e};this.ws&&this.ws.readyState===WebSocket.OPEN&&this.ws.send(JSON.stringify(s)),this.channel.postMessage(s)}updateOrderStatus(e,s){const t=this.orders.find(i=>i.id===e);if(!t)return;const a=Number(t.total||0);if(s==="Atendido"&&a>0){const i=t.montoCorroborado!==null&&t.montoCorroborado!==void 0&&t.montoCorroborado!==""?Number(t.montoCorroborado):a;if(Math.abs(i-a)>1){const r=Math.abs(i-a);if(!window.confirm(`Mesa ${t.mesa}: El monto anotado en caja (${this.formatGuaranies(i)}) tiene una diferencia de ${this.formatGuaranies(r)} respecto al total de la mesa (${this.formatGuaranies(a)}). ¿Confirmas cobrar y cerrar la mesa de todos modos?`))return}t.montoCorroborado=i,t.verificadoCaja=!0,t.cobradoAt=new Date().toISOString()}t.estado=s,t.updatedAt=new Date().toISOString(),s==="Atendido"&&this.recordOrderInTableHistory(t),this.saveOrdersToStorage(),this.broadcastOrderUpdate(t),this.renderAll(),this.showAlertBanner(s==="Atendido"?`✓ Mesa ${t.mesa} cobrada (${this.formatGuaranies(a)}) y guardada en Historial`:`✓ Mesa ${t.mesa} marcada como "${s}"`)}archiveOrders(e=!0){const s=e?this.orders.filter(t=>t.estado==="Atendido"):[...this.orders];if(s.length>0){s.forEach(t=>this.recordOrderInTableHistory(t));try{const t=localStorage.getItem(O),a=t?JSON.parse(t):[];a.unshift({closedAt:new Date().toISOString(),closedBy:this.waiterId,sector:this.assignedSector,ordersCount:s.length,totalRevenue:s.reduce((i,r)=>i+Number(r.total||0),0),orders:s}),localStorage.setItem(O,JSON.stringify(a.slice(0,30)))}catch(t){console.warn("No se pudo guardar archivo histórico del turno:",t)}}e?this.orders=this.orders.filter(t=>t.estado!=="Atendido"):this.orders=[],this.saveOrdersToStorage(),this.ws&&this.ws.readyState===WebSocket.OPEN&&this.ws.send(JSON.stringify({type:"CLEAR_SHIFT",eventType:"TURNO_ACTUALIZADO",onlyAttended:e})),this.channel.postMessage({eventType:"TURNO_ACTUALIZADO"}),this.renderAll()}getFilteredOrders(){return this.orders.filter(e=>{let s=!0;this.sectorFilter==="ASSIGNED"?s=e.sector.toLowerCase()===this.assignedSector.toLowerCase():this.sectorFilter!=="ALL"&&(s=e.sector.toLowerCase()===this.sectorFilter.toLowerCase());const t=this.statusFilter==="ALL"||e.estado===this.statusFilter;return s&&t})}renderAll(){this.renderMetrics(),this.renderTablesHistory(),this.renderOrderCards()}renderMetrics(){const e=this.orders.filter(n=>this.sectorFilter==="ASSIGNED"?n.sector.toLowerCase()===this.assignedSector.toLowerCase():this.sectorFilter==="ALL"?!0:n.sector.toLowerCase()===this.sectorFilter.toLowerCase()),s=e.filter(n=>n.estado==="Pendiente").length,t=e.filter(n=>n.estado==="Cargado en Caja").length,a=e.filter(n=>n.estado==="Atendido").length,i=e.reduce((n,c)=>n+Number(c.total||0),0);document.getElementById("count-pendientes").textContent=String(s),document.getElementById("count-caja").textContent=String(t),document.getElementById("count-atendidos").textContent=String(a);const r=document.getElementById("total-shift-revenue");r&&(r.textContent=this.formatGuaranies(i))}renderTablesHistory(){const e=document.getElementById("tables-history-list"),s=document.getElementById("history-count-badge"),t=document.getElementById("hist-closed-count"),a=document.getElementById("hist-collected-total"),i=document.getElementById("hist-pending-total"),r=new Map;this.orders.filter(o=>o&&o.estado==="Atendido").forEach(o=>r.set(o.id,o)),(this.tableHistory||[]).forEach(o=>{o&&o.id&&!r.has(o.id)&&r.set(o.id,o)});const n=Array.from(r.values()).sort((o,l)=>new Date(l.cobradoAt||l.timestamp||0)-new Date(o.cobradoAt||o.timestamp||0)),c=n.reduce((o,l)=>o+Number(l.total||0),0),h=this.orders.filter(o=>o&&o.estado!=="Atendido").reduce((o,l)=>o+Number(l.total||0),0);if(s&&(s.textContent=String(n.length)),t&&(t.textContent=String(n.length)),a&&(a.textContent=this.formatGuaranies(c)),i&&(i.textContent=this.formatGuaranies(h)),!!e){if(n.length===0){e.innerHTML=`
        <div class="empty-orders-box" style="padding: 20px;">
          <p>Aún no hay mesas cobradas o cerradas en el historial de este turno.<br/>
          <small>Cuando marques una comanda como <strong>"Atendido / Cobrar Mesa"</strong> aparecerá aquí con sus subcuentas y hora exacta para el arqueo de caja.</small></p>
        </div>
      `;return}e.innerHTML=n.map(o=>{const l=this.computeOrderSubAccounts(o),u=new Date(o.cobradoAt||o.updatedAt||o.timestamp).toLocaleTimeString("es-ES",{hour:"2-digit",minute:"2-digit",second:"2-digit"}),g=l.filter(f=>f.subtotal>0).map(f=>`<span class="history-sub-pill">${f.nombre}: ${this.formatGuaranies(f.subtotal)}</span>`).join(""),m=o.montoCorroborado!==null&&o.montoCorroborado!==void 0?Number(o.montoCorroborado):Number(o.total||0);return`
          <div class="history-table-row">
            <div class="history-row-top">
              <div>
                <span class="history-row-title">MESA ${o.mesa} · ${o.sector}</span>
                <span class="history-row-time"> · ID ${o.id} · Hora cobro: ${u} · Mozo: ${(o.mesero_id||this.waiterId).toUpperCase()}</span>
              </div>
              <span class="history-row-total">${this.formatGuaranies(o.total||0)}</span>
            </div>
            <div class="history-row-subaccounts">
              ${g||'<span class="history-sub-pill">Sin consumo monetario</span>'}
              <span class="history-verified-tag">✓ Corroborado en Caja: ${this.formatGuaranies(m)}</span>
            </div>
          </div>
        `}).join("")}}renderOrderCards(){const e=document.getElementById("orders-grid");if(!e)return;const s=this.getFilteredOrders();if(e.innerHTML="",s.length===0){e.innerHTML=`
        <div class="empty-orders-box">
          <h3>Sin comandas en esta vista</h3>
          <p>Esperando nuevos pedidos en tiempo real para <strong>${this.sectorFilter==="ASSIGNED"?this.assignedSector:this.sectorFilter}</strong>...<br/><small>El historial del turno permanece guardado en este dispositivo aunque recargues o se apague la pantalla.</small></p>
        </div>
      `;return}s.forEach(t=>{const a=t.estado==="Pendiente"?"status-pendiente":t.estado==="Cargado en Caja"?"status-caja":"status-atendido",i=t.estado==="Pendiente"?"pendiente":t.estado==="Cargado en Caja"?"caja":"atendido",r=new Date(t.timestamp).toLocaleTimeString("es-ES",{hour:"2-digit",minute:"2-digit",second:"2-digit"}),n=this.computeOrderSubAccounts(t),c=this.getAvailableSubAccountNames(t),h=(t.items||[]).map((d,p)=>{const A=d.nombreBase||d.nombre;let S="";Array.isArray(d.opcionesDetalle)&&d.opcionesDetalle.length>0?S=`<div class="item-variants-wrap">${d.opcionesDetalle.map(I=>`<span class="item-variant-tag"><strong>${I.grupo}:</strong> ${I.valor}</span>`).join("")}</div>`:d.resumenOpciones&&(S=`<div class="item-variants-wrap"><span class="item-variant-tag">${d.resumenOpciones}</span></div>`);const x=d.subcuenta||"Cuenta 1 (Familia A)",B=c.map(y=>`<option value="${y}" ${y===x?"selected":""}>${y}</option>`).join(""),H=t.tipo!=="LLAMADO_MESERO"?`
              <div class="waiter-item-subaccount-row">
                <span class="waiter-item-subaccount-label">Cuenta / Familia:</span>
                <select class="waiter-item-subaccount-select" data-item-index="${p}" aria-label="Asignar ítem a cuenta o familia">
                  ${B}
                </select>
              </div>
            `:"";return`
          <li class="comanda-item-li">
            <div class="comanda-item-main">
              <div class="comanda-item-title-row">
                <span class="item-qty-badge">${d.cantidad}x</span>
                <span>${A}</span>
              </div>
              ${S}
              ${H}
            </div>
            <span class="comanda-item-subtotal">${d.subtotal>0?this.formatGuaranies(d.subtotal):""}</span>
          </li>
        `}).join(""),o=n.map(d=>`
          <div class="comanda-split-row">
            <span>${d.nombre} <small>(${d.cantidadItems} ítem${d.cantidadItems===1?"":"s"})</small></span>
            <strong>${this.formatGuaranies(d.subtotal)}</strong>
          </div>
        `).join(""),l=t.tipo!=="LLAMADO_MESERO"&&Number(t.total||0)>0?`
          <div class="comanda-split-box">
            <div class="comanda-split-header">
              <span>Cuentas Divididas en Mesa (Subtotales)</span>
              <button type="button" class="comanda-split-add-btn" data-action="add-subaccount">+ Dividir / Nueva Familia</button>
            </div>
            ${o}
          </div>
        `:"",u=Number(t.total||0),g=t.montoCorroborado!==null&&t.montoCorroborado!==void 0&&t.montoCorroborado!==""?Number(t.montoCorroborado):u,m=g-u,f=Math.abs(m)<=1,M=t.tipo!=="LLAMADO_MESERO"&&u>0?`
          <div class="comanda-verify-box ${t.verificadoCaja?"verified":""}">
            <div class="verify-box-title">Verificación de Total Antes de Cobrar (Caja / Mozo)</div>
            <div class="verify-input-row">
              <input
                type="number"
                class="verify-amount-input"
                data-action="verify-input"
                value="${Math.round(g)}"
                min="0"
                step="500"
                aria-label="Monto en caja o anotación del mozo"
              />
              <button type="button" class="verify-equal-btn" data-action="verify-equal">
                = Igualar (${this.formatGuaranies(u)})
              </button>
            </div>
            <div class="verify-diff-badge ${f?"match":"mismatch"}" data-role="verify-badge">
              ${f?`✓ Monto corroborado: Coincide exacto con el total (${this.formatGuaranies(u)})`:`⚠ Diferencia: ${this.formatGuaranies(Math.abs(m))} (${m>0?"Sobra":"Falta"} respecto a ${this.formatGuaranies(u)})`}
            </div>
            <label class="verify-checkbox-label">
              <input
                type="checkbox"
                data-action="verify-check"
                ${t.verificadoCaja?"checked":""}
              />
              <span>Total corroborado por el mozo contra caja antes de cobrar</span>
            </label>
          </div>
        `:"",b=document.createElement("article");b.className=`comanda-card ${a}`,b.innerHTML=`
        <div class="comanda-top">
          <div class="mesa-huge-badge">
            <span class="mesa-number">MESA ${t.mesa}</span>
            <span class="mesa-sector">Sector: ${t.sector} · Mesero: ${(t.mesero_id||"juan").toUpperCase()}</span>
          </div>
          <span class="status-badge ${i}">${t.estado}</span>
        </div>

        <div class="comanda-meta">
          <span>ID: <strong>${t.id}</strong> (${t.tipo==="LLAMADO_MESERO"?"Llamado de Mesa":"Comanda"})</span>
          <span>Hora: ${r}</span>
        </div>

        <ul class="comanda-items">
          ${h}
        </ul>

        ${l}

        <div class="comanda-total-row">
          <span>Total General Mesa ${t.mesa}</span>
          <strong>${this.formatGuaranies(u)}</strong>
        </div>

        ${M}

        <div class="comanda-actions">
          <button
            type="button"
            class="action-btn btn-pos"
            data-action="pos"
            ${t.estado==="Cargado en Caja"||t.estado==="Atendido"?"disabled":""}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
            <span>Cargado en Caja</span>
          </button>
          <button
            type="button"
            class="action-btn btn-attended"
            data-action="attended"
            ${t.estado==="Atendido"?"disabled":""}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
            <span>${u>0?"Cobrar / Atendido":"Atendido"}</span>
          </button>
        </div>
      `,b.querySelectorAll(".waiter-item-subaccount-select").forEach(d=>{d.addEventListener("change",p=>{const A=Number(d.dataset.itemIndex);this.reassignItemSubAccount(t.id,A,p.target.value)})});const C=b.querySelector('[data-action="add-subaccount"]');C&&C.addEventListener("click",()=>{this.addOrderSubAccount(t.id)});const v=b.querySelector('[data-action="verify-input"]'),E=b.querySelector('[data-action="verify-equal"]'),L=b.querySelector('[data-action="verify-check"]');v&&v.addEventListener("change",d=>{const p=Math.max(0,Number(d.target.value)||0);this.updateOrderVerification(t.id,{montoCorroborado:p,verificadoCaja:Math.abs(p-u)<=1?!0:t.verificadoCaja})}),E&&E.addEventListener("click",()=>{this.updateOrderVerification(t.id,{montoCorroborado:u,verificadoCaja:!0}),this.showAlertBanner(`✓ Total de Mesa ${t.mesa} corroborado (${this.formatGuaranies(u)})`)}),L&&L.addEventListener("change",d=>{this.updateOrderVerification(t.id,{montoCorroborado:v&&Number(v.value)||u,verificadoCaja:d.target.checked})}),b.querySelector('[data-action="pos"]').addEventListener("click",()=>{this.updateOrderStatus(t.id,"Cargado en Caja")}),b.querySelector('[data-action="attended"]').addEventListener("click",()=>{this.updateOrderStatus(t.id,"Atendido")}),e.appendChild(b)})}bindUIEvents(){document.getElementById("sector-filter").addEventListener("change",o=>{this.sectorFilter=o.target.value,this.saveWaiterPreferences(),this.renderAll()});const s=document.querySelectorAll(".status-pill");s.forEach(o=>{o.addEventListener("click",()=>{s.forEach(l=>l.classList.remove("active")),o.classList.add("active"),this.statusFilter=o.dataset.status,this.saveWaiterPreferences(),this.renderAll()})});const t=document.getElementById("toggle-history-btn"),a=document.getElementById("close-history-section-btn"),i=document.getElementById("tables-history-section");t&&i&&t.addEventListener("click",()=>{const o=i.classList.toggle("hidden");t.classList.toggle("active",!o),o||this.renderTablesHistory()}),a&&i&&a.addEventListener("click",()=>{i.classList.add("hidden"),t&&t.classList.remove("active")});const r=document.getElementById("sound-toggle-btn");r.addEventListener("click",()=>{this.soundEnabled=!0,r.classList.add("active"),this.playBellAlert(!1),this.showAlertBanner("Sonido de campana verificado y activo")});const n=document.getElementById("close-shift-modal"),c=document.getElementById("shift-modal-summary"),h=()=>{n.classList.add("hidden"),n.setAttribute("aria-hidden","true")};document.getElementById("close-shift-btn").addEventListener("click",()=>{const o=this.orders.filter(m=>m.estado==="Pendiente").length,l=this.orders.filter(m=>m.estado==="Cargado en Caja").length,u=this.orders.filter(m=>m.estado==="Atendido").length,g=this.orders.reduce((m,f)=>m+Number(f.total||0),0);c.innerHTML=`
        <strong>Resumen actual en memoria:</strong><br/>
        • Pendientes: <strong>${o}</strong> | Cargadas en Caja: <strong>${l}</strong> | Atendidas / Cobradas: <strong>${u}</strong><br/>
        • Recaudación en salón: <strong>${this.formatGuaranies(g)}</strong><br/>
        • Mesas en Historial del Turno: <strong>${this.tableHistory.length}</strong><br/><br/>
        Selecciona cómo deseas cerrar o limpiar el turno:
      `,n.classList.remove("hidden"),n.setAttribute("aria-hidden","false")}),document.getElementById("cancel-shift-modal-x").addEventListener("click",h),document.getElementById("cancel-shift-btn").addEventListener("click",h),document.getElementById("archive-attended-btn").addEventListener("click",()=>{this.archiveOrders(!0),h(),this.showAlertBanner("Órdenes atendidas archivadas en Historial. Pedidos pendientes conservados.")}),document.getElementById("reset-full-shift-btn").addEventListener("click",()=>{const o=this.orders.filter(l=>l.estado!=="Atendido").length;o>0&&!window.confirm(`Aún existen ${o} comanda(s) sin marcar como Atendidas. ¿Confirmas cerrar la caja completa y archivar todo el turno?`)||(this.archiveOrders(!1),h(),this.showAlertBanner("Turno cerrado y guardado en Historial de Mesas."))})}showAlertBanner(e){const s=document.getElementById("alert-banner"),t=document.getElementById("alert-banner-text");!s||!t||(t.textContent=e,s.classList.remove("hidden"),clearTimeout(this.bannerTimeout),this.bannerTimeout=setTimeout(()=>{s.classList.add("hidden")},3200))}}const N=()=>{window.waiterPanelApp||(window.waiterPanelApp=new k)};document.readyState==="loading"?window.addEventListener("DOMContentLoaded",N,{once:!0}):N();
