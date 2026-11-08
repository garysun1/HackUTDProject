// The memory graph. Photos are nodes; the places, assets and objects the model saw in them
// are nodes that stem outward; a line is a relationship. Shared entities pull photos together.
// Time is a soft left-to-right force, so the shift still reads in order. A hand-written force
// simulation (no dependency) lays it out; new photos drift into place; Replay rebuilds the
// shift from empty in ten seconds.
import { state, visibleEvents, displayName, edgesFrom, props, alertsFor, wearerColor, wearerName, fmtTime, notify, loadPhoto, type Ev } from './store';
import { select, esc } from './timeline';
import { view as vs, shownEvents, setScope, onView } from './view';
import { photoCard, showTip, hideTip } from './card';
import { fitRequested } from './tools';

const canvas = document.getElementById('floor') as HTMLCanvasElement;
const empty = document.getElementById('floor-empty') as HTMLElement;
const floorEl = canvas.parentElement as HTMLElement;
const scopeHead = document.getElementById('scope-head') as HTMLElement; const scopeTitle = document.getElementById('scope-title') as HTMLElement;
document.getElementById('scope-close')!.addEventListener('click', () => setScope(null));
const ctx = canvas.getContext('2d')!;

// ---------- model ----------
type Kind = 'photo' | 'place' | 'asset' | 'object';
type N = { id: string; kind: Kind; x: number; y: number; vx: number; vy: number; r: number; w: number; fx: number | null; fy: number | null; born: number; a: number; deg: number; t: number };
type L = { s: N; t: N; kind: 'involves' | 'changes' | 'next'; len: number; label?: string; color?: string };
const nodes = new Map<string, N>(); let links: L[] = [];
let alpha = 0; const PW = 56, PH = 42; // photo node size
let W = 0, H = 0;
const view = { k: 1, tx: 0, ty: 0 }; let userView = false;
const bootT = performance.now();
let hover: string | null = null; let drag: { n: N; moved: boolean; sx: number; sy: number } | null = null; let pan: { sx: number; sy: number; tx: number; ty: number; moved: boolean } | null = null;
const imgs = new Map<string, HTMLImageElement>();
let raf = 0; let lastFrame = performance.now(); let seenFit = fitRequested; let lastReplayStart = 0;

function photo(id: string): HTMLImageElement | null {
  const url = state.photos.get(id); if (!url) { loadPhoto(id); return null; }
  let im = imgs.get(id);
  if (!im) { im = new Image(); im.onload = () => frame(); im.src = url; imgs.set(id, im); }
  return im.complete && im.naturalWidth ? im : null;
}
function frame() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; renderFloor(); }); }
function toWorld(px: number, py: number) { return { x: (px - view.tx) / view.k, y: (py - view.ty) / view.k }; }

// ---------- theme ----------
function cssVar(name: string): string { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
let C = { ink: '', ink2: '', ink3: '', ink4: '', line: '', soft: '', place: '', entity: '', warn: '', crit: '', panel: '', ground: '', dark: false };
function readTokens() {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches && document.documentElement.dataset.theme !== 'light' || document.documentElement.dataset.theme === 'dark';
  C = { ink: cssVar('--ink'), ink2: cssVar('--ink-2'), ink3: cssVar('--ink-3'), ink4: cssVar('--ink-4'), line: cssVar('--line-strong'), soft: cssVar('--line'), place: cssVar('--place'), entity: cssVar('--entity'), warn: cssVar('--warning-ink'), crit: cssVar('--critical'), panel: cssVar('--panel'), ground: cssVar('--ground'), dark };
}
readTokens(); matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { readTokens(); frame(); });
const withAlpha = (hex: string, a: number) => { const m = /^#([0-9a-f]{6})$/i.exec(hex); if (!m) return hex; const n = parseInt(m[1], 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };

// ---------- hover card (shared element in card.ts) ----------
function entityCard(n: N): string {
  const ent = state.entities.get(n.id); const evs = photosOf(n.id); const last = evs[0];
  const kind = n.kind === 'place' ? 'Place' : n.kind === 'asset' ? 'Asset' : 'Seen in photos';
  return `<div class="tb"><div class="tt"><b>${esc(ent ? displayName(ent) : n.id)}</b>${ent && displayName(ent) !== ent.canonicalName ? ` <span>${esc(ent.canonicalName)}</span>` : ''}</div><div class="ts">${kind} · in ${evs.length} photo${evs.length === 1 ? '' : 's'}${last ? ` · last ${fmtTime(last.tMicros)} by ${esc(wearerName(last.deviceId))}` : ''}. Click to trace.</div></div>`;
}
function photosOf(entityId: string): Ev[] { return shown().filter(e => state.edges.some(x => x.fromId === e.eventId && x.toId === entityId)); }

function shown(): Ev[] { return shownEvents(true); }

// ---------- pointer ----------
function hit(px: number, py: number): N | null {
  const { x, y } = toWorld(px, py); let best: N | null = null, bd = 1e9;
  for (const n of nodes.values()) {
    if (n.kind === 'object' && n.deg < 2 && !(hover && (hover === n.id || links.some(l => l.t === n && l.s.id === hover))) && !(state.selected && links.some(l => l.t === n && l.s.id === state.selected))) continue;
    const d = n.kind === 'photo' ? (Math.abs(n.x - x) <= PW / 2 + 4 && Math.abs(n.y - y) <= PH / 2 + 4 ? 0 : 1e9) : Math.hypot(n.x - x, n.y - y) - n.r - 4;
    if (d <= 0 && (best === null || n.kind === 'photo' || d < bd)) { best = n; bd = d; if (n.kind === 'photo') break; }
  }
  return best;
}
canvas.addEventListener('mousedown', e => {
  const r = canvas.getBoundingClientRect(); const px = e.clientX - r.left, py = e.clientY - r.top; const n = hit(px, py);
  if (n) { drag = { n, moved: false, sx: px, sy: py }; n.fx = n.x; n.fy = n.y; }
  else pan = { sx: px, sy: py, tx: view.tx, ty: view.ty, moved: false };
});
canvas.addEventListener('mousemove', e => {
  const r = canvas.getBoundingClientRect(); const px = e.clientX - r.left, py = e.clientY - r.top;
  if (drag) { const w = toWorld(px, py); drag.n.fx = w.x; drag.n.fy = w.y; if (Math.hypot(px - drag.sx, py - drag.sy) > 4) drag.moved = true; alpha = Math.max(alpha, 0.25); frame(); return; }
  if (pan) { if (Math.hypot(px - pan.sx, py - pan.sy) > 4) { pan.moved = true; userView = true; } if (pan.moved) { view.tx = pan.tx + (px - pan.sx); view.ty = pan.ty + (py - pan.sy); frame(); } return; }
  const n = hit(px, py); const prev = hover; hover = n?.id ?? null; canvas.style.cursor = n ? 'pointer' : 'grab';
  if (n) showTip(n.kind === 'photo' ? photoCard(n.id) : entityCard(n), e.clientX, e.clientY, n.id);
  else hideTip();
  if (prev !== hover) frame();
});
addEventListener('mouseup', e => {
  if (drag) { const n = drag.n; const moved = drag.moved; drag = null; n.fx = n.fy = null; if (!moved) { if (n.kind === 'photo') select(n.id); else { state.assetFilter = state.assetFilter === n.id ? null : n.id; notify(); } } return; }
  if (pan) { const moved = pan.moved; pan = null; if (!moved && e.target === canvas && state.selected) select(null); }
});
canvas.addEventListener('mouseleave', () => { hover = null; hideTip(); frame(); });
canvas.addEventListener('dblclick', () => { userView = false; frame(); });
canvas.addEventListener('wheel', e => {
  if (!nodes.size) return; e.preventDefault();
  const r = canvas.getBoundingClientRect(); const px = e.clientX - r.left, py = e.clientY - r.top;
  const k = Math.min(4, Math.max(0.2, view.k * Math.exp(-e.deltaY * 0.0015)));
  view.tx = px - (px - view.tx) * (k / view.k); view.ty = py - (py - view.ty) * (k / view.k); view.k = k; userView = true; frame();
}, { passive: false });
document.addEventListener('keydown', e => {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
  const tag = (e.target as HTMLElement).tagName; if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  const chrono = [...shown()].reverse(); if (!chrono.length) return;
  const i = chrono.findIndex(ev => ev.eventId === state.selected); const fwd = e.key === 'ArrowRight' || e.key === 'ArrowDown';
  const next = i < 0 ? (fwd ? chrono[0] : chrono[chrono.length - 1]) : chrono[Math.min(chrono.length - 1, Math.max(0, i + (fwd ? 1 : -1)))];
  e.preventDefault(); select(next.eventId);
});
addEventListener('resize', () => { alpha = Math.max(alpha, 0.2); frame(); });

// ---------- graph construction: keep positions, add what is new, drop what left ----------
function sync(evs: Ev[]) {
  const now = performance.now(); const booted = now - bootT > 2500 || vs.replay.on;
  const keep = new Set<string>(); links = [];
  const chrono = [...evs].reverse();
  // x target by order in time, gaps capped: a four-hour pause is a longer gap, not an empty screen
  const xs = new Map<number, number>(); let xAcc = 90;
  chrono.forEach((e, i) => { if (i) { const m = Number(e.tMicros - chrono[i - 1].tMicros) / 60e6; xAcc += Math.min(260, Math.max(130, 130 + m * 3)); } xs.set(Number(e.tMicros), xAcc); });
  const xT = (t: number) => xs.get(t) ?? xAcc;
  let changed = false;
  const add = (id: string, kind: Kind, near: N[] | null, t: number): N => {
    let n = nodes.get(id);
    if (!n) {
      const base = near && near.length ? { x: near.reduce((s, m) => s + m.x, 0) / near.length, y: near.reduce((s, m) => s + m.y, 0) / near.length } : { x: kind === 'photo' ? xT(t) : W / 2, y: H / 2 };
      const jitter = kind === 'photo' ? 30 : 60;
      n = { id, kind, x: base.x + (Math.random() - 0.5) * jitter + (kind === 'photo' && near?.length ? 70 : 0), y: base.y + (Math.random() - 0.5) * jitter, vx: 0, vy: 0, r: kind === 'place' ? 30 : kind === 'asset' ? 13 : 5, w: kind === 'photo' ? 1.6 : kind === 'place' ? 2.2 : kind === 'asset' ? 1 : 0.5, fx: null, fy: null, born: booted ? now : 0, a: booted ? 0 : 1, deg: 0, t };
      nodes.set(id, n); changed = true;
    }
    n.deg = 0; n.t = t; keep.add(id); return n;
  };
  let prev: N | null = null;
  for (const e of chrono) {
    const t = Number(e.tMicros); const pn = add(e.eventId, 'photo', prev ? [prev] : null, t);
    for (const ed of edgesFrom(e.eventId)) {
      const ent = state.entities.get(ed.toId); if (!ent) continue;
      if (ed.kind === 'INVOLVES') {
        const kind: Kind = props(ed).role === 'setting' || ent.kind === 'place' ? 'place' : ent.kind === 'asset' ? 'asset' : 'object';
        const en = add(ent.entityId, kind, [pn], t);
        links.push({ s: pn, t: en, kind: 'involves', len: kind === 'place' ? 120 : kind === 'asset' ? 85 : 55 });
        pn.deg++; en.deg++;
      } else if (ed.kind === 'CHANGES') {
        const en = add(ent.entityId, ent.kind === 'asset' ? 'asset' : 'object', [pn], t); const p = props(ed);
        const lbl = `${p.attr ? p.attr + ' ' : ''}${p.from ?? ''} → ${p.to ?? ''}`; links.push({ s: pn, t: en, kind: 'changes', len: 85, label: lbl.length > 44 ? lbl.slice(0, 43) + '…' : lbl });
        pn.deg++; en.deg++;
      }
    }
    if (prev) links.push({ s: prev, t: pn, kind: 'next', len: 150, color: wearerColor(e.deviceId) });
    prev = pn;
  }
  for (const id of [...nodes.keys()]) if (!keep.has(id)) { nodes.delete(id); changed = true; }
  // the operator's label promotes an object to an asset-looking node
  for (const e of chrono) if (e.label) { const n = nodes.get(e.label.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')); if (n && n.kind === 'object') { n.kind = 'asset'; n.r = 13; n.w = 1; } }
  if (changed) alpha = Math.max(alpha, 0.8);
  return { xT, chrono };
}

// ---------- the simulation ----------
function tick(xT: (t: number) => number) {
  const ns = [...nodes.values()]; const cy = H / 2, cx = W / 2;
  for (const l of links) {
    const dx = l.t.x - l.s.x, dy = l.t.y - l.s.y; const d = Math.max(1, Math.hypot(dx, dy));
    const k = l.kind === 'next' ? 0.03 : 0.07; const f = (d - l.len) * k * alpha;
    const bs = l.t.w / (l.s.w + l.t.w), bt = l.s.w / (l.s.w + l.t.w);
    l.s.vx += dx / d * f * bs; l.s.vy += dy / d * f * bs; l.t.vx -= dx / d * f * bt; l.t.vy -= dy / d * f * bt;
  }
  for (let i = 0; i < ns.length; i++) for (let j = i + 1; j < ns.length; j++) {
    const a = ns[i], b = ns[j]; let dx = b.x - a.x, dy = b.y - a.y; let d2 = dx * dx + dy * dy;
    if (d2 > 260 * 260) continue; if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
    const d = Math.sqrt(d2);
    const f = (1400 * a.w * b.w * alpha) / d2;
    a.vx -= dx / d * f / a.w; a.vy -= dy / d * f / a.w; b.vx += dx / d * f / b.w; b.vy += dy / d * f / b.w;
    const ra = a.kind === 'photo' ? 34 : a.r + 6, rb = b.kind === 'photo' ? 34 : b.r + 6; const min = ra + rb;
    if (d < min) { const push = (min - d) * 0.5; a.vx -= dx / d * push * 0.5; a.vy -= dy / d * push * 0.5; b.vx += dx / d * push * 0.5; b.vy += dy / d * push * 0.5; }
  }
  for (const n of ns) {
    if (n.kind === 'photo') n.vx += (xT(n.t) - n.x) * 0.05 * alpha;
    else n.vx += (cx - n.x) * 0.002 * alpha;
    n.vy += (cy - n.y) * 0.02 * alpha;
    n.vx *= 0.5; n.vy *= 0.5;
    if (n.fx != null) { n.x = n.fx; n.y = n.fy!; n.vx = n.vy = 0; } else { n.x += n.vx; n.y += n.vy; }
  }
}

// ---------- render ----------
export function renderFloor() {
  const now = performance.now(); const dt = Math.min(50, now - lastFrame); lastFrame = now;
  floorEl.dataset.mode = vs.mode;
  const visible = vs.mode === 'graph' || !!vs.scope;
  canvas.hidden = !visible; scopeHead.hidden = !(vs.mode === 'map' && vs.scope);
  if (vs.scope) scopeTitle.innerHTML = `<b>${esc(vs.scopeLabel || 'Selection')}</b> · ${shown().length} photo${shown().length === 1 ? '' : 's'} · what connects`;
  if (!visible) { empty.hidden = true; return; }
  if (vs.replay.start !== lastReplayStart) { lastReplayStart = vs.replay.start; nodes.clear(); links = []; userView = false; }
  if (fitRequested !== seenFit) { seenFit = fitRequested; userView = false; }
  const dpr = devicePixelRatio || 1;
  W = canvas.clientWidth; H = canvas.clientHeight;
  if (canvas.width !== W * dpr || canvas.height !== H * dpr) { canvas.width = W * dpr; canvas.height = H * dpr; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);

  const evs = shown(); empty.hidden = evs.length > 0 || vs.replay.on || !!vs.scope;
  const { xT, chrono } = sync(evs);
  let moving = vs.replay.playing;
  if (alpha > 0.004) { for (let i = 0; i < 2; i++) tick(xT); alpha += (0 - alpha) * 0.028; moving = true; } else alpha = 0;

  // view: auto-fit until the user takes over
  if (nodes.size) {
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const n of nodes.values()) { const rx = n.kind === 'photo' ? PW / 2 : n.r + 10, ry = n.kind === 'photo' ? PH / 2 : n.r + 18; x0 = Math.min(x0, n.x - rx); x1 = Math.max(x1, n.x + rx); y0 = Math.min(y0, n.y - ry); y1 = Math.max(y1, n.y + ry); }
    if (!userView) {
      const m = 48; const kFit = Math.min((W - 2 * m) / Math.max(120, x1 - x0), (H - 2 * m) / Math.max(120, y1 - y0));
      // Whole graph when it fits at a readable size; otherwise centre on the selected photo, else keep the newest at the right edge.
      const MIN = 0.6; const sel = state.selected ? nodes.get(state.selected) : null;
      const kT = kFit >= MIN ? Math.min(1.3, kFit) : sel ? Math.max(kFit, 0.85) : MIN;
      let txT = (W - (x0 + x1) * kT) / 2, tyT = (H - (y0 + y1) * kT) / 2;
      if (kFit < MIN) { if (sel) { txT = W / 2 - sel.x * kT; tyT = H / 2 - sel.y * kT; } else txT = W - m - x1 * kT; }
      const e = 1 - Math.exp(-dt / 160);
      if (Math.abs(kT - view.k) > 0.002 || Math.abs(txT - view.tx) > 0.5 || Math.abs(tyT - view.ty) > 0.5) moving = true;
      view.k += (kT - view.k) * e; view.tx += (txT - view.tx) * e; view.ty += (tyT - view.ty) * e;
    }
  }
  ctx.save(); ctx.translate(view.tx, view.ty); ctx.scale(view.k, view.k);

  // trace / hover emphasis
  const traceId = state.assetFilter && nodes.has(state.assetFilter) ? state.assetFilter : null;
  const focusId = traceId ?? (hover && nodes.get(hover)?.kind !== 'photo' ? hover : null) ?? hover ?? state.selected;
  const lit = new Set<string>();
  if (focusId) { lit.add(focusId); for (const l of links) { if (l.kind === 'next') continue; if (l.s.id === focusId) lit.add(l.t.id); if (l.t.id === focusId) lit.add(l.s.id); } }
  const dimTo = traceId ? 0.12 : 0.45; const dimOf = (id: string) => (focusId && !lit.has(id) ? dimTo : 1);
  for (const n of nodes.values()) { n.a += (1 - n.a) * (1 - Math.exp(-dt / 220)); if (1 - n.a > 0.02) moving = true; else n.a = 1; }

  // edges
  ctx.lineCap = 'round';
  for (const l of links) {
    if (l.t.kind === 'object' && l.t.deg < 2 && !lit.has(l.t.id)) continue;
    const a = Math.min(l.s.a, l.t.a) * (focusId ? (lit.has(l.s.id) && lit.has(l.t.id) ? 1 : dimTo) : 1);
    ctx.globalAlpha = a;
    if (l.kind === 'next') { ctx.strokeStyle = withAlpha(l.color!, 0.55); ctx.lineWidth = 1.5; ctx.setLineDash([3, 5]); }
    else if (l.kind === 'changes') { ctx.strokeStyle = C.warn; ctx.lineWidth = 1.8; ctx.setLineDash([]); }
    else { ctx.strokeStyle = C.dark ? 'rgba(200,200,195,0.35)' : 'rgba(60,60,56,0.28)'; ctx.lineWidth = focusId && lit.has(l.s.id) && lit.has(l.t.id) ? 1.6 : 1; ctx.setLineDash([]); }
    const prog = l.kind === 'next' ? Math.min(1, (now - Math.max(l.t.born, l.s.born)) / 650) : 1; if (prog < 1) moving = true;
    ctx.beginPath(); ctx.moveTo(l.s.x, l.s.y);
    if (l.kind === 'next') { const mx = (l.s.x + l.t.x) / 2; if (prog >= 1) ctx.bezierCurveTo(mx, l.s.y, mx, l.t.y, l.t.x, l.t.y); else { for (let s = 1; s <= 16; s++) { const q = bez(l.s.x, l.s.y, mx, l.t.x, l.t.y, (s / 16) * prog); ctx.lineTo(q.x, q.y); } } }
    else ctx.lineTo(l.t.x, l.t.y);
    ctx.stroke(); ctx.setLineDash([]);
    if (l.kind === 'changes' && l.label && (focusId === l.s.id || focusId === l.t.id)) { ctx.globalAlpha = 1; ctx.font = '11px "JetBrains Mono", monospace'; ctx.fillStyle = C.warn; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText(l.label, (l.s.x + l.t.x) / 2, (l.s.y + l.t.y) / 2 - 4); }
  }
  ctx.globalAlpha = 1;

  // entity nodes
  ctx.textBaseline = 'middle';
  for (const n of nodes.values()) {
    if (n.kind === 'photo') continue;
    const ent = state.entities.get(n.id); const name = ent ? displayName(ent) : n.id; const isFocus = focusId === n.id;
    const open = n.kind !== 'place' && evs.some(e => alertsFor(e).some(al => al.assetId === n.id && !al.acked));
    ctx.globalAlpha = n.a * dimOf(n.id);
    if (n.kind === 'place') {
      ctx.fillStyle = withAlpha(C.place, C.dark ? 0.16 : 0.1); ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, 7); ctx.fill();
      ctx.strokeStyle = withAlpha(C.place, isFocus ? 0.9 : 0.45); ctx.lineWidth = isFocus ? 1.5 : 1; ctx.stroke();
      ctx.fillStyle = C.place; ctx.font = '600 12px Inter, sans-serif'; ctx.textAlign = 'center'; wrapText(name.toUpperCase(), n.x, n.y, 72, 13);
    } else if (n.kind === 'asset') {
      ctx.font = '500 12px "JetBrains Mono", monospace'; const tw = ctx.measureText(name).width + 18; const h = 24;
      ctx.fillStyle = isFocus && traceId ? C.ink : C.panel; ctx.strokeStyle = open ? C.crit : isFocus ? C.ink : C.line; ctx.lineWidth = open || isFocus ? 1.5 : 1;
      roundRect(n.x - tw / 2, n.y - h / 2, tw, h, 6); ctx.fill(); ctx.stroke();
      ctx.fillStyle = isFocus && traceId ? C.ground : open ? C.crit : C.entity; ctx.textAlign = 'center'; ctx.fillText(name, n.x, n.y + 1);
      n.r = Math.max(13, tw / 2);
    } else {
      if (n.deg < 2 && !lit.has(n.id) && !isFocus) continue; // one-off objects stem out only when their photo is in focus
      ctx.fillStyle = isFocus ? C.ink : C.ink3; ctx.beginPath(); ctx.arc(n.x, n.y, 4, 0, 7); ctx.fill();
      if (n.deg >= 2 || isFocus || lit.has(n.id)) { ctx.font = '11px Inter, sans-serif'; ctx.fillStyle = C.ink2; ctx.textAlign = 'left'; ctx.fillText(name.length > 28 ? name.slice(0, 27) + '…' : name, n.x + 8, n.y + 1); }
    }
  }

  // photo nodes
  for (const e of chrono) {
    const n = nodes.get(e.eventId)!; const open = alertsFor(e).some(a => !a.acked); const sel = state.selected === n.id || hover === n.id;
    const color = open ? C.crit : wearerColor(e.deviceId); const base = n.a * dimOf(n.id);
    ctx.globalAlpha = base;
    if (n.born) { const kk = Math.min(1, (now - n.born) / 1200); if (kk < 1) { moving = true; ctx.strokeStyle = color; ctx.globalAlpha = base * (1 - kk); ctx.lineWidth = 2; roundRect(n.x - PW / 2 - 4 - kk * 18, n.y - PH / 2 - 4 - kk * 18, PW + 8 + kk * 36, PH + 8 + kk * 36, 10 + kk * 10); ctx.stroke(); ctx.globalAlpha = base; } }
    if (open) { ctx.fillStyle = 'rgba(208,59,59,0.16)'; roundRect(n.x - PW / 2 - 6, n.y - PH / 2 - 6, PW + 12, PH + 12, 10); ctx.fill(); }
    const x0 = n.x - PW / 2, y0 = n.y - PH / 2; const im = photo(n.id);
    ctx.save(); roundRect(x0, y0, PW, PH, 6); ctx.clip(); ctx.fillStyle = C.panel; ctx.fillRect(x0, y0, PW, PH);
    if (im) { const s = Math.max(PW / im.naturalWidth, PH / im.naturalHeight); const dw = im.naturalWidth * s, dh = im.naturalHeight * s; ctx.drawImage(im, x0 + (PW - dw) / 2, y0 + (PH - dh) / 2, dw, dh); }
    ctx.restore();
    ctx.strokeStyle = color; ctx.lineWidth = sel ? 2.5 : 2; roundRect(x0, y0, PW, PH, 6); ctx.stroke();
    if (sel) { ctx.strokeStyle = C.ink; ctx.lineWidth = 1.5; roundRect(x0 - 4, y0 - 4, PW + 8, PH + 8, 9); ctx.stroke(); }
    ctx.font = '11px "JetBrains Mono", monospace'; ctx.fillStyle = C.ink3; ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText(fmtTime(e.tMicros), n.x, y0 + PH + 5); ctx.textBaseline = 'middle';
  }
  ctx.globalAlpha = 1; ctx.restore();

  // replay caption
  if (vs.replay.on && chrono.length && vs.mode === 'graph') { const last = chrono[chrono.length - 1]; ctx.font = '12px Inter, sans-serif'; ctx.fillStyle = C.ink3; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillText(`Replay · ${fmtTime(last.tMicros)} · ${chrono.length} photo${chrono.length === 1 ? '' : 's'}`, 16, H - 10); }

  if (moving) frame();
}
function bez(ax: number, ay: number, mx: number, bx: number, by: number, t: number) { const u = 1 - t; return { x: u * u * u * ax + 3 * u * u * t * mx + 3 * u * t * t * mx + t * t * t * bx, y: u * u * u * ay + 3 * u * u * t * ay + 3 * u * t * t * by + t * t * t * by }; }
function roundRect(x: number, y: number, w: number, h: number, r: number) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
function wrapText(s: string, x: number, y: number, maxW: number, lh: number) {
  const words = s.split(' '); const lines: string[] = []; let cur = '';
  for (const w of words) { const t = cur ? cur + ' ' + w : w; if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t; }
  if (cur) lines.push(cur); const top = y - ((lines.length - 1) * lh) / 2;
  lines.slice(0, 3).forEach((l, i) => ctx.fillText(l, x, top + i * lh));
}
export function floorUserView() { return userView; }
onView(() => renderFloor());
