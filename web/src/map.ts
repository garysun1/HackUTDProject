// The map (#21, #26): the 3D site. Opaque neighbours, the main building translucent with its
// floors, the mapped ground floor, imagery underneath; each wearer a lit dot with a fading trail
// and a heat layer where they lingered; photo pins where photos were taken, red while an alert is
// open. Live, or driven by the replay clock. The shift-memory panel sits beside it. Reads the
// console's store (subscriptions, capture time); nothing here is fetched separately.
import { state, wearerColor, wearerName, fmtTime, loadPhoto, alertsFor } from './store';
import { select } from './timeline';
import { view, onView, clock as viewClock, jumpTo, shownEvents } from './view';
import { photoCard, showTip, hideTip } from './card';
import { fitRequested } from './tools';
import { current } from './workspaces';
import { SiteScene, type PinSpec, type SiteData } from './site3d/scene';
import { pointInRing, centroid, haversineM } from './site3d/geo';
import ecsw from './site3d/data/ecsw.json';
import { shifts, positionAt, renderBrain, openAt, type Shift } from './brain';

const host = document.getElementById('map') as HTMLElement;
let scene: SiteScene | null = null; let brainEl: HTMLElement; let followBtn: HTMLButtonElement; let seenFit = fitRequested;
let raf = 0; let brainAt = 0;

function ensureScene(): SiteScene {
  if (scene) return scene;
  host.innerHTML = `<canvas class="s3-gl" aria-label="3D view of the site"></canvas><div class="s3-labels" aria-hidden="true"></div>
    <div class="s3-ctl"><span class="seg" role="group" aria-label="Camera"><button type="button" data-cam="3d" aria-pressed="true">3D</button><button type="button" data-cam="2d" aria-pressed="false">Top-down</button></span><button type="button" class="btn ghost" data-follow aria-pressed="false" title="Keep the camera on the wearer (F)">Follow</button></div>
    <aside class="s3-brain" aria-label="Shift memory"><div class="bh"><h2>Shift memory</h2></div><div class="s3-brain-body"></div></aside>
    <div class="s3-attr">Imagery © Esri · Building © OpenStreetMap contributors</div>`;
  const canvas = host.querySelector('canvas')!; const labels = host.querySelector('.s3-labels') as HTMLElement;
  scene = new SiteScene(canvas, labels, host); (window as any).__scene = scene;
  brainEl = host.querySelector('.s3-brain-body') as HTMLElement; followBtn = host.querySelector('[data-follow]') as HTMLButtonElement;
  host.querySelectorAll<HTMLButtonElement>('[data-cam]').forEach(b => b.addEventListener('click', () => { scene!.setView(b.dataset.cam as '3d' | '2d'); host.querySelectorAll('[data-cam]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); }));
  followBtn.addEventListener('click', () => scene!.setFollow(!scene!.follow));
  host.addEventListener('site:follow', (e: any) => followBtn.setAttribute('aria-pressed', String(e.detail.on)));
  document.addEventListener('keydown', e => { const t = e.target as HTMLElement; if (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA') return; if (e.key === 'f' && view.mode === 'map') followBtn.click(); });
  scene.onPinClick = id => select(id);
  scene.onPinHover = (id, x, y) => { if (id) showTip(photoCard(id), x, y, id); else hideTip(); };
  document.addEventListener('select', () => { const id = state.selected; const l = id ? state.locations.get(id) : null; if (l && scene && site) { const [x, z] = scene.proj.toXZ(l.lon, l.lat); scene.focus(x, z); } });
  return scene;
}

// ---------- site ----------
type Site = { kind: 'ecsw' | 'generic'; rooms: { name: string; ring: [number, number][] }[]; outer: [number, number][] | null; builtFor: string };
let site: Site | null = null;
const ECSW_CENTER = ecsw.center as [number, number];
function dataCentroid(): [number, number] | null {
  const pts: [number, number][] = [];
  for (const p of state.track.values()) if (p.kind === 'point') pts.push([p.lon, p.lat]);
  for (const l of state.locations.values()) pts.push([l.lon, l.lat]);
  return pts.length ? centroid(pts) : null;
}
function ensureSite(sc: SiteScene) {
  const c = dataCentroid(); const nearEcsw = !c || haversineM(c[1], c[0], ECSW_CENTER[1], ECSW_CENTER[0]) < 400;
  const key = nearEcsw ? 'ecsw' : `generic:${current().db}`;
  if (site && site.builtFor === key) return;
  if (nearEcsw) {
    const d: SiteData = { center: ECSW_CENTER, main: { name: ecsw.ecsw.name, levels: ecsw.ecsw.levels, height: ecsw.ecsw.height, outer: ecsw.ecsw.outer as any, inner: ecsw.ecsw.inner as any }, indoor: ecsw.indoor as any, neighbors: ecsw.neighbors as any, paths: ecsw.paths as any, tileRadius: 4 };
    sc.buildSite(d);
    site = { kind: 'ecsw', outer: ecsw.ecsw.outer as any, rooms: (ecsw.indoor as any[]).filter(r => r.name && r.pts.length >= 3).map(r => ({ name: r.name, ring: r.pts })), builtFor: key };
  } else {
    sc.buildSite({ center: c!, tileRadius: 3 });
    const xs: [number, number][] = []; for (const p of state.track.values()) if (p.kind === 'point') xs.push(sc.proj.toXZ(p.lon, p.lat)); for (const l of state.locations.values()) xs.push(sc.proj.toXZ(l.lon, l.lat));
    const minX = Math.min(...xs.map(p => p[0])) - 10, maxX = Math.max(...xs.map(p => p[0])) + 10, minZ = Math.min(...xs.map(p => p[1])) - 10, maxZ = Math.max(...xs.map(p => p[1])) + 10;
    sc.buildHall(minX, maxX, minZ, maxZ, current().name);
    site = { kind: 'generic', outer: null, rooms: [], builtFor: key };
  }
  resetHeat();
}
function locate(lat: number, lon: number): string | undefined {
  if (!site) return; const pt: [number, number] = [lon, lat];
  for (const r of site.rooms) if (pointInRing(pt, r.ring)) return r.name;
  if (site.outer && pointInRing(pt, site.outer)) return 'inside ECSW';
  return site.kind === 'ecsw' ? 'outside the building' : undefined;
}

// ---------- heat (incremental over the clock) ----------
const heatCursor = new Map<string, number>(); let heatClock = -Infinity;
function resetHeat() { scene?.heat?.reset(); heatCursor.clear(); heatClock = -Infinity; }
function advanceHeat(sc: SiteScene, all: Shift[], clock: number) {
  if (!sc.heat) return; if (clock < heatClock) resetHeat();
  for (const s of all) {
    let i = heatCursor.get(s.key) ?? 0; const p = s.smooth;
    while (i < p.length && p[i].tMs <= clock) { const dt = Math.min(120_000, (p[i + 1]?.tMs ?? p[i].tMs + 30_000) - p[i].tMs) / 1000; const [x, z] = sc.proj.toXZ(p[i].lon, p[i].lat); sc.heat.add(x, z, dt); i++; }
    heatCursor.set(s.key, i);
  }
  heatClock = clock;
}

// ---------- frame ----------
let lastDb = ''; const dbg = { frames: 0, lastError: '' as string }; (window as any).__s3 = dbg;
function frame() {
  raf = 0; dbg.frames++;
  try { frameBody(); } catch (e: any) { dbg.lastError = String(e?.stack || e); console.error('[map] frame failed', e); raf = requestAnimationFrame(frame); }
}
function frameBody() {
  if (view.mode !== 'map' || host.hidden) return;
  const sc = ensureScene();
  if (current().db !== lastDb) { lastDb = current().db; site = null; resetHeat(); }
  if (state.track.size || state.locations.size) ensureSite(sc);
  if (!site) { sc.frame(); raf = requestAnimationFrame(frame); return; }
  const clock = viewClock();
  const cutoff = state.windowMin ? Date.now() - state.windowMin * 60_000 : 0;
  const all = shifts().filter(s => !state.hiddenWearers.has(s.deviceId) && s.lastMs >= cutoff);
  const byDevice = new Map<string, Shift[]>(); for (const s of all) (byDevice.get(s.deviceId) ?? byDevice.set(s.deviceId, []).get(s.deviceId)!).push(s);
  const drawnDevices = new Set<string>();
  for (const [dev, list] of byDevice) {
    drawnDevices.add(dev); let drawn = false;
    for (const s of list) {
      const pos = positionAt(s, clock); if (!pos) continue;
      const [x, z] = sc.proj.toXZ(pos.lon, pos.lat); const y = (pos.floor ?? 0) * sc.floorH + 1.1;
      const trail: number[] = []; for (let i = 0; i <= pos.i; i++) { const q = s.smooth[i]; const [tx, tz] = sc.proj.toXZ(q.lon, q.lat); trail.push(tx, (q.floor ?? 0) * sc.floorH + 0.6, tz); } trail.push(x, y - 0.5, z);
      const where = locate(pos.lat, pos.lon); const last = s.smooth[pos.i]; const stale = clock - last.tMs > 90_000;
      sc.setWearer(dev, { color: wearerColor(dev), name: wearerName(dev), sub: where ? where : stale ? `last fix ${fmtTime(BigInt(Math.round(last.tMs)) * 1000n)}` : 'on site', pos: [x, y, z], trail });
      drawn = true; break;
    }
    if (!drawn) {
      const s = [...list].reverse().find(s => s.startMs <= clock && s.smooth.length >= 2);
      if (s) { const trail: number[] = []; for (const q of s.smooth) { if (q.tMs > clock) break; const [tx, tz] = sc.proj.toXZ(q.lon, q.lat); trail.push(tx, (q.floor ?? 0) * sc.floorH + 0.6, tz); } sc.setWearer(dev, { color: wearerColor(dev), name: wearerName(dev), sub: '', pos: null, trail }); }
      else sc.hideWearer(dev);
    }
  }
  for (const dev of sc.wearers.keys()) if (!drawnDevices.has(dev)) sc.hideWearer(dev);
  advanceHeat(sc, all, clock);
  const pins: PinSpec[] = [];
  for (const e of shownEvents()) {
    const l = state.locations.get(e.eventId); if (!l) continue;
    const [x, z] = sc.proj.toXZ(l.lon, l.lat); const url = state.photos.get(e.eventId); if (!url) loadPhoto(e.eventId);
    const alert = alertsFor(e).some(a => openAt(a, clock));
    pins.push({ id: e.eventId, x, y: (l.floor ?? 0) * sc.floorH, z, color: wearerColor(e.deviceId), time: fmtTime(e.tMicros), alert, thumb: url, selected: state.selected === e.eventId, title: e.summary });
  }
  sc.setPins(pins);
  if (fitRequested !== seenFit) { seenFit = fitRequested; sc.resetView(); }
  const now = performance.now();
  if (now - brainAt > 250) { brainAt = now; renderBrain(brainEl, { clock, locate, onSelect: select, onJump: jumpTo }); }
  sc.frame();
  raf = requestAnimationFrame(frame);
}

export function renderMap() {
  const active = view.mode === 'map';
  host.hidden = !active; if (!active) { hideTip(); return; }
  if (!raf) raf = requestAnimationFrame(frame);
}
export function mapUserView() { return !!scene?.userView; }
onView(() => renderMap());
