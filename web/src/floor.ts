// The signature move: the entity graph drawn as a floor schematic.
// Places are zones (columns); assets are fixed tiles inside their zone; events are marks on a
// vertical time axis beneath the asset they touched; NEXT edges trace the operator's path.
import { state, visibleEvents, placeOf, assetsOf, displayName, edgesFrom, props, alertsFor, wearerColor, wearerName, fmtTime, nowMicros, notify, loadPhoto, type Ev, type Ent } from './store';
import { select, esc } from './timeline';

const canvas = document.getElementById('floor') as HTMLCanvasElement;
const empty = document.getElementById('floor-empty') as HTMLElement;
const ctx = canvas.getContext('2d')!;
type Mark = { x: number; y: number; r: number; id: string };
type Tile = { x0: number; y0: number; w: number; h: number; id: string };
let marks: Mark[] = []; let tiles: Tile[] = [];
let hover: string | null = null;
const tip = document.createElement('div');
tip.className = 'floor-tip'; tip.style.display = 'none';
document.body.appendChild(tip);

function placeTip(e: MouseEvent) {
  const pad = 14; const w = tip.offsetWidth || 260, h = tip.offsetHeight || 120;
  const x = e.clientX + pad + w > innerWidth ? e.clientX - pad - w : e.clientX + pad;
  const y = e.clientY + pad + h > innerHeight ? e.clientY - pad - h : e.clientY + pad;
  tip.style.left = `${x}px`; tip.style.top = `${y}px`;
}
canvas.addEventListener('mousemove', e => {
  const r = canvas.getBoundingClientRect(); const x = e.clientX - r.left, y = e.clientY - r.top;
  const m = marks.find(m => Math.hypot(m.x - x, m.y - y) <= Math.max(m.r + 7, 12));
  const t = !m && tiles.find(t => x >= t.x0 && x <= t.x0 + t.w && y >= t.y0 && y <= t.y0 + t.h);
  const prev = hover; hover = m?.id ?? null; canvas.style.cursor = m || t ? 'pointer' : 'default';
  if (m) {
    const ev = state.events.get(m.id)!; const url = state.photos.get(m.id); if (!url) loadPhoto(m.id).then(() => { if (hover === m.id) renderTip(m.id); });
    if (prev !== m.id) renderTip(m.id);
    tip.style.display = 'block'; placeTip(e);
  } else if (t) {
    const a = state.entities.get(t.id); const last = visibleEvents().find(ev => assetsOf(ev.eventId).some(x => x.entityId === t.id));
    tip.innerHTML = `<div class="tt"><b>${esc(a ? displayName(a) : t.id)}</b>${a && displayName(a) !== a.canonicalName ? ` <span class="mono">${esc(a.canonicalName)}</span>` : ''}</div><div class="ts">${last ? `last seen ${fmtTime(last.tMicros)} by ${esc(wearerName(last.deviceId))} · click to trace` : 'click to trace'}</div>`;
    tip.style.display = 'block'; placeTip(e);
  } else tip.style.display = 'none';
  if (prev !== hover) renderFloor();
});
function renderTip(id: string) {
  const ev = state.events.get(id)!; const url = state.photos.get(id); const alerts = alertsFor(ev).filter(a => !a.acked); const place = placeOf(id);
  tip.innerHTML = `${url ? `<img src="${url}" alt="">` : '<div class="ph"></div>'}<div class="tb"><div class="tt"><span class="mono">${fmtTime(ev.tMicros)}</span> · <i style="background:${wearerColor(ev.deviceId)}"></i>${esc(wearerName(ev.deviceId))}${place ? ` · ${esc(place.canonicalName)}` : ''}</div>${alerts.length ? `<div class="ta">${esc(alerts[0].text)}${alerts[0].assetName ? ` · ${esc(alerts[0].assetName)}` : ''}</div>` : ''}<div class="ts">${esc(ev.summary || 'reading the photo…')}</div>${ev.note ? `<div class="tn">“${esc(ev.note)}”</div>` : ''}</div>`;
}
canvas.addEventListener('mouseleave', () => { hover = null; tip.style.display = 'none'; renderFloor(); });
// Keyboard: step through the shift in time order; Escape is handled by the detail panel.
document.addEventListener('keydown', e => {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
  const tag = (e.target as HTMLElement).tagName; if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  const chrono = [...visibleEvents()].reverse(); if (!chrono.length) return;
  const i = chrono.findIndex(ev => ev.eventId === state.selected); const fwd = e.key === 'ArrowRight' || e.key === 'ArrowDown';
  const next = i < 0 ? (fwd ? chrono[0] : chrono[chrono.length - 1]) : chrono[Math.min(chrono.length - 1, Math.max(0, i + (fwd ? 1 : -1)))];
  e.preventDefault(); select(next.eventId);
});
// Arrival pulse: a ring expands from a new mark for ~1.2 s.
const arrived = new Map<string, number>();
let raf = 0;
function animateIfFresh() { if (state.fresh.size && !raf) raf = requestAnimationFrame(() => { raf = 0; renderFloor(); }); }
canvas.addEventListener('click', e => {
  if (hover) { select(hover); return; }
  const r = canvas.getBoundingClientRect(); const x = e.clientX - r.left, y = e.clientY - r.top;
  const t = tiles.find(t => x >= t.x0 && x <= t.x0 + t.w && y >= t.y0 && y <= t.y0 + t.h);
  if (t) { state.assetFilter = state.assetFilter === t.id ? null : t.id; notify(); }
});
addEventListener('resize', renderFloor);

// Colors come from the stylesheet tokens so the canvas follows the theme; see web/DESIGN.md.
function cssVar(name: string): string { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
let C = { ink: '', ink2: '', ink3: '', line: '', soft: '', place: '', entity: '', warn: '', crit: '', panel: '', ground: '', path: '', zoneA: '', zoneB: '' };
function readTokens() {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches && document.documentElement.dataset.theme !== 'light' || document.documentElement.dataset.theme === 'dark';
  C = { ink: cssVar('--ink'), ink2: cssVar('--ink-2'), ink3: cssVar('--ink-3'), line: cssVar('--line-strong'), soft: cssVar('--line'), place: cssVar('--place'), entity: cssVar('--entity'), warn: cssVar('--warning-ink'), crit: cssVar('--critical'), panel: cssVar('--panel'), ground: cssVar('--ground'),
    path: dark ? 'rgba(200,200,195,0.5)' : 'rgba(60,60,56,0.42)', zoneA: dark ? 'rgba(255,255,255,0.035)' : 'rgba(20,20,18,0.035)', zoneB: dark ? 'rgba(255,255,255,0.015)' : 'rgba(20,20,18,0.015)' };
}
readTokens(); matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { readTokens(); renderFloor(); });
const ROW = 44, GAP_MAX = 56;

export function renderFloor() {
  const dpr = devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (canvas.width !== W * dpr || canvas.height !== H * dpr) { canvas.width = W * dpr; canvas.height = H * dpr; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
  marks = []; tiles = [];
  const evs = visibleEvents();
  empty.hidden = evs.length > 0;
  if (!evs.length) return;

  // zones: places in order of first appearance; "unplaced" bucket last
  const zoneOrder: string[] = []; const zoneOf = new Map<string, string>();
  const assetZone = new Map<string, string>(); const assetSet = new Map<string, Ent>();
  const saved = state.assetFilter; state.assetFilter = null; const allEvs = visibleEvents(); state.assetFilter = saved;
  for (const e of [...allEvs].reverse()) {
    const p = placeOf(e.eventId); const z = p?.entityId ?? '_none';
    if (!zoneOrder.includes(z)) zoneOrder.push(z); zoneOf.set(e.eventId, z);
    const labelId = e.label ? slug(e.label) : null;
    for (const a of assetsOf(e.eventId)) if (a.kind === 'asset' || a.entityId === labelId) { assetSet.set(a.entityId, a); assetZone.set(a.entityId, z); }
  }
  const pad = 16, top = 46, axisTop = top + 64, axisBottom = H - 28;
  const zoneW = (W - pad * 2) / zoneOrder.length;

  // y by event rank, oldest at top; the gap between consecutive events is proportional to
  // elapsed time but capped, so three sparse photos never become one mark and 700px of nothing.
  const chrono = [...evs].reverse();
  const yRank = new Map<string, number>(); let y = axisTop + 10;
  for (let i = 0; i < chrono.length; i++) {
    if (i) { const dt = Number(chrono[i].tMicros - chrono[i - 1].tMicros) / 60e6; y += Math.min(GAP_MAX, Math.max(18, 18 + dt * 4)); }
    yRank.set(chrono[i].eventId, y);
  }
  const usable = axisBottom - axisTop - 20; const span = Math.max(1, y - (axisTop + 10));
  const scale = span > usable ? usable / span : Math.min(4, Math.max(1, (usable * 0.6) / span));
  const yOf = (id: string) => axisTop + 10 + (yRank.get(id)! - (axisTop + 10)) * scale;

  // zones
  ctx.font = '600 12px Inter, sans-serif'; ctx.textBaseline = 'middle';
  zoneOrder.forEach((z, i) => {
    const x0 = pad + i * zoneW;
    ctx.fillStyle = i % 2 ? C.zoneB : C.zoneA; ctx.fillRect(x0, top - 30, zoneW, H - top + 30);
    ctx.strokeStyle = C.soft; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x0, top - 30); ctx.lineTo(x0, H); ctx.stroke();
    const none = z === '_none';
    const name = none ? (zoneOrder.length === 1 ? 'Places not identified yet' : 'No place identified') : (state.entities.get(z)?.canonicalName ?? z);
    ctx.fillStyle = none ? C.ink3 : C.place; ctx.textAlign = 'left'; ctx.font = none ? '500 12px Inter, sans-serif' : '600 12px Inter, sans-serif';
    ctx.fillText(none ? name : name.toUpperCase(), x0 + 10, top - 14);
  });

  // asset tiles per zone, with the latest reading or change beneath
  const assetX = new Map<string, number>();
  zoneOrder.forEach((z, i) => {
    const assets = [...assetSet.values()].filter(a => assetZone.get(a.entityId) === z);
    const x0 = pad + i * zoneW; const slotW = zoneW / Math.max(assets.length + 1, 2);
    assets.forEach((a, j) => {
      const x = x0 + slotW * (j + 1); assetX.set(a.entityId, x);
      const shortName = displayName(a);
      const label = shortName.length > 18 ? shortName.slice(0, 17) + '…' : shortName;
      ctx.font = '500 12px "JetBrains Mono", monospace'; const tw = Math.max(72, ctx.measureText(label).width + 18);
      const hasAlert = evs.some(e => alertsFor(e).some(al => al.assetId === a.entityId && !al.acked));
      const active = state.assetFilter === a.entityId;
      ctx.fillStyle = active ? C.soft : C.panel; ctx.strokeStyle = hasAlert ? C.crit : active ? C.ink2 : C.line; ctx.lineWidth = hasAlert || active ? 1.5 : 1;
      roundRect(x - tw / 2, top + 2, tw, 26, 5); ctx.fill(); ctx.stroke();
      ctx.fillStyle = hasAlert ? C.crit : C.entity; ctx.textAlign = 'center'; ctx.fillText(label, x, top + 15);
      tiles.push({ x0: x - tw / 2, y0: top + 2, w: tw, h: 26, id: a.entityId });
      // last change or reading under the tile
      let reading = '';
      for (const e of evs) { const ch = edgesFrom(e.eventId, 'CHANGES').find(ed => ed.toId === a.entityId); if (ch) { const p = props(ch); reading = `${p.attr ? p.attr + ' ' : ''}${p.from} → ${p.to}`; break; } }
      if (reading) { ctx.font = '11px "JetBrains Mono", monospace'; ctx.fillStyle = C.warn; ctx.fillText(reading.length > 24 ? reading.slice(0, 23) + '…' : reading, x, top + 40); }
      // time axis
      ctx.strokeStyle = C.soft; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, axisTop); ctx.lineTo(x, axisBottom); ctx.stroke();
    });
    if (!assets.length) { const x = x0 + zoneW / 2; ctx.strokeStyle = C.soft; ctx.setLineDash([2, 4]); ctx.beginPath(); ctx.moveTo(x, axisTop); ctx.lineTo(x, axisBottom); ctx.stroke(); ctx.setLineDash([]); }
  });

  // time ticks down the left: one per event where there is room
  ctx.font = '11px "JetBrains Mono", monospace'; ctx.fillStyle = C.ink3; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  let lastTickY = -99;
  for (const e of chrono) { const yy = yOf(e.eventId); if (yy - lastTickY >= 16) { ctx.fillText(fmtTime(e.tMicros), pad + 6, yy); lastTickY = yy; } }
  // "now" edge: the shift continues below the last mark
  if (!state.windowMin || true) {
    const yNow = axisBottom; ctx.strokeStyle = C.line; ctx.setLineDash([3, 4]); ctx.beginPath(); ctx.moveTo(pad, yNow); ctx.lineTo(W - pad, yNow); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = C.ink3; ctx.font = '11px "JetBrains Mono", monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillText(`now ${fmtTime(nowMicros())}`, pad + 6, yNow - 4); ctx.textBaseline = 'middle';
  }

  // event positions
  const pos = new Map<string, { x: number; y: number }>();
  const laneCount = new Map<string, number>();
  for (const e of chrono) {
    const z = zoneOf.get(e.eventId)!; const zi = zoneOrder.indexOf(z);
    const a = assetsOf(e.eventId).find(a => assetX.has(a.entityId)); const x = a ? assetX.get(a.entityId)! : pad + zi * zoneW + zoneW / 2;
    const key = `${x}:${Math.round(yOf(e.eventId))}`; const n = laneCount.get(key) ?? 0; laneCount.set(key, n + 1);
    pos.set(e.eventId, { x: x + (n ? (n % 2 ? 1 : -1) * Math.ceil(n / 2) * 12 : 0), y: yOf(e.eventId) });
  }
  // NEXT path: the operator's walk
  ctx.strokeStyle = C.path; ctx.lineWidth = 1.5;
  for (const ed of state.edges) if (ed.kind === 'NEXT') { const a = pos.get(ed.fromId), b = pos.get(ed.toId); if (!a || !b) continue; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.bezierCurveTo(a.x, (a.y + b.y) / 2, b.x, (a.y + b.y) / 2, b.x, b.y); ctx.stroke(); }
  // CHANGES ticks (amber) toward other assets
  ctx.strokeStyle = C.warn; ctx.lineWidth = 1.5;
  for (const ed of state.edges) if (ed.kind === 'CHANGES') { const a = pos.get(ed.fromId); const bx = assetX.get(ed.toId); if (!a || bx === undefined) continue; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(bx, a.y); ctx.stroke(); }
  // marks
  for (const e of evs) {
    const p = pos.get(e.eventId)!; const alerts = alertsFor(e); const sel = state.selected === e.eventId || hover === e.eventId;
    const r = sel ? 8 : 6;
    if (state.fresh.has(e.eventId)) {
      if (!arrived.has(e.eventId)) arrived.set(e.eventId, performance.now());
      const k = Math.min(1, (performance.now() - arrived.get(e.eventId)!) / 1200);
      ctx.strokeStyle = alerts.some(a => !a.acked) ? C.crit : wearerColor(e.deviceId); ctx.globalAlpha = 1 - k; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(p.x, p.y, r + 4 + k * 22, 0, 7); ctx.stroke(); ctx.globalAlpha = 1;
    } else arrived.delete(e.eventId);
    if (alerts.some(a => !a.acked)) { ctx.fillStyle = 'rgba(208,59,59,0.18)'; ctx.beginPath(); ctx.arc(p.x, p.y, r + 7, 0, 7); ctx.fill(); }
    ctx.fillStyle = alerts.some(a => !a.acked) ? C.crit : wearerColor(e.deviceId); ctx.strokeStyle = C.ground; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 7); ctx.fill(); ctx.stroke();
    if (sel) { ctx.strokeStyle = C.ink; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(p.x, p.y, r + 4, 0, 7); ctx.stroke(); }
    marks.push({ x: p.x, y: p.y, r, id: e.eventId });
  }
  animateIfFresh();
}
function slug(name: string): string { return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''); }
function roundRect(x: number, y: number, w: number, h: number, r: number) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
