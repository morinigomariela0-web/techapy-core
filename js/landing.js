import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/**
 * Controlador de la Landing Editorial de TechaPY (`landing.html`):
 * - Renderiza el visor 3D interactivo embebido en el Hero con perfil de rendimiento adaptativo.
 * - Gestiona el Modal Unificado de "Iniciar Sesión" (Admin de Local, Mesero o SuperAdmin).
 * - Registra solicitudes de nuevos restaurantes en estado `"pendiente"` (`POST /api/public/register-tenant`)
 *   y abre WhatsApp con el mensaje prearmado de solicitud de activación.
 */
class TechaPYLandingApp {
  constructor() {
    this.viewport = document.getElementById('landing-3d-viewport');
    this.dimsTag = document.getElementById('landing-3d-dims-tag');
    this.showDims = true;
    this.isViewportVisible = true;

    this.perfProfile = this.detectPerformanceProfile();
    if (this.perfProfile.isLite) {
      document.body.classList.add('perf-lite');
    }

    this.demoCatalog = {
      ramen: {
        name: 'Tonkotsu Ramen Especial',
        price: 'Gs. 78.000',
        dims: '⌀ 22 cm · Altura 11 cm · Escala Real 1:1',
        radius: 1.05,
        url: './assets/tenants/demo/models/ramen.glb',
        scale: 1.08
      },
      burger: {
        name: 'Gyozas Artesanales a la Plancha',
        price: 'Gs. 45.000',
        dims: '⌀ 24 cm · Altura 6 cm · Escala Real 1:1',
        radius: 1.12,
        url: './assets/tenants/demo/models/burger.glb',
        scale: 1.02
      },
      dessert: {
        name: 'Trío de Mochi Imperial',
        price: 'Gs. 38.000',
        dims: '⌀ 20 cm · Altura 6 cm · Escala Real 1:1',
        radius: 0.98,
        url: './assets/tenants/demo/models/dessert.glb',
        scale: 1.05
      }
    };

    this.currentModel = null;
    this.cotaRing = null;
    this.demoGlbCache = new Map();
    this.clock = new THREE.Clock();

    // 1. Vincular todos los botones, formulario WhatsApp y modal Iniciar Sesión antes del visor 3D
    this.bindUIEvents();
    this.bindLoginModalEvents();

    // 2. Inicializar visor 3D embebido de forma resiliente con preview instantáneo
    if (this.viewport) {
      try {
        this.initEmbedded3DViewer();
        this.loadDemoModel('ramen');
      } catch (err) {
        console.warn('[Landing 3D] Visor WebGL en modo ligero:', err);
      }
    }
  }

  /**
   * Detecta capacidades del dispositivo y red para ajustar pixelRatio y efectos visuales.
   */
  detectPerformanceProfile() {
    const cores = Number(navigator.hardwareConcurrency) || 4;
    const memory = Number(navigator.deviceMemory) || 4;
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    const saveData = Boolean(conn && conn.saveData);
    const slowNet = Boolean(conn && ['slow-2g', '2g', '3g'].includes(conn.effectiveType));
    const reducedMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const isLite = saveData || slowNet || cores <= 4 || memory <= 3 || reducedMotion;
    const maxPixelRatio = isLite ? 1 : Math.min(window.devicePixelRatio || 1, 1.5);

    return { isLite, maxPixelRatio, reducedMotion };
  }

  initEmbedded3DViewer() {
    const width = this.viewport.clientWidth || 480;
    const height = this.viewport.clientHeight || 330;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, width / height, 0.1, 40);
    this.camera.position.set(0.3, 2.1, 3.1);

    this.renderer = new THREE.WebGLRenderer({
      antialias: !this.perfProfile.isLite,
      alpha: true,
      powerPreference: 'high-performance'
    });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(this.perfProfile.maxPixelRatio);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;

    this.viewport.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.enablePan = false;
    this.controls.minDistance = 1.8;
    this.controls.maxDistance = 4.6;
    this.controls.target.set(0, 0.25, 0);

    const ambient = new THREE.AmbientLight(0xffffff, 0.95);
    const keyLight = new THREE.DirectionalLight(0xfff1d6, 2.3);
    keyLight.position.set(3, 5, 3);
    const rimLight = new THREE.DirectionalLight(0xc5a059, 1.25);
    rimLight.position.set(-3, 2.5, -3);
    this.scene.add(ambient, keyLight, rimLight);

    this.gltfLoader = new GLTFLoader();

    window.addEventListener('resize', () => {
      if (!this.viewport) return;
      const w = this.viewport.clientWidth;
      const h = this.viewport.clientHeight;
      if (!w || !h) return;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
      this.renderer.setPixelRatio(this.perfProfile.maxPixelRatio);
    });

    if (typeof IntersectionObserver !== 'undefined') {
      const obs = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          this.isViewportVisible = entry.isIntersecting;
        });
      });
      obs.observe(this.viewport);
    }

    this.animate();
  }

  createQuickProceduralPreview(key) {
    const group = new THREE.Group();
    const plate = new THREE.Mesh(
      new THREE.CylinderGeometry(0.95, 0.76, 0.12, 36),
      new THREE.MeshStandardMaterial({ color: 0x1c212b, roughness: 0.25, metalness: 0.1 })
    );
    plate.position.y = 0.06;
    group.add(plate);

    const foodColor = key === 'ramen' ? 0xd4af37 : key === 'burger' ? 0xc5a059 : 0xe8998d;
    const food = new THREE.Mesh(
      new THREE.SphereGeometry(0.42, 24, 18),
      new THREE.MeshStandardMaterial({ color: foodColor, roughness: 0.35 })
    );
    food.scale.set(1, 0.65, 1);
    food.position.y = 0.28;
    group.add(food);
    return group;
  }

  loadDemoModel(key) {
    const item = this.demoCatalog[key] || this.demoCatalog.ramen;
    if (this.dimsTag) {
      this.dimsTag.textContent = item.dims;
    }
    if (!this.scene) return;

    if (this.currentModel) {
      this.scene.remove(this.currentModel);
      this.currentModel = null;
    }

    this.updateCotaRing(item.radius);

    if (this.demoGlbCache.has(item.url)) {
      const cachedClone = this.demoGlbCache.get(item.url).clone(true);
      this.currentModel = cachedClone;
      this.scene.add(cachedClone);
      return;
    }

    // Mostrar preview procedural inmediato en el primer frame mientras descarga el .glb
    const preview = this.createQuickProceduralPreview(key);
    this.currentModel = preview;
    this.scene.add(preview);

    this.gltfLoader.load(
      item.url,
      (gltf) => {
        const root = gltf.scene;
        const box = new THREE.Box3().setFromObject(root);
        const center = box.getCenter(new THREE.Vector3());
        root.position.x -= center.x;
        root.position.z -= center.z;
        root.position.y -= box.min.y;
        root.scale.setScalar(item.scale);
        this.demoGlbCache.set(item.url, root.clone(true));
        if (this.currentModel) {
          this.scene.remove(this.currentModel);
        }
        this.currentModel = root;
        this.scene.add(root);
      },
      undefined,
      (err) => {
        console.warn('Usando modelo procedural de respaldo en landing:', err);
      }
    );
  }

  updateCotaRing(radius = 1.05) {
    if (this.cotaRing) {
      this.scene.remove(this.cotaRing);
      this.cotaRing = null;
    }
    if (!this.showDims) return;

    const pts = [];
    const segs = 64;
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * radius, 0.015, Math.sin(a) * radius));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({ color: 0xc5a059, transparent: true, opacity: 0.78 });
    this.cotaRing = new THREE.Line(geo, mat);
    this.scene.add(this.cotaRing);
  }

  bindLoginModalEvents() {
    const openBtn = document.getElementById('open-login-modal-btn');
    const closeBtn = document.getElementById('close-login-modal-btn');
    const modal = document.getElementById('landing-login-modal');
    const roleSelect = document.getElementById('login-role');
    const tenantGroup = document.getElementById('login-tenant-group');
    const tenantInput = document.getElementById('login-tenant');
    const pinInput = document.getElementById('login-pin');
    const pinLabel = document.getElementById('login-pin-label');
    const errBox = document.getElementById('landing-login-error');
    const loginForm = document.getElementById('landing-login-form');

    if (!modal || !loginForm) return;

    const syncRoleFields = () => {
      const role = roleSelect.value;
      if (role === 'superadmin') {
        tenantGroup.classList.add('hidden');
        tenantInput.required = false;
        pinLabel.textContent = 'Contraseña Maestra SuperAdmin';
      } else {
        tenantGroup.classList.remove('hidden');
        tenantInput.required = true;
        pinLabel.textContent =
          role === 'admin' ? 'PIN de Administrador del Local' : 'PIN de Mesero de Salón';
      }
      errBox.classList.add('hidden');
    };

    roleSelect.addEventListener('change', syncRoleFields);
    syncRoleFields();

    if (openBtn) {
      openBtn.addEventListener('click', () => {
        errBox.classList.add('hidden');
        modal.classList.remove('hidden');
        pinInput.focus();
      });
    }

    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        modal.classList.add('hidden');
      });
    }

    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.classList.add('hidden');
      }
    });

    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      errBox.classList.add('hidden');
      const role = roleSelect.value;
      const tenant =
        role === 'superadmin'
          ? 'global'
          : (tenantInput.value || 'demo').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'demo';
      const pin = pinInput.value.trim();

      if (!pin) return;

      try {
        const res = await fetch('./api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tenant, role, pin })
        });
        const data = await res.json();
        if (!res.ok || !data || !data.ok) {
          errBox.textContent = (data && data.error) || 'Credenciales inválidas para el rol seleccionado.';
          errBox.classList.remove('hidden');
          return;
        }

        if (role === 'superadmin') {
          window.location.href = './superadmin.html';
        } else if (role === 'admin') {
          window.location.href = `./admin-menu.html?tenant=${encodeURIComponent(tenant)}`;
        } else {
          window.location.href = `./mesero.html?tenant=${encodeURIComponent(tenant)}&id=juan&sector=Terraza`;
        }
      } catch (err) {
        errBox.textContent = 'Error de conexión al verificar credenciales.';
        errBox.classList.remove('hidden');
      }
    });
  }

  bindUIEvents() {
    // Selector de platos del visor demo
    document.querySelectorAll('.demo-dish-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.demo-dish-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        this.loadDemoModel(btn.dataset.dish);
      });
    });

    // Toggle de cota dimensional 1:1 en el visor demo
    const toggleDimsBtn = document.getElementById('landing-toggle-dims');
    if (toggleDimsBtn) {
      toggleDimsBtn.addEventListener('click', () => {
        this.showDims = !this.showDims;
        toggleDimsBtn.textContent = `Cota 1:1: ${this.showDims ? 'Activa' : 'Oculta'}`;
        if (this.dimsTag) {
          this.dimsTag.style.display = this.showDims ? 'block' : 'none';
        }
        this.updateCotaRing(1.05);
      });
    }

    // Botones de planes -> Autocompletan el selector del formulario y hacen scroll
    document.querySelectorAll('.select-plan-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const planVal = btn.dataset.plan;
        const planSelect = document.getElementById('lead-plan');
        if (planSelect && planVal) {
          planSelect.value = planVal;
        }
        const contactSection = document.getElementById('agendar');
        if (contactSection) {
          contactSection.scrollIntoView({ behavior: 'smooth' });
        }
      });
    });

    // Formulario de solicitud -> Registra el tenant en estado "pendiente" y abre WhatsApp con solicitud de activación
    const form = document.getElementById('whatsapp-quote-form');
    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = document.getElementById('lead-name').value.trim();
        const restaurant = document.getElementById('lead-restaurant').value.trim();
        const rucEl = document.getElementById('lead-ruc');
        const ruc = rucEl ? rucEl.value.trim() : '80000000-0';
        const city = document.getElementById('lead-city').value.trim();
        const tables = document.getElementById('lead-tables').value;
        const plan = document.getElementById('lead-plan').value;
        const notes = document.getElementById('lead-notes').value.trim();
        const contactPhone = document.getElementById('lead-whatsapp').value.trim();
        const statusBox = document.getElementById('lead-registration-status');

        let assignedSlug = restaurant
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 26) || 'nuevo-local';
        let targetSalesWa = '595972736447';

        try {
          const res = await fetch('./api/public/register-tenant', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              nombre: restaurant,
              ruc,
              ciudad: city,
              plan,
              contactoNombre: name,
              contactoWhatsapp: contactPhone,
              capacidadMesas: tables
            })
          });
          const data = await res.json();
          if (res.ok && data && data.ok) {
            assignedSlug = data.tenant || assignedSlug;
            targetSalesWa = data.salesWhatsapp || targetSalesWa;
          }
        } catch (err) {
          console.warn('No se pudo pre-registrar el tenant en servidor:', err);
        }

        // Asegurar formato internacional limpio para wa.me (sin +, espacios ni 0 inicial)
        let cleanWaPhone = String(targetSalesWa || '595972736447').replace(/[^0-9]/g, '');
        if (cleanWaPhone.startsWith('09') && cleanWaPhone.length === 10) {
          cleanWaPhone = `595${cleanWaPhone.slice(1)}`;
        } else if (!cleanWaPhone) {
          cleanWaPhone = '595972736447';
        }

        if (statusBox) {
          statusBox.classList.remove('hidden');
          statusBox.innerHTML = `
            ✓ Solicitud registrada con estado <strong>PENDIENTE DE ACTIVACIÓN</strong>.<br/>
            • Identificador asignado (Slug): <code>${assignedSlug}</code><br/>
            • Tu cuenta será habilitada en el panel de <strong>SuperAdmin</strong> tras confirmar por WhatsApp.
          `;
        }

        const baseGreeting = `Hola TechaPY, solicito la activación de mi cuenta (estado pendiente) y agendar demostración para mi restaurante.`;
        const details = [
          `• Restaurante: ${restaurant}`,
          `• Slug / Tenant registrado: ${assignedSlug} (Estado: pendiente)`,
          `• RUC: ${ruc || 'A confirmar'}`,
          `• Contacto: ${name || 'A confirmar'} (${contactPhone || '—'})`,
          `• Ciudad/Zona: ${city || 'Asunción'}`,
          `• Capacidad: ${tables}`,
          `• Plan solicitado: ${plan}`
        ];
        if (notes) details.push(`• Horario sugerido: ${notes}`);

        const finalMessage = `${baseGreeting}\n\n${details.join('\n')}`;
        const waUrl = `https://wa.me/${cleanWaPhone}?text=${encodeURIComponent(finalMessage)}`;
        window.open(waUrl, '_blank', 'noopener,noreferrer');
      });
    }
  }

  animate() {
    requestAnimationFrame(() => this.animate());
    if (document.hidden || !this.isViewportVisible) return;

    const delta = Math.min(this.clock.getDelta(), 0.1);
    if (this.currentModel && !this.perfProfile.reducedMotion) {
      this.currentModel.rotation.y += delta * 0.32;
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}

const bootLandingApp = () => {
  if (!window.techaPYLandingApp) {
    window.techaPYLandingApp = new TechaPYLandingApp();
  }
};

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', bootLandingApp, { once: true });
} else {
  bootLandingApp();
}
