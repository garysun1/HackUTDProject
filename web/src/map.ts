// The map (#21, #26): the 3D site. Opaque neighbours, the main building translucent with its
// floors, the mapped ground floor, imagery underneath; each wearer a lit dot with a fading trail
// and a heat layer where they lingered; photo pins where photos were taken, red while an alert is
// open. Live, or driven by the replay clock. The shift-memory panel sits beside it. Reads the
// console's store (subscriptions, capture time); nothing here is fetched separately.
import { state, wearerColor, wearerName, fmtTime, fmtTimeS, loadPhoto, alertsFor } from './store';
import { select } from './timeline';
import { view, onView, clock as viewClock, jumpTo, shownEvents, togglePlay, stopReplay, setSpeed, scrubReplay, replayRange } from './view';
import { photoCard, showTip, hideTip } from './card';
import { fitRequested } from './tools';
import { current } from './workspaces';
import { SiteScene, type PinSpec } from './site3d/scene';
import { centroid } from './site3d/geo';
import { siteFor, locateIn, type KnownSite } from './site3d/sites';
import { shifts, positionAt, renderBrain, openAt, shiftEnd, type Shift } from './brain';

const host = document.getElementById('map') as HTMLElement;
let scene: SiteScene | null = null; let brainEl: HTMLElement; let followBtn: HTMLButtonElement; let seenFit = fitRequested;
let raf = 0; let brainAt = 0; let scrubEl: HTMLInputElement; let marksEl: HTMLElement; let scrubbing = false; let marksSig = '';

function ensureScene(): SiteScene {
  if (scene) return scene;
  host.innerHTML = `<canvas class="s3-gl" aria-label="3D view of the site"></canvas><div class="s3-labels" aria-hidden="true"></div>
    <div class="s3-ctl"><span class="seg" role="group" aria-label="Camera"><button type="button" data-cam="3d" aria-pressed="true">3D</button><button type="button" data-cam="2d" aria-pressed="false">Top-down</button></span><button type="button" class="btn ghost" data-follow aria-pressed="false" title="Keep the camera on the wearer (F)">Follow</button></div>
    <aside class="s3-brain" aria-label="Shift memory"><div class="bh"><h2>Shift memory</h2></div><div class="s3-brain-body"></div></aside>
    <div class="s3-replay" role="group" aria-label="Replay"><button type="button" data-play aria-label="Play">▶</button><button type="button" data-live class="on">Live</button><div class="speeds" role="group" aria-label="Speed">${[1, 10, 60, 300].map(v => `<button type="button" data-speed="${v}">${v}×</button>`).join('')}</div><div class="scrub"><input type="range" min="0" max="1000" value="1000" data-scrub aria-label="Time" /><div class="s3-marks"></div></div><span class="clock mono" data-clock>—</span></div>
    <div class="s3-legend"><span><i class="sw trail"></i>walk</span><span><i class="sw heat"></i>time spent</span><span><i class="sw photo"></i>photo</span><span><i class="sw alert"></i>open issue</span><span class="attr">Imagery © Esri · ECSW © OpenStreetMap contributors · sample sites generated</span></div>`;
  const canvas = host.querySelector('canvas')!; const labels = host.querySelector('.s3-labels') as HTMLElement;
  scene = new SiteScene(canvas, labels, host); (window as any).__scene = scene;
  brainEl = host.querySelector('.s3-brain-body') as HTMLElement; followBtn = host.querySelector('[data-follow]') as HTMLButtonElement;
  host.querySelectorAll<HTMLButtonElement>('[data-cam]').forEach(b => b.addEventListener('click', () => { scene!.setView(b.dataset.cam as '3d' | '2d'); host.querySelectorAll('[data-cam]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); }));
  followBtn.addEventListener('click', () => scene!.setFollow(!scene!.follow));
  host.addEventListener('site:follow', (e: any) => followBtn.setAttribute('aria-pressed', String(e.detail.on)));
  document.addEventListener('keydown', e => { const t = e.target as HTMLElement; if (t.closest('input, select, textarea, button, a, [role="button"], [contenteditable]')) return; if (e.key === 'f' && view.mode === 'map') followBtn.click(); });
  // replay bar: the same controls as the standalone site view, driving the shared clock
  const bar = host.querySelector('.s3-replay') as HTMLElement; scrubEl = bar.querySelector('[data-scrub]') as HTMLInputElement; marksEl = bar.querySelector('.s3-marks') as HTMLElement;
  bar.addEventListener('click', e => { const t = e.target as HTMLElement; const sp = t.closest('[data-speed]') as HTMLElement | null; if (sp) { setSpeed(Number(sp.dataset.speed)); return; } if (t.closest('[data-play]')) togglePlay(); if (t.closest('[data-live]')) stopReplay(); });
  scrubEl.addEventListener('input', () => scrubReplay(Number(scrubEl.value) / 1000));
  scrubEl.addEventListener('pointerdown', () => { scrubbing = true; }); document.addEventListener('pointerup', () => { scrubbing = false; });
  scene.onPinClick = id => select(id);
  scene.onPinHover = (id, x, y) => { if (id) showTip(photoCard(id), x, y, id); else hideTip(); };
  document.addEventListener('select', () => { const id = state.selected; const l = id ? state.locations.get(id) : null; if (l && scene && site) { const [x, z] = scene.proj.toXZ(l.lon, l.lat); scene.focus(x, z); } });
  return scene;
}

// ---------- site ----------
// The known site the data sits in (ECSW for the venue capture, a generated plant for each sample
// workspace, decision 0032), else a generic glass box around the walk.
type Site = { kind: 'known' | 'generic'; known: KnownSite | null; builtFor: string };
let site: Site | null = null;
function dataCentroid(): [number, number] | null {
  const pts: [number, number][] = [];
  for (const p of state.track.values()) if (p.kind === 'point') pts.push([p.lon, p.lat]);
  for (const l of state.locations.values()) pts.push([l.lon, l.lat]);
  return pts.length ? centroid(pts) : null;
}
function ensureSite(sc: SiteScene) {
  const c = dataCentroid(); const k = siteFor(c);
  const key = k ? k.key : `generic:${current().db}`;
  if (site && site.builtFor === key) return;
  if (k) {
    sc.buildSite(k.data);
    site = { kind: 'known', known: k, builtFor: key };
  } else {
    sc.buildSite({ center: c!, tileRadius: 3 });
    const xs: [number, number][] = []; for (const p of state.track.values()) if (p.kind === 'point') xs.push(sc.proj.toXZ(p.lon, p.lat)); for (const l of state.locations.values()) xs.push(sc.proj.toXZ(l.lon, l.lat));
    const minX = Math.min(...xs.map(p => p[0])) - 10, maxX = Math.max(...xs.map(p => p[0])) + 10, minZ = Math.min(...xs.map(p => p[1])) - 10, maxZ = Math.max(...xs.map(p => p[1])) + 10;
    sc.buildHall(minX, maxX, minZ, maxZ, current().name);
    site = { kind: 'generic', known: null, builtFor: key };
  }
  resetHeat();
}
function locate(lat: number, lon: number, floor?: number | null): string | undefined {
  if (!site?.known) return;
  return locateIn(site.known, lat, lon, floor);
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
let lastDb = ''; let lastFilterSig = ''; const dbg = { frames: 0, lastError: '' as string }; (window as any).__s3 = dbg;
function frame() {
  raf = 0; dbg.frames++;
  try { frameBody(); } catch (e: any) { dbg.lastError = String(e?.stack || e); console.error('[map] frame failed', e); raf = requestAnimationFrame(frame); }
}
function frameBody() {
  if (view.mode !== 'map' || host.hidden) return;
  const sc = ensureScene();
  if (current().db !== lastDb) { lastDb = current().db; site = null; resetHeat(); for (const dev of [...sc.wearers.keys()]) sc.hideWearer(dev); sc.setPins([]); brainEl.innerHTML = ''; }
  if (state.track.size || state.locations.size) ensureSite(sc);
  const clock = viewClock();
  if (!site) { const t = performance.now(); if (t - brainAt > 250) { brainAt = t; renderBrain(brainEl, { clock, locate, onSelect: select, onJump: jumpTo }); } sc.frame(); raf = requestAnimationFrame(frame); return; }
  const filterSig = `${state.windowMin}|${[...state.hiddenWearers].sort().join(',')}`; if (filterSig !== lastFilterSig) { lastFilterSig = filterSig; resetHeat(); }
  const cutoff = state.windowMin ? Date.now() - state.windowMin * 60_000 : 0;
  const all = shifts().filter(s => !state.hiddenWearers.has(s.deviceId) && s.lastMs >= cutoff);
  const byDevice = new Map<string, Shift[]>(); for (const s of all) (byDevice.get(s.deviceId) ?? byDevice.set(s.deviceId, []).get(s.deviceId)!).push(s);
  sc.followId = (state.selected && state.events.get(state.selected)?.deviceId) || byDevice.keys().next().value || null;
  const drawnDevices = new Set<string>();
  for (const [dev, list] of byDevice) {
    drawnDevices.add(dev); let drawn = false;
    for (const s of list) {
      const pos = positionAt(s, clock); if (!pos) continue;
      const [x, z] = sc.proj.toXZ(pos.lon, pos.lat); const y = (pos.floor ?? 0) * sc.floorH + 1.1;
      const trail: number[] = []; for (let i = 0; i <= pos.i; i++) { const q = s.smooth[i]; const [tx, tz] = sc.proj.toXZ(q.lon, q.lat); trail.push(tx, (q.floor ?? 0) * sc.floorH + 0.6, tz); } trail.push(x, y - 0.5, z);
      const where = locate(pos.lat, pos.lon, pos.floor); const last = s.smooth[pos.i]; const stale = clock - last.tMs > 90_000;
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
  renderBar(clock);
  sc.frame();
  raf = requestAnimationFrame(frame);
}

function renderBar(clock: number) {
  const r = view.replay; const bar = host.querySelector('.s3-replay') as HTMLElement | null; if (!bar) return;
  const [t0, t1] = replayRange();
  (bar.querySelector('[data-play]') as HTMLElement).textContent = r.on && r.playing ? '❚❚' : '▶';
  (bar.querySelector('[data-live]') as HTMLElement).classList.toggle('on', !r.on);
  bar.querySelectorAll<HTMLElement>('[data-speed]').forEach(b => b.classList.toggle('on', Number(b.dataset.speed) === r.speed));
  if (!scrubbing && document.activeElement !== scrubEl) scrubEl.value = String(Math.round(((clock - t0) / Math.max(1, t1 - t0)) * 1000));
  (bar.querySelector('[data-clock]') as HTMLElement).textContent = (r.on ? `${r.speed}× · ` : '') + fmtTimeS(BigInt(Math.round(clock)) * 1000n);
  // marks: photos (grey), photos with an alert (red), shift changes (blue)
  const sig = `${state.events.size}|${state.alerts.size}|${state.track.size}|${Math.round(t0 / 60000)}|${Math.round(t1 / 600000)}`;
  if (sig !== marksSig) {
    marksSig = sig; const f = (t: number) => `${((t - t0) / Math.max(1, t1 - t0)) * 100}%`;
    const evs = [...state.events.values()].map(e => `<i style="left:${f(Number(e.tMicros) / 1000)}" class="${alertsFor(e).length ? 'a' : ''}"></i>`);
    const all = shifts(); const hs = all.filter(s => s.endMs !== null || all.some(o => o.startMs > shiftEnd(s))).map(s => `<i class="h" style="left:${f(shiftEnd(s))}"></i>`);
    marksEl.innerHTML = evs.join('') + hs.join('');
  }
}

export function renderMap() {
  const active = view.mode === 'map';
  host.hidden = !active; if (!active) { hideTip(); return; }
  if (!raf) raf = requestAnimationFrame(frame);
}
export function mapUserView() { return !!scene?.userView; }
onView(() => renderMap());
