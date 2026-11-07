// The signature move: the entity graph drawn as a floor schematic.
// Zones come from the asset registry (the first segment of each asset's location) plus any
// place the model named that no registry asset explains. Assets are tiles inside their zone,
// carrying their latest state. Events are photo chips (or dots where crowded) on a vertical
// time axis beneath the asset they touched; NEXT edges trace the operator's walk. New photos
// slide in from the "now" edge and the path draws itself to them.
import { state, visibleEvents, placeOf, assetsOf, displayName, edgesFrom, props, alertsFor, wearerColor, wearerName, fmtTime, nowMicros, notify, loadPhoto, type Ev, type Ent } from './store';
import { select, esc } from './timeline';

const canvas = document.getElementById('floor') as HTMLCanvasElement;
const empty = document.getElementById('floor-empty') as HTMLElement;
const tools = document.getElementById('floor-tools') as HTMLElement;
const ctx = canvas.getContext('2d')!;

type Mark = { x: number; y: number; w: number; h: number; id: string };
type TileHit = { x0: number; y0: number; w: number; h: number; id: string };
let marks: Mark[] = []; let tiles: TileHit[] = [];
let hover: string | null = null;

// ---------- view state: zoom/pan on the time axis, animated positions, photo cache ----------
let zoom = 1, panY = 0;
const bootT = performance.now();
const seen = new Set<string>();
const anim = new Map<string, { x: number; y: number; a: number; t0: number }>();
const imgs = new Map<string, HTMLImageElement>();
let lastFrame = performance.now(); let raf = 0;
function photo(id: string): HTMLImageElement | null {
  const url = state.photos.get(id); if (!url) { loadPhoto(id); return null; }
  let im = imgs.get(id);
  if (!im) { im = new Image(); im.onload = () => renderFloor(); im.src = url; imgs.set(id, im); }
  return im.complete && im.naturalWidth ? im : null;
}
function frame() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; renderFloor(); }); }

// ---------- hover card ----------
const tip = document.createElement('div');
tip.className = 'floor-tip'; tip.style.display = 'none';
document.body.appendChild(tip);
function placeTip(e: MouseEvent) {
  const pad = 14; const w = tip.offsetWidth || 260, h = tip.offsetHeight || 120;
  tip.style.left = `${e.clientX + pad + w > innerWidth ? e.clientX - pad - w : e.clientX + pad}px`;
  tip.style.top = `${e.clientY + pad + h > innerHeight ? e.clientY - pad - h : e.clientY + pad}px`;
}
function renderTip(id: string) {
  const ev = state.events.get(id)!; const url = state.photos.get(id); const alerts = alertsFor(ev).filter(a => !a.acked); const place = placeOf(id);
  tip.innerHTML = `${url ? `<img src="${url}" alt="">` : '<div class="ph"></div>'}<div class="tb"><div class="tt"><span class="mono">${fmtTime(ev.tMicros)}</span> · <i style="background:${wearerColor(ev.deviceId)}"></i>${esc(wearerName(ev.deviceId))}${place ? ` · ${esc(place.canonicalName)}` : ''}</div>${alerts.length ? `<div class="ta">${esc(alerts[0].text)}${alerts[0].assetName ? ` · ${esc(alerts[0].assetName)}` : ''}</div>` : ''}<div class="ts">${esc(ev.summary || 'reading the photo…')}</div>${ev.note ? `<div class="tn">“${esc(ev.note)}”</div>` : ''}</div>`;
}
canvas.addEventListener('mousemove', e => {
  const r = canvas.getBoundingClientRect(); const x = e.clientX - r.left, y = e.clientY - r.top;
  const m = marks.find(m => Math.abs(m.x - x) <= m.w / 2 + 6 && Math.abs(m.y - y) <= m.h / 2 + 6);
  const t = !m && tiles.find(t => x >= t.x0 && x <= t.x0 + t.w && y >= t.y0 && y <= t.y0 + t.h);
  const prev = hover; hover = m?.id ?? null; canvas.style.cursor = m || t ? 'pointer' : 'default';
  if (m) {
    if (!state.photos.get(m.id)) loadPhoto(m.id).then(() => { if (hover === m.id) renderTip(m.id); });
    if (prev !== m.id) renderTip(m.id);
    tip.style.display = 'block'; placeTip(e);
  } else if (t) {
    const a = state.entities.get(t.id); const asset = state.assets.get(t.id.toUpperCase().replace(/_/g, '-'));
    const name = a ? displayName(a) : asset?.assetId ?? t.id; const full = a?.canonicalName ?? asset?.name ?? '';
    const last = allEvents().find(ev => assetsOf(ev.eventId).some(x => x.entityId === t.id));
    tip.innerHTML = `<div class="tb"><div class="tt"><b>${esc(name)}</b>${full && full !== name ? ` <span>${esc(full)}</span>` : ''}${asset?.location ? ` · ${esc(asset.location)}` : ''}</div><div class="ts">${last ? `Last seen ${fmtTime(last.tMicros)} by ${esc(wearerName(last.deviceId))}. Click to trace.` : 'Not photographed in this window.'}</div></div>`;
    tip.style.display = 'block'; placeTip(e);
  } else tip.style.display = 'none';
  if (prev !== hover) renderFloor();
});
canvas.addEventListener('mouseleave', () => { hover = null; tip.style.display = 'none'; renderFloor(); });
canvas.addEventListener('click', e => {
  if (hover) { select(hover); return; }
  const r = canvas.getBoundingClientRect(); const x = e.clientX - r.left, y = e.clientY - r.top;
  const t = tiles.find(t => x >= t.x0 && x <= t.x0 + t.w && y >= t.y0 && y <= t.y0 + t.h);
  if (t) { state.assetFilter = state.assetFilter === t.id ? null : t.id; notify(); }
});
canvas.addEventListener('dblclick', () => { zoom = 1; panY = 0; renderFloor(); });
// Wheel zooms the time axis around the cursor; shift+wheel (or a trackpad) pans.
canvas.addEventListener('wheel', e => {
  if (!marks.length) return; e.preventDefault();
  const r = canvas.getBoundingClientRect(); const yC = e.clientY - r.top;
  if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) { panY -= (e.deltaX || e.deltaY); }
  else { const before = (yC - axisOrigin - panY) / zoom; zoom = Math.min(5, Math.max(1, zoom * Math.exp(-e.deltaY * 0.0015))); panY = yC - axisOrigin - before * zoom; }
  renderFloor();
}, { passive: false });
tools.addEventListener('click', e => {
  const t = e.target as HTMLElement;
  if (t.closest('[data-fit]')) { zoom = 1; panY = 0; renderFloor(); }
  if (t.closest('[data-clear]')) { state.assetFilter = null; notify(); }
});
document.addEventListener('keydown', e => {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
  const tag = (e.target as HTMLElement).tagName; if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  const chrono = [...visibleEvents()].reverse(); if (!chrono.length) return;
  const i = chrono.findIndex(ev => ev.eventId === state.selected); const fwd = e.key === 'ArrowRight' || e.key === 'ArrowDown';
  const next = i < 0 ? (fwd ? chrono[0] : chrono[chrono.length - 1]) : chrono[Math.min(chrono.length - 1, Math.max(0, i + (fwd ? 1 : -1)))];
  e.preventDefault(); select(next.eventId);
});
addEventListener('resize', renderFloor);

// ---------- theme tokens ----------
function cssVar(name: string): string { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
let C = { ink: '', ink2: '', ink3: '', ink4: '', line: '', soft: '', place: '', entity: '', warn: '', crit: '', panel: '', ground: '', path: '', zoneA: '', zoneB: '' };
function readTokens() {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches && document.documentElement.dataset.theme !== 'light' || document.documentElement.dataset.theme === 'dark';
  C = { ink: cssVar('--ink'), ink2: cssVar('--ink-2'), ink3: cssVar('--ink-3'), ink4: cssVar('--ink-4'), line: cssVar('--line-strong'), soft: cssVar('--line'), place: cssVar('--place'), entity: cssVar('--entity'), warn: cssVar('--warning-ink'), crit: cssVar('--critical'), panel: cssVar('--panel'), ground: cssVar('--ground'),
    path: dark ? 'rgba(200,200,195,0.5)' : 'rgba(60,60,56,0.42)', zoneA: dark ? 'rgba(255,255,255,0.035)' : 'rgba(20,20,18,0.035)', zoneB: dark ? 'rgba(255,255,255,0.015)' : 'rgba(20,20,18,0.015)' };
}
readTokens(); matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { readTokens(); renderFloor(); });

// ---------- layout constants ----------
const PAD = 16, TOP = 46, TILE_H = 26, TILE_ROW = 32, GAP_MIN = 18, GAP_MAX = 56, COLLAPSE_MIN = 30; // minutes before a gap is drawn as a break
const CHIP_W = 44, CHIP_H = 33, DOT_R = 6;
let axisOrigin = 0; // y of the first event at zoom 1, pan 0 (needed by the wheel handler)

const entityIdOf = (assetId: string) => assetId.toLowerCase().replace(/-/g, '_');
const zoneKey = (loc: string) => (loc || '').split('/')[0].trim() || 'Unassigned';
function allEvents(): Ev[] { const saved = state.assetFilter; state.assetFilter = null; try { return visibleEvents(); } finally { state.assetFilter = saved; } }
function slug(name: string): string { return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|$/g, ''); }
function roundRect(x: number, y: number, w: number, h: number, r: number) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
function bezierPoint(ax: number, ay: number, bx: number, by: number, t: number) {
  const my = (ay + by) / 2; const u = 1 - t;
  return { x: u * u * u * ax + 3 * u * u * t * ax + 3 * u * t * t * bx + t * t * t * bx, y: u * u * u * ay + 3 * u * u * t * my + 3 * u * t * t * my + t * t * t * by };
}

let lastTools = '';
export function renderFloor() {
  const now = performance.now(); const dt = Math.min(50, now - lastFrame); lastFrame = now;
  const dpr = devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (canvas.width !== W * dpr || canvas.height !== H * dpr) { canvas.width = W * dpr; canvas.height = H * dpr; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
  marks = []; tiles = [];
  const evs = allEvents(); const tracedList = state.assetFilter ? visibleEvents() : null;
  const traced = tracedList ? new Set(tracedList.map(e => e.eventId)) : null;
  empty.hidden = evs.length > 0 || state.assets.size > 0;
  if (!evs.length && !state.assets.size) { setTools(''); return; }

  // ---- zones: registry first, then places the model named that no asset explains ----
  type Zone = { key: string; name: string; registry: boolean; tileIds: string[]; x0: number; w: number; rows: number };
  const zones: Zone[] = []; const zoneByKey = new Map<string, Zone>();
  const addZone = (key: string, name: string, registry: boolean) => { let z = zoneByKey.get(key); if (!z) { z = { key, name, registry, tileIds: [], x0: 0, w: 0, rows: 1 }; zoneByKey.set(key, z); zones.push(z); } return z; };
  const assetZone = new Map<string, string>(); // entityId -> zone key
  for (const a of state.assets.values()) { const k = zoneKey(a.location); addZone(k, k, true); assetZone.set(entityIdOf(a.assetId), k); }
  const chrono = [...evs].reverse();
  const placeZone = new Map<string, string>(); // place entityId -> zone key, learned from events that touched a registry asset there
  for (const e of chrono) { const p = placeOf(e.eventId); if (!p || placeZone.has(p.entityId)) continue; const a = assetsOf(e.eventId).find(x => assetZone.has(x.entityId)); if (a) placeZone.set(p.entityId, assetZone.get(a.entityId)!); }
  const zoneOf = new Map<string, string>();
  for (const e of chrono) {
    const p = placeOf(e.eventId); const a = assetsOf(e.eventId).find(x => assetZone.has(x.entityId));
    let k: string;
    if (a) k = assetZone.get(a.entityId)!;
    else if (p && placeZone.has(p.entityId)) k = placeZone.get(p.entityId)!;
    else if (p) { k = `place:${p.entityId}`; addZone(k, p.canonicalName, false); }
    else { k = '_none'; addZone(k, 'No place identified', false); }
    zoneOf.set(e.eventId, k);
    // labeled, non-registry entities earn a tile in the event's zone
    const labelId = e.label ? slug(e.label) : null;
    for (const x of assetsOf(e.eventId)) if (x.entityId === labelId && !assetZone.has(x.entityId)) { assetZone.set(x.entityId, k); }
  }
  for (const [id, k] of assetZone) { const z = zoneByKey.get(k); if (z && !z.tileIds.includes(id)) z.tileIds.push(id); }
  // drop registry zones with nothing to show when there are events elsewhere? No: unseen zones are the coverage story. Keep them.

  // ---- zone widths: proportional to tiles, with a floor, wrapping tiles into two rows when dense ----
  const avail = W - PAD * 2;
  const needFor = () => zones.map(z => Math.max(130, Math.ceil(z.tileIds.length / z.rows) * 82 + 16));
  for (const z of zones) z.rows = z.tileIds.length > 4 ? 2 : 1;
  let need = needFor(); let sum = need.reduce((a, b) => a + b, 0);
  if (sum > avail) { for (const z of zones) if (z.tileIds.length > 2) z.rows = 2; need = needFor(); sum = need.reduce((a, b) => a + b, 0); } // narrow: wrap sooner rather than truncate names
  let x = PAD;
  zones.forEach((z, i) => { z.w = sum <= avail ? need[i] + (avail - sum) * (need[i] / sum) : avail * (need[i] / sum); z.x0 = x; x += z.w; });
  const rowsMax = Math.max(1, ...zones.map(z => z.rows));
  const axisTop = TOP + TILE_ROW * rowsMax + 34, axisBottom = H - 28;

  // ---- y by event rank: linear time while it fits, compressed gaps (drawn as breaks) once it does not ----
  const usable = axisBottom - axisTop - CHIP_H - 10;
  const rank = new Map<string, number>(); let breaks: { y: number; minutes: number }[] = [];
  const lay = (compress: boolean) => {
    rank.clear(); breaks = []; let y = 0;
    for (let i = 0; i < chrono.length; i++) {
      if (i) {
        const m = Number(chrono[i].tMicros - chrono[i - 1].tMicros) / 60e6;
        const g = compress ? Math.min(GAP_MAX, Math.max(GAP_MIN, GAP_MIN + m * 4)) : Math.max(GAP_MIN, GAP_MIN + m * 4);
        if (compress && m >= COLLAPSE_MIN) breaks.push({ y: y + g / 2, minutes: Math.round(m) });
        y += g;
      }
      rank.set(chrono[i].eventId, y);
    }
    return y;
  };
  let span = lay(false); if (span > usable) span = lay(true); span = Math.max(1, span);
  const scale = span > usable ? usable / span : Math.min(2.2, Math.max(1, (usable * 0.6) / span));
  axisOrigin = axisTop + CHIP_H / 2 + 4;
  const content = span * scale * zoom; const minPan = Math.min(0, usable - content);
  panY = Math.min(0, Math.max(minPan, panY)); if (zoom <= 1) panY = 0;
  const yOf = (id: string) => axisOrigin + rank.get(id)! * scale * zoom + panY;
  const yBreak = (b: number) => axisOrigin + b * scale * zoom + panY;

  // ---- zones: shading and headers ----
  ctx.textBaseline = 'middle';
  zones.forEach((z, i) => {
    ctx.fillStyle = i % 2 ? C.zoneB : C.zoneA; ctx.fillRect(z.x0, TOP - 30, z.w, H - TOP + 30);
    ctx.strokeStyle = C.soft; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(z.x0, TOP - 30); ctx.lineTo(z.x0, H); ctx.stroke();
    const none = z.key === '_none';
    ctx.fillStyle = none ? C.ink3 : C.place; ctx.textAlign = 'left'; ctx.font = none ? '500 12px Inter, sans-serif' : '600 12px Inter, sans-serif';
    const label = none ? z.name : z.name.toUpperCase(); const maxW = z.w - 20;
    ctx.fillText(fit(label, maxW), z.x0 + 10, TOP - 14);
    if (z.registry && z.tileIds.length) {
      const seenN = z.tileIds.filter(id => evs.some(e => assetsOf(e.eventId).some(a => a.entityId === id))).length;
      const t = `${seenN}/${z.tileIds.length} seen`; ctx.font = '11px "JetBrains Mono", monospace'; const tw = ctx.measureText(t).width;
      if (ctx.measureText(label).width + tw + 30 < z.w) { ctx.fillStyle = seenN === z.tileIds.length ? C.ink4 : C.ink3; ctx.textAlign = 'right'; ctx.fillText(t, z.x0 + z.w - 10, TOP - 14); }
    }
  });

  // ---- asset tiles with state: last change (amber), else last seen; faded when unseen; red edge on open alert ----
  const assetX = new Map<string, number>();
  for (const z of zones) {
    const cols = Math.ceil(z.tileIds.length / z.rows); if (!cols) {
      const cx = z.x0 + z.w / 2; ctx.strokeStyle = C.soft; ctx.setLineDash([2, 4]); ctx.beginPath(); ctx.moveTo(cx, axisTop); ctx.lineTo(cx, axisBottom); ctx.stroke(); ctx.setLineDash([]); continue;
    }
    const slotW = z.w / (cols + 1); const twMax = Math.min(96, slotW - 8);
    z.tileIds.forEach((id, j) => {
      const row = z.rows === 2 ? j % 2 : 0; const col = z.rows === 2 ? Math.floor(j / 2) : j;
      const cx = z.x0 + slotW * (col + 1); assetX.set(id, cx);
      const ent = state.entities.get(id); const asset = state.assets.get(id.toUpperCase().replace(/_/g, '-'));
      const name = ent ? displayName(ent) : asset?.assetId ?? id;
      ctx.font = '500 12px "JetBrains Mono", monospace';
      const label = fit(name, twMax - 16); const tw = Math.max(56, Math.min(twMax, ctx.measureText(label).width + 18));
      const lastEv = evs.find(e => assetsOf(e.eventId).some(a => a.entityId === id));
      const hasAlert = evs.some(e => alertsFor(e).some(al => al.assetId === id && !al.acked));
      const active = state.assetFilter === id; const faded = !lastEv;
      const ty = TOP + 2 + row * TILE_ROW;
      ctx.globalAlpha = faded ? 0.45 : 1;
      ctx.fillStyle = active ? C.ink : C.panel; ctx.strokeStyle = hasAlert ? C.crit : active ? C.ink : C.line; ctx.lineWidth = hasAlert || active ? 1.5 : 1;
      if (faded) ctx.setLineDash([3, 3]);
      roundRect(cx - tw / 2, ty, tw, TILE_H, 5); ctx.fill(); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = active ? C.ground : hasAlert ? C.crit : C.entity; ctx.textAlign = 'center'; ctx.fillText(label, cx, ty + TILE_H / 2 + 1);
      ctx.globalAlpha = 1;
      tiles.push({ x0: cx - tw / 2, y0: ty, w: tw, h: TILE_H, id });
      // state line under the tile row block
      let reading = '', tone = C.ink3;
      for (const e of evs) { const ch = edgesFrom(e.eventId, 'CHANGES').find(ed => ed.toId === id); if (ch) { const p = props(ch); reading = `${p.attr ? p.attr + ' ' : ''}${p.from} → ${p.to}`; tone = C.warn; break; } }
      if (!reading && lastEv) reading = `${fmtTime(lastEv.tMicros)} · ${wearerName(lastEv.deviceId)}`;
      if (!reading) { reading = 'not seen'; tone = C.ink4; }
      if (z.rows === 1 || row === 1) { ctx.font = '11px "JetBrains Mono", monospace'; ctx.fillStyle = tone; ctx.fillText(fit(reading, slotW - 6), cx, TOP + TILE_ROW * z.rows + 8); }
      // time axis under the tile
      ctx.strokeStyle = C.soft; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(cx, axisTop); ctx.lineTo(cx, axisBottom); ctx.stroke();
    });
  }

  // ---- time ticks, gap breaks, now edge ----
  ctx.save(); ctx.beginPath(); ctx.rect(0, axisTop - 2, W, axisBottom - axisTop + 2); ctx.clip();
  ctx.font = '11px "JetBrains Mono", monospace'; ctx.fillStyle = C.ink3; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  let lastTickY = -99;
  for (const e of chrono) { const yy = yOf(e.eventId); if (yy - lastTickY >= 16) { ctx.fillText(fmtTime(e.tMicros), PAD + 6, yy); lastTickY = yy; } }
  for (const b of breaks) {
    const yy = yBreak(b.y); const h = Math.min(GAP_MAX, GAP_MIN + b.minutes * 4) * scale * zoom; if (h < 34) continue;
    const label = b.minutes >= 90 ? `${Math.floor(b.minutes / 60)} h ${b.minutes % 60 ? (b.minutes % 60) + ' min' : ''}`.trim() : `${b.minutes} min`;
    ctx.fillStyle = C.ink4; ctx.font = 'italic 11px Inter, sans-serif'; ctx.fillText(`· ${label} ·`, PAD + 6, yy);
    // break marks across every axis line
    ctx.strokeStyle = C.ground; ctx.lineWidth = 6; for (const cx of assetX.values()) { ctx.beginPath(); ctx.moveTo(cx, yy - 5); ctx.lineTo(cx, yy + 5); ctx.stroke(); }
    ctx.strokeStyle = C.line; ctx.lineWidth = 1; for (const cx of assetX.values()) { ctx.beginPath(); ctx.moveTo(cx - 4, yy + 3); ctx.lineTo(cx + 4, yy - 3); ctx.stroke(); }
    ctx.font = '11px "JetBrains Mono", monospace';
  }
  ctx.restore();
  ctx.strokeStyle = C.line; ctx.setLineDash([3, 4]); ctx.beginPath(); ctx.moveTo(PAD, axisBottom); ctx.lineTo(W - PAD, axisBottom); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = C.ink3; ctx.font = '11px "JetBrains Mono", monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillText(`now ${fmtTime(nowMicros())}`, PAD + 6, axisBottom - 4); ctx.textBaseline = 'middle';

  // ---- target positions, then animated positions ----
  const target = new Map<string, { x: number; y: number }>(); const lane = new Map<string, number>();
  for (const e of chrono) {
    const z = zoneByKey.get(zoneOf.get(e.eventId)!)!;
    const a = assetsOf(e.eventId).find(a => assetX.has(a.entityId)); const tx = a ? assetX.get(a.entityId)! : z.x0 + z.w / 2;
    const ty = yOf(e.eventId); const key = `${Math.round(tx)}:${Math.round(ty)}`; const n = lane.get(key) ?? 0; lane.set(key, n + 1);
    target.set(e.eventId, { x: tx + (n ? (n % 2 ? 1 : -1) * Math.ceil(n / 2) * 14 : 0), y: ty });
  }
  const booted = now - bootT > 2500 && seen.size > 0;
  let moving = false; const k = 1 - Math.exp(-dt / 110);
  const pos = new Map<string, { x: number; y: number; a: number; t0: number }>();
  for (const e of chrono) {
    const t = target.get(e.eventId)!; let p = anim.get(e.eventId);
    if (!p) { const isNew = booted && !seen.has(e.eventId); p = { x: t.x, y: isNew ? axisBottom : t.y, a: isNew ? 0 : 1, t0: now }; anim.set(e.eventId, p); }
    seen.add(e.eventId);
    p.x += (t.x - p.x) * k; p.y += (t.y - p.y) * k; p.a += (1 - p.a) * k;
    if (Math.abs(t.x - p.x) > 0.3 || Math.abs(t.y - p.y) > 0.3 || 1 - p.a > 0.02) moving = true; else { p.x = t.x; p.y = t.y; p.a = 1; }
    pos.set(e.eventId, p);
  }
  for (const id of anim.keys()) if (!target.has(id)) anim.delete(id);

  // ---- chips or dots: a chip when nothing else sits within its height in the same column ----
  const chip = new Set<string>();
  for (const e of chrono) {
    const t = target.get(e.eventId)!;
    const crowded = chrono.some(o => o !== e && Math.abs(target.get(o.eventId)!.x - t.x) < CHIP_W && Math.abs(target.get(o.eventId)!.y - t.y) < CHIP_H + 6);
    if (!crowded) chip.add(e.eventId);
  }

  ctx.save(); ctx.beginPath(); ctx.rect(0, axisTop - CHIP_H, W, axisBottom - axisTop + CHIP_H + 20); ctx.clip();
  // ---- NEXT path: the operator's walk; draws itself toward a newly arrived photo ----
  ctx.lineWidth = 1.5; ctx.lineCap = 'round';
  for (const ed of state.edges) if (ed.kind === 'NEXT') {
    const a = pos.get(ed.fromId), b = pos.get(ed.toId); if (!a || !b) continue;
    const dim = traced && !(traced.has(ed.fromId) && traced.has(ed.toId));
    ctx.strokeStyle = C.path; ctx.globalAlpha = (dim ? 0.18 : 1) * Math.min(a.a, 1);
    const prog = Math.min(1, (now - b.t0) / 650); if (prog < 1) moving = true;
    ctx.beginPath(); ctx.moveTo(a.x, a.y);
    if (prog >= 1) ctx.bezierCurveTo(a.x, (a.y + b.y) / 2, b.x, (a.y + b.y) / 2, b.x, b.y);
    else for (let s = 1; s <= 24; s++) { const q = bezierPoint(a.x, a.y, b.x, b.y, (s / 24) * prog); ctx.lineTo(q.x, q.y); }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  // ---- CHANGES ticks (amber) toward the asset that changed ----
  ctx.strokeStyle = C.warn; ctx.lineWidth = 1.5;
  for (const ed of state.edges) if (ed.kind === 'CHANGES') { const a = pos.get(ed.fromId); const bx = assetX.get(ed.toId); if (!a || bx === undefined) continue; ctx.globalAlpha = traced && !traced.has(ed.fromId) ? 0.18 : 1; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(bx, a.y); ctx.stroke(); }
  ctx.globalAlpha = 1;

  // ---- marks ----
  for (const e of chrono) {
    const p = pos.get(e.eventId)!; const open = alertsFor(e).some(a => !a.acked); const sel = state.selected === e.eventId || hover === e.eventId;
    const dim = traced ? !traced.has(e.eventId) : false; const color = open ? C.crit : wearerColor(e.deviceId);
    ctx.globalAlpha = (dim ? 0.22 : 1) * p.a;
    const isChip = chip.has(e.eventId); const im = isChip ? photo(e.eventId) : null;
    if (state.fresh.has(e.eventId)) { const kk = Math.min(1, (now - p.t0) / 1200); if (kk < 1) moving = true; ctx.strokeStyle = color; ctx.globalAlpha *= 1 - kk; ctx.lineWidth = 2; roundRect(p.x - CHIP_W / 2 - 4 - kk * 18, p.y - CHIP_H / 2 - 4 - kk * 18, CHIP_W + 8 + kk * 36, CHIP_H + 8 + kk * 36, 8 + kk * 10); ctx.stroke(); ctx.globalAlpha = (dim ? 0.22 : 1) * p.a; }
    if (open) { ctx.fillStyle = 'rgba(208,59,59,0.16)'; if (isChip) { roundRect(p.x - CHIP_W / 2 - 6, p.y - CHIP_H / 2 - 6, CHIP_W + 12, CHIP_H + 12, 9); ctx.fill(); } else { ctx.beginPath(); ctx.arc(p.x, p.y, DOT_R + 7, 0, 7); ctx.fill(); } }
    if (isChip) {
      const x0 = p.x - CHIP_W / 2, y0 = p.y - CHIP_H / 2;
      ctx.save(); roundRect(x0, y0, CHIP_W, CHIP_H, 5); ctx.clip();
      ctx.fillStyle = C.panel; ctx.fillRect(x0, y0, CHIP_W, CHIP_H);
      if (im) { const s = Math.max(CHIP_W / im.naturalWidth, CHIP_H / im.naturalHeight); const dw = im.naturalWidth * s, dh = im.naturalHeight * s; ctx.drawImage(im, x0 + (CHIP_W - dw) / 2, y0 + (CHIP_H - dh) / 2, dw, dh); }
      else { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, 7); ctx.fill(); }
      ctx.restore();
      ctx.strokeStyle = color; ctx.lineWidth = sel ? 2.5 : 2; roundRect(x0, y0, CHIP_W, CHIP_H, 5); ctx.stroke();
      if (sel) { ctx.strokeStyle = C.ink; ctx.lineWidth = 1.5; roundRect(x0 - 4, y0 - 4, CHIP_W + 8, CHIP_H + 8, 8); ctx.stroke(); }
      marks.push({ x: p.x, y: p.y, w: CHIP_W, h: CHIP_H, id: e.eventId });
    } else {
      const r = sel ? 8 : DOT_R;
      ctx.fillStyle = color; ctx.strokeStyle = C.ground; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 7); ctx.fill(); ctx.stroke();
      if (sel) { ctx.strokeStyle = C.ink; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(p.x, p.y, r + 4, 0, 7); ctx.stroke(); }
      marks.push({ x: p.x, y: p.y, w: r * 2, h: r * 2, id: e.eventId });
    }
    ctx.globalAlpha = 1;
  }
  ctx.restore();

  // ---- header tools: trace pill, fit ----
  const tracedName = state.assetFilter ? (state.entities.get(state.assetFilter) ? displayName(state.entities.get(state.assetFilter)!) : state.assetFilter) : '';
  setTools((tracedName ? `<button type="button" class="pill" data-clear title="Stop tracing">Tracing <b>${esc(tracedName)}</b> · ${tracedList!.length} photo${tracedList!.length === 1 ? '' : 's'} · clear</button>` : '') + (zoom > 1.01 ? `<button type="button" class="btn ghost" data-fit title="Reset zoom (double-click the floor)">Fit ${zoom.toFixed(1)}×</button>` : ''));
  if (moving) frame();
}
function setTools(html: string) { if (html !== lastTools) { tools.innerHTML = html; lastTools = html; } }
function fit(s: string, maxW: number): string { if (ctx.measureText(s).width <= maxW) return s; let t = s; while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1); return t + '…'; }
