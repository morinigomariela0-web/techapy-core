import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/**
 * Controlador de la Landing Editorial de TechaPY (`landing.html`):
 * - Renderiza el visor 3D interactivo embebido en el Hero con modelos `.glb` reales
 *   (`ramen.glb`, `burger.glb`, `dessert.glb`) y guía de cota métrica 1:1 en bronce satinado.
 * - Conecta los botones de selección de planes con el formulario de demostración.
 * - Abre WhatsApp con el mensaje directo requerido:
 *   "Hola, me interesa agendar una demostración de TechaPY en mi local."
 */
class TechaPYLandingApp {
  constructor() {
    this.viewport = document.getElementById('landing-3d-viewport');
    this.dimsTag = document.getElementById('landing-3d-dims-tag');
    this.showDims = true;

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
    this.clock = new THREE.Clock();

    if (this.viewport) {
      this.initEmbedded3DViewer();
      this.loadDemoModel('ramen');
    }

    this.bindUIEvents();
  }

  initEmbedded3DViewer() {
    const width = this.viewport.clientWidth || 480;
    const height = this.viewport.clientHeight || 330;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, width / height, 0.1, 40);
    this.camera.position.set(0.3, 2.1, 3.1);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
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
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
    });

    this.animate();
  }

  loadDemoModel(key) {
    const item = this.demoCatalog[key] || this.demoCatalog.ramen;
    if (this.dimsTag) {
      this.dimsTag.textContent = item.dims;
    }

    if (this.currentModel) {
      this.scene.remove(this.currentModel);
      this.currentModel = null;
    }

    this.updateCotaRing(item.radius);

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
        this.currentModel = root;
        this.scene.add(root);
      },
      undefined,
      (err) => {
        console.error('Error cargando modelo demo en landing:', err);
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

    // Formulario de cotización -> Abre WhatsApp con mensaje directo de TechaPY
    const form = document.getElementById('whatsapp-quote-form');
    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const name = document.getElementById('lead-name').value.trim();
        const restaurant = document.getElementById('lead-restaurant').value.trim();
        const city = document.getElementById('lead-city').value.trim();
        const tables = document.getElementById('lead-tables').value;
        const plan = document.getElementById('lead-plan').value;
        const notes = document.getElementById('lead-notes').value.trim();
        const rawPhone = document.getElementById('lead-whatsapp').value.replace(/[^0-9]/g, '') || '595981000000';

        const baseGreeting = 'Hola, me interesa agendar una demostración de TechaPY en mi local.';
        const details = [];
        if (name) details.push(`• Contacto: ${name}`);
        if (restaurant) details.push(`• Restaurante: ${restaurant}`);
        if (city) details.push(`• Ciudad/Zona: ${city}`);
        if (tables) details.push(`• Capacidad: ${tables}`);
        if (plan) details.push(`• Plan: ${plan}`);
        if (notes) details.push(`• Horario sugerido: ${notes}`);

        const finalMessage = details.length > 0
          ? `${baseGreeting}\n\n${details.join('\n')}`
          : baseGreeting;

        const waUrl = `https://wa.me/${rawPhone}?text=${encodeURIComponent(finalMessage)}`;
        window.open(waUrl, '_blank', 'noopener,noreferrer');
      });
    }
  }

  animate() {
    requestAnimationFrame(() => this.animate());
    const delta = Math.min(this.clock.getDelta(), 0.1);
    if (this.currentModel) {
      this.currentModel.rotation.y += delta * 0.32;
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.techaPYLandingApp = new TechaPYLandingApp();
});
