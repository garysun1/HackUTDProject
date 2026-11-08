// The shift's memory as of a moment in time: issues raised and resolved, time spent, the handoff
// between shifts with what was carried over, and the photos in order. Every item is
// derived from the live tables (nothing is invented here); the clock is the replay's.
import { state, type Alert, type Ev, type TrackPoint, wearerColor, wearerName, fmtTime, loadPhoto, alertsFor, placeOf, changesTo } from './store';
import { haversineM } from './geo';

export type Fix = { tMs: number; lat: number; lon: number; floor?: number; acc: number };
export type Shift = { key: string; deviceId: string; shiftId: string; startMs: number; endMs: number | null; lastMs: number; pts: TrackPoint[]; smooth: Fix[] };
const params = new URLSearchParams(location.search);
const SHIFT_PARAM = params.get('shift'); const ALL_SHIFTS = params.get('all') === '1';
export type Snapshot = {
  shifts: Shift[]; active: Shift[]; latestIdle: Shift | null;
  open: Alert[]; resolvedRecently: Alert[]; events: Ev[]; handoff: HandoffCard | null;
};
export type HandoffCard = { atMs: number; from: Shift; to: Shift | null; carried: { a: Alert; done: boolean }[]; said: string[]; text?: string };

const TEN_MIN = 10 * 60_000;
let shiftCache: { v: number; db: string; shifts: Shift[] } | null = null;
export function shifts(): Shift[] {
  if (shiftCache && shiftCache.v === state.version && shiftCache.db === state.db) return shiftCache.shifts;
  const by = new Map<string, TrackPoint[]>();
  for (const p of state.track) { const k = `${p.deviceId}|${p.shiftId}`; (by.get(k) ?? by.set(k, []).get(k)!).push(p); }
  // events with a position but no track still define a shift
  for (const l of state.locations.values()) { const k = `${l.deviceId}|${l.shiftId}`; if (!by.has(k)) by.set(k, []); }
  const out: Shift[] = [];
  for (const [key, pts] of by) {
    const [deviceId, shiftId] = key.split('|'); pts.sort((a, b) => a.tMs - b.tMs);
    const locs = [...state.locations.values()].filter(l => l.deviceId === deviceId && l.shiftId === shiftId);
    const points = pts.filter(p => p.kind === 'point');
    const times = [...points.map(p => p.tMs), ...locs.map(l => l.tMs)]; if (!times.length) continue;
    const end = pts.find(p => p.kind === 'shift_end');
    out.push({ key, deviceId, shiftId, startMs: Math.min(...times), endMs: end ? end.tMs : null, lastMs: Math.max(...times), pts: points, smooth: filterTrack(points) });
  }
  out.sort((a, b) => a.startMs - b.startMs);
  shiftCache = { v: state.version, db: state.db, shifts: out }; return out;
}
/** A photo belongs to the session when a tracked shift of its wearer covers it (or its fix names the shift). */
export function inSession(e: Ev, all: Shift[] = sessionShifts()): boolean {
  const loc = state.locations.get(e.eventId);
  if (loc && all.some(s => s.shiftId === loc.shiftId && s.deviceId === loc.deviceId)) return true;
  return all.some(s => s.deviceId === e.deviceId && e.tMs >= s.startMs - 120_000 && e.tMs <= shiftEnd(s) + 120_000);
}
// The phone's fixes, made honest rather than pretty: a fix that implies a jump no walker makes
// (over 4 m/s and farther than its own accuracy) is dropped as GPS noise; the rest are averaged
// over ±6 s with each fix weighted by 1/accuracy², so a 4 m fix outweighs a 30 m one beside it.
// Timestamps are the phone's; nothing is resampled.
export function filterTrack(points: TrackPoint[]): Fix[] {
  const kept: TrackPoint[] = [];
  for (const p of points) {
    const prev = kept[kept.length - 1];
    if (prev) { const dt = (p.tMs - prev.tMs) / 1000; const d = haversineM(prev.lat, prev.lon, p.lat, p.lon); if (dt > 0 && d / dt > 4 && d > Math.max(p.accuracyM, prev.accuracyM, 10)) continue; }
    kept.push(p);
  }
  const W = 6000;
  return kept.map((p, i) => {
    let sw = 0, la = 0, lo = 0;
    const add = (q: TrackPoint) => { const w = 1 / Math.max(3, q.accuracyM) ** 2; sw += w; la += w * q.lat; lo += w * q.lon; };
    for (let j = i; j >= 0 && p.tMs - kept[j].tMs <= W; j--) add(kept[j]);
    for (let j = i + 1; j < kept.length && kept[j].tMs - p.tMs <= W; j++) add(kept[j]);
    return { tMs: p.tMs, lat: la / sw, lon: lo / sw, floor: p.floor, acc: p.accuracyM };
  });
}
/** The shifts this view is about: `?shift=<id prefix>` or `?all=1`, else the latest real shift (two
 *  minutes or more of track), preferring one whose fixes carry a floor. Older shifts stay in the
 *  database and out of the way. */
export function sessionShifts(): Shift[] {
  const all = shifts();
  if (ALL_SHIFTS) return all;
  if (SHIFT_PARAM) return all.filter(s => s.shiftId.startsWith(SHIFT_PARAM));
  const real = all.filter(s => s.lastMs - s.startMs >= 120_000 && s.smooth.length >= 5);
  const withFloor = real.filter(s => s.pts.some(p => p.floor !== undefined));
  const pool = withFloor.length ? withFloor : real.length ? real : all;
  return pool.length ? [pool[pool.length - 1]] : [];
}
export function shiftLive(s: Shift, clock: number) { return clock >= s.startMs && (s.endMs !== null ? clock <= s.endMs + 60_000 : clock <= s.lastMs + TEN_MIN); }
export function shiftEnd(s: Shift) { return s.endMs ?? s.lastMs; }
export function resolvedAt(a: Alert) { return a.acked ? (a.ackedMs ?? a.tMs) : Infinity; }
export function openAt(a: Alert, clock: number) { return a.tMs <= clock && resolvedAt(a) > clock; }

// where a wearer is at `clock`, interpolated along the smoothed track; null before the first fix or
// once the shift is over
export function positionAt(s: Shift, clock: number): { lat: number; lon: number; floor?: number; acc: number; i: number } | null {
  const p = s.smooth; if (!p.length || clock < p[0].tMs) return null;
  if (!shiftLive(s, clock)) return null;
  let i = p.length - 1; for (let k = 0; k < p.length; k++) if (p[k].tMs > clock) { i = k - 1; break; }
  if (i < 0) return null;
  const a = p[i], b = p[i + 1];
  // between two fixes the dot moves at constant speed; across a gap of over two minutes it waits
  if (!b || b.tMs - a.tMs > 120_000) return { lat: a.lat, lon: a.lon, floor: a.floor, acc: a.acc, i };
  const f = (clock - a.tMs) / (b.tMs - a.tMs);
  return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f, floor: f < 0.5 ? a.floor : b.floor, acc: a.acc + (b.acc - a.acc) * f, i };
}
export function walkedM(s: Shift, clock: number): number {
  let d = 0; const p = s.smooth;
  for (let i = 1; i < p.length && p[i].tMs <= clock; i++) { const seg = haversineM(p[i - 1].lat, p[i - 1].lon, p[i].lat, p[i].lon); if (seg < 80) d += seg; }
  return d;
}
export function snapshot(clock: number): Snapshot {
  const all = sessionShifts();
  const active = all.filter(s => shiftLive(s, clock));
  const past = all.filter(s => shiftEnd(s) < clock);
  const latestIdle = active.length ? null : (past.length ? past[past.length - 1] : null);
  const open = state.alerts.filter(a => openAt(a, clock)).sort((a, b) => b.tMs - a.tMs);
  const resolvedRecently = state.alerts.filter(a => a.tMs <= clock && resolvedAt(a) <= clock).sort((a, b) => resolvedAt(b) - resolvedAt(a)).slice(0, 3);
  const events = [...state.events.values()].filter(e => e.tMs <= clock && inSession(e, all)).sort((a, b) => a.tMs - b.tMs).slice(-200);
  // the most recent shift transition at or before the clock
  let handoff: HandoffCard | null = null;
  for (let i = all.length - 1; i >= 0; i--) {
    const from = all[i]; const at = shiftEnd(from);
    if (at > clock || shiftLive(from, clock)) continue;
    const to = all.find(s => s !== from && s.startMs >= at - 5 * 60_000) ?? null;
    if (!to && clock - at > 6 * 3600_000) break; // an old shift with nothing after it is not a handoff
    const carried = state.alerts.filter(a => openAt(a, at)).map(a => ({ a, done: resolvedAt(a) <= clock }));
    const said = [...state.events.values()].filter(e => e.deviceId === from.deviceId && e.tMs >= from.startMs && e.tMs <= at + 60_000 && e.note && /^handoff:/i.test(e.note)).map(e => e.note!.replace(/^handoff:\s*/i, ''));
    const row = [...state.handoffs].reverse().find(h => h.generatedMs <= clock && Math.abs(h.generatedMs - at) < 2 * 3600_000);
    handoff = { atMs: at, from, to, carried, said, text: row?.text }; break;
  }
  return { shifts: all, active, latestIdle, open, resolvedRecently, events, handoff };
}

// ---------- render ----------
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const seen = new Set<string>(); let lastSig = ''; let lastCur = ''; let userScrollAt = 0;
function watchScroll(el: HTMLElement) { if ((el as any).__watched) return; (el as any).__watched = true; for (const ev of ['wheel', 'touchmove', 'pointerdown']) el.addEventListener(ev, () => { userScrollAt = performance.now(); }, { passive: true }); }
export type BrainCtx = { clock: number; selected: string | null; locate: (lat: number, lon: number) => string | undefined; onSelect: (id: string) => void; onJump: (ms: number) => void };
export function fmtSpan(ms: number): string { const m = Math.max(0, Math.round(ms / 60_000)); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} min`; }

/** The panel is rebuilt only when its content changes (a photo reached, an issue raised or
 *  resolved, a thumbnail loaded); the clock-driven numbers are updated in place so the feed
 *  never flickers while the replay runs. */
export function renderBrain(el: HTMLElement, ctx: BrainCtx): Snapshot {
  const snap = snapshot(ctx.clock);
  const focus = snap.active[0] ?? snap.latestIdle;
  const raised = state.alerts.filter(a => a.tMs <= ctx.clock).sort((a, b) => b.tMs - a.tMs);
  const resolved = raised.filter(a => resolvedAt(a) <= ctx.clock);
  const spent = focus ? Math.min(ctx.clock, shiftEnd(focus)) - focus.startMs : 0;
  const sig = [state.version, state.db, focus?.key, raised.map(a => a.alertId).join(','), resolved.map(a => a.alertId).join(','), snap.events.length, snap.events[0]?.eventId, snap.handoff?.atMs, snap.handoff?.carried.filter(c => c.done).length, ctx.selected, [...state.photos.keys()].length].join('|');
  if (sig !== lastSig) {
    lastSig = sig;
    const parts: string[] = [];
    // the three numbers that matter stay pinned above the scrolling feed
    const statsEl = document.getElementById('brain-stats');
    if (statsEl) {
      statsEl.innerHTML = `<div class="stats"><div class="stat raised"><i></i><b>${raised.length}</b><span>issues raised</span></div><div class="stat resolved"><i></i><b>${resolved.length}</b><span>resolved</span></div><div class="stat time"><b id="st-time">${fmtSpan(spent)}</b><span>time spent</span></div></div>`;
      const last = raised[0]; statsEl.querySelector('.stat.raised')?.addEventListener('click', () => { if (last) ctx.onJump(last.tMs); });
      statsEl.querySelector('.stat.resolved')?.addEventListener('click', () => { if (resolved[0]) ctx.onJump(resolvedAt(resolved[0])); });
    }
    // issues: open first, then resolved, newest first
    const issue = (a: Alert) => { const done = resolvedAt(a) <= ctx.clock; return `<div class="issue${done ? ' done' : ''}" data-jump="${done ? resolvedAt(a) : a.tMs}"><i class="ic"></i><div class="tx"><b>${esc(a.entityName || a.text)}</b>${a.entityName ? `<span class="what"> · ${esc(a.text)}</span>` : ''}<div class="m">${done ? `resolved ${fmtTime(resolvedAt(a))}` : `open since ${fmtTime(a.tMs)}`} · ${esc(a.wearerName || wearerName(a.deviceId))}</div></div></div>`; };
    parts.push(`<section class="sec"><h3>Issues <span class="n">${snap.open.length} open</span></h3>${raised.length ? [...snap.open, ...resolved].map(issue).join('') : '<div class="empty">None raised yet.</div>'}</section>`);
    // handoff, one card
    if (snap.handoff) {
      const h = snap.handoff;
      parts.push(`<section class="sec"><h3>Handoff</h3><div class="hand" data-jump="${h.atMs}"><div class="arrow"><span style="color:${wearerColor(h.from.deviceId)}">●</span> ${esc(wearerName(h.from.deviceId))} <i>→</i> ${h.to ? `<span style="color:${wearerColor(h.to.deviceId)}">●</span> ${esc(wearerName(h.to.deviceId))}` : '<i>next shift</i>'}<span class="t">${fmtTime(h.atMs)}</span></div>` +
        (h.carried.length ? `<ul>${h.carried.map(c => `<li class="${c.done ? 'done' : ''}">${esc(c.a.entityName || c.a.text)}${c.a.entityName ? ` · ${esc(c.a.text)}` : ''}</li>`).join('')}</ul>` : '<div class="clear">Nothing carried over</div>') +
        h.said.map(s => `<div class="said">“${esc(s)}”</div>`).join('') + `</div></section>`);
    }
    // photos, oldest first; the current one is marked and scrolled into view
    const curId = snap.events.length ? snap.events[snap.events.length - 1].eventId : '';
    const evHtml = (e: Ev) => {
      const open = alertsFor(e.eventId).some(a => openAt(a, ctx.clock)); const chg = changesTo(e.eventId);
      const url = state.photos.get(e.eventId); if (!url) loadPhoto(e.eventId);
      const isAck = !!e.note && /^briefing ack/i.test(e.note);
      const place = placeOf(e.eventId) || e.locationGuess;
      const fresh = !seen.has(e.eventId); seen.add(e.eventId);
      const pending = e.status !== 'in_graph' && !e.summary;
      return `<div class="ev${open ? ' alert' : ''}${chg.length ? ' change' : ''}${ctx.selected === e.eventId ? ' sel' : ''}${fresh ? ' arrive' : ''}${e.eventId === curId ? ' cur' : ''}" data-ev="${e.eventId}" style="--c:${wearerColor(e.deviceId)}"><span class="k"><i></i></span>${url ? `<img class="th" src="${url}" alt="">` : '<span class="th"></span>'}<div class="tx"><div class="t">${fmtTime(e.tMs)}${place && !isAck ? ` · ${esc(place)}` : ''}</div>` +
        (isAck ? `<p class="note">Briefing confirmed. ${esc(e.note!.replace(/^briefing ack:\s*/i, ''))}</p>` : `<p>${pending ? '<span class="pending">Reading the photo…</span>' : esc(e.summary || e.scene || '')}</p>`) +
        (e.note && !isAck ? `<p class="note">“${esc(e.note)}”</p>` : '') + chg.map(c => `<p class="chg">Changed: ${esc(c.text)}</p>`).join('') + `</div></div>`;
    };
    parts.push(`<section class="sec"><h3>Photos <span class="n">${snap.events.length}</span></h3><div class="feed">${snap.events.length ? snap.events.map(evHtml).join('') : '<div class="empty">No photos yet at this time.</div>'}</div></section>`);
    watchScroll(el);
    const keepTop = el.scrollTop; el.innerHTML = parts.join(''); el.scrollTop = keepTop;
    if (curId && curId !== lastCur) { lastCur = curId; if (performance.now() - userScrollAt > 6000) { const c = el.querySelector('.ev.cur') as HTMLElement | null; if (c) el.scrollTo({ top: Math.max(0, c.offsetTop - el.clientHeight / 2), behavior: 'auto' }); } /* instant, on the panel itself: a smooth scrollIntoView left the body blank when the feed was rebuilt mid-animation */ }
    el.querySelectorAll<HTMLElement>('[data-ev]').forEach(n => n.addEventListener('click', () => ctx.onSelect(n.dataset.ev!)));
    el.querySelectorAll<HTMLElement>('[data-jump]').forEach(n => n.addEventListener('click', e => { e.stopPropagation(); if (n.dataset.jump) ctx.onJump(Number(n.dataset.jump)); }));
  } else {
    const t = document.getElementById('st-time'); if (t) t.textContent = fmtSpan(spent);
  }
  return snap;
}
