// The signature move: the entity graph drawn as a floor schematic.
// Places are zones (columns); assets are fixed tiles inside their zone; events are marks on a
// vertical time axis beneath the asset they touched; NEXT edges trace the operator's path.
import { state, visibleEvents, placeOf, assetsOf, edgesFrom, props, alertsFor, wearerColor, fmtTime, nowMicros, type Ev, type Ent } from './store';
import { select } from './timeline';

const canvas = document.getElementById('floor') as HTMLCanvasElement;
const empty = document.getElementById('floor-empty') as HTMLElement;
const ctx = canvas.getContext('2d')!;
type Mark = { x: number; y: number; r: number; id: string };
let marks: Mark[] = [];
let hover: string | null = null;
const tip = document.createElement('div');
tip.style.cssText = 'position:fixed;pointer-events:none;background:#141f2c;border:1px solid #223042;color:#e8edf3;font:12px/1.4 "Inter Tight",sans-serif;padding:6px 8px;border-radius:6px;max-width:280px;display:none;z-index:9;box-shadow:0 6px 18px rgba(0,0,0,.45)';
document.body.appendChild(tip);

canvas.addEventListener('mousemove', e => {
  const r = canvas.getBoundingClientRect(); const x = e.clientX - r.left, y = e.clientY - r.top;
  const m = marks.find(m => Math.hypot(m.x - x, m.y - y) <= m.r + 6);
  hover = m?.id ?? null; canvas.style.cursor = m ? 'pointer' : 'default';
  if (m) { const ev = state.events.get(m.id)!; tip.innerHTML = `<div style="color:#74839a;font-family:'JetBrains Mono',monospace;font-size:11px">${fmtTime(ev.tMicros)}</div>${ev.summary || 'processing…'}`; tip.style.display = 'block'; tip.style.left = `${e.clientX + 12}px`; tip.style.top = `${e.clientY + 12}px`; } else tip.style.display = 'none';
  renderFloor();
});
canvas.addEventListener('mouseleave', () => { hover = null; tip.style.display = 'none'; renderFloor(); });
canvas.addEventListener('click', () => { if (hover) select(hover); });
addEventListener('resize', renderFloor);

const C = { ink: '#e8edf3', ink2: '#aab6c5', ink3: '#74839a', line: '#223042', soft: '#182434', place: '#199e70', entity: '#9085e9', warn: '#fab219', crit: '#d03b3b', panel: '#0f1620' };

export function renderFloor() {
  const dpr = devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (canvas.width !== W * dpr || canvas.height !== H * dpr) { canvas.width = W * dpr; canvas.height = H * dpr; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
  marks = [];
  const evs = visibleEvents();
  empty.hidden = evs.length > 0;
  if (!evs.length) return;

  // zones: places in order of first appearance; "unplaced" bucket last
  const zoneOrder: string[] = []; const zoneOf = new Map<string, string>();
  const assetZone = new Map<string, string>(); const assetSet = new Map<string, Ent>();
  for (const e of [...evs].reverse()) {
    const p = placeOf(e.eventId); const z = p?.entityId ?? '_none';
    if (!zoneOrder.includes(z)) zoneOrder.push(z); zoneOf.set(e.eventId, z);
    for (const a of assetsOf(e.eventId)) { assetSet.set(a.entityId, a); assetZone.set(a.entityId, z); }
  }
  const pad = 16, top = 46, axisTop = top + 44, axisBottom = H - 28;
  const zoneW = (W - pad * 2) / zoneOrder.length;
  const tMin = evs[evs.length - 1].tMicros, tMax = nowMicros();
  const span = Number(tMax - tMin) || 1;
  const yOf = (t: bigint) => axisTop + (Number(t - tMin) / span) * (axisBottom - axisTop);

  // zones
  ctx.font = '600 12px "Inter Tight", sans-serif'; ctx.textBaseline = 'middle';
  zoneOrder.forEach((z, i) => {
    const x0 = pad + i * zoneW;
    ctx.fillStyle = i % 2 ? 'rgba(255,255,255,0.015)' : 'rgba(255,255,255,0.03)'; ctx.fillRect(x0, top - 30, zoneW, H - top + 30);
    ctx.strokeStyle = C.soft; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x0, top - 30); ctx.lineTo(x0, H); ctx.stroke();
    const name = z === '_none' ? 'unplaced' : (state.entities.get(z)?.canonicalName ?? z);
    ctx.fillStyle = z === '_none' ? C.ink3 : C.place; ctx.textAlign = 'left'; ctx.fillText(name.toUpperCase(), x0 + 10, top - 14);
  });

  // asset tiles per zone
  const assetX = new Map<string, number>();
  zoneOrder.forEach((z, i) => {
    const assets = [...assetSet.values()].filter(a => assetZone.get(a.entityId) === z);
    const x0 = pad + i * zoneW; const slotW = zoneW / Math.max(assets.length + 1, 2);
    assets.forEach((a, j) => {
      const x = x0 + slotW * (j + 1); assetX.set(a.entityId, x);
      const label = a.canonicalName.length > 16 ? a.canonicalName.slice(0, 15) + '…' : a.canonicalName;
      ctx.font = '500 11px "JetBrains Mono", monospace'; const tw = ctx.measureText(label).width + 14;
      const hasAlert = evs.some(e => alertsFor(e).some(al => al.assetId === a.entityId));
      ctx.fillStyle = C.panel; ctx.strokeStyle = hasAlert ? C.crit : C.line; ctx.lineWidth = hasAlert ? 1.5 : 1;
      roundRect(x - tw / 2, top + 4, tw, 22, 4); ctx.fill(); ctx.stroke();
      ctx.fillStyle = hasAlert ? C.crit : C.entity; ctx.textAlign = 'center'; ctx.fillText(label, x, top + 15);
      // time axis
      ctx.strokeStyle = C.soft; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, axisTop); ctx.lineTo(x, axisBottom); ctx.stroke();
    });
    // zone-level axis when no assets (events placed mid-zone)
    if (!assets.length) { const x = x0 + zoneW / 2; ctx.strokeStyle = C.soft; ctx.setLineDash([2, 4]); ctx.beginPath(); ctx.moveTo(x, axisTop); ctx.lineTo(x, axisBottom); ctx.stroke(); ctx.setLineDash([]); }
  });

  // time labels
  ctx.font = '11px "JetBrains Mono", monospace'; ctx.fillStyle = C.ink3; ctx.textAlign = 'right';
  ctx.fillText(fmtTime(tMin), W - pad - 2, axisTop); ctx.fillText('now', W - pad - 2, axisBottom);

  // event positions
  const pos = new Map<string, { x: number; y: number }>();
  for (const e of evs) {
    const z = zoneOf.get(e.eventId)!; const zi = zoneOrder.indexOf(z);
    const a = assetsOf(e.eventId)[0]; const x = a && assetX.has(a.entityId) ? assetX.get(a.entityId)! : pad + zi * zoneW + zoneW / 2;
    pos.set(e.eventId, { x, y: yOf(e.tMicros) });
  }
  // NEXT path
  ctx.strokeStyle = 'rgba(170,182,197,0.28)'; ctx.lineWidth = 1.2;
  for (const ed of state.edges) if (ed.kind === 'NEXT') { const a = pos.get(ed.fromId), b = pos.get(ed.toId); if (!a || !b) continue; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.bezierCurveTo(a.x, (a.y + b.y) / 2, b.x, (a.y + b.y) / 2, b.x, b.y); ctx.stroke(); }
  // CHANGES ticks (amber) toward other assets
  ctx.strokeStyle = C.warn; ctx.lineWidth = 1.5;
  for (const ed of state.edges) if (ed.kind === 'CHANGES') { const a = pos.get(ed.fromId); const bx = assetX.get(ed.toId); if (!a || bx === undefined) continue; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(bx, a.y); ctx.stroke(); }
  // marks
  for (const e of evs) {
    const p = pos.get(e.eventId)!; const alerts = alertsFor(e); const sel = state.selected === e.eventId || hover === e.eventId;
    const r = sel ? 7 : 5;
    if (alerts.length) { ctx.fillStyle = 'rgba(208,59,59,0.22)'; ctx.beginPath(); ctx.arc(p.x, p.y, r + 7 + (state.fresh.has(e.eventId) ? 4 : 0), 0, 7); ctx.fill(); }
    ctx.fillStyle = alerts.length ? C.crit : wearerColor(e.deviceId); ctx.strokeStyle = '#0c1017'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 7); ctx.fill(); ctx.stroke();
    if (sel) { ctx.strokeStyle = C.ink; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(p.x, p.y, r + 4, 0, 7); ctx.stroke(); }
    marks.push({ x: p.x, y: p.y, r, id: e.eventId });
  }
}
function roundRect(x: number, y: number, w: number, h: number, r: number) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
