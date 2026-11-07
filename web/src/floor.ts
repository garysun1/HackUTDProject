// The signature move: the entity graph drawn as a floor schematic.
// Places are zones (columns); assets are fixed tiles inside their zone; events are marks on a
// vertical time axis beneath the asset they touched; NEXT edges trace the operator's path.
import { state, visibleEvents, placeOf, assetsOf, edgesFrom, props, alertsFor, wearerColor, fmtTime, nowMicros, notify, type Ev, type Ent } from './store';
import { select } from './timeline';

const canvas = document.getElementById('floor') as HTMLCanvasElement;
const empty = document.getElementById('floor-empty') as HTMLElement;
const ctx = canvas.getContext('2d')!;
type Mark = { x: number; y: number; r: number; id: string };
type Tile = { x0: number; y0: number; w: number; h: number; id: string };
let marks: Mark[] = []; let tiles: Tile[] = [];
let hover: string | null = null;
const tip = document.createElement('div');
tip.style.cssText = 'position:fixed;pointer-events:none;background:#141f2c;border:1px solid #223042;color:#e8edf3;font:12px/1.4 "Inter Tight",sans-serif;padding:6px 8px;border-radius:6px;max-width:280px;display:none;z-index:9;box-shadow:0 6px 18px rgba(0,0,0,.45)';
document.body.appendChild(tip);

canvas.addEventListener('mousemove', e => {
  const r = canvas.getBoundingClientRect(); const x = e.clientX - r.left, y = e.clientY - r.top;
  const m = marks.find(m => Math.hypot(m.x - x, m.y - y) <= Math.max(m.r + 7, 12));
  const t = !m && tiles.find(t => x >= t.x0 && x <= t.x0 + t.w && y >= t.y0 && y <= t.y0 + t.h);
  hover = m?.id ?? null; canvas.style.cursor = m || t ? 'pointer' : 'default';
  if (m) { const ev = state.events.get(m.id)!; tip.innerHTML = `<div style="color:#74839a;font-family:'JetBrains Mono',monospace;font-size:11px">${fmtTime(ev.tMicros)}</div>${ev.summary || 'processing…'}`; tip.style.display = 'block'; tip.style.left = `${e.clientX + 12}px`; tip.style.top = `${e.clientY + 12}px`; } else tip.style.display = 'none';
  renderFloor();
});
canvas.addEventListener('mouseleave', () => { hover = null; tip.style.display = 'none'; renderFloor(); });
canvas.addEventListener('click', e => {
  if (hover) { select(hover); return; }
  const r = canvas.getBoundingClientRect(); const x = e.clientX - r.left, y = e.clientY - r.top;
  const t = tiles.find(t => x >= t.x0 && x <= t.x0 + t.w && y >= t.y0 && y <= t.y0 + t.h);
  if (t) { state.assetFilter = state.assetFilter === t.id ? null : t.id; notify(); }
});
addEventListener('resize', renderFloor);

// Strokes chosen to clear 3:1 on the ground for a projector; see web/DESIGN.md.
const C = { ink: '#e8edf3', ink2: '#aab6c5', ink3: '#8a97ab', line: '#3a4b63', soft: '#2a3a4f', place: '#2bb383', entity: '#a197f0', warn: '#fab219', crit: '#e04e4e', panel: '#0f1620', path: 'rgba(170,182,197,0.55)' };
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
    for (const a of assetsOf(e.eventId)) { assetSet.set(a.entityId, a); assetZone.set(a.entityId, z); }
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
  ctx.font = '600 12px "Inter Tight", sans-serif'; ctx.textBaseline = 'middle';
  zoneOrder.forEach((z, i) => {
    const x0 = pad + i * zoneW;
    ctx.fillStyle = i % 2 ? 'rgba(255,255,255,0.025)' : 'rgba(255,255,255,0.05)'; ctx.fillRect(x0, top - 30, zoneW, H - top + 30);
    ctx.strokeStyle = C.soft; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x0, top - 30); ctx.lineTo(x0, H); ctx.stroke();
    const none = z === '_none';
    const name = none ? (zoneOrder.length === 1 ? 'Places not identified yet' : 'No place identified') : (state.entities.get(z)?.canonicalName ?? z);
    ctx.fillStyle = none ? C.ink3 : C.place; ctx.textAlign = 'left'; ctx.font = none ? '500 12px "Inter Tight", sans-serif' : '600 12px "Inter Tight", sans-serif';
    ctx.fillText(none ? name : name.toUpperCase(), x0 + 10, top - 14);
  });

  // asset tiles per zone, with the latest reading or change beneath
  const assetX = new Map<string, number>();
  zoneOrder.forEach((z, i) => {
    const assets = [...assetSet.values()].filter(a => assetZone.get(a.entityId) === z);
    const x0 = pad + i * zoneW; const slotW = zoneW / Math.max(assets.length + 1, 2);
    assets.forEach((a, j) => {
      const x = x0 + slotW * (j + 1); assetX.set(a.entityId, x);
      const label = a.canonicalName.length > 18 ? a.canonicalName.slice(0, 17) + '…' : a.canonicalName;
      ctx.font = '500 12px "JetBrains Mono", monospace'; const tw = Math.max(72, ctx.measureText(label).width + 18);
      const hasAlert = evs.some(e => alertsFor(e).some(al => al.assetId === a.entityId && !al.acked));
      const active = state.assetFilter === a.entityId;
      ctx.fillStyle = active ? '#1a2a3d' : C.panel; ctx.strokeStyle = hasAlert ? C.crit : active ? C.ink2 : C.line; ctx.lineWidth = hasAlert || active ? 1.5 : 1;
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

  // time ticks down the left: one per event where there is room, hour marks otherwise
  ctx.font = '11px "JetBrains Mono", monospace'; ctx.fillStyle = C.ink3; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  let lastTickY = -99;
  for (const e of chrono) { const yy = yOf(e.eventId); if (yy - lastTickY >= 16) { ctx.fillText(fmtTime(e.tMicros), pad + 6, yy); lastTickY = yy; } }

  // event positions
  const pos = new Map<string, { x: number; y: number }>();
  const laneCount = new Map<string, number>();
  for (const e of chrono) {
    const z = zoneOf.get(e.eventId)!; const zi = zoneOrder.indexOf(z);
    const a = assetsOf(e.eventId)[0]; const x = a && assetX.has(a.entityId) ? assetX.get(a.entityId)! : pad + zi * zoneW + zoneW / 2;
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
    if (alerts.length) { ctx.fillStyle = 'rgba(208,59,59,0.22)'; ctx.beginPath(); ctx.arc(p.x, p.y, r + 7 + (state.fresh.has(e.eventId) ? 4 : 0), 0, 7); ctx.fill(); }
    ctx.fillStyle = alerts.some(a => !a.acked) ? C.crit : wearerColor(e.deviceId); ctx.strokeStyle = '#0c1017'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 7); ctx.fill(); ctx.stroke();
    if (sel) { ctx.strokeStyle = C.ink; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(p.x, p.y, r + 4, 0, 7); ctx.stroke(); }
    marks.push({ x: p.x, y: p.y, r, id: e.eventId });
  }
}
function roundRect(x: number, y: number, w: number, h: number, r: number) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
