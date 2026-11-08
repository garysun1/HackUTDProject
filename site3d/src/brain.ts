// The shift's memory as of a moment in time: who is on the floor and where, what is open, the
// handoff between shifts with what was carried over, and what happened in order. Every item is
// derived from the live tables (nothing is invented here); the clock is the replay's.
import { state, type Alert, type Ev, type TrackPoint, wearerColor, wearerName, fmtTime, loadPhoto, alertsFor, placeOf, changesTo } from './store';
import { haversineM } from './geo';

export type Shift = { key: string; deviceId: string; shiftId: string; startMs: number; endMs: number | null; lastMs: number; pts: TrackPoint[]; smooth: { tMs: number; lat: number; lon: number; floor?: number }[] };
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
    const points = pts.filter(p => p.kind === 'point' && p.accuracyM <= 40);
    const times = [...points.map(p => p.tMs), ...locs.map(l => l.tMs)]; if (!times.length) continue;
    const end = pts.find(p => p.kind === 'shift_end');
    const smooth = points.map((p, i) => { const w = points.slice(Math.max(0, i - 2), Math.min(points.length, i + 3)); return { tMs: p.tMs, lat: w.reduce((s, q) => s + q.lat, 0) / w.length, lon: w.reduce((s, q) => s + q.lon, 0) / w.length, floor: p.floor }; });
    out.push({ key, deviceId, shiftId, startMs: Math.min(...times), endMs: end ? end.tMs : null, lastMs: Math.max(...times), pts: points, smooth });
  }
  out.sort((a, b) => a.startMs - b.startMs);
  shiftCache = { v: state.version, db: state.db, shifts: out }; return out;
}
export function shiftLive(s: Shift, clock: number) { return clock >= s.startMs && (s.endMs !== null ? clock <= s.endMs + 60_000 : clock <= s.lastMs + TEN_MIN); }
export function shiftEnd(s: Shift) { return s.endMs ?? s.lastMs; }
export function resolvedAt(a: Alert) { return a.acked ? (a.ackedMs ?? a.tMs) : Infinity; }
export function openAt(a: Alert, clock: number) { return a.tMs <= clock && resolvedAt(a) > clock; }

// where a wearer is at `clock`, interpolated along the smoothed track; null before the first fix or
// once the shift is over
export function positionAt(s: Shift, clock: number): { lat: number; lon: number; floor?: number; i: number } | null {
  const p = s.smooth; if (!p.length || clock < p[0].tMs) return null;
  if (!shiftLive(s, clock)) return null;
  let i = p.length - 1; for (let k = 0; k < p.length; k++) if (p[k].tMs > clock) { i = k - 1; break; }
  if (i < 0) return null;
  const a = p[i], b = p[i + 1];
  if (!b || b.tMs - a.tMs > TEN_MIN) return { lat: a.lat, lon: a.lon, floor: a.floor, i };
  const f = (clock - a.tMs) / (b.tMs - a.tMs); const e = f * f * (3 - 2 * f);
  return { lat: a.lat + (b.lat - a.lat) * e, lon: a.lon + (b.lon - a.lon) * e, floor: a.floor, i };
}
export function walkedM(s: Shift, clock: number): number {
  let d = 0; const p = s.smooth;
  for (let i = 1; i < p.length && p[i].tMs <= clock; i++) { const seg = haversineM(p[i - 1].lat, p[i - 1].lon, p[i].lat, p[i].lon); if (seg < 80) d += seg; }
  return d;
}
export function snapshot(clock: number): Snapshot {
  const all = shifts();
  const active = all.filter(s => shiftLive(s, clock));
  const past = all.filter(s => shiftEnd(s) < clock);
  const latestIdle = active.length ? null : (past.length ? past[past.length - 1] : null);
  const open = state.alerts.filter(a => openAt(a, clock)).sort((a, b) => b.tMs - a.tMs);
  const resolvedRecently = state.alerts.filter(a => a.tMs <= clock && resolvedAt(a) <= clock).sort((a, b) => resolvedAt(b) - resolvedAt(a)).slice(0, 3);
  const events = [...state.events.values()].filter(e => e.tMs <= clock).sort((a, b) => b.tMs - a.tMs).slice(0, 60);
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
const seen = new Set<string>(); let lastSig = '';
export type BrainCtx = { clock: number; selected: string | null; locate: (lat: number, lon: number) => string | undefined; onSelect: (id: string) => void; onJump: (ms: number) => void };

export function renderBrain(el: HTMLElement, ctx: BrainCtx): Snapshot {
  const snap = snapshot(ctx.clock);
  const sig = [state.version, state.db, snap.active.map(s => s.key).join(','), snap.open.map(a => a.alertId).join(','), snap.events.length, snap.events[0]?.eventId, snap.handoff?.atMs, snap.handoff?.carried.filter(c => c.done).length, Math.floor(ctx.clock / 20_000), ctx.selected, [...state.photos.keys()].length].join('|');
  if (sig === lastSig) return snap; lastSig = sig;
  const parts: string[] = [];
  // who is on the floor
  const who = (s: Shift, live: boolean) => {
    const pos = positionAt(s, ctx.clock); const where = pos ? (ctx.locate(pos.lat, pos.lon) ?? 'on site') : (live ? 'no fix yet' : `last seen ${fmtTime(s.lastMs)}`);
    const since = live ? `on shift since ${fmtTime(s.startMs)}` : `shift ${fmtTime(s.startMs)}–${fmtTime(shiftEnd(s))}`;
    return `<div class="who${live ? '' : ' idle'}" style="--c:${wearerColor(s.deviceId)}"><i class="sw"></i><div><b>${esc(wearerName(s.deviceId))}</b><br><span>${since}</span></div><span class="where">${esc(where)}</span></div>`;
  };
  const focus = snap.active[0] ?? snap.latestIdle;
  parts.push(`<section class="sec"><h3>On the floor</h3>${snap.active.length ? snap.active.map(s => who(s, true)).join('') : snap.latestIdle ? who(snap.latestIdle, false) : '<div class="empty">No one on shift yet.</div>'}`);
  if (focus) {
    const photos = [...state.events.values()].filter(e => e.deviceId === focus.deviceId && e.tMs >= focus.startMs && e.tMs <= Math.min(ctx.clock, shiftEnd(focus) + 60_000)).length;
    const mins = Math.max(0, Math.round((Math.min(ctx.clock, shiftEnd(focus)) - focus.startMs) / 60_000));
    parts.push(`<div class="now"><div class="stat"><b>${photos}</b><span>photo${photos === 1 ? '' : 's'} this shift</span></div><div class="stat"><b>${Math.round(walkedM(focus, ctx.clock))} m</b><span>walked</span></div><div class="stat"><b>${mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins} min`}</b><span>on shift</span></div><div class="stat"><b>${snap.open.length}</b><span>open issue${snap.open.length === 1 ? '' : 's'}</span></div></div>`);
  }
  parts.push('</section>');
  // open issues
  const issue = (a: Alert, done: boolean) => `<div class="issue${done ? ' done' : ''}" data-jump="${a.tMs}"><span class="ic">${done ? '✓' : '!'}</span><div><b>${esc(a.entityName || a.text)}</b>${a.entityName ? ` · ${esc(a.text)}` : ''}<div class="m">${done ? `resolved ${fmtTime(resolvedAt(a))} · ` : ''}seen by ${esc(a.wearerName || wearerName(a.deviceId))} at ${fmtTime(a.tMs)}</div></div></div>`;
  parts.push(`<section class="sec"><h3>Needs attention <span class="n">${snap.open.length}</span></h3>${snap.open.length ? snap.open.map(a => issue(a, false)).join('') : '<div class="clear">All clear on the floor</div>'}${snap.resolvedRecently.map(a => issue(a, true)).join('')}</section>`);
  // handoff
  if (snap.handoff) {
    const h = snap.handoff;
    parts.push(`<section class="sec"><h3>Handoff</h3><div class="hand" data-jump="${h.atMs}"><div class="arrow"><span style="color:${wearerColor(h.from.deviceId)}">●</span> ${esc(wearerName(h.from.deviceId))} <i>→</i> ${h.to ? `<span style="color:${wearerColor(h.to.deviceId)}">●</span> ${esc(wearerName(h.to.deviceId))}${h.to.startMs > ctx.clock ? ' <i>(not started)</i>' : ''}` : '<i>next shift</i>'}<span class="t">${fmtTime(h.atMs)}</span></div>` +
      (h.carried.length ? `<div>Carried over:</div><ul>${h.carried.map(c => `<li class="${c.done ? 'done' : ''}">${esc(c.a.entityName || c.a.text)}${c.a.entityName ? ` · ${esc(c.a.text)}` : ''}${c.done ? ` <span class="t">done ${fmtTime(resolvedAt(c.a))}</span>` : ''}</li>`).join('')}</ul>` : '<div class="clear">Nothing open at handoff</div>') +
      h.said.map(s => `<div class="said">“${esc(s)}”</div>`).join('') + (h.text ? `<pre>${esc(h.text.slice(0, 700))}${h.text.length > 700 ? '…' : ''}</pre>` : '') + `</div></section>`);
  }
  // what happened
  const evHtml = (e: Ev) => {
    const open = alertsFor(e.eventId).some(a => openAt(a, ctx.clock)); const chg = changesTo(e.eventId);
    const url = state.photos.get(e.eventId); if (!url) loadPhoto(e.eventId);
    const isAck = !!e.note && /^briefing ack/i.test(e.note);
    const place = placeOf(e.eventId) || e.locationGuess;
    const fresh = !seen.has(e.eventId); seen.add(e.eventId);
    const pending = e.status !== 'in_graph' && !e.summary;
    return `<div class="ev${open ? ' alert' : ''}${chg.length ? ' change' : ''}${ctx.selected === e.eventId ? ' sel' : ''}${fresh ? ' arrive' : ''}" data-ev="${e.eventId}" style="--c:${wearerColor(e.deviceId)}"><span class="k"><i></i></span>${url ? `<img class="th" src="${url}" alt="">` : '<span class="th"></span>'}<div class="tx"><div class="t">${fmtTime(e.tMs)} · ${esc(wearerName(e.deviceId))}${e.source === 'shutter_button' ? ' · shutter' : ''}</div>` +
      (isAck ? `<p class="note">Briefing confirmed. ${esc(e.note!.replace(/^briefing ack:\s*/i, ''))}</p>` : `<p>${pending ? '<span class="place">Reading the photo…</span>' : esc(e.summary || e.scene || '')}</p>`) +
      (place && !isAck ? `<div class="place">${esc(place)}</div>` : '') + (e.note && !isAck ? `<p class="note">“${esc(e.note)}”</p>` : '') + chg.map(c => `<p class="chg">Changed: ${esc(c.text)}</p>`).join('') + `</div></div>`;
  };
  parts.push(`<section class="sec"><h3>What happened <span class="n">${snap.events.length}</span></h3><div class="feed">${snap.events.length ? snap.events.map(evHtml).join('') : '<div class="empty">No photos yet at this time.</div>'}</div></section>`);
  el.innerHTML = parts.join('');
  el.querySelectorAll<HTMLElement>('[data-ev]').forEach(n => n.addEventListener('click', () => ctx.onSelect(n.dataset.ev!)));
  el.querySelectorAll<HTMLElement>('[data-jump]').forEach(n => n.addEventListener('click', () => ctx.onJump(Number(n.dataset.jump))));
  return snap;
}
