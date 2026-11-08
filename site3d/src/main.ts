import './styles.css';
import { state, start, onChange, wearerColor, wearerName, fmtTime, fmtTimeS, alertsFor, loadPhoto, placeOf, type Alert } from './store';
import { SiteScene, type PinSpec, type IssueSpec, type SiteData } from './scene';
import { sessionShifts, shifts, positionAt, shiftEnd, shiftLive, resolvedAt, renderBrain, inSession, type Shift } from './brain';
import { pointInRing, centroid, haversineM } from './geo';
import ecsw from './data/ecsw.json';

const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s)!;
const scene = new SiteScene($('#gl'), $('#labels'));

// ---------- site ----------
type Site = { kind: 'ecsw' | 'generic'; center: [number, number]; rooms: { name: string; ring: [number, number][] }[]; outer: [number, number][] | null; builtFor: string };
let site: Site | null = null;
const ECSW_CENTER = ecsw.center as [number, number];
function dataCentroid(): [number, number] | null {
  const pts = [...state.track.filter(p => p.kind === 'point').map(p => [p.lon, p.lat] as [number, number]), ...[...state.locations.values()].map(l => [l.lon, l.lat] as [number, number])];
  return pts.length ? centroid(pts) : null;
}
function ensureSite() {
  const c = dataCentroid(); const nearEcsw = !c || haversineM(c[1], c[0], ECSW_CENTER[1], ECSW_CENTER[0]) < 400;
  const key = nearEcsw ? 'ecsw' : `generic:${state.db}`;
  if (site && site.builtFor === key) return;
  if (nearEcsw) {
    const d: SiteData = { center: ECSW_CENTER, main: { name: ecsw.ecsw.name, levels: ecsw.ecsw.levels, height: ecsw.ecsw.height, outer: ecsw.ecsw.outer as any, inner: ecsw.ecsw.inner as any }, indoor: ecsw.indoor as any, neighbors: ecsw.neighbors as any, paths: ecsw.paths as any, tileRadius: 4 };
    scene.buildSite(d);
    site = { kind: 'ecsw', center: ECSW_CENTER, outer: ecsw.ecsw.outer as any, rooms: (ecsw.indoor as any[]).filter(r => r.name && r.pts.length >= 3).map(r => ({ name: r.name, ring: r.pts })), builtFor: key };
    $('#site').textContent = 'ECSW · UT Dallas';
  } else {
    scene.buildSite({ center: c!, tileRadius: 3 });
    const xs = [...state.track.filter(p => p.kind === 'point'), ...state.locations.values()].map(p => scene.proj.toXZ(p.lon, p.lat));
    const minX = Math.min(...xs.map(p => p[0])) - 10, maxX = Math.max(...xs.map(p => p[0])) + 10, minZ = Math.min(...xs.map(p => p[1])) - 10, maxZ = Math.max(...xs.map(p => p[1])) + 10;
    const name = state.assets.size ? ([...state.assets.values()][0].location.split('/')[0].trim() || 'Site') : 'Site';
    scene.buildHall(minX, maxX, minZ, maxZ, name);
    site = { kind: 'generic', center: c!, outer: null, rooms: [], builtFor: key };
    $('#site').textContent = `${state.db.replace(/^wm-/, '')} · synthetic site`;
  }
  resetHeat();
}
function locate(lat: number, lon: number): string | undefined {
  if (!site) return; const pt: [number, number] = [lon, lat];
  for (const r of site.rooms) if (pointInRing(pt, r.ring)) return r.name;
  if (site.outer && pointInRing(pt, site.outer)) return 'inside ECSW';
  return site.kind === 'ecsw' ? 'outside the building' : undefined;
}

// ---------- clock / replay ----------
const replay = { mode: 'live' as 'live' | 'replay', playing: false, speed: 60, clock: Date.now() };
// The replay covers the tracked shift: from just before the first fix to the moment the shift
// actually ended (its shift_end row, or ten minutes after its last fix); while a shift is still
// live it runs to now. Photos outside any shift do not stretch it and are not drawn.
function range(): [number, number] {
  const all = sessionShifts(); const now = Date.now();
  if (!all.length) return [now - 3600_000, now];
  const t0 = Math.min(...all.map(s => s.startMs)) - 5_000;
  const over = all.every(s => !shiftLive(s, now));
  return [t0, over ? Math.max(...all.map(shiftEnd)) + 10_000 : now];
}
function setMode(m: 'live' | 'replay') {
  replay.mode = m; $('#live').classList.toggle('on', m === 'live'); const md = $('#mode'); md.textContent = m === 'live' ? 'live' : 'replay'; md.classList.toggle('replay', m === 'replay');
  if (m === 'live') { replay.playing = false; replay.clock = Date.now(); } $('#play').textContent = replay.playing ? '❚❚' : '▶';
}
function setClock(ms: number) { replay.clock = ms; }
$('#play').onclick = () => {
  const [t0, t1] = range();
  if (replay.mode === 'live') { setMode('replay'); replay.clock = t0; replay.playing = true; resetHeat(); scene.setFollow(true); }
  else if (!replay.playing && replay.clock >= t1 - 1) { replay.clock = t0; replay.playing = true; resetHeat(); }
  else replay.playing = !replay.playing;
  $('#play').textContent = replay.playing ? '❚❚' : '▶';
};
$('#live').onclick = () => setMode('live');
document.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach(b => b.onclick = () => { replay.speed = Number(b.dataset.speed); document.querySelectorAll('[data-speed]').forEach(x => x.classList.toggle('on', x === b)); });
const scrub = $('#scrub') as HTMLInputElement;
scrub.oninput = () => { const [t0, t1] = range(); if (replay.mode === 'live') setMode('replay'); setClock(t0 + (Number(scrub.value) / 1000) * (t1 - t0)); };
document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(b => b.onclick = () => { scene.setView(b.dataset.view as any); document.querySelectorAll('[data-view]').forEach(x => x.classList.toggle('on', x === b)); });
const followBtn = $('#follow'); followBtn.onclick = () => scene.setFollow(!scene.follow);
addEventListener('site:follow', (e: any) => followBtn.setAttribute('aria-pressed', String(e.detail.on)));
addEventListener('keydown', e => { if ((e.target as HTMLElement).tagName === 'INPUT') return; if (e.key === ' ') { e.preventDefault(); $('#play').click(); } if (e.key === 'l') setMode('live'); if (e.key === 'f') followBtn.click(); if (e.key === '2') (document.querySelector('[data-view="2d"]') as HTMLElement).click(); if (e.key === '3') (document.querySelector('[data-view="3d"]') as HTMLElement).click(); });

// ---------- selection / tips ----------
let selected: string | null = null;
function select(id: string | null) {
  selected = id; if (!id) return; const l = state.locations.get(id); if (l) { const [x, z] = scene.proj.toXZ(l.lon, l.lat); scene.focus(x, z); }
  const e = state.events.get(id); if (e && e.tMs > replay.clock) { if (replay.mode === 'live') setMode('replay'); setClock(e.tMs + 1000); }
}
const tip = $('#tip');
scene.onPinClick = id => select(id);
scene.onPinHover = (id, x, y) => {
  if (!id) { tip.hidden = true; return; } const e = state.events.get(id); if (!e) return;
  tip.innerHTML = `<div class="t">${fmtTime(e.tMs)} · ${wearerName(e.deviceId)}${placeOf(id) ? ' · ' + placeOf(id) : ''}</div><p>${e.summary || e.scene || 'Reading the photo…'}</p>${e.note ? `<p><i>“${e.note}”</i></p>` : ''}`;
  tip.hidden = false; tip.style.left = Math.min(innerWidth - 300, x + 14) + 'px'; tip.style.top = Math.max(8, y - 60) + 'px';
};

scene.onIssueClick = id => { const a = state.alerts.find(a => String(a.alertId) === id); if (!a) return; select(a.eventId); };
scene.onIssueHover = (id, x, y) => {
  if (!id) { tip.hidden = true; return; } const a = state.alerts.find(a => String(a.alertId) === id); if (!a) return;
  const done = resolvedAt(a) <= replay.clock;
  tip.innerHTML = `<div class="t">${done ? `resolved ${fmtTime(resolvedAt(a))}` : `open since ${fmtTime(a.tMs)}`} · ${wearerName(a.deviceId)}</div><p><b>${a.entityName || a.text}</b>${a.entityName ? ` · ${a.text}` : ''}</p>`;
  tip.hidden = false; tip.style.left = Math.min(innerWidth - 300, x + 14) + 'px'; tip.style.top = Math.max(8, y - 60) + 'px';
};

// ---------- issue markers ----------
// An issue sits where the photo that raised it was taken; a photo without a fix falls back to where
// its wearer's track was at that moment. Issues with neither stay in the panel only.
function issueSpot(a: Alert): { lat: number; lon: number; floor?: number } | null {
  const l = state.locations.get(a.eventId); if (l) return { lat: l.lat, lon: l.lon, floor: l.floor };
  for (const s of shifts()) { if (s.deviceId !== a.deviceId || a.tMs < s.startMs || a.tMs > shiftEnd(s) + 60_000) continue; const p = positionAt(s, a.tMs); if (p) return { lat: p.lat, lon: p.lon, floor: p.floor }; }
  return null;
}
function issueSpecs(clock: number, lvl: (f: number | undefined) => number): IssueSpec[] {
  const out: IssueSpec[] = []; const stack = new Map<string, number>();
  for (const a of state.alerts) {
    if (a.tMs > clock) continue; const at = issueSpot(a); if (!at) continue;
    const [x, z] = scene.proj.toXZ(at.lon, at.lat); const key = `${x.toFixed(0)}|${z.toFixed(0)}|${lvl(at.floor)}`; const lift = stack.get(key) ?? 0; stack.set(key, lift + 1);
    out.push({ id: String(a.alertId), x, y: lvl(at.floor) * scene.floorH, z, open: resolvedAt(a) > clock, title: `${a.entityName || a.text}${a.entityName ? ' · ' + a.text : ''}`, lift });
  }
  return out;
}

// ---------- heat (incremental over the clock) ----------
const heatCursor = new Map<string, number>(); let heatClock = -Infinity;
function resetHeat() { scene.heat?.reset(); heatCursor.clear(); heatClock = -Infinity; }
function advanceHeat(all: Shift[], clock: number) {
  if (!scene.heat) return; if (clock < heatClock) resetHeat();
  for (const s of all) {
    let i = heatCursor.get(s.key) ?? 0; const p = s.smooth;
    while (i < p.length && p[i].tMs <= clock) { const dt = Math.min(120_000, (p[i + 1]?.tMs ?? p[i].tMs + 30_000) - p[i].tMs) / 1000; const [x, z] = scene.proj.toXZ(p[i].lon, p[i].lat); scene.heat.add(x, z, dt); i++; }
    heatCursor.set(s.key, i);
  }
  heatClock = clock;
}

// ---------- frame ----------
const conn = $('#conn'); const think = $('#think'); let thinkUntil = 0; let lastVersion = -1; let lastDb = '';
onChange(() => {
  conn.className = 'dot ' + (state.connected === 'live' ? 'live' : state.connected === 'error' ? 'err' : ''); conn.title = state.connected === 'error' ? state.lastError : state.connected;
  $('#dataset').textContent = state.db === 'wm-physical' ? 'live capture' : state.db.replace(/^wm-/, '');
  if (state.version !== lastVersion) { lastVersion = state.version; thinkUntil = performance.now() + 1200; }
  if (state.db !== lastDb) { lastDb = state.db; site = null; selected = null; resetHeat(); }
  if (state.track.length || state.locations.size) ensureSite();
  drawMarks();
});
function drawMarks() {
  const [t0, t1] = range(); const f = (t: number) => `${((t - t0) / (t1 - t0)) * 100}%`;
  const evs = [...state.events.values()].filter(e => inSession(e)).map(e => `<i style="left:${f(e.tMs)}" class="${alertsFor(e.eventId).length ? 'a' : ''}"></i>`);
  const all = sessionShifts(); const hs = all.filter(s => s.endMs !== null || all.some(o => o.startMs > shiftEnd(s))).map(s => `<i class="h" style="left:${f(shiftEnd(s))}"></i>`);
  $('#marks').innerHTML = evs.join('') + hs.join('');
}

let lastReal = performance.now(); let brainAt = 0;
function frame(now: number) {
  requestAnimationFrame(frame);
  const dtReal = (now - lastReal) / 1000; lastReal = now;
  if (replay.mode === 'live') replay.clock = Date.now();
  const [t0, t1] = range();
  if (replay.mode === 'replay' && replay.playing) {
    replay.clock += dtReal * 1000 * replay.speed;
    // a live shift hands back to the live clock; a finished one stops at its end
    if (replay.clock >= t1) { if (t1 >= Date.now() - 1000) setMode('live'); else { replay.clock = t1; replay.playing = false; $('#play').textContent = '▶'; } }
  }
  const clock = replay.clock;
  if (document.activeElement !== scrub) scrub.value = String(Math.round(((clock - t0) / (t1 - t0)) * 1000));
  $('#clock').textContent = (replay.mode === 'live' ? '' : `${replay.speed}× · `) + fmtTimeS(clock);
  think.hidden = now > thinkUntil;
  if (!site) { ensureSite(); if (!site) { scene.frame(); return; } }
  const all = sessionShifts();
  const lvl = (f: number | undefined) => Math.max(0, Math.min(f ?? 0, scene.levels - 1)); // the phone may count past the roof
  // wearers: one dot per device, driven by whichever of its shifts is live at the clock
  const byDevice = new Map<string, Shift[]>(); for (const s of all) (byDevice.get(s.deviceId) ?? byDevice.set(s.deviceId, []).get(s.deviceId)!).push(s);
  for (const [dev, list] of byDevice) {
    let drawn = false;
    for (const s of list) {
      const pos = positionAt(s, clock); if (!pos) continue;
      const [x, z] = scene.proj.toXZ(pos.lon, pos.lat); const y = lvl(pos.floor) * scene.floorH + 1.1;
      const trail: number[] = []; for (let i = 0; i <= pos.i; i++) { const q = s.smooth[i]; const [tx, tz] = scene.proj.toXZ(q.lon, q.lat); trail.push(tx, lvl(q.floor) * scene.floorH + 0.6, tz); } trail.push(x, y - 0.5, z);
      const where = locate(pos.lat, pos.lon); const last = s.smooth[pos.i]; const stale = clock - last.tMs > 90_000;
      const floorTxt = pos.floor !== undefined && pos.floor > 0 ? ` · L${pos.floor}` : '';
      scene.setWearer(dev, { color: wearerColor(dev), name: wearerName(dev), sub: (where ? where : stale ? `last fix ${fmtTime(last.tMs)}` : 'on shift') + floorTxt, pos: [x, y, z], trail, acc: pos.acc });
      drawn = true; break;
    }
    if (!drawn) {
      // a finished shift keeps its whole trail and its dot at the last point, with when it ended
      const s = [...list].reverse().find(s => s.startMs <= clock && s.smooth.length >= 1);
      if (s) {
        const trail: number[] = []; let last = s.smooth[0];
        for (const q of s.smooth) { if (q.tMs > clock) break; last = q; const [tx, tz] = scene.proj.toXZ(q.lon, q.lat); trail.push(tx, lvl(q.floor) * scene.floorH + 0.6, tz); }
        const [x, z] = scene.proj.toXZ(last.lon, last.lat); const y = lvl(last.floor) * scene.floorH + 1.1;
        const where = locate(last.lat, last.lon);
        scene.setWearer(dev, { color: wearerColor(dev), name: wearerName(dev), sub: `${where ? where + ' · ' : ''}ended ${fmtTime(shiftEnd(s))}`, pos: [x, y, z], trail });
      } else scene.hideWearer(dev);
    }
  }
  advanceHeat(all, clock);
  // pins
  const pins: PinSpec[] = [];
  for (const e of state.events.values()) {
    if (e.tMs > clock || !inSession(e, all)) continue; const l = state.locations.get(e.eventId); if (!l) continue;
    const [x, z] = scene.proj.toXZ(l.lon, l.lat); const url = state.photos.get(e.eventId); if (!url) loadPhoto(e.eventId);
    pins.push({ id: e.eventId, x, y: lvl(l.floor) * scene.floorH, z, color: wearerColor(e.deviceId), time: fmtTime(e.tMs), alert: alertsFor(e.eventId).some(a => a.tMs <= clock && (!a.acked || (a.ackedMs ?? a.tMs) > clock)), thumb: url, selected: selected === e.eventId, title: e.summary });
  }
  scene.setPins(pins);
  scene.setIssues(issueSpecs(clock, lvl));
  if (now - brainAt > 250) { brainAt = now; renderBrain($('#brain-body'), { clock, selected, locate, onSelect: select, onJump: ms => { if (replay.mode === 'live') setMode('replay'); setClock(ms + 1000); } }); }
  scene.frame();
}
start(4000);
requestAnimationFrame(frame);
