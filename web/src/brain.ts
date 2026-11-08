// The shift's memory as of a moment in time, beside the map: issues raised and resolved, time
// spent, the handoff between shifts with what was carried over, and the photos in order.
// Everything is derived from the store (nothing is invented here); the clock is the replay's.
// Mirrors site3d/src/brain.ts, the standalone reference, over the console's store.
import { state, type Alert, type Ev, type Issue, type TrackPoint, wearerColor, wearerName, fmtTime, loadPhoto, alertsFor, placeOf, edgesFrom, props } from './store';
import { esc } from './timeline';
import { vocab, current } from './workspaces';
import { haversineM } from './site3d/geo';
import { overlayActive, badgeOf } from './overlay';

const ms = (micros: bigint) => Number(micros) / 1000;
export type Fix = { tMs: number; lat: number; lon: number; floor?: number; acc: number; gap: boolean /* no continuous tracking since the previous fix */ };
// The phone samples every 5 m or 30 s while a shift is live; two minutes without a fix means it lost
// location (deep indoors, pocketed, app killed). That stretch is drawn dashed and the dot waits.
export const GAP_MS = 120_000;
export type Shift = { key: string; deviceId: string; shiftId: string; startMs: number; endMs: number | null; lastMs: number; pts: TrackPoint[]; smooth: Fix[] };
export type HandoffCard = { atMs: number; from: Shift; to: Shift | null; carried: { a: Alert; done: boolean }[]; said: string[]; text?: string };
export type Snapshot = { shifts: Shift[]; active: Shift[]; latestIdle: Shift | null; open: Alert[]; resolved: Alert[]; raised: Alert[]; workOrders: Issue[]; events: Ev[]; handoff: HandoffCard | null };
const params = new URLSearchParams(location.search);
const SHIFT_PARAM = params.get('shift'); const ALL_SHIFTS = params.get('all') === '1';

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
    const points = pts.filter(p => p.kind === 'point');
    // a photo fix's own time is the server's; the photo's capture time is the honest one
    const times = [...points.map(p => ms(p.tMicros)), ...locs.map(l => ms(state.events.get(l.eventId)?.tMicros ?? l.tMicros))]; if (!times.length) continue;
    const end = pts.find(p => p.kind === 'shift_end');
    out.push({ key, deviceId, shiftId, startMs: Math.min(...times), endMs: end ? ms(end.tMicros) : null, lastMs: Math.max(...times), pts: points, smooth: filterTrack(points) });
  }
  out.sort((a, b) => a.startMs - b.startMs);
  shiftCache = { sig, shifts: out }; return out;
}
// The phone's fixes, made honest rather than pretty: a fix that implies a jump no walker makes
// (over 4 m/s and farther than its own accuracy) is dropped as GPS noise; the rest are averaged
// over ±6 s with each fix weighted by 1/accuracy², so a 4 m fix outweighs a 30 m one beside it.
// Timestamps are the phone's; nothing is resampled.
export function filterTrack(points: TrackPoint[]): Fix[] {
  const kept: TrackPoint[] = [];
  for (const p of points) {
    const prev = kept[kept.length - 1];
    if (prev) { const dt = (ms(p.tMicros) - ms(prev.tMicros)) / 1000; const d = haversineM(prev.lat, prev.lon, p.lat, p.lon); if (dt > 0 && d / dt > 4 && d > Math.max(p.accuracyM, prev.accuracyM, 10)) continue; }
    kept.push(p);
  }
  const W = 6000;
  return kept.map((p, i) => {
    let sw = 0, la = 0, lo = 0; const t = ms(p.tMicros);
    const add = (q: TrackPoint) => { const w = 1 / Math.max(3, q.accuracyM) ** 2; sw += w; la += w * q.lat; lo += w * q.lon; };
    for (let j = i; j >= 0 && t - ms(kept[j].tMicros) <= W; j--) add(kept[j]);
    for (let j = i + 1; j < kept.length && ms(kept[j].tMicros) - t <= W; j++) add(kept[j]);
    return { tMs: t, lat: la / sw, lon: lo / sw, floor: p.floor, acc: p.accuracyM, gap: i > 0 && t - ms(kept[i - 1].tMicros) > GAP_MS };
  });
}
/** The shifts in the console's wearer and time-window filters. */
function filteredShifts(withHidden = false): Shift[] {
  const cutoff = state.windowMin ? Date.now() - state.windowMin * 60_000 : 0;
  return shifts().filter(s => (withHidden || !state.hiddenWearers.has(s.deviceId)) && s.lastMs >= cutoff);
}
/** The shifts this view is about: `?shift=<id prefix>` or `?all=1`, else the latest real shift (two
 *  minutes or more of track), preferring one whose fixes carry a floor. Older shifts stay in the
 *  database and out of the way. */
export function sessionShifts(withHidden = false): Shift[] {
  const all = filteredShifts(withHidden);
  if (ALL_SHIFTS || overlayActive()) return all; // a workspace with an overlay is about the whole record
  if (SHIFT_PARAM) return all.filter(s => s.shiftId.startsWith(SHIFT_PARAM));
  const wsShift = current().shift; if (wsShift) { const own = all.filter(s => s.shiftId.startsWith(wsShift)); if (own.length) return own; }
  const real = all.filter(s => s.lastMs - s.startMs >= 120_000 && s.smooth.length >= 5);
  const withFloor = real.filter(s => s.pts.some(p => p.floor !== undefined));
  const pool = withFloor.length ? withFloor : real.length ? real : all;
  // the shift being viewed plus the ones it chains from: shifts that overlap it or ended within
  // two hours before it (a handoff), so worker 1's photos and the issues they raised stay in view
  if (!pool.length) return [];
  const chain = [pool[pool.length - 1]];
  for (let i = pool.length - 2; i >= 0; i--) if (shiftEnd(pool[i]) >= chain[0].startMs - 2 * 3600_000) chain.unshift(pool[i]);
  return chain;
}
/** A photo belongs to the session when a tracked shift of its wearer covers it (or its fix names the shift). */
export function inSession(e: Ev, all: Shift[] = sessionShifts()): boolean {
  if (overlayActive()) return true; // the overlay is the session
  const loc = state.locations.get(e.eventId);
  if (loc && all.some(s => s.shiftId === loc.shiftId && s.deviceId === loc.deviceId)) return true;
  const t = ms(e.tMicros);
  return all.some(s => s.deviceId === e.deviceId && t >= s.startMs - 120_000 && t <= shiftEnd(s) + 120_000);
}
/** The replay covers the tracked shift: from just before the first fix to the moment the shift
 *  actually ended (its shift_end row, or ten minutes after its last fix); while a shift is still
 *  live it runs to now. Null when there is no tracked shift. */
export function sessionRange(): [number, number] | null {
  const all = sessionShifts(); const now = Date.now();
  if (!all.length) return null;
  const t0 = Math.min(...all.map(s => s.startMs)) - 5_000;
  const over = all.every(s => !shiftLive(s, now));
  return [t0, over ? Math.max(...all.map(shiftEnd)) + 10_000 : now];
}
export function shiftLive(s: Shift, clock: number) { return clock >= s.startMs && (s.endMs !== null ? clock <= s.endMs + 60_000 : clock <= s.lastMs + TEN_MIN); }
export function shiftEnd(s: Shift) { return s.endMs ?? s.lastMs; }
// Alert and work-order rows carry server time; the photo that raised or resolved them carries
// capture time, which is the honest clock for a replayed shift. Prefer the photo's.
/** Who resolved an alert: the wearer of the resolving photo (resolution row, else the photo nearest that moment), else the raiser. */
export function resolverName(a: Alert): string {
  const r = [...state.resolutions.values()].find(x => x.alertId === a.id); if (r?.deviceId) return wearerName(r.deviceId);
  const at = resolvedAt(a); let best: Ev | undefined; let bd = 3 * 60_000;
  for (const e of state.events.values()) { const d = Math.abs(ms(e.tMicros) - at); if (d < bd) { bd = d; best = e; } }
  return best ? wearerName(best.deviceId) : a.wearerName || wearerName(a.deviceId);
}
export function raisedAt(a: Alert) { const e = state.events.get(a.eventId); return e ? ms(e.tMicros) : ms(a.tMicros); }
export function resolvedAt(a: Alert) {
  if (!a.acked) return Infinity;
  const res = [...state.resolutions.values()].find(r => r.alertId === a.id); const e = res ? state.events.get(res.eventId) : undefined;
  if (e) return ms(e.tMicros);
  return a.ackedMicros !== undefined ? ms(a.ackedMicros) : raisedAt(a);
}
export function openAt(a: Alert, clock: number) { return raisedAt(a) <= clock && resolvedAt(a) > clock; }
function woResolvedAt(i: Issue) { const e = i.resolvedEventId ? state.events.get(i.resolvedEventId) : undefined; return e ? ms(e.tMicros) : i.resolvedMicros !== undefined ? ms(i.resolvedMicros) : (i.status === 'resolved' ? -Infinity : Infinity); }

/** Where a wearer is at `clock`, interpolated along the smoothed track; null before the first fix or once the shift is over. */
export function positionAt(s: Shift, clock: number): { lat: number; lon: number; floor?: number; acc: number; i: number } | null {
  const p = s.smooth; if (!p.length || clock < p[0].tMs || !shiftLive(s, clock)) return null;
  let i = p.length - 1; for (let k = 0; k < p.length; k++) if (p[k].tMs > clock) { i = k - 1; break; }
  if (i < 0) return null;
  const a = p[i], b = p[i + 1];
  // between two fixes the dot moves at constant speed; across a gap of over two minutes it waits
  if (!b || b.gap) return { lat: a.lat, lon: a.lon, floor: a.floor, acc: a.acc, i };
  const f = (clock - a.tMs) / (b.tMs - a.tMs);
  return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f, floor: f < 0.5 ? a.floor : b.floor, acc: a.acc + (b.acc - a.acc) * f, i };
}
export function snapshot(clock: number): Snapshot {
  const all = sessionShifts();
  const active = all.filter(s => shiftLive(s, clock));
  const past = all.filter(s => shiftEnd(s) < clock);
  const latestIdle = active.length ? null : (past.length ? past.reduce((a, b) => (shiftEnd(b) > shiftEnd(a) ? b : a)) : null);
  const cutoff = state.windowMin ? Date.now() - state.windowMin * 60_000 : 0;
  // only what this session's photos raised or touched: a database also holds test photos and seeded
  // work orders from other demos (HackUTD 2026 had Gary's rack test and the data-center work orders)
  const scoped = all.length > 0 && !overlayActive(); // no tracked walk (or the weekend overlay): show everything, as before
  const inScope = (eventId: string | undefined) => { if (!scoped) return true; const e = eventId ? state.events.get(eventId) : undefined; return !!e && inSession(e, all); };
  const alerts = [...state.alerts.values()].filter(a => !state.hiddenWearers.has(a.deviceId) && raisedAt(a) >= cutoff && inScope(a.eventId));
  const raised = alerts.filter(a => raisedAt(a) <= clock).sort((a, b) => raisedAt(b) - raisedAt(a));
  const open = raised.filter(a => openAt(a, clock));
  const resolved = raised.filter(a => resolvedAt(a) <= clock).sort((a, b) => resolvedAt(b) - resolvedAt(a));
  const sessionIds = new Set([...state.events.values()].filter(e => inSession(e, all)).map(e => e.eventId));
  const touched = new Set(state.edges.filter(x => sessionIds.has(x.fromId)).map(x => x.toId));
  const range = all.length ? [Math.min(...all.map(s => s.startMs)), Math.max(...all.map(shiftEnd))] : null;
  const woInScope = (i: Issue) => !scoped || touched.has(slug(i.assetId)) || (!!i.resolvedEventId && sessionIds.has(i.resolvedEventId)) || (!!range && ms(i.openedMicros) >= range[0] && ms(i.openedMicros) <= range[1]);
  const workOrders = [...state.issues.values()].filter(i => ms(i.openedMicros) <= clock && woInScope(i)).sort((a, b) => ms(b.openedMicros) - ms(a.openedMicros));
  const events = [...state.events.values()].filter(e => ms(e.tMicros) <= clock && inSession(e, all)).sort((a, b) => ms(a.tMicros) - ms(b.tMicros)).slice(-200);
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
  return { shifts: all, active, latestIdle, open, resolved, raised, workOrders, events, handoff };
}

// ---------- render ----------
/** The module's entity id for a registry asset (module/spacetimedb/src/rules.ts slug). */
const slug = (name: string) => name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const seen = new Set<string>(); let lastSig = ''; let lastCur = ''; let userScrollAt = 0;
/** Empty the panel and force the next renderBrain to redraw (its change check would otherwise skip). */
export function resetBrain(el: HTMLElement, stats?: HTMLElement) { el.innerHTML = ''; if (stats) stats.innerHTML = ''; lastSig = ''; lastCur = ''; }
function watchScroll(el: HTMLElement) { if ((el as any).__watched) return; (el as any).__watched = true; for (const ev of ['wheel', 'touchmove', 'pointerdown']) el.addEventListener(ev, () => { userScrollAt = performance.now(); }, { passive: true }); }
export type BrainCtx = { clock: number; stats: HTMLElement | null; locate: (lat: number, lon: number) => string | undefined; onSelect: (id: string) => void; onJump: (ms: number) => void };
const fmt = (t: number) => fmtTime(BigInt(Math.round(t)) * 1000n);
export function fmtSpan(ms: number): string { const m = Math.max(0, Math.round(ms / 60_000)); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} min`; }

/** The panel is rebuilt only when its content changes (a photo reached, an issue raised or
 *  resolved, a thumbnail loaded); the clock-driven numbers are updated in place so the feed
 *  never flickers while the replay runs. */
export function renderBrain(el: HTMLElement, ctx: BrainCtx): Snapshot {
  const snap = snapshot(ctx.clock); const v = vocab(); const session = v.session.toLowerCase();
  const focus = snap.active[0] ?? snap.latestIdle;
  const woDone = (i: Issue) => woResolvedAt(i) <= ctx.clock;
  const raisedN = snap.raised.length + snap.workOrders.length; const resolvedN = snap.resolved.length + snap.workOrders.filter(woDone).length;
  const openN = snap.open.length + snap.workOrders.filter(i => !woDone(i)).length;
  const spent = focus ? Math.min(ctx.clock, shiftEnd(focus)) - focus.startMs : 0;
  const sig = [state.events.size, state.alerts.size, state.issues.size, state.track.size, focus?.key, snap.raised.map(a => a.id).join(','), snap.resolved.map(a => a.id).join(','), snap.workOrders.map(w => w.issueId + woDone(w)).join(','), snap.events.length, snap.events[0]?.eventId, snap.handoff?.atMs, snap.handoff?.carried.filter(c => c.done).length, state.selected, state.photos.size, state.hiddenWearers.size, v.session, state.badges.size].join('|');
  if (sig !== lastSig) {
    lastSig = sig;
    // the three numbers that matter stay pinned above the scrolling feed
    if (ctx.stats) {
      ctx.stats.innerHTML = `<div class="stats"><div class="stat raised"><i></i><b>${raisedN}</b><span>${esc(v.flags.toLowerCase())} raised</span></div><div class="stat resolved"><i></i><b>${resolvedN}</b><span>resolved</span></div><div class="stat time"><b data-st-time>${fmtSpan(spent)}</b><span>time spent</span></div></div>`;
      const last = snap.raised[0]; ctx.stats.querySelector('.stat.raised')?.addEventListener('click', () => { if (last) ctx.onJump(raisedAt(last)); });
      ctx.stats.querySelector('.stat.resolved')?.addEventListener('click', () => { if (snap.resolved[0]) ctx.onJump(resolvedAt(snap.resolved[0])); });
    }
    const parts: string[] = [];
    // issues: open first, then resolved, newest first
    const issue = (a: Alert) => { const done = resolvedAt(a) <= ctx.clock; return `<div class="issue${done ? ' done' : ''}" data-jump="${done ? resolvedAt(a) : raisedAt(a)}"><i class="ic"></i><div class="tx"><b>${esc(a.assetName || a.text)}</b>${a.assetName ? `<span class="what"> · ${esc(a.text)}</span>` : ''}<div class="m">${done ? `resolved ${fmt(resolvedAt(a))}` : `open since ${fmt(raisedAt(a))}`} · ${esc(done ? resolverName(a) : a.wearerName || wearerName(a.deviceId))}</div></div></div>`; };
    const wo = (i: Issue) => { const done = woDone(i); return `<div class="issue wo${done ? ' done' : i.status === 'in_progress' ? ' prog' : ''}" data-jump="${done ? woResolvedAt(i) : ms(i.openedMicros)}"><i class="ic"></i><div class="tx"><b>${esc(i.title)}</b>${i.assetId ? `<span class="what"> · ${esc(state.assets.get(i.assetId)?.name || i.assetId)}</span>` : ''}<div class="m">${done ? `resolved ${fmt(woResolvedAt(i))}` : `${i.status === 'in_progress' ? 'in progress' : 'open'} since ${fmt(ms(i.openedMicros))}`} · work order ${esc(i.issueId)}</div></div></div>`; };
    const openWo = snap.workOrders.filter(i => !woDone(i)), doneWo = snap.workOrders.filter(woDone);
    parts.push(`<section class="sec"><h3>${esc(v.flags)} <span class="n">${openN} open</span></h3>${raisedN ? snap.open.map(issue).join('') + openWo.map(wo).join('') + snap.resolved.map(issue).join('') + doneWo.map(wo).join('') : '<div class="s3-empty">None raised yet.</div>'}</section>`);
    // handoff, one card
    if (snap.handoff) {
      const h = snap.handoff;
      parts.push(`<section class="sec"><h3>Handoff</h3><div class="hand" data-jump="${h.atMs}"><div class="arrow"><span style="color:${wearerColor(h.from.deviceId)}">●</span> ${esc(wearerName(h.from.deviceId))} <i>→</i> ${h.to ? `<span style="color:${wearerColor(h.to.deviceId)}">●</span> ${esc(wearerName(h.to.deviceId))}` : `<i>next ${esc(session)}</i>`}<span class="t">${fmt(h.atMs)}</span></div>` +
        (h.carried.length ? `<ul>${h.carried.map(c => `<li class="${c.done ? 'done' : ''}">${esc(c.a.assetName || c.a.text)}${c.a.assetName ? ` · ${esc(c.a.text)}` : ''}</li>`).join('')}</ul>` : '<div class="clear">Nothing carried over</div>') +
        h.said.map(s => `<div class="said">“${esc(s)}”</div>`).join('') + `</div></section>`);
    }
    // issues and the handoff stay pinned under the numbers; only the photo feed scrolls away
    if (ctx.stats) { const pinned = document.createElement('div'); pinned.className = 'pinned'; pinned.innerHTML = parts.splice(0).join(''); ctx.stats.appendChild(pinned); pinned.querySelectorAll<HTMLElement>('[data-jump]').forEach(n => n.addEventListener('click', e => { e.stopPropagation(); if (n.dataset.jump) ctx.onJump(Number(n.dataset.jump)); })); }
    // photos, oldest first; the current one is marked and scrolled into view
    const curId = snap.events.length ? snap.events[snap.events.length - 1].eventId : '';
    const evHtml = (e: Ev) => {
      const open = alertsFor(e).some(a => openAt(a, ctx.clock));
      const chg = edgesFrom(e.eventId, 'CHANGES').map(x => props(x)).map(p => `${p.attr && !/^(status|state|description)$/i.test(String(p.attr)) ? String(p.attr).replace(/_/g, ' ') + ': ' : ''}${p.from ?? ''} → ${p.to ?? ''}`);
      const url = state.photos.get(e.eventId); if (!url) loadPhoto(e.eventId);
      const isAck = !!e.note && /^briefing ack/i.test(e.note);
      const place = placeOf(e.eventId)?.canonicalName || e.locationGuess;
      const fresh = !seen.has(e.eventId); seen.add(e.eventId);
      const pending = !(e.summary && e.confidence > 0);
      const badge = badgeOf(e.eventId);
      return `<div class="ev${open ? ' alert' : ''}${chg.length ? ' change' : ''}${state.selected === e.eventId ? ' sel' : ''}${fresh ? ' arrive' : ''}${e.eventId === curId ? ' cur' : ''}${badge ? ' badged' : ''}" data-ev="${e.eventId}" style="--c:${wearerColor(e.deviceId)}"><span class="k"><i></i></span>${url ? `<img class="th" src="${url}" alt="">` : '<span class="th"></span>'}<div class="tx"><div class="t">${fmt(ms(e.tMicros))}${place && !isAck ? ` · ${esc(place)}` : ''}</div>` +
        (badge ? `<p class="badge"><span class="crown" aria-hidden="true">★</span>${esc(badge)}</p>` : '') +
        (isAck ? `<p class="note">Briefing confirmed. ${esc(e.note!.replace(/^briefing ack:\s*/i, ''))}</p>` : `<p>${pending ? `<span class="pending">${e.status === 'failed' ? 'This photo could not be read.' : 'Reading the photo…'}</span>` : esc(e.summary)}</p>`) +
        (e.note && !isAck ? `<p class="note">“${esc(e.note)}”</p>` : '') + chg.map(c => `<p class="chg">Changed: ${esc(String(c))}</p>`).join('') + `</div></div>`;
    };
    parts.push(`<section class="sec"><h3>Photos <span class="n">${snap.events.length}</span></h3><div class="feed">${snap.events.length ? snap.events.map(evHtml).join('') : '<div class="s3-empty">No photos yet at this time.</div>'}</div></section>`);
    watchScroll(el);
    const top = el.scrollTop; el.innerHTML = parts.join(''); el.scrollTop = top;
    if (curId && curId !== lastCur) { lastCur = curId; if (performance.now() - userScrollAt > 6000) { const c = el.querySelector('.ev.cur') as HTMLElement | null; if (c) el.scrollTo({ top: Math.max(0, c.offsetTop - el.clientHeight / 2), behavior: 'auto' }); } /* instant, on the panel itself: a smooth scrollIntoView left the body blank when the feed was rebuilt mid-animation */ }
    el.querySelectorAll<HTMLElement>('[data-ev]').forEach(n => n.addEventListener('click', () => ctx.onSelect(n.dataset.ev!)));
    el.querySelectorAll<HTMLElement>('[data-jump]').forEach(n => n.addEventListener('click', e => { e.stopPropagation(); if (n.dataset.jump) ctx.onJump(Number(n.dataset.jump)); }));
  } else {
    const t = ctx.stats?.querySelector('[data-st-time]'); if (t) t.textContent = fmtSpan(spent);
  }
  return snap;
}
