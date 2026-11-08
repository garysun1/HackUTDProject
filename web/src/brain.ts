// The shift's memory as of a moment in time, beside the map: who is on the floor and in which
// room, what needs attention (open alerts and work orders), the handoff between shifts with what
// was carried over, and what happened in order. Everything is derived from the store (nothing is
// invented here); the clock is the replay's.
import { state, type Alert, type Ev, type Issue, type TrackPoint, wearerColor, wearerName, fmtTime, loadPhoto, alertsFor, placeOf, edgesFrom, props } from './store';
import { esc } from './timeline';
import { vocab } from './workspaces';
import { haversineM } from './site3d/geo';

const ms = (micros: bigint) => Number(micros) / 1000;
export type Shift = { key: string; deviceId: string; shiftId: string; startMs: number; endMs: number | null; lastMs: number; pts: TrackPoint[]; smooth: { tMs: number; lat: number; lon: number; floor?: number }[] };
export type HandoffCard = { atMs: number; from: Shift; to: Shift | null; carried: { a: Alert; done: boolean }[]; said: string[]; text?: string };
export type Snapshot = { shifts: Shift[]; active: Shift[]; latestIdle: Shift | null; open: Alert[]; resolvedRecently: Alert[]; workOrders: Issue[]; events: Ev[]; handoff: HandoffCard | null };

const TEN_MIN = 10 * 60_000;
let shiftCache: { sig: string; shifts: Shift[] } | null = null;
export function shifts(): Shift[] {
  const sig = `${state.track.size}|${state.locations.size}|${state.events.size}|${[...state.track.keys()].slice(-1)[0] ?? ''}`;
  if (shiftCache && shiftCache.sig === sig) return shiftCache.shifts;
  const by = new Map<string, TrackPoint[]>();
  for (const p of state.track.values()) { const k = `${p.deviceId}|${p.shiftId}`; (by.get(k) ?? by.set(k, []).get(k)!).push(p); }
  for (const l of state.locations.values()) { const k = `${l.deviceId}|${l.shiftId}`; if (!by.has(k)) by.set(k, []); }
  const out: Shift[] = [];
  for (const [key, pts] of by) {
    const [deviceId, shiftId] = key.split('|'); pts.sort((a, b) => (a.tMicros < b.tMicros ? -1 : 1));
    const locs = [...state.locations.values()].filter(l => l.deviceId === deviceId && l.shiftId === shiftId);
    const points = pts.filter(p => p.kind === 'point' && p.accuracyM <= 40);
    // a photo fix's own time is the server's; the photo's capture time is the honest one
    const times = [...points.map(p => ms(p.tMicros)), ...locs.map(l => ms(state.events.get(l.eventId)?.tMicros ?? l.tMicros))]; if (!times.length) continue;
    const end = pts.find(p => p.kind === 'shift_end');
    const smooth = points.map((p, i) => { const w = points.slice(Math.max(0, i - 2), Math.min(points.length, i + 3)); return { tMs: ms(p.tMicros), lat: w.reduce((s, q) => s + q.lat, 0) / w.length, lon: w.reduce((s, q) => s + q.lon, 0) / w.length, floor: p.floor }; });
    out.push({ key, deviceId, shiftId, startMs: Math.min(...times), endMs: end ? ms(end.tMicros) : null, lastMs: Math.max(...times), pts: points, smooth });
  }
  out.sort((a, b) => a.startMs - b.startMs);
  shiftCache = { sig, shifts: out }; return out;
}
export function shiftLive(s: Shift, clock: number) { return clock >= s.startMs && (s.endMs !== null ? clock <= s.endMs + 60_000 : clock <= s.lastMs + TEN_MIN); }
export function shiftEnd(s: Shift) { return s.endMs ?? s.lastMs; }
// Alert and work-order rows carry server time; the photo that raised or resolved them carries
// capture time, which is the honest clock for a replayed shift. Prefer the photo's.
export function raisedAt(a: Alert) { const e = state.events.get(a.eventId); return e ? ms(e.tMicros) : ms(a.tMicros); }
export function resolvedAt(a: Alert) {
  if (!a.acked) return Infinity;
  const res = [...state.resolutions.values()].find(r => r.alertId === a.id); const e = res ? state.events.get(res.eventId) : undefined;
  if (e) return ms(e.tMicros);
  return a.ackedMicros !== undefined ? ms(a.ackedMicros) : raisedAt(a);
}
export function openAt(a: Alert, clock: number) { return raisedAt(a) <= clock && resolvedAt(a) > clock; }
function woResolvedAt(i: Issue) { const e = i.resolvedEventId ? state.events.get(i.resolvedEventId) : undefined; return e ? ms(e.tMicros) : i.resolvedMicros !== undefined ? ms(i.resolvedMicros) : (i.status === 'resolved' ? -Infinity : Infinity); }
function woOpenAt(i: Issue, clock: number) { return ms(i.openedMicros) <= clock && woResolvedAt(i) > clock; }

/** Where a wearer is at `clock`, interpolated along the smoothed track; null before the first fix or once the shift is over. */
export function positionAt(s: Shift, clock: number): { lat: number; lon: number; floor?: number; i: number } | null {
  const p = s.smooth; if (!p.length || clock < p[0].tMs || !shiftLive(s, clock)) return null;
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
  const cutoff = state.windowMin ? Date.now() - state.windowMin * 60_000 : 0;
  const all = shifts().filter(s => !state.hiddenWearers.has(s.deviceId) && s.lastMs >= cutoff);
  const active = all.filter(s => shiftLive(s, clock));
  const past = all.filter(s => shiftEnd(s) < clock);
  const latestIdle = active.length ? null : (past.length ? past.reduce((a, b) => (shiftEnd(b) > shiftEnd(a) ? b : a)) : null);
  const alerts = [...state.alerts.values()].filter(a => !state.hiddenWearers.has(a.deviceId) && raisedAt(a) >= cutoff);
  const open = alerts.filter(a => openAt(a, clock)).sort((a, b) => raisedAt(b) - raisedAt(a));
  const resolvedRecently = alerts.filter(a => raisedAt(a) <= clock && resolvedAt(a) <= clock).sort((a, b) => resolvedAt(b) - resolvedAt(a)).slice(0, 3);
  const workOrders = [...state.issues.values()].filter(i => woOpenAt(i, clock)).sort((a, b) => ms(b.openedMicros) - ms(a.openedMicros));
  const events = [...state.events.values()].filter(e => ms(e.tMicros) <= clock && ms(e.tMicros) >= cutoff && !state.hiddenWearers.has(e.deviceId)).sort((a, b) => ms(b.tMicros) - ms(a.tMicros)).slice(0, 60);
  let handoff: HandoffCard | null = null;
  for (let i = all.length - 1; i >= 0; i--) {
    const from = all[i]; const at = shiftEnd(from);
    if (at > clock || shiftLive(from, clock)) continue;
    const to = all.find(s => s !== from && s.startMs >= at - 5 * 60_000) ?? null;
    if (!to && clock - at > 6 * 3600_000) break;
    const carried = alerts.filter(a => openAt(a, at)).map(a => ({ a, done: resolvedAt(a) <= clock }));
    const said = [...state.events.values()].filter(e => e.deviceId === from.deviceId && ms(e.tMicros) >= from.startMs && ms(e.tMicros) <= at + 60_000 && e.note && /^handoff:/i.test(e.note)).map(e => e.note!.replace(/^handoff:\s*/i, ''));
    const row = [...state.handoffs].reverse().find(h => ms(h.generatedMicros) <= clock && Math.abs(ms(h.generatedMicros) - at) < 2 * 3600_000);
    handoff = { atMs: at, from, to, carried, said, text: row?.text }; break;
  }
  return { shifts: all, active, latestIdle, open, resolvedRecently, workOrders, events, handoff };
}

// ---------- render ----------
const seen = new Set<string>(); let lastSig = '';
export type BrainCtx = { clock: number; locate: (lat: number, lon: number, floor?: number | null) => string | undefined; onSelect: (id: string) => void; onJump: (ms: number) => void };
const fmt = (t: number) => fmtTime(BigInt(Math.round(t)) * 1000n);

export function renderBrain(el: HTMLElement, ctx: BrainCtx): Snapshot {
  const snap = snapshot(ctx.clock); const v = vocab(); const session = v.session.toLowerCase();
  const sig = [state.events.size, state.alerts.size, state.issues.size, state.track.size, snap.active.map(s => s.key).join(','), snap.open.map(a => a.id).join(','), snap.workOrders.map(w => w.issueId + w.status).join(','), snap.events.length, snap.events[0]?.eventId, snap.handoff?.atMs, snap.handoff?.carried.filter(c => c.done).length, Math.floor(performance.now() / 2000), state.selected, state.photos.size, state.hiddenWearers.size, v.session].join('|');
  if (sig === lastSig) return snap; lastSig = sig;
  const parts: string[] = [];
  const who = (s: Shift, live: boolean) => {
    const pos = positionAt(s, ctx.clock); const where = pos ? (ctx.locate(pos.lat, pos.lon, pos.floor) ?? 'on site') : (live ? 'no fix yet' : `last seen ${fmt(s.lastMs)}`);
    const since = live ? `on ${session} since ${fmt(s.startMs)}` : `${session} ${fmt(s.startMs)}–${fmt(shiftEnd(s))}`;
    return `<div class="who${live ? '' : ' idle'}" style="--c:${wearerColor(s.deviceId)}"><i class="sw"></i><div><b>${esc(wearerName(s.deviceId))}</b><br><span>${since}</span></div><span class="where">${esc(where)}</span></div>`;
  };
  const focus = snap.active[0] ?? snap.latestIdle;
  parts.push(`<section class="sec"><h3>On the floor</h3>${snap.active.length ? snap.active.map(s => who(s, true)).join('') : snap.latestIdle ? who(snap.latestIdle, false) : `<div class="s3-empty">No one on ${esc(session)} yet.</div>`}`);
  if (focus) {
    const photos = [...state.events.values()].filter(e => e.deviceId === focus.deviceId && ms(e.tMicros) >= focus.startMs && ms(e.tMicros) <= Math.min(ctx.clock, shiftEnd(focus) + 60_000)).length;
    const mins = Math.max(0, Math.round((Math.min(ctx.clock, shiftEnd(focus)) - focus.startMs) / 60_000));
    const openN = snap.open.length + snap.workOrders.length;
    parts.push(`<div class="now"><div class="stat"><b>${photos}</b><span>photo${photos === 1 ? '' : 's'} this ${esc(session)}</span></div><div class="stat"><b>${Math.round(walkedM(focus, ctx.clock))} m</b><span>walked</span></div><div class="stat"><b>${mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins} min`}</b><span>on ${esc(session)}</span></div><div class="stat"><b>${openN}</b><span>open ${esc(openN === 1 ? v.flag.toLowerCase() : v.flags.toLowerCase())}</span></div></div>`);
  }
  parts.push('</section>');
  const issue = (a: Alert, done: boolean) => `<div class="issue${done ? ' done' : ''}" data-jump="${raisedAt(a)}"><span class="ic">${done ? '✓' : '!'}</span><div><b>${esc(a.assetName || a.text)}</b>${a.assetName ? ` · ${esc(a.text)}` : ''}<div class="m">${done ? `resolved ${fmt(resolvedAt(a))} · ` : ''}seen by ${esc(a.wearerName || wearerName(a.deviceId))} at ${fmt(raisedAt(a))}</div></div></div>`;
  const wo = (i: Issue) => `<div class="issue wo${i.status === 'in_progress' ? ' prog' : ''}" data-jump="${ms(i.openedMicros)}"><span class="ic">${i.status === 'in_progress' ? '…' : '○'}</span><div><b>${esc(i.title)}</b>${i.assetId ? ` · ${esc(state.assets.get(i.assetId)?.name || i.assetId)}` : ''}<div class="m">work order ${esc(i.issueId)} · ${i.status === 'in_progress' ? 'in progress' : 'open'} since ${fmt(ms(i.openedMicros))}</div></div></div>`;
  parts.push(`<section class="sec"><h3>Needs attention <span class="n">${snap.open.length + snap.workOrders.length}</span></h3>${snap.open.length || snap.workOrders.length ? snap.open.map(a => issue(a, false)).join('') + snap.workOrders.map(wo).join('') : '<div class="clear">All clear on the floor</div>'}${snap.resolvedRecently.map(a => issue(a, true)).join('')}</section>`);
  if (snap.handoff) {
    const h = snap.handoff;
    parts.push(`<section class="sec"><h3>Handoff</h3><div class="hand" data-jump="${h.atMs}"><div class="arrow"><span style="color:${wearerColor(h.from.deviceId)}">●</span> ${esc(wearerName(h.from.deviceId))} <i>→</i> ${h.to ? `<span style="color:${wearerColor(h.to.deviceId)}">●</span> ${esc(wearerName(h.to.deviceId))}${h.to.startMs > ctx.clock ? ' <i>(not started)</i>' : ''}` : `<i>next ${esc(session)}</i>`}<span class="t">${fmt(h.atMs)}</span></div>` +
      (h.carried.length ? `<div>Carried over:</div><ul>${h.carried.map(c => `<li class="${c.done ? 'done' : ''}">${esc(c.a.assetName || c.a.text)}${c.a.assetName ? ` · ${esc(c.a.text)}` : ''}${c.done ? ` <span class="t">done ${fmt(resolvedAt(c.a))}</span>` : ''}</li>`).join('')}</ul>` : '<div class="clear">Nothing open at handoff</div>') +
      h.said.map(s => `<div class="said">“${esc(s)}”</div>`).join('') + (h.text ? `<pre>${esc(h.text.slice(0, 700))}${h.text.length > 700 ? '…' : ''}</pre>` : '') + `</div></section>`);
  }
  const evHtml = (e: Ev) => {
    const open = alertsFor(e).some(a => openAt(a, ctx.clock));
    const chg = edgesFrom(e.eventId, 'CHANGES').map(x => props(x)).map(p => `${p.attr && !/^(status|state|description)$/i.test(String(p.attr)) ? String(p.attr).replace(/_/g, ' ') + ': ' : ''}${p.from ?? ''} → ${p.to ?? ''}`);
    const url = state.photos.get(e.eventId); if (!url) loadPhoto(e.eventId);
    const isAck = !!e.note && /^briefing ack/i.test(e.note);
    const place = placeOf(e.eventId)?.canonicalName || e.locationGuess;
    const fresh = !seen.has(e.eventId); seen.add(e.eventId);
    const pending = !(e.summary && e.confidence > 0);
    return `<div class="ev${open ? ' alert' : ''}${chg.length ? ' change' : ''}${state.selected === e.eventId ? ' sel' : ''}${fresh ? ' arrive' : ''}" data-ev="${e.eventId}" style="--c:${wearerColor(e.deviceId)}"><span class="k"><i></i></span>${url ? `<img class="th" src="${url}" alt="">` : '<span class="th"></span>'}<div class="tx"><div class="t">${fmt(ms(e.tMicros))} · ${esc(wearerName(e.deviceId))}${e.source === 'shutter_button' ? ' · shutter' : ''}</div>` +
      (isAck ? `<p class="note">Briefing confirmed. ${esc(e.note!.replace(/^briefing ack:\s*/i, ''))}</p>` : `<p>${pending ? `<span class="place">${e.status === 'failed' ? 'This photo could not be read.' : 'Reading the photo…'}</span>` : esc(e.summary)}</p>`) +
      (place && !isAck ? `<div class="place">${esc(place)}</div>` : '') + (e.note && !isAck ? `<p class="note">“${esc(e.note)}”</p>` : '') + chg.map(c => `<p class="chg">Changed: ${esc(String(c))}</p>`).join('') + `</div></div>`;
  };
  parts.push(`<section class="sec"><h3>What happened <span class="n">${snap.events.length}</span></h3><div class="feed">${snap.events.length ? snap.events.map(evHtml).join('') : '<div class="s3-empty">No photos yet at this time.</div>'}</div></section>`);
  const top = el.scrollTop; el.innerHTML = parts.join(''); el.scrollTop = top;
  el.querySelectorAll<HTMLElement>('[data-ev]').forEach(n => n.addEventListener('click', () => ctx.onSelect(n.dataset.ev!)));
  el.querySelectorAll<HTMLElement>('[data-jump]').forEach(n => n.addEventListener('click', () => ctx.onJump(Number(n.dataset.jump))));
  return snap;
}
