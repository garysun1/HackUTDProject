// The 3D site: imagery ground, campus buildings, ECSW as translucent floors over its OSM footprint
// with the mapped ground-floor rooms, wearers as lit dots with a fading trail and a heat layer,
// photo pins. Top-down is the same scene through an orthographic camera.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { Proj, tileXY, tileBounds, centroid } from './geo';
const cssVar = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

export type LonLat = [number, number];
export type Building = { name?: string | null; kind?: string | null; height: number; pts: LonLat[] };
export type Room = { name?: string | null; indoor?: string | null; level?: string | null; pts: LonLat[] };
export type SiteData = {
  center: LonLat;
  main?: { name: string; levels: number; height: number; outer: LonLat[]; inner: LonLat[][] };
  indoor?: Room[];
  neighbors?: Building[];
  paths?: { highway: string; pts: LonLat[] }[];
  tileRadius?: number;
};
export type IssueSpec = { id: string; x: number; y: number; z: number; open: boolean; title: string; lift: number /* stacking order when several issues share a spot */ };
export type PinSpec = { id: string; x: number; y: number; z: number; color: string; time: string; alert: boolean; thumb?: string; selected: boolean; title: string; badge?: string /* a line pinned above the photo, e.g. the judging beat */ };
export type WearerSpec = { color: string; name: string; sub: string; pos: [number, number, number] | null; trail: number[] /* flat xyz */; acc?: number /* metres of GPS uncertainty, drawn as a ring */ };

const IMAGERY = (z: number, x: number, y: number) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
const rot = <T extends THREE.Object3D>(o: T): T => { o.rotation.x = -Math.PI / 2; return o; };

export class HeatLayer {
  canvas = document.createElement('canvas'); ctx: CanvasRenderingContext2D; tex: THREE.CanvasTexture; mesh: THREE.Mesh;
  private dirty = false;
  constructor(private minX: number, private maxX: number, private minZ: number, private maxZ: number, public color: string, size = 1024) {
    this.canvas.width = size; this.canvas.height = size; this.ctx = this.canvas.getContext('2d')!;
    this.tex = new THREE.CanvasTexture(this.canvas); this.tex.colorSpace = THREE.SRGBColorSpace;
    const g = new THREE.PlaneGeometry(maxX - minX, maxZ - minZ);
    this.mesh = rot(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthWrite: false, opacity: 0.9 })));
    this.mesh.position.set((minX + maxX) / 2, 0.14, (minZ + maxZ) / 2); this.mesh.renderOrder = 2;
  }
  reset() { this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); this.dirty = true; }
  // w: seconds spent around this point
  add(x: number, z: number, w: number) {
    const px = ((x - this.minX) / (this.maxX - this.minX)) * this.canvas.width;
    const py = ((z - this.minZ) / (this.maxZ - this.minZ)) * this.canvas.height;
    const r = (6 / (this.maxX - this.minX)) * this.canvas.width;
    const a = Math.min(0.12, Math.max(0.01, w / 600)); // 30 s at a spot ≈ 0.05; saturates after ~10 min
    const g = this.ctx.createRadialGradient(px, py, 0, px, py, r);
    g.addColorStop(0, hexA(this.color, a)); g.addColorStop(1, hexA(this.color, 0));
    this.ctx.fillStyle = g; this.ctx.fillRect(px - r, py - r, 2 * r, 2 * r); this.dirty = true;
  }
  flush() { if (this.dirty) { this.tex.needsUpdate = true; this.dirty = false; } }
}
function hexA(hex: string, a: number) { const c = new THREE.Color(hex); return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${a})`; }

type WearerVis = { head: THREE.Mesh; ring: THREE.Mesh; accRing: THREE.Mesh; beam: THREE.Mesh; light: THREE.PointLight; line: Line2; geom: LineGeometry; label: CSS2DObject; labelEl: HTMLElement; color: THREE.Color; n: number; born: number };
type PinVis = { obj: CSS2DObject; el: HTMLElement; pole: THREE.Mesh; sig: string };
type IssueVis = { obj: CSS2DObject; el: HTMLElement; pole: THREE.Mesh; ring: THREE.Mesh; open: boolean | null; born: number; solvedAt: number };

export class SiteScene {
  renderer: THREE.WebGLRenderer; labels: CSS2DRenderer; scene = new THREE.Scene();
  persp: THREE.PerspectiveCamera; ortho: THREE.OrthographicCamera; ctrl3d: OrbitControls; ctrl2d: OrbitControls;
  mode: '3d' | '2d' = '3d'; follow = false; followPos: THREE.Vector3 | null = null; followId: string | null = null;
  proj!: Proj; floorH = 3.6; beamH = 24; levels = 1; site = new THREE.Group(); ground = new THREE.Group(); heat: HeatLayer | null = null;
  wearers = new Map<string, WearerVis>(); pins = new Map<string, PinVis>(); issues = new Map<string, IssueVis>(); roomLabels: CSS2DObject[] = []; bldLabels: CSS2DObject[] = []; upper: THREE.Object3D[] = [];
  onPinClick: (id: string) => void = () => {}; onPinHover: (id: string | null, x: number, y: number) => void = () => {};
  onIssueClick: (id: string) => void = () => {}; onIssueHover: (id: string | null, x: number, y: number) => void = () => {};
  private clock = new THREE.Clock(); private materials: { m: THREE.Material; role: string }[] = []; private lineMats: LineMaterial[] = [];
  private sun: THREE.DirectionalLight; private hemi: THREE.HemisphereLight;

  constructor(canvas: HTMLCanvasElement, labelsEl: HTMLElement, private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.labels = new CSS2DRenderer({ element: labelsEl });
    const asp = Math.max(0.2, host.clientWidth / Math.max(1, host.clientHeight));
    this.persp = new THREE.PerspectiveCamera(42, asp, 0.5, 5000); this.persp.position.set(150, 125, 185);
    const o = 140; this.ortho = new THREE.OrthographicCamera(-o * asp, o * asp, o, -o, 0.5, 5000); this.ortho.position.set(0, 600, 0.001); this.ortho.up.set(0, 0, -1); this.ortho.lookAt(0, 0, 0);
    this.ctrl3d = new OrbitControls(this.persp, canvas); this.ctrl3d.enableDamping = true; this.ctrl3d.dampingFactor = 0.08; this.ctrl3d.maxPolarAngle = Math.PI / 2 - 0.04; this.ctrl3d.minDistance = 18; this.ctrl3d.maxDistance = 900; this.ctrl3d.target.set(0, 4, 0);
    this.ctrl2d = new OrbitControls(this.ortho, canvas); this.ctrl2d.enableRotate = false; this.ctrl2d.enableDamping = true; this.ctrl2d.dampingFactor = 0.1; this.ctrl2d.minZoom = 0.35; this.ctrl2d.maxZoom = 8; this.ctrl2d.enabled = false;
    this.ctrl2d.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }; this.ctrl2d.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
    for (const c of [this.ctrl3d, this.ctrl2d]) c.addEventListener('start', () => { this.userView = true; if (this.follow) this.setFollow(false, true); });
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x9a968c, 1.1); this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffffff, 1.7); this.sun.position.set(140, 260, 90); this.sun.castShadow = true;
    const sc = this.sun.shadow.camera; sc.left = sc.bottom = -380; sc.right = sc.top = 380; sc.near = 10; sc.far = 800; this.sun.shadow.mapSize.set(2048, 2048); this.sun.shadow.bias = -0.0006; this.sun.shadow.normalBias = 0.6;
    this.scene.add(this.sun); this.scene.add(this.ground); this.scene.add(this.site);
    this.applyTheme();
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.applyTheme());
    new ResizeObserver(() => this.resize()).observe(host); this.resize();
  }
  userView = false;
  /** Back to the opening framing of the site. */
  resetView() { this.userView = false; this.setFollow(false); if (this.home) { this.ctrl3d.target.copy(this.home.target); this.persp.position.copy(this.home.pos); this.ctrl2d.target.set(this.home.target.x, 0, this.home.target.z); this.ortho.position.set(this.home.target.x, 600, this.home.target.z + 0.001); this.ortho.zoom = 1; this.ortho.updateProjectionMatrix(); } }
  private home: { target: THREE.Vector3; pos: THREE.Vector3 } | null = null;
  private setHome() { this.home = { target: this.ctrl3d.target.clone(), pos: this.persp.position.clone() }; }

  get camera() { return this.mode === '3d' ? this.persp : this.ortho; }
  resize() {
    const w = Math.max(1, this.host.clientWidth), h = Math.max(1, this.host.clientHeight), asp = w / h;
    this.renderer.setSize(w, h); this.labels.setSize(w, h);
    this.persp.aspect = asp; this.persp.updateProjectionMatrix();
    const o = 140; this.ortho.left = -o * asp; this.ortho.right = o * asp; this.ortho.top = o; this.ortho.bottom = -o; this.ortho.updateProjectionMatrix();
    for (const m of this.lineMats) m.resolution.set(w, h);
  }
  applyTheme() {
    const v = (n: string, d: string) => cssVar(n) || d;
    this.scene.background = new THREE.Color(v('--scene-bg', '#e9ebe7'));
    this.scene.fog = new THREE.Fog(new THREE.Color(v('--scene-fog', '#e9ebe7')), 700, 1900);
    const dark = matchMedia('(prefers-color-scheme: dark)').matches && document.documentElement.dataset.theme !== 'light' || document.documentElement.dataset.theme === 'dark';
    this.hemi.intensity = dark ? 0.7 : 1.1; this.sun.intensity = dark ? 1.1 : 1.7; this.renderer.toneMappingExposure = dark ? 0.95 : 1.05;
    for (const { m, role } of this.materials) {
      const mm = m as any;
      if (role === 'bld') mm.color.set(v('--bld', '#ecebe6'));
      if (role === 'edge') mm.color.set(v('--bld-edge', '#a9a8a2'));
      if (role === 'glass') mm.color.set(v('--glass', '#8fb0e6'));
      if (role === 'slab') mm.color.set(v('--slab', '#f3f2ee'));
      if (role === 'room') mm.color.set(v('--room', '#7d7c77'));
      if (role === 'path') mm.color.set(v('--line-strong', '#d4d4cf'));
      if (role === 'imagery') mm.color.set(dark ? '#a6a6a4' : '#d6d6d3');
      if (role === 'pole') mm.color.set(v('--ink-4', '#8a8982'));
    }
    if (this.heat) this.heat.color = v('--heat', '#eb6834');
  }
  private mat<T extends THREE.Material>(m: T, role: string): T { this.materials.push({ m, role }); return m; }

  // ---------- site ----------
  private disposeGroup(g: THREE.Group) {
    g.traverse(o => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); const mat = m.material as THREE.Material | undefined; if (mat && !Array.isArray(mat)) { const t = (mat as any).map as THREE.Texture | undefined; t?.dispose(); mat.dispose(); } if ((o as any).isCSS2DObject) (o as CSS2DObject).element.remove(); });
    g.clear();
  }
  buildSite(data: SiteData) {
    this.disposeGroup(this.site); this.disposeGroup(this.ground); this.materials = this.materials.filter(e => e.role === 'pole'); this.roomLabels = []; this.bldLabels = []; this.upper = [];
    for (const w of this.wearers.values()) { this.scene.remove(w.head, w.ring, w.beam, w.light, w.line, w.label); } this.wearers.clear();
    for (const p of this.pins.values()) { this.scene.remove(p.obj, p.pole); } this.pins.clear();
    for (const v of this.issues.values()) { this.scene.remove(v.obj, v.pole, v.ring); v.el.remove(); } this.issues.clear();
    if (this.heat) { this.scene.remove(this.heat.mesh); this.heat.tex.dispose(); this.heat.mesh.geometry.dispose(); this.heat = null; }
    const [lon0, lat0] = data.center; this.proj = new Proj(lon0, lat0);
    this.buildGround(lon0, lat0, data.tileRadius ?? 4);
    // campus paths
    const pathMat = this.mat(new THREE.LineBasicMaterial({ transparent: true, opacity: 0.55 }), 'path');
    for (const p of data.paths ?? []) {
      const pts = p.pts.map(([lon, lat]) => { const [x, z] = this.proj.toXZ(lon, lat); return new THREE.Vector3(x, 0.06, z); });
      this.ground.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), pathMat));
    }
    // neighbours
    const bldMat = this.mat(new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0 }), 'bld');
    const edgeMat = this.mat(new THREE.LineBasicMaterial({ transparent: true, opacity: 0.6 }), 'edge');
    for (const b of data.neighbors ?? []) {
      const shape = this.shape(b.pts); if (!shape) continue;
      const g = new THREE.ExtrudeGeometry(shape, { depth: b.height, bevelEnabled: false });
      const m = rot(new THREE.Mesh(g, bldMat)); m.castShadow = true; m.receiveShadow = true; this.site.add(m);
      this.site.add(rot(new THREE.LineSegments(new THREE.EdgesGeometry(g, 25), edgeMat)));
      if (b.name && !/^\d+$/.test(b.name)) {
        const [cx, cy] = centroid(b.pts); const [x, z] = this.proj.toXZ(cx, cy);
        const el = document.createElement('div'); el.className = 's3-lbl bld'; el.textContent = b.name;
        const lo = new CSS2DObject(el); lo.position.set(x, b.height + 2, z); this.site.add(lo); this.bldLabels.push(lo);
      }
    }
    // main building
    if (data.main) {
      const M = data.main; this.floorH = M.height / M.levels; this.beamH = M.height + 3; this.levels = M.levels;
      const shape = this.shape(M.outer, M.inner)!;
      const glass = this.mat(new THREE.MeshPhysicalMaterial({ transparent: true, opacity: 0.13, roughness: 0.15, metalness: 0, side: THREE.DoubleSide, depthWrite: false }), 'glass');
      const walls = new THREE.ExtrudeGeometry(shape, { depth: M.height, bevelEnabled: false });
      const wm = rot(new THREE.Mesh(walls, glass)); wm.renderOrder = 5; this.site.add(wm); this.upper.push(wm);
      const we = rot(new THREE.LineSegments(new THREE.EdgesGeometry(walls, 20), edgeMat)); this.site.add(we); this.upper.push(we);
      const slabMat = (op: number) => this.mat(new THREE.MeshStandardMaterial({ transparent: true, opacity: op, side: THREE.DoubleSide, depthWrite: false, roughness: 1 }), 'slab');
      const slabGeom = new THREE.ShapeGeometry(shape);
      for (let i = 0; i <= M.levels; i++) {
        const y = i * this.floorH + (i === 0 ? 0.04 : 0.02);
        const s = rot(new THREE.Mesh(slabGeom, slabMat(i === 0 ? 0.78 : i === M.levels ? 0.1 : 0.22))); s.position.y = y; s.renderOrder = 1; s.receiveShadow = i === 0; this.site.add(s);
        const e = rot(new THREE.LineSegments(new THREE.EdgesGeometry(slabGeom), edgeMat)); e.position.y = y + 0.01; this.site.add(e);
        if (i > 0) this.upper.push(s, e);
      }
      const el = document.createElement('div'); el.className = 's3-lbl bld'; el.textContent = M.name;
      const [cx, cy] = centroid(M.outer); const [x, z] = this.proj.toXZ(cx, cy); const lo = new CSS2DObject(el); lo.position.set(x, M.height + 4, z); this.site.add(lo); this.bldLabels.push(lo);
      // rooms on the ground floor
      const roomMat = this.mat(new THREE.LineBasicMaterial({ transparent: true, opacity: 0.5 }), 'room');
      for (const r of data.indoor ?? []) {
        if (r.pts.length < 3) continue;
        const pts = r.pts.map(([lon, lat]) => { const [x, z] = this.proj.toXZ(lon, lat); return new THREE.Vector3(x, 0.12, z); });
        this.site.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), roomMat));
        if (r.name) {
          const [cx, cy] = centroid(r.pts); const [x, z] = this.proj.toXZ(cx, cy);
          const el = document.createElement('div'); el.className = 's3-lbl'; el.textContent = r.name;
          const lo = new CSS2DObject(el); lo.position.set(x, 0.6, z); this.site.add(lo); this.roomLabels.push(lo);
        }
      }
      // heat layer over the footprint
      const xs = M.outer.map(p => this.proj.toXZ(p[0], p[1]));
      const minX = Math.min(...xs.map(p => p[0])) - 25, maxX = Math.max(...xs.map(p => p[0])) + 25, minZ = Math.min(...xs.map(p => p[1])) - 25, maxZ = Math.max(...xs.map(p => p[1])) + 25;
      this.heat = new HeatLayer(minX, maxX, minZ, maxZ, cssVar('--heat') || '#eb6834'); this.scene.add(this.heat.mesh);
      this.ctrl3d.target.set(x, 4, z); this.persp.position.set(x + 150, 125, z + 185); this.ctrl2d.target.set(x, 0, z); this.ortho.position.set(x, 600, z + 0.001); this.setHome();
    } else {
      this.floorH = 3.6; this.beamH = 9; this.levels = 1;
      this.heat = new HeatLayer(-160, 160, -160, 160, cssVar('--heat') || '#eb6834'); this.scene.add(this.heat.mesh);
    }
    this.applyTheme();
  }
  // a generic hall for datasets without a mapped building: a translucent box around the walk
  buildHall(minX: number, maxX: number, minZ: number, maxZ: number, name: string) {
    const glass = this.mat(new THREE.MeshPhysicalMaterial({ transparent: true, opacity: 0.12, roughness: 0.2, side: THREE.DoubleSide, depthWrite: false }), 'glass');
    const edgeMat = this.mat(new THREE.LineBasicMaterial({ transparent: true, opacity: 0.6 }), 'edge');
    const g = new THREE.BoxGeometry(maxX - minX, 6, maxZ - minZ); const m = new THREE.Mesh(g, glass); m.position.set((minX + maxX) / 2, 3, (minZ + maxZ) / 2); m.renderOrder = 5; this.site.add(m);
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(g), edgeMat); e.position.copy(m.position); this.site.add(e); this.upper.push(m);
    const el = document.createElement('div'); el.className = 's3-lbl bld'; el.textContent = name; const lo = new CSS2DObject(el); lo.position.set(m.position.x, 8, m.position.z); this.site.add(lo);
    if (this.heat) { this.scene.remove(this.heat.mesh); } this.heat = new HeatLayer(minX - 20, maxX + 20, minZ - 20, maxZ + 20, cssVar('--heat') || '#eb6834'); this.scene.add(this.heat.mesh);
    this.ctrl3d.target.set(m.position.x, 3, m.position.z); this.persp.position.set(m.position.x + 90, 70, m.position.z + 110); this.ctrl2d.target.set(m.position.x, 0, m.position.z); this.ortho.position.set(m.position.x, 600, m.position.z + 0.001); this.setHome();
  }
  private shape(outer: LonLat[], holes: LonLat[][] = []): THREE.Shape | null {
    if (outer.length < 3) return null;
    const s = new THREE.Shape(outer.map(([lon, lat]) => new THREE.Vector2(...this.proj.toShape(lon, lat))));
    for (const h of holes) if (h.length >= 3) s.holes.push(new THREE.Path(h.map(([lon, lat]) => new THREE.Vector2(...this.proj.toShape(lon, lat)))));
    return s;
  }
  private buildGround(lon0: number, lat0: number, radius: number) {
    const z = 19; const [tx, ty] = tileXY(lon0, lat0, z); const loader = new THREE.TextureLoader(); loader.setCrossOrigin('anonymous');
    const imgMat = () => this.mat(new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 }), 'imagery');
    for (let dx = -radius; dx <= radius; dx++) for (let dy = -radius; dy <= radius; dy++) {
      const b = tileBounds(tx + dx, ty + dy, z);
      const [x0, z0] = this.proj.toXZ(b.w, b.n), [x1, z1] = this.proj.toXZ(b.e, b.s);
      const m = imgMat(); const mesh = rot(new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), m)); mesh.position.set((x0 + x1) / 2, -0.02, (z0 + z1) / 2); mesh.receiveShadow = true; this.ground.add(mesh);
      loader.load(IMAGERY(z, tx + dx, ty + dy), t => { t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; m.map = t; m.needsUpdate = true; });
    }
  }

  // ---------- wearers ----------
  setWearer(id: string, spec: WearerSpec) {
    let w = this.wearers.get(id);
    if (!w) {
      const color = new THREE.Color(spec.color);
      const head = new THREE.Mesh(new THREE.SphereGeometry(1.05, 28, 18), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.9, roughness: 0.4 })); head.castShadow = true;
      const ring = rot(new THREE.Mesh(new THREE.RingGeometry(1.2, 2.2, 48), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false }))); ring.renderOrder = 3;
      // GPS uncertainty: a thin ring whose radius is the fix's accuracy, so a 30 m fix reads as 30 m
      const accRing = rot(new THREE.Mesh(new THREE.RingGeometry(0.97, 1, 72), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false }))); accRing.renderOrder = 3;
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 1, 12, 1, true), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.2, depthWrite: false, side: THREE.DoubleSide })); beam.renderOrder = 4;
      const light = new THREE.PointLight(color, 60, 40, 2);
      const geom = new LineGeometry(); const lm = new LineMaterial({ vertexColors: true, linewidth: 4, worldUnits: false, transparent: true, opacity: 0.95, depthTest: true }); lm.resolution.set(this.host.clientWidth, this.host.clientHeight); this.lineMats.push(lm);
      geom.setPositions([0, 0, 0, 0, 0, 0]); geom.setColors([0, 0, 0, 0, 0, 0]);
      const line = new Line2(geom, lm); line.renderOrder = 6; line.frustumCulled = false;
      const labelEl = document.createElement('div'); labelEl.className = 's3-wlbl'; labelEl.style.setProperty('--c', spec.color); labelEl.innerHTML = `<i></i><span></span><small></small>`;
      const label = new CSS2DObject(labelEl);
      w = { head, ring, accRing, beam, light, line, geom, label, labelEl, color, n: 0, born: performance.now() };
      this.scene.add(head, ring, accRing, beam, light, line, label); this.wearers.set(id, w);
    }
    const on = !!spec.pos;
    for (const o of [w.head, w.ring, w.accRing, w.beam, w.light, w.label]) o.visible = on;
    if (spec.pos) {
      const [x, y, z] = spec.pos; w.head.position.set(x, y, z); w.ring.position.set(x, y - 0.9, z); w.light.position.set(x, y + 2, z);
      const acc = Math.max(1.5, spec.acc ?? 0); w.accRing.visible = on && spec.acc !== undefined; w.accRing.scale.setScalar(acc); w.accRing.position.set(x, y - 0.88, z);
      w.beam.scale.y = this.beamH; w.beam.position.set(x, this.beamH / 2, z); w.label.position.set(x, y + 1.6, z);
      (w.labelEl.children[1] as HTMLElement).textContent = spec.name; (w.labelEl.children[2] as HTMLElement).textContent = spec.sub;
      if (this.follow && (this.followId === null || this.followId === id)) this.followPos = new THREE.Vector3(x, y, z);
    }
    // trail with a fade toward the head
    const n = spec.trail.length / 3; w.line.visible = n >= 2;
    if (n >= 2) {
      const bg = new THREE.Color(cssVar('--scene-bg') || '#e9ebe7'); const cols: number[] = []; const c = new THREE.Color();
      for (let i = 0; i < n; i++) { const t = n === 1 ? 1 : i / (n - 1); c.copy(bg).lerp(w.color, 0.22 + 0.78 * Math.pow(t, 0.6)); cols.push(c.r, c.g, c.b); }
      if (n !== w.n) { w.geom.dispose(); w.geom = new LineGeometry(); w.line.geometry = w.geom; w.n = n; }
      w.geom.setPositions(spec.trail); w.geom.setColors(cols);
    }
  }
  hideWearer(id: string) { const w = this.wearers.get(id); if (!w) return; for (const o of [w.head, w.ring, w.accRing, w.beam, w.light, w.label, w.line]) o.visible = false; if (id === this.followId) this.followPos = null; }

  // ---------- pins ----------
  setPins(list: PinSpec[]) {
    const keep = new Set<string>();
    for (const p of list) {
      keep.add(p.id);
      let v = this.pins.get(p.id);
      const sig = `${p.alert}|${p.thumb ? 1 : 0}|${p.selected}|${p.color}|${p.badge ?? ''}`;
      if (!v) {
        const el = document.createElement('div'); el.className = 's3-pin arrive'; el.dataset.id = p.id;
        el.addEventListener('click', ev => { ev.stopPropagation(); this.onPinClick(p.id); });
        el.addEventListener('mouseenter', ev => this.onPinHover(p.id, ev.clientX, ev.clientY)); el.addEventListener('mouseleave', () => this.onPinHover(null, 0, 0));
        const obj = new CSS2DObject(el); obj.position.set(p.x, p.y + 2.6, p.z);
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 1, 6), this.mat(new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.8 }), 'pole')); pole.renderOrder = 3;
        v = { obj, el, pole, sig: '' }; this.pins.set(p.id, v); this.scene.add(obj, pole);
      }
      v.pole.scale.y = p.y + 2.6; v.pole.position.set(p.x, (p.y + 2.6) / 2, p.z);
      if (v.sig !== sig) {
        v.sig = sig; v.el.style.setProperty('--c', p.color); v.el.classList.toggle('alert', p.alert); v.el.classList.toggle('sel', p.selected); v.el.title = p.title;
        v.el.classList.toggle('badged', !!p.badge);
        v.el.innerHTML = `${p.badge ? `<em>${p.badge.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))}</em>` : ''}${p.thumb ? `<img src="${p.thumb}" alt="">` : '<i></i>'}<b>${p.time}</b>`;
      }
    }
    for (const [id, v] of this.pins) if (!keep.has(id)) { this.scene.remove(v.obj, v.pole); v.el.remove(); this.pins.delete(id); }
  }

  // ---------- issues ----------
  // Every issue is a dot on the model where the photo that raised it was taken: red and pulsing
  // while open, green once resolved. Several issues at one spot stack upward.
  setIssues(list: IssueSpec[]) {
    const keep = new Set<string>();
    const red = cssVar('--critical') || '#d03b3b', green = cssVar('--good') || '#0ca30c';
    for (const p of list) {
      keep.add(p.id);
      let v = this.issues.get(p.id);
      if (!v) {
        const el = document.createElement('div'); el.className = 's3-idot arrive'; el.dataset.id = p.id; el.innerHTML = '<i></i>';
        el.addEventListener('click', ev => { ev.stopPropagation(); this.onIssueClick(p.id); });
        el.addEventListener('mouseenter', ev => this.onIssueHover(p.id, ev.clientX, ev.clientY)); el.addEventListener('mouseleave', () => this.onIssueHover(null, 0, 0));
        const obj = new CSS2DObject(el);
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 1, 6), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.55, depthWrite: false })); pole.renderOrder = 3;
        const ring = rot(new THREE.Mesh(new THREE.RingGeometry(1.6, 2.4, 48), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false }))); ring.renderOrder = 3;
        v = { obj, el, pole, ring, open: null, born: performance.now(), solvedAt: 0 }; this.issues.set(p.id, v); this.scene.add(obj, pole, ring);
      }
      const top = p.y + 7 + p.lift * 3.2;
      v.obj.position.set(p.x, top, p.z); v.pole.scale.y = top - p.y; v.pole.position.set(p.x, p.y + (top - p.y) / 2, p.z); v.ring.position.set(p.x, p.y + 0.3, p.z);
      if (v.open !== p.open) {
        v.open = p.open; const c = new THREE.Color(p.open ? red : green);
        (v.pole.material as THREE.MeshBasicMaterial).color.copy(c); (v.ring.material as THREE.MeshBasicMaterial).color.copy(c);
        v.el.classList.toggle('open', p.open); v.el.classList.toggle('done', !p.open); v.el.title = p.title;
        // resolving pulses once (a ring that swells and fades, the dot flashes) and settles small
        if (!p.open) { v.solvedAt = performance.now(); v.ring.scale.setScalar(1); const el = v.el; el.classList.add('just'); setTimeout(() => el.classList.remove('just'), 1200); }
        else v.solvedAt = 0;
      }
    }
    for (const [id, v] of this.issues) if (!keep.has(id)) { this.scene.remove(v.obj, v.pole, v.ring); v.el.remove(); this.issues.delete(id); }
  }

  // ---------- view ----------
  setView(mode: '3d' | '2d') {
    this.mode = mode; this.ctrl3d.enabled = mode === '3d'; this.ctrl2d.enabled = mode === '2d';
    for (const o of this.upper) o.visible = mode === '3d'; // top-down shows the ground floor plan, not the roof
    if (mode === '2d') { const t = this.ctrl3d.target; this.ctrl2d.target.set(t.x, 0, t.z); this.ortho.position.set(t.x, 600, t.z + 0.001); this.ortho.lookAt(t.x, 0, t.z); }
    else { const t = this.ctrl2d.target; const d = this.persp.position.clone().sub(this.ctrl3d.target); this.ctrl3d.target.set(t.x, 4, t.z); this.persp.position.copy(this.ctrl3d.target).add(d); }
  }
  setFollow(on: boolean, fromUser = false) { this.follow = on; if (!on) this.followPos = null; this.host.dispatchEvent(new CustomEvent('site:follow', { detail: { on, fromUser } })); }
  focus(x: number, z: number) {
    const c = this.mode === '3d' ? this.ctrl3d : this.ctrl2d; const d = c.object.position.clone().sub(c.target);
    c.target.set(x, this.mode === '3d' ? 4 : 0, z); c.object.position.copy(c.target).add(d);
  }

  frame() {
    const dt = this.clock.getDelta(); const t = performance.now();
    const c = this.mode === '3d' ? this.ctrl3d : this.ctrl2d;
    if (this.follow && this.followPos) {
      // Follow keeps the wearer in frame without pinning them to the centre: the camera stays put
      // while the dot moves through the middle of the view, and pans only when the dot nears an
      // edge. Pinning made the dot look still at 1x, with the world sliding under it.
      const ndc = this.followPos.clone().project(c.object as THREE.Camera); const edge = 0.5;
      if (Math.abs(ndc.x) > edge || Math.abs(ndc.y) > edge || ndc.z > 1) {
        const goal = this.followPos.clone(); goal.y = this.mode === '3d' ? 4 : 0;
        const d = goal.clone().sub(c.target).multiplyScalar(Math.min(1, dt * 1.2)); c.target.add(d); c.object.position.add(d);
      }
      // come in close enough to read the floor plan, once
      if (this.mode === '3d') {
        const off = this.persp.position.clone().sub(this.ctrl3d.target); const len = off.length(); const want = 110;
        if (len > want + 2) { off.setLength(len + (want - len) * Math.min(1, dt * 2)); if (off.y < 28) off.y = 28; this.persp.position.copy(this.ctrl3d.target).add(off); }
      } else if (this.ortho.zoom < 2.8) { this.ortho.zoom += (3 - this.ortho.zoom) * Math.min(1, dt * 2); this.ortho.updateProjectionMatrix(); }
    }
    c.update();
    for (const v of this.issues.values()) {
      const rm = v.ring.material as THREE.MeshBasicMaterial;
      if (v.open) { const k = 1 + 0.35 * (0.5 + 0.5 * Math.sin(t / 260)); v.ring.scale.setScalar(k); rm.opacity = 0.75 - 0.4 * (k - 1) / 0.35; }
      else if (v.solvedAt) { const f = Math.min(1, (t - v.solvedAt) / 1100); v.ring.scale.setScalar(1 + 2.2 * f); rm.opacity = 0.7 * (1 - f) + (f >= 1 ? 0.3 : 0); if (f >= 1) { v.ring.scale.setScalar(0.6); v.solvedAt = 0; } }
    }
    for (const w of this.wearers.values()) {
      const ph = ((t - w.born) % 1800) / 1800; w.ring.scale.setScalar(1 + ph * 1.6); (w.ring.material as THREE.MeshBasicMaterial).opacity = 0.7 * (1 - ph);
      (w.beam.material as THREE.MeshBasicMaterial).opacity = 0.16 + 0.06 * Math.sin(t / 400);
    }
    const dist = this.mode === '3d' ? this.persp.position.distanceTo(this.ctrl3d.target) : 420 / this.ortho.zoom;
    const near = dist < 230; for (const l of this.roomLabels) l.visible = near;
    const mid = dist < 520; for (const l of this.bldLabels) l.visible = mid;
    this.heat?.flush();
    this.renderer.render(this.scene, this.camera); this.labels.render(this.scene, this.camera);
  }
}
