// The map (#21, #26): the 3D site. Opaque neighbours, the main building translucent with its
// floors, the mapped ground floor, imagery underneath; each wearer a lit dot with a fading trail
// and a heat layer where they lingered; photo pins where photos were taken, red while an alert is
// open. Live, or driven by the replay clock. The shift-memory panel sits beside it. Reads the
// console's store (subscriptions, capture time); nothing here is fetched separately.
import { state, wearerColor, wearerName, fmtTime, fmtTimeS, loadPhoto, alertsFor, type Alert } from './store';
import { select } from './timeline';
import { view, onView, clock as viewClock, jumpTo, shownEvents, togglePlay, stopReplay, setSpeed, scrubReplay, replayRange, setRangeSource } from './view';
import { photoCard, showTip, hideTip } from './card';
import { esc } from './timeline';
import { fitRequested } from './tools';
import { current } from './workspaces';
import { SiteScene, type PinSpec, type IssueSpec, type SiteData } from './site3d/scene';
import { pointInRing, centroid, haversineM } from './site3d/geo';
import ecsw from './site3d/data/ecsw.json';
import { sessionShifts, shifts, positionAt, renderBrain, openAt, shiftEnd, inSession, sessionRange, raisedAt, resolvedAt, type Shift } from './brain';

const host = document.getElementById('map') as HTMLElement;
let scene: SiteScene | null = null; let brainEl: HTMLElement; let statsEl: HTMLElement; let followBtn: HTMLButtonElement; let seenFit = fitRequested;
let raf = 0; let brainAt = 0; let scrubEl: HTMLInputElement; let marksEl: HTMLElement; let scrubbing = false; let marksSig = '';

function ensureScene(): SiteScene {
  if (scene) return scene;
  host.innerHTML = `<canvas class="s3-gl" aria-label="3D view of the site"></canvas><div class="s3-labels" aria-hidden="true"></div>
    <div class="s3-ctl"><span class="seg" role="group" aria-label="Camera"><button type="button" data-cam="3d" aria-pressed="true">3D</button><button type="button" data-cam="2d" aria-pressed="false">Top-down</button></span><button type="button" class="btn ghost" data-follow aria-pressed="false" title="Keep the camera on the wearer (F)">Follow</button></div>
    <aside class="s3-brain" aria-label="Shift memory"><div class="bh"><h2>Shift memory</h2></div><div class="s3-brain-stats"></div><div class="s3-brain-body"></div></aside>
    <div class="s3-replay" role="group" aria-label="Replay"><button type="button" data-play aria-label="Play">▶</button><button type="button" data-live class="on">Live</button><div class="speeds" role="group" aria-label="Speed">${[1, 10, 60, 300].map(v => `<button type="button" data-speed="${v}">${v}×</button>`).join('')}</div><div class="scrub"><input type="range" min="0" max="1000" value="1000" data-scrub aria-label="Time" /><div class="s3-marks"></div></div><span class="clock mono" data-clock>—</span></div>
    <div class="s3-legend"><span><i class="sw trail"></i>walk</span><span><i class="sw heat"></i>time spent</span><span><i class="sw photo"></i>photo</span><span><i class="sw alert"></i>open issue</span><span><i class="sw done"></i>resolved</span><span class="attr">Imagery © Esri · Building © OpenStreetMap contributors</span></div>`;
  const canvas = host.querySelector('canvas')!; const labels = host.querySelector('.s3-labels') as HTMLElement;
  scene = new SiteScene(canvas, labels, host); (window as any).__scene = scene;
  brainEl = host.querySelector('.s3-brain-body') as HTMLElement; statsEl = host.querySelector('.s3-brain-stats') as HTMLElement; followBtn = host.querySelector('[data-follow]') as HTMLButtonElement;
  host.querySelectorAll<HTMLButtonElement>('[data-cam]').forEach(b => b.addEventListener('click', () => { scene!.setView(b.dataset.cam as '3d' | '2d'); host.querySelectorAll('[data-cam]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); }));
  followBtn.addEventListener('click', () => scene!.setFollow(!scene!.follow));
  host.addEventListener('site:follow', (e: any) => followBtn.setAttribute('aria-pressed', String(e.detail.on)));
  document.addEventListener('keydown', e => { const t = e.target as HTMLElement; if (t.closest('input, select, textarea, button, a, [role="button"], [contenteditable]')) return; if (e.key === 'f' && view.mode === 'map') followBtn.click(); });
  // replay bar: the same controls as the standalone site view, driving the shared clock
  const bar = host.querySelector('.s3-replay') as HTMLElement; scrubEl = bar.querySelector('[data-scrub]') as HTMLInputElement; marksEl = bar.querySelector('.s3-marks') as HTMLElement;
  bar.addEventListener('click', e => { const t = e.target as HTMLElement; const sp = t.closest('[data-speed]') as HTMLElement | null; if (sp) { setSpeed(Number(sp.dataset.speed)); return; } if (t.closest('[data-play]')) { if (!view.replay.on) { resetHeat(); scene!.setFollow(true); } togglePlay(); } if (t.closest('[data-live]')) stopReplay(); });
  scrubEl.addEventListener('input', () => scrubReplay(Number(scrubEl.value) / 1000));
  scrubEl.addEventListener('pointerdown', () => { scrubbing = true; }); document.addEventListener('pointerup', () => { scrubbing = false; });
  scene.onPinClick = id => select(id);
  scene.onPinHover = (id, x, y) => { if (id) showTip(photoCard(id), x, y, id); else hideTip(); };
  scene.onIssueClick = id => { const a = state.alerts.get(id); if (a) { select(a.eventId); if (raisedAt(a) > viewClock()) jumpTo(raisedAt(a) + 1000); } };
  scene.onIssueHover = (id, x, y) => {
    const a = id ? state.alerts.get(id) : undefined; if (!a) { hideTip(); return; }
    const t = (v: number) => fmtTime(BigInt(Math.round(v)) * 1000n); const done = resolvedAt(a) <= viewClock();
    showTip(`<div class="t">${done ? `resolved ${t(resolvedAt(a))}` : `open since ${t(raisedAt(a))}`} · ${esc(a.wearerName || wearerName(a.deviceId))}</div><p><b>${esc(a.assetName || a.text)}</b>${a.assetName ? ` · ${esc(a.text)}` : ''}</p>`, x, y, id);
  };
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

// ---------- issue markers ----------
// An issue sits where the photo that raised it was taken; a photo without a fix falls back to where
// its wearer's track was at that moment. Issues with neither stay in the panel only.
function issueSpot(a: Alert): { lat: number; lon: number; floor?: number } | null {
  const l = state.locations.get(a.eventId); if (l) return { lat: l.lat, lon: l.lon, floor: l.floor };
  const at = raisedAt(a);
  for (const s of shifts()) { if (s.deviceId !== a.deviceId || at < s.startMs || at > shiftEnd(s) + 60_000) continue; const p = positionAt(s, at); if (p) return { lat: p.lat, lon: p.lon, floor: p.floor }; }
  return null;
}
function issueSpecs(sc: SiteScene, clock: number, lvl: (f: number | undefined) => number): IssueSpec[] {
  const out: IssueSpec[] = []; const stack = new Map<string, number>();
  const cutoff = state.windowMin ? Date.now() - state.windowMin * 60_000 : 0;
  for (const a of state.alerts.values()) {
    if (raisedAt(a) > clock || raisedAt(a) < cutoff || state.hiddenWearers.has(a.deviceId)) continue; const at = issueSpot(a); if (!at) continue;
    const [x, z] = sc.proj.toXZ(at.lon, at.lat); const key = `${x.toFixed(0)}|${z.toFixed(0)}|${lvl(at.floor)}`; const lift = stack.get(key) ?? 0; stack.set(key, lift + 1);
    out.push({ id: a.id, x, y: lvl(at.floor) * sc.floorH, z, open: resolvedAt(a) > clock, title: `${a.assetName || a.text}${a.assetName ? ' · ' + a.text : ''}`, lift });
  }
  return out;
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
  if (current().db !== lastDb) { lastDb = current().db; site = null; resetHeat(); for (const dev of [...sc.wearers.keys()]) sc.hideWearer(dev); sc.setPins([]); brainEl.innerHTML = ''; statsEl.innerHTML = ''; }
  if (state.track.size || state.locations.size) ensureSite(sc);
  const clock = viewClock();
  if (!site) { const t = performance.now(); if (t - brainAt > 250) { brainAt = t; renderBrain(brainEl, { clock, stats: statsEl, locate, onSelect: select, onJump: jumpTo }); } sc.frame(); raf = requestAnimationFrame(frame); return; }
  const filterSig = `${state.windowMin}|${[...state.hiddenWearers].sort().join(',')}`; if (filterSig !== lastFilterSig) { lastFilterSig = filterSig; resetHeat(); }
  const all = sessionShifts();
  const lvl = (f: number | undefined) => Math.max(0, Math.min(f ?? 0, sc.levels - 1)); // the phone may count past the roof
  const byDevice = new Map<string, Shift[]>(); for (const s of all) (byDevice.get(s.deviceId) ?? byDevice.set(s.deviceId, []).get(s.deviceId)!).push(s);
  sc.followId = (state.selected && state.events.get(state.selected)?.deviceId) || byDevice.keys().next().value || null;
  const drawnDevices = new Set<string>();
  for (const [dev, list] of byDevice) {
    drawnDevices.add(dev); let drawn = false;
    for (const s of list) {
      const pos = positionAt(s, clock); if (!pos) continue;
      const [x, z] = sc.proj.toXZ(pos.lon, pos.lat); const y = lvl(pos.floor) * sc.floorH + 1.1;
      const trail: number[] = []; for (let i = 0; i <= pos.i; i++) { const q = s.smooth[i]; const [tx, tz] = sc.proj.toXZ(q.lon, q.lat); trail.push(tx, lvl(q.floor) * sc.floorH + 0.6, tz); } trail.push(x, y - 0.5, z);
      const where = locate(pos.lat, pos.lon); const last = s.smooth[pos.i]; const stale = clock - last.tMs > 90_000;
      const floorTxt = pos.floor !== undefined && pos.floor > 0 ? ` · L${pos.floor}` : '';
      sc.setWearer(dev, { color: wearerColor(dev), name: wearerName(dev), sub: (where ? where : stale ? `last fix ${fmtTime(BigInt(Math.round(last.tMs)) * 1000n)}` : 'on shift') + floorTxt, pos: [x, y, z], trail, acc: pos.acc });
      drawn = true; break;
    }
    if (!drawn) {
      // a finished shift keeps its whole trail and its dot at the last point, with when it ended
      const s = [...list].reverse().find(s => s.startMs <= clock && s.smooth.length >= 1);
      if (s) {
        const trail: number[] = []; let last = s.smooth[0];
        for (const q of s.smooth) { if (q.tMs > clock) break; last = q; const [tx, tz] = sc.proj.toXZ(q.lon, q.lat); trail.push(tx, lvl(q.floor) * sc.floorH + 0.6, tz); }
        const [x, z] = sc.proj.toXZ(last.lon, last.lat); const y = lvl(last.floor) * sc.floorH + 1.1;
        const where = locate(last.lat, last.lon);
        sc.setWearer(dev, { color: wearerColor(dev), name: wearerName(dev), sub: `${where ? where + ' · ' : ''}ended ${fmtTime(BigInt(Math.round(shiftEnd(s))) * 1000n)}`, pos: [x, y, z], trail });
      } else sc.hideWearer(dev);
    }
  }
  for (const dev of sc.wearers.keys()) if (!drawnDevices.has(dev)) sc.hideWearer(dev);
  advanceHeat(sc, all, clock);
  const pins: PinSpec[] = [];
  for (const e of shownEvents()) {
    if (!inSession(e, all)) continue; const l = state.locations.get(e.eventId); if (!l) continue;
    const [x, z] = sc.proj.toXZ(l.lon, l.lat); const url = state.photos.get(e.eventId); if (!url) loadPhoto(e.eventId);
    const alert = alertsFor(e).some(a => openAt(a, clock));
    pins.push({ id: e.eventId, x, y: lvl(l.floor) * sc.floorH, z, color: wearerColor(e.deviceId), time: fmtTime(e.tMicros), alert, thumb: url, selected: state.selected === e.eventId, title: e.summary });
  }
  sc.setPins(pins);
  sc.setIssues(issueSpecs(sc, clock, lvl));
  if (fitRequested !== seenFit) { seenFit = fitRequested; sc.resetView(); }
  const now = performance.now();
  if (now - brainAt > 250) { brainAt = now; renderBrain(brainEl, { clock, stats: statsEl, locate, onSelect: select, onJump: jumpTo }); }
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
    const all = sessionShifts();
    const evs = [...state.events.values()].filter(e => inSession(e, all)).map(e => `<i style="left:${f(Number(e.tMicros) / 1000)}" class="${alertsFor(e).length ? 'a' : ''}"></i>`);
    const hs = all.filter(s => s.endMs !== null || all.some(o => o.startMs > shiftEnd(s))).map(s => `<i class="h" style="left:${f(shiftEnd(s))}"></i>`);
    marksEl.innerHTML = evs.join('') + hs.join('');
  }
}

export function renderMap() {
  const active = view.mode === 'map';
  host.hidden = !active; if (!active) { hideTip(); return; }
  if (!raf) raf = requestAnimationFrame(frame);
}
export function mapUserView() { return !!scene?.userView; }
setRangeSource(sessionRange);
onView(() => renderMap());
