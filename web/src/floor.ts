// The shift view. Chronological order is the canonical order: photos sit on one horizontal line,
// time beneath. Four kinds of thing on screen: photo, equipment, issue, note. Equipment and
// issues hang above the line and thread down to every photo they touch; notes (what the wearer
// said) hang below. A change arcs from the earlier photo of a piece of equipment to the later one
// with its text. Everything that is only about one photo (place, people, objects, text read) is
// behind the click. Hover reveals shared identifiers and look-alike photos. No layout algorithm:
// nothing moves except a new photo sliding in on the right.
import { state, visibleEvents, edgesFrom, props, alertsFor, wearerColor, wearerName, fmtTime, notify, loadPhoto, perception, type Ev, type Ent, type Alert } from './store';
import { select, esc } from './timeline';
import { view as vs, shownEvents, setScope, onView } from './view';
import { photoCard, showTip, hideTip } from './card';
import { fitRequested } from './tools';
import { vocab, typeWords } from './workspaces';
import { sessionShifts, inSession } from './brain';
import { overlayActive } from './overlay';

const canvas = document.getElementById('floor') as HTMLCanvasElement;
const empty = document.getElementById('floor-empty') as HTMLElement;
const floorEl = canvas.parentElement as HTMLElement;
const scopeHead = document.getElementById('scope-head') as HTMLElement; const scopeTitle = document.getElementById('scope-title') as HTMLElement;
document.getElementById('scope-close')!.addEventListener('click', () => setScope(null));
const ctx = canvas.getContext('2d')!;

// ---------- geometry ----------
const PW = 72, PH = 54; // photo chip
const STEP = 124, STEP_MAX = 210, BREAK_MIN = 30; // px per photo, extra for long gaps, minutes before a gap is labelled
const LANE = 36, PILL_H = 26, NOTE_W = 190, NOTE_H = 40;
let W = 0, H = 0;
const view = { k: 1, tx: 0, ty: 0 }; let userView = false; let seenFit = fitRequested; let lastReplayStart = 0;
const bootT = performance.now(); const seen = new Set<string>();
const anim = new Map<string, { x: number; a: number; t0: number }>();
const imgs = new Map<string, HTMLImageElement>();
let raf = 0; let lastFrame = performance.now();
let hover: { kind: 'photo' | 'node'; id: string } | null = null;
let drag: { sx: number; sy: number; tx: number; ty: number; moved: boolean } | null = null;

type Node = { id: string; kind: 'equipment' | 'issue'; label: string; sub: string; photos: string[]; alert?: Alert; assetId?: string; resolvedBy?: string; x: number; y: number; w: number; lane: number; open: boolean; progress?: boolean };
type Note = { id: string; text: string; x: number; y: number; w: number; lane: number };
type Q = { id: string; text: string; answer: string; photos: string[]; x: number; y: number; w: number; lane: number; t: bigint };
const Q_W = 230, Q_H = 46;
type Hit = { kind: 'photo' | 'node'; id: string; x0: number; y0: number; x1: number; y1: number };
let hits: Hit[] = [];

function photo(id: string): HTMLImageElement | null {
  const url = state.photos.get(id); if (!url) { loadPhoto(id); return null; }
  let im = imgs.get(id);
  if (!im) { im = new Image(); im.onload = () => frame(); im.src = url; imgs.set(id, im); }
  return im.complete && im.naturalWidth ? im : null;
}
function frame() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; renderFloor(); }); }
function toWorld(px: number, py: number) { return { x: (px - view.tx) / view.k, y: (py - view.ty) / view.k }; }
// The graph draws exactly the photos the map and its panel are about: the session's shifts (brain.sessionShifts).
// A database with no tracked walk, or a workspace with an overlay, is about the whole record, as in the panel.
function shown(): Ev[] {
  const evs = shownEvents(true); const all = sessionShifts();
  return all.length && !overlayActive() ? evs.filter(e => inSession(e, all)) : evs;
}

// ---------- theme ----------
function cssVar(name: string): string { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
let C = { ink: '', ink2: '', ink3: '', ink4: '', line: '', soft: '', entity: '', warn: '', warnBg: '', crit: '', critInk: '', critBg: '', good: '', goodInk: '', panel: '', ground: '', dark: false };
function readTokens() {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches && document.documentElement.dataset.theme !== 'light' || document.documentElement.dataset.theme === 'dark';
  C = { ink: cssVar('--ink'), ink2: cssVar('--ink-2'), ink3: cssVar('--ink-3'), ink4: cssVar('--ink-4'), line: cssVar('--line-strong'), soft: cssVar('--line'), entity: cssVar('--entity'), warn: cssVar('--warning-ink'), warnBg: cssVar('--warning-bg'), crit: cssVar('--critical'), critInk: cssVar('--critical-ink'), critBg: cssVar('--critical-bg'), good: cssVar('--good'), goodInk: cssVar('--good-ink'), panel: cssVar('--panel'), ground: cssVar('--ground'), dark };
}
readTokens(); matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { readTokens(); frame(); });
const withAlpha = (hex: string, a: number) => { const m = /^#([0-9a-f]{6})$/i.exec(hex); if (!m) return hex; const n = parseInt(m[1], 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };

// ---------- plain words ----------
const slug = (name: string) => name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const registryOf = (ent: Ent) => state.assets.get(ent.entityId.toUpperCase().replace(/_/g, '-'));
/** "Power unit A, Rack R12" + "power distribution unit · PDU-A". The code is secondary. */
function equipmentWords(ent: Ent): { label: string; sub: string } {
  const a = registryOf(ent);
  if (a) { const kind = typeWords(a.assetType); const loc = a.location ? a.location.split('/').pop()!.trim() : ''; return { label: a.name, sub: [kind, loc && !a.name.toLowerCase().includes(loc.toLowerCase()) ? loc : '', a.assetId].filter(Boolean).join(' · ') }; }
  return { label: ent.canonicalName, sub: ent.kind === 'asset' ? vocab().tracked.toLowerCase() : 'labelled by the wearer' };
}
/** "PSU 2 fault" from alert text like "FAULT" / "PSU2 OK → PSU2 FAULT" / "status: ... → ..." */
function issueWords(a: Alert): string {
  let t = a.text.replace(/\s+/g, ' ').trim();
  const arrow = t.split('→'); if (arrow.length > 1) t = arrow[arrow.length - 1].trim();
  t = t.replace(/^[a-z_ ]+:\s*/i, '');
  if (t === t.toUpperCase() && /[A-Z]{3,}/.test(t)) t = t.charAt(0) + t.slice(1).toLowerCase();
  t = t.replace(/\bpsu(\d)/i, 'PSU $1').replace(/\balarm\b/i, 'alarm');
  if (t.length > 38) t = t.slice(0, 37) + '…';
  return t.charAt(0).toUpperCase() + t.slice(1);
}
function identifiers(e: Ev): string[] {
  const p = perception(e); const out = new Set<string>();
  for (const s of (p?.text_in_scene ?? []) as string[]) { const str = String(s); for (const m of str.matchAll(/\b(?:ticket|inc|wo|sr|case)\s*#?\s*(\d{3,})\b|#(\d{3,})\b|\b([A-Z]{2,}-\d{1,4}[A-Z]?)\b/gi)) out.add((m[1] ? `ticket ${m[1]}` : m[2] ? `#${m[2]}` : m[3]).toUpperCase()); }
  return [...out];
}

// ---------- pointer ----------
function hit(px: number, py: number): Hit | null { const { x, y } = toWorld(px, py); for (const h of hits) if (x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1) return h; return null; }
canvas.addEventListener('mousedown', e => { const r = canvas.getBoundingClientRect(); drag = { sx: e.clientX - r.left, sy: e.clientY - r.top, tx: view.tx, ty: view.ty, moved: false }; });
canvas.addEventListener('mousemove', e => {
  const r = canvas.getBoundingClientRect(); const px = e.clientX - r.left, py = e.clientY - r.top;
  if (drag) { if (Math.hypot(px - drag.sx, py - drag.sy) > 4) { drag.moved = true; userView = true; } if (drag.moved) { view.tx = drag.tx + (px - drag.sx); view.ty = drag.ty + (py - drag.sy); frame(); } return; }
  const h = hit(px, py); const prevId = hover?.id ?? null; hover = h ? { kind: h.kind, id: h.id } : null; canvas.style.cursor = h ? 'pointer' : 'grab';
  if (h) showTip(h.kind === 'photo' ? photoCard(h.id) : nodeCard(h.id), e.clientX, e.clientY, h.id); else hideTip();
  if (prevId !== (hover?.id ?? null)) frame();
});
addEventListener('mouseup', e => {
  if (!drag) return; const moved = drag.moved; drag = null; if (moved || e.target !== canvas) return;
  const r = canvas.getBoundingClientRect(); const h = hit(e.clientX - r.left, e.clientY - r.top);
  if (!h) { if (state.selected) select(null); return; }
  if (h.kind === 'photo') select(h.id); else if (h.id.startsWith('q:')) { const q = state.questions.get(h.id.slice(2)); if (q?.eventIds[0]) select(q.eventIds[0]); } else { const n = nodeById.get(h.id); const ent = n?.kind === 'issue' ? n.assetId : h.id; if (ent) { state.assetFilter = state.assetFilter === ent ? null : ent; notify(); } }
});
canvas.addEventListener('mouseleave', () => { hover = null; hideTip(); frame(); });
canvas.addEventListener('dblclick', () => { userView = false; frame(); });
canvas.addEventListener('wheel', e => {
  if (!hits.length) return; e.preventDefault();
  const r = canvas.getBoundingClientRect(); const px = e.clientX - r.left, py = e.clientY - r.top;
  if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) { view.tx -= e.deltaX || e.deltaY; userView = true; frame(); return; }
  const k = Math.min(3, Math.max(0.25, view.k * Math.exp(-e.deltaY * 0.0015)));
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
addEventListener('resize', () => frame());

const nodeById = new Map<string, Node>();
function nodeCard(id: string): string {
  if (id.startsWith('q:')) { const q = state.questions.get(id.slice(2)); if (!q) return ''; return `<div class="tb"><div class="tt"><b>Asked ${fmtTime(q.tMicros)}</b> · ${esc(q.asker || q.source)} · ${esc(q.tool.replace(/_/g, ' '))}</div><div class="ts">${esc(q.text)}</div><div class="tn">${esc(q.answer)}</div></div>`; }
  const n = nodeById.get(id); if (!n) return '';
  const last = n.photos.map(p => state.events.get(p)!).sort((a, b) => (a.tMicros < b.tMicros ? 1 : -1))[0];
  const head = n.kind === 'issue' ? `<span class="ta">${esc(n.label)}</span>` : `<b>${esc(n.label)}</b>`;
  const resolved = n.resolvedBy ? state.events.get(n.resolvedBy) : null;
  return `<div class="tb"><div class="tt">${head}</div><div class="ts">${esc(n.sub)}${n.kind === 'issue' && !n.id.startsWith('wo:') ? (n.open ? ' · open' : ' · resolved') : ''}${resolved ? ` · resolved by the ${fmtTime(resolved.tMicros)} photo` : ''} · in ${n.photos.length} photo${n.photos.length === 1 ? '' : 's'}${last ? ` · last ${fmtTime(last.tMicros)} by ${esc(wearerName(last.deviceId))}` : ''}. Click to follow.</div></div>`;
}

// ---------- layout ----------
type Layout = { chrono: Ev[]; xOf: Map<string, number>; breaks: { x: number; minutes: number }[]; nodes: Node[]; notes: Note[]; questions: Q[]; changes: { from: string; to: string; text: string; entity: string }[]; lanesUp: number; lanesDown: number; spineY: number; width: number };
function layout(evs: Ev[]): Layout {
  const chrono = [...evs].reverse();
  const xOf = new Map<string, number>(); const breaks: Layout['breaks'] = []; let x = 90;
  chrono.forEach((e, i) => { if (i) { const m = Number(e.tMicros - chrono[i - 1].tMicros) / 60e6; const step = Math.min(STEP_MAX, STEP + Math.max(0, m - 2) * 2.5); if (m >= BREAK_MIN) breaks.push({ x: x + step / 2, minutes: Math.round(m) }); x += step; } xOf.set(e.eventId, x); });
  const width = x + 90;
  // equipment: registry assets and the wearer's labelled thing; issues: alerts, each with the photos it spans
  const eq = new Map<string, Node>();
  for (const e of chrono) {
    const labelId = e.label ? slug(e.label) : null;
    for (const ed of edgesFrom(e.eventId, 'INVOLVES')) {
      const ent = state.entities.get(ed.toId); if (!ent || props(ed).role === 'setting') continue;
      if (ent.kind !== 'asset' && ent.entityId !== labelId) continue;
      let n = eq.get(ent.entityId); if (!n) { const w = equipmentWords(ent); n = { id: ent.entityId, kind: 'equipment', label: w.label, sub: w.sub, photos: [], x: 0, y: 0, w: 0, lane: 0, open: false }; eq.set(ent.entityId, n); }
      n.photos.push(e.eventId);
    }
  }
  const issues: Node[] = [];
  const evIds = new Set(chrono.map(e => e.eventId));
  for (const a of state.alerts.values()) {
    if (!evIds.has(a.eventId)) continue;
    const raised = state.events.get(a.eventId)!; const photos = [a.eventId];
    const until = a.acked && a.ackedMicros ? a.ackedMicros : null;
    for (const e of chrono) if (e.eventId !== a.eventId && e.tMicros > raised.tMicros && (until === null || e.tMicros <= until) && a.assetId && edgesFrom(e.eventId, 'INVOLVES').some(ed => ed.toId === a.assetId)) photos.push(e.eventId);
    const ent = a.assetId ? state.entities.get(a.assetId) : undefined; const where = ent ? equipmentWords(ent).label : a.assetName || '';
    const res = [...state.resolutions.values()].find(r => r.alertId === a.id && evIds.has(r.eventId));
    if (res && !photos.includes(res.eventId)) photos.push(res.eventId);
    issues.push({ id: `alert:${a.id}`, kind: 'issue', label: issueWords(a), sub: where ? `${vocab().flag.toLowerCase()} on ${where}` : vocab().flag.toLowerCase(), photos, alert: a, assetId: a.assetId, resolvedBy: res?.eventId, x: 0, y: 0, w: 0, lane: 0, open: !a.acked });
  }
  // work orders: a flag that existed before the first photo, threading to every photo of its asset
  for (const wo of state.issues.values()) {
    const assetEnt = state.assets.get(wo.assetId) ? state.entities.get(wo.assetId.toLowerCase().replace(/-/g, '_')) : undefined; const entId = assetEnt?.entityId ?? wo.assetId.toLowerCase().replace(/-/g, '_');
    const photos = chrono.filter(e => edgesFrom(e.eventId, 'INVOLVES').some(ed => ed.toId === entId)).map(e => e.eventId);
    if (wo.resolvedEventId && evIds.has(wo.resolvedEventId) && !photos.includes(wo.resolvedEventId)) photos.push(wo.resolvedEventId);
    if (!photos.length) continue; // a work order nobody has looked at yet stays in the registry, not on the line
    const where = assetEnt ? equipmentWords(assetEnt).label : state.assets.get(wo.assetId)?.name ?? wo.assetId;
    const label = wo.title.length > 38 ? wo.title.slice(0, 37) + '…' : wo.title;
    issues.push({ id: `wo:${wo.issueId}`, kind: 'issue', label, sub: `work order ${wo.issueId} on ${where}${wo.status === 'in_progress' ? ' · in progress' : wo.status === 'resolved' ? ' · resolved' : ' · open'}${wo.openedBy ? ` · opened by ${wo.openedBy}` : ''}`, photos, assetId: entId, resolvedBy: wo.resolvedEventId, x: 0, y: 0, w: 0, lane: 0, open: wo.status !== 'resolved', progress: wo.status === 'in_progress' });
  }
  // open issues nearest the line, then equipment by first appearance; lanes packed by horizontal overlap
  ctx.font = '500 12.5px Inter, sans-serif';
  const place = (ns: Node[]) => {
    for (const n of ns) { const xs = n.photos.map(p => xOf.get(p)!); n.x = (Math.min(...xs) + Math.max(...xs)) / 2; n.w = Math.max(96, Math.min(260, ctx.measureText(n.label).width + (n.kind === 'issue' ? 44 : 22))); }
    ns.sort((a, b) => (a.kind !== b.kind ? (a.kind === 'issue' ? -1 : 1) : Math.min(...a.photos.map(p => xOf.get(p)!)) - Math.min(...b.photos.map(p => xOf.get(p)!))));
    const lanes: { x0: number; x1: number }[][] = [];
    for (const n of ns) { let l = 0; for (; ; l++) { const row = lanes[l] ?? (lanes[l] = []); if (!row.some(r => n.x - n.w / 2 < r.x1 + 14 && n.x + n.w / 2 > r.x0 - 14)) { row.push({ x0: n.x - n.w / 2, x1: n.x + n.w / 2 }); break; } } n.lane = l; }
    return lanes.length;
  };
  const nodes = [...issues, ...eq.values()]; const lanesUp = place(nodes);
  // notes below
  const notes: Note[] = []; const rows: { x0: number; x1: number }[][] = [];
  for (const e of chrono) if (e.note) { const x0 = xOf.get(e.eventId)! - NOTE_W / 2; let l = 0; for (; ; l++) { const row = rows[l] ?? (rows[l] = []); if (!row.some(r => x0 < r.x1 + 12 && x0 + NOTE_W > r.x0 - 12)) { row.push({ x0, x1: x0 + NOTE_W }); break; } } notes.push({ id: e.eventId, text: e.note, x: xOf.get(e.eventId)!, y: 0, w: NOTE_W, lane: l }); }
  // changes: before → after on the same equipment
  const changes: Layout['changes'] = [];
  for (const e of chrono) for (const ed of edgesFrom(e.eventId, 'CHANGES')) {
    const p = props(ed); const prev = [...chrono].reverse().find(o => o.tMicros < e.tMicros && edgesFrom(o.eventId, 'INVOLVES').some(x => x.toId === ed.toId));
    if (!prev) continue; const ent = state.entities.get(ed.toId); const name = ent ? equipmentWords(ent).label : ed.toId;
    const text = `${p.attr && !/^(status|state|description)$/i.test(String(p.attr)) ? String(p.attr) + ': ' : ''}${p.from ?? ''} → ${p.to ?? ''}`;
    changes.push({ from: prev.eventId, to: e.eventId, text: text.length > 48 ? text.slice(0, 47) + '…' : text, entity: name });
  }
  const arcTop = changes.length ? 92 : 40; // room for change arcs and their text between the line and the first lane
  // questions asked of this memory, placed under the photos that answered them
  const questions: Q[] = []; const qrows: { x0: number; x1: number }[][] = [];
  for (const q of [...state.questions.values()].sort((a, b) => (a.tMicros < b.tMicros ? -1 : 1))) {
    const photos = q.eventIds.filter(id => xOf.has(id)); if (!photos.length) continue;
    const xs = photos.map(p => xOf.get(p)!); const cx = (Math.min(...xs) + Math.max(...xs)) / 2; const x0 = cx - Q_W / 2;
    let l = 0; for (; ; l++) { const row = qrows[l] ?? (qrows[l] = []); if (!row.some(r => x0 < r.x1 + 12 && x0 + Q_W > r.x0 - 12)) { row.push({ x0, x1: x0 + Q_W }); break; } }
    questions.push({ id: q.questionId, text: q.text, answer: q.answer, photos, x: cx, y: 0, w: Q_W, lane: l, t: q.tMicros });
  }
  const spineY = Math.max(170, 40 + lanesUp * LANE + arcTop + PH / 2);
  for (const n of nodes) n.y = spineY - PH / 2 - arcTop - n.lane * LANE;
  for (const n of notes) n.y = spineY + PH / 2 + 44 + n.lane * (NOTE_H + 10);
  const qTop = spineY + PH / 2 + 44 + rows.length * (NOTE_H + 10) + (rows.length ? 16 : 0);
  for (const q of questions) q.y = qTop + q.lane * (Q_H + 12);
  return { chrono, xOf, breaks, nodes, notes, questions, changes, lanesUp, lanesDown: rows.length + questions.length, spineY, width };
}

// ---------- render ----------
export function renderFloor() {
  const now = performance.now(); const dt = Math.min(50, now - lastFrame); lastFrame = now;
  floorEl.dataset.mode = vs.mode;
  const visible = vs.mode === 'graph' || !!vs.scope;
  canvas.hidden = !visible; scopeHead.hidden = !(vs.mode === 'map' && vs.scope);
  if (vs.scope) scopeTitle.innerHTML = `<b>${esc(vs.scopeLabel || 'Selection')}</b> · ${shown().length} photo${shown().length === 1 ? '' : 's'}`;
  if (!visible) { empty.hidden = true; return; }
  if (vs.replay.start !== lastReplayStart) { lastReplayStart = vs.replay.start; anim.clear(); userView = false; }
  if (fitRequested !== seenFit) { seenFit = fitRequested; userView = false; }
  const dpr = devicePixelRatio || 1;
  W = canvas.clientWidth; H = canvas.clientHeight;
  if (canvas.width !== W * dpr || canvas.height !== H * dpr) { canvas.width = W * dpr; canvas.height = H * dpr; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
  hits = []; nodeById.clear();
  const evs = shown(); canvas.dataset.photos = String(evs.length); empty.hidden = evs.length > 0 || vs.replay.on || !!vs.scope;
  if (!evs.length) return;
  const L = layout(evs); for (const n of L.nodes) nodeById.set(n.id, n);
  let moving = vs.replay.playing;

  // animated x for photos: new ones slide in from the right edge of the content
  const booted = now - bootT > 2500 || vs.replay.on; const k = 1 - Math.exp(-dt / 120);
  const ax = (id: string) => { const target = L.xOf.get(id)!; let a = anim.get(id); if (!a) { const isNew = booted && !seen.has(id); a = { x: isNew ? target + 160 : target, a: isNew ? 0 : 1, t0: now }; anim.set(id, a); } seen.add(id); a.x += (target - a.x) * k; a.a += (1 - a.a) * k; if (Math.abs(target - a.x) > 0.3 || 1 - a.a > 0.02) moving = true; else { a.x = target; a.a = 1; } return a; };
  for (const id of anim.keys()) if (!L.xOf.has(id)) anim.delete(id);
  const px = new Map<string, { x: number; a: number; t0: number }>(); for (const e of L.chrono) px.set(e.eventId, ax(e.eventId));

  // view: fit while readable; otherwise keep the newest at the right or centre the selection
  const contentH = (L.questions.length ? Math.max(...L.questions.map(q => q.y)) + Q_H : L.spineY + PH / 2 + 44 + L.lanesDown * (NOTE_H + 10)) + 40; const x0 = 0, x1 = L.width;
  if (!userView) {
    const m = 24; const kFit = Math.min((W - 2 * m) / Math.max(200, x1 - x0), (H - 2 * m) / Math.max(200, contentH));
    const MIN = 0.62; const selX = state.selected && L.xOf.has(state.selected) ? L.xOf.get(state.selected)! : null;
    const kT = kFit >= MIN ? Math.min(1.25, kFit) : selX !== null ? Math.max(kFit, 0.8) : MIN;
    let txT = (W - (x0 + x1) * kT) / 2, tyT = (H - contentH * kT) / 2;
    if (kFit < MIN) { txT = selX !== null ? W / 2 - selX * kT : W - m - x1 * kT; tyT = Math.max(H - contentH * kT - m, Math.min(m, (H - contentH * kT) / 2)); }
    const e = 1 - Math.exp(-dt / 160);
    if (Math.abs(kT - view.k) > 0.002 || Math.abs(txT - view.tx) > 0.5 || Math.abs(tyT - view.ty) > 0.5) moving = true;
    view.k += (kT - view.k) * e; view.tx += (txT - view.tx) * e; view.ty += (tyT - view.ty) * e;
  }
  ctx.save(); ctx.translate(view.tx, view.ty); ctx.scale(view.k, view.k);

  // emphasis: a traced entity, a hovered node, a hovered or selected photo
  const traceId = state.assetFilter;
  const focusNode = hover?.kind === 'node' ? nodeById.get(hover.id) : null;
  const litPhotos = new Set<string>(); let anyFocus = false;
  if (traceId) { anyFocus = true; for (const n of L.nodes) if (n.id === traceId || n.assetId === traceId) n.photos.forEach(p => litPhotos.add(p)); }
  else if (focusNode) { anyFocus = true; focusNode.photos.forEach(p => litPhotos.add(p)); }
  const focusPhoto = hover?.kind === 'photo' ? hover.id : state.selected;
  const dim = (id: string) => (anyFocus && !litPhotos.has(id) ? 0.25 : 1);
  const nodeDim = (n: Node) => (traceId ? (n.id === traceId || n.assetId === traceId ? 1 : 0.25) : focusNode ? (n === focusNode ? 1 : 0.35) : 1);

  // the line and the breaks
  ctx.strokeStyle = C.soft; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(40, L.spineY); ctx.lineTo(L.width - 40, L.spineY); ctx.stroke();
  ctx.font = 'italic 11px Inter, sans-serif'; ctx.fillStyle = C.ink4; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const b of L.breaks) { ctx.fillStyle = C.ground; ctx.fillRect(b.x - 30, L.spineY - 8, 60, 16); ctx.fillStyle = C.ink4; ctx.fillText(`${b.minutes >= 90 ? `${Math.floor(b.minutes / 60)} h` : `${b.minutes} min`} quiet`, b.x, L.spineY); }

  // threads from nodes to photos
  ctx.lineCap = 'round';
  for (const n of L.nodes) {
    const col = n.kind === 'issue' ? (n.open ? C.crit : C.ink4) : C.line;
    for (const p of n.photos) {
      const pp = px.get(p); if (!pp) continue; const prog = Math.min(1, (now - pp.t0) / 650); if (prog < 1) moving = true;
      const resolving = n.resolvedBy === p;
      ctx.globalAlpha = Math.min(pp.a, nodeDim(n)) * (n.kind === 'issue' ? 0.9 : 0.7) * prog;
      ctx.strokeStyle = resolving ? C.goodInk : col; ctx.lineWidth = resolving ? 2 : n.kind === 'issue' ? 1.6 : 1;
      const y0 = n.y + PILL_H / 2, y1 = L.spineY - PH / 2 - 3; const my = (y0 + y1) / 2;
      ctx.beginPath(); ctx.moveTo(n.x, y0); ctx.bezierCurveTo(n.x, my, pp.x, my, pp.x, y1); ctx.stroke();
    }
  }
  // note stems
  for (const n of L.notes) { const pp = px.get(n.id)!; ctx.globalAlpha = pp.a * dim(n.id) * 0.7; ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(pp.x, L.spineY + PH / 2 + 3); ctx.lineTo(pp.x, n.y - 2); ctx.stroke(); }
  ctx.globalAlpha = 1;

  // change arcs: before → after, over the line
  for (const c of L.changes) {
    const a = px.get(c.from), b = px.get(c.to); if (!a || !b) continue;
    const lit = !anyFocus || (litPhotos.has(c.from) && litPhotos.has(c.to)); ctx.globalAlpha = (lit ? 1 : 0.2) * Math.min(a.a, b.a);
    const y = L.spineY - PH / 2 - 10, h = Math.min(56, 22 + (b.x - a.x) * 0.08);
    ctx.strokeStyle = C.warn; ctx.lineWidth = 1.6; ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(a.x + PW / 2 - 6, y); ctx.bezierCurveTo(a.x + PW / 2 - 6, y - h, b.x - PW / 2 + 6, y - h, b.x - PW / 2 + 6, y); ctx.stroke();
    // arrowhead
    ctx.fillStyle = C.warn; ctx.beginPath(); ctx.moveTo(b.x - PW / 2 + 6, y + 2); ctx.lineTo(b.x - PW / 2 + 1, y - 7); ctx.lineTo(b.x - PW / 2 + 11, y - 7); ctx.closePath(); ctx.fill();
    ctx.font = '500 11.5px Inter, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; const mx = (a.x + b.x) / 2; const tw = ctx.measureText(c.text).width;
    ctx.fillStyle = C.ground; ctx.fillRect(mx - tw / 2 - 5, y - h * 0.75 - 15, tw + 10, 16); ctx.fillStyle = C.warn; ctx.fillText(c.text, mx, y - h * 0.75);
  }
  ctx.globalAlpha = 1; ctx.textBaseline = 'middle';

  // hover reveals on a photo: shared identifiers and look-alikes
  if (focusPhoto && px.has(focusPhoto)) {
    const me = state.events.get(focusPhoto)!; const mine = identifiers(me); const a = px.get(focusPhoto)!;
    for (const e of L.chrono) {
      if (e.eventId === focusPhoto) continue; const b = px.get(e.eventId)!;
      const shared = identifiers(e).filter(x => mine.includes(x));
      const similar = state.edges.some(ed => ed.kind === 'SIMILAR_TO' && ((ed.fromId === focusPhoto && ed.toId === e.eventId) || (ed.fromId === e.eventId && ed.toId === focusPhoto)));
      if (!shared.length && !similar) continue;
      const y = L.spineY + PH / 2 + 12, h = Math.min(60, 20 + Math.abs(b.x - a.x) * 0.08);
      ctx.strokeStyle = shared.length ? C.ink3 : C.ink4; ctx.lineWidth = 1; ctx.setLineDash([3, 4]);
      ctx.beginPath(); ctx.moveTo(a.x, y); ctx.bezierCurveTo(a.x, y + h, b.x, y + h, b.x, y); ctx.stroke(); ctx.setLineDash([]);
      ctx.font = '11px "JetBrains Mono", monospace'; ctx.fillStyle = shared.length ? C.ink2 : C.ink4; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(shared.length ? shared.join(' · ') : 'looks alike', (a.x + b.x) / 2, y + h * 0.75 + 2); ctx.textBaseline = 'middle';
    }
  }

  // nodes above the line
  for (const n of L.nodes) {
    ctx.globalAlpha = nodeDim(n); const isFocus = focusNode === n || n.id === traceId || n.assetId === traceId;
    const x0 = n.x - n.w / 2, y0 = n.y - PILL_H / 2;
    if (n.kind === 'issue') {
      ctx.fillStyle = n.open ? (n.progress ? C.warnBg : C.critBg) : C.panel; ctx.strokeStyle = n.open ? (n.progress ? C.warn : C.crit) : C.line; ctx.lineWidth = isFocus ? 1.5 : 1;
      roundRect(x0, y0, n.w, PILL_H, 7); ctx.fill(); ctx.stroke();
      // mark: a small triangle while open, a check once resolved
      ctx.fillStyle = n.open ? (n.progress ? C.warn : C.crit) : C.goodInk;
      if (n.open) { ctx.beginPath(); ctx.moveTo(x0 + 14, y0 + 7); ctx.lineTo(x0 + 20.5, y0 + 19); ctx.lineTo(x0 + 7.5, y0 + 19); ctx.closePath(); ctx.fill(); ctx.fillStyle = C.critBg; ctx.fillRect(x0 + 13.3, y0 + 11, 1.4, 4.5); ctx.fillRect(x0 + 13.3, y0 + 16.5, 1.4, 1.4); }
      else { ctx.strokeStyle = C.goodInk; ctx.lineWidth = 1.8; ctx.beginPath(); ctx.moveTo(x0 + 9, y0 + 13.5); ctx.lineTo(x0 + 13, y0 + 17.5); ctx.lineTo(x0 + 20, y0 + 9.5); ctx.stroke(); }
      ctx.font = '600 12.5px Inter, sans-serif'; ctx.fillStyle = n.open ? (n.progress ? C.warn : C.critInk) : C.ink2; ctx.textAlign = 'left'; ctx.fillText(fit(n.label, n.w - 36), x0 + 28, n.y + 0.5);
    } else {
      ctx.fillStyle = isFocus ? C.ink : C.panel; ctx.strokeStyle = isFocus ? C.ink : C.line; ctx.lineWidth = 1;
      roundRect(x0, y0, n.w, PILL_H, 7); ctx.fill(); ctx.stroke();
      ctx.font = '500 12.5px Inter, sans-serif'; ctx.fillStyle = isFocus ? C.ground : C.ink; ctx.textAlign = 'center'; ctx.fillText(fit(n.label, n.w - 16), n.x, n.y + 0.5);
    }
    if (n.sub && isFocus) { ctx.font = '10.5px Inter, sans-serif'; ctx.fillStyle = C.ink3; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; const tw = ctx.measureText(n.sub).width; ctx.fillStyle = C.ground; ctx.fillRect(n.x - tw / 2 - 4, y0 - 17, tw + 8, 15); ctx.fillStyle = C.ink3; ctx.fillText(n.sub, n.x, y0 - 3); ctx.textBaseline = 'middle'; }
    hits.push({ kind: 'node', id: n.id, x0, y0: y0 - 14, x1: x0 + n.w, y1: y0 + PILL_H });
  }
  ctx.globalAlpha = 1;

  // photos on the line
  for (const e of L.chrono) {
    const p = px.get(e.eventId)!; const open = alertsFor(e).some(a => !a.acked); const sel = state.selected === e.eventId || hover?.id === e.eventId;
    const color = open ? C.crit : wearerColor(e.deviceId); const base = p.a * dim(e.eventId); ctx.globalAlpha = base;
    const x0 = p.x - PW / 2, y0 = L.spineY - PH / 2;
    if (now - p.t0 < 1200 && booted && p.t0 > bootT + 2500) { const kk = (now - p.t0) / 1200; moving = true; ctx.strokeStyle = color; ctx.globalAlpha = base * (1 - kk); ctx.lineWidth = 2; roundRect(x0 - 4 - kk * 16, y0 - 4 - kk * 16, PW + 8 + kk * 32, PH + 8 + kk * 32, 10 + kk * 8); ctx.stroke(); ctx.globalAlpha = base; }
    if (open) { ctx.fillStyle = withAlpha(C.crit, 0.14); roundRect(x0 - 6, y0 - 6, PW + 12, PH + 12, 10); ctx.fill(); }
    const im = photo(e.eventId);
    ctx.save(); roundRect(x0, y0, PW, PH, 6); ctx.clip(); ctx.fillStyle = C.panel; ctx.fillRect(x0, y0, PW, PH);
    if (im) { const s = Math.max(PW / im.naturalWidth, PH / im.naturalHeight); const dw = im.naturalWidth * s, dh = im.naturalHeight * s; ctx.drawImage(im, x0 + (PW - dw) / 2, y0 + (PH - dh) / 2, dw, dh); }
    ctx.restore();
    ctx.strokeStyle = color; ctx.lineWidth = sel ? 2.5 : 2; roundRect(x0, y0, PW, PH, 6); ctx.stroke();
    if (sel) { ctx.strokeStyle = C.ink; ctx.lineWidth = 1.5; roundRect(x0 - 4, y0 - 4, PW + 8, PH + 8, 9); ctx.stroke(); }
    ctx.font = '11px "JetBrains Mono", monospace'; ctx.fillStyle = C.ink3; ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText(fmtTime(e.tMicros), p.x, y0 + PH + 6);
    ctx.font = '10.5px Inter, sans-serif'; ctx.fillStyle = C.ink4; ctx.fillText(fit(wearerName(e.deviceId), PW + 30), p.x, y0 + PH + 20); ctx.textBaseline = 'middle';
    hits.push({ kind: 'photo', id: e.eventId, x0, y0, x1: x0 + PW, y1: y0 + PH + 32 });
  }
  // questions: dashed threads up to the moments that answered, then the card
  for (const q of L.questions) {
    const fresh = state.fresh.has('q:' + q.id); const accent = cssVar('--accent');
    for (const p of q.photos) { const pp = px.get(p)!; ctx.globalAlpha = 0.7 * dim(p); ctx.strokeStyle = accent; ctx.lineWidth = 1; ctx.setLineDash([3, 4]); const y0 = L.spineY + PH / 2 + 34, y1 = q.y; const my = (y0 + y1) / 2; ctx.beginPath(); ctx.moveTo(pp.x, y0); ctx.bezierCurveTo(pp.x, my, q.x, my, q.x, y1); ctx.stroke(); ctx.setLineDash([]); }
    ctx.globalAlpha = 1; const x0 = q.x - q.w / 2;
    ctx.fillStyle = withAlpha(accent, C.dark ? 0.16 : 0.07); ctx.strokeStyle = withAlpha(accent, fresh ? 0.9 : 0.45); ctx.lineWidth = fresh ? 1.5 : 1; roundRect(x0, q.y, q.w, Q_H, 7); ctx.fill(); ctx.stroke();
    ctx.font = '600 10px Inter, sans-serif'; ctx.fillStyle = accent; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText('ASKED', x0 + 10, q.y + 6);
    ctx.font = '500 11.5px Inter, sans-serif'; ctx.fillStyle = C.ink; ctx.fillText(fit(q.text.charAt(0).toUpperCase() + q.text.slice(1), q.w - 60), x0 + 50, q.y + 5);
    ctx.font = '11px Inter, sans-serif'; ctx.fillStyle = C.ink3; ctx.fillText(fit(q.answer, q.w - 20), x0 + 10, q.y + 25); ctx.textBaseline = 'middle';
    hits.push({ kind: 'node', id: 'q:' + q.id, x0, y0: q.y, x1: x0 + q.w, y1: q.y + Q_H });
  }
  // notes below the line
  for (const n of L.notes) {
    const p = px.get(n.id)!; ctx.globalAlpha = p.a * dim(n.id);
    const x0 = n.x - n.w / 2;
    ctx.fillStyle = C.ground; ctx.strokeStyle = C.soft; ctx.lineWidth = 1; roundRect(x0, n.y, n.w, NOTE_H, 6); ctx.fill(); ctx.stroke();
    ctx.font = 'italic 11.5px Inter, sans-serif'; ctx.fillStyle = C.ink2; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    wrap(`“${n.text}”`, x0 + 10, n.y + 7, n.w - 20, 14, 2); ctx.textBaseline = 'middle';
  }
  ctx.globalAlpha = 1; ctx.restore();

  if (vs.replay.on && L.chrono.length && vs.mode === 'graph') { const last = L.chrono[L.chrono.length - 1]; ctx.font = '12px Inter, sans-serif'; ctx.fillStyle = C.ink3; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillText(`Replay · ${fmtTime(last.tMicros)} · ${L.chrono.length} photo${L.chrono.length === 1 ? '' : 's'}`, 16, H - 10); }
  if (moving) frame();
}
function roundRect(x: number, y: number, w: number, h: number, r: number) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
function fit(s: string, maxW: number): string { if (ctx.measureText(s).width <= maxW) return s; let t = s; while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1); return t + '…'; }
function wrap(s: string, x: number, y: number, maxW: number, lh: number, maxLines: number) {
  const words = s.split(' '); const lines: string[] = []; let cur = '';
  for (const w of words) { const t = cur ? cur + ' ' + w : w; if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; if (lines.length === maxLines) break; } else cur = t; }
  if (lines.length < maxLines && cur) lines.push(cur);
  if (lines.length === maxLines && (words.join(' ').length > lines.join(' ').length)) lines[maxLines - 1] = fit(lines[maxLines - 1] + '…', maxW);
  lines.forEach((l, i) => ctx.fillText(l, x, y + i * lh));
}
export function floorUserView() { return userView; }
(window as any).__shift = () => ({ view: { ...view }, W, H, hits: hits.length, mode: vs.mode, shown: shown().length, hidden: canvas.hidden });
onView(() => renderFloor());
