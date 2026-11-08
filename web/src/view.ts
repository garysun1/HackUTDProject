// View state shared by the map, the shift line and the header tools: which view is up, the replay
// clock, and an optional scope (a set of photos the shift line is narrowed to). Separate from the
// store so a replay tick re-renders the canvases without rebuilding the timeline DOM.
//
// Replay is time-based (issue #26): a clock runs from the start of the shift's track at 1–300×
// real time, and both views draw what existed at that moment; reaching "now" returns to live.
import { state, visibleEvents, type Ev } from './store';

export type Mode = 'map' | 'graph';
export const view = {
  mode: 'graph' as Mode,
  modeChosen: false, // the user picked a mode; stop auto-switching to the map when positions appear
  replay: { on: false, playing: false, start: 0, progress: 1, speed: 300, clockMs: 0 },
  scope: null as Set<string> | null, // shift line narrowed to these events
  scopeLabel: '',
};
try { const m = localStorage.getItem('wm.mode'); if (m === 'map' || m === 'graph' || m === 'site') { view.mode = m === 'site' ? 'map' : m; view.modeChosen = true; } } catch { /* private mode */ }

type Fn = () => void; const listeners = new Set<Fn>();
export function onView(fn: Fn) { listeners.add(fn); }
export function emitView() { for (const l of listeners) l(); }

export function setMode(m: Mode, byUser = true) {
  if (view.mode === m) return; view.mode = m; if (byUser) { view.modeChosen = true; try { localStorage.setItem('wm.mode', m); } catch { /* ignore */ } }
  if (m === 'graph') view.scope = null;
  emitView();
}
export function setScope(ids: Set<string> | null, label = '') { view.scope = ids; view.scopeLabel = label; emitView(); }

// ---------- replay clock ----------
/** The span a replay covers: a minute before the first track point or photo in the window, to now. */
export function replayRange(): [number, number] {
  let lo = Infinity, hi = -Infinity;
  const cutoff = state.windowMin ? BigInt(Date.now() - state.windowMin * 60_000) * 1000n : 0n;
  for (const p of state.track.values()) { if (p.tMicros < cutoff || state.hiddenWearers.has(p.deviceId)) continue; const ms = Number(p.tMicros) / 1000; if (ms < lo) lo = ms; if (ms > hi) hi = ms; }
  for (const e of windowEvents()) { const ms = Number(e.tMicros) / 1000; if (ms < lo) lo = ms; if (ms > hi) hi = ms; }
  const now = Date.now();
  if (!Number.isFinite(lo)) return [now - 3_600_000, now];
  return [lo - 60_000, Math.max(now, hi)];
}
/** The moment the views draw: the replay clock, or now. */
export function clock(): number { return view.replay.on ? view.replay.clockMs : Date.now(); }

let raf = 0; let lastTick = 0;
export function startReplay() {
  const [t0] = replayRange();
  view.replay.on = true; view.replay.playing = true; view.replay.start = performance.now(); view.replay.clockMs = t0; view.replay.progress = 0;
  lastTick = performance.now(); if (!raf) raf = requestAnimationFrame(tick); emitView();
}
export function stopReplay() { view.replay.on = false; view.replay.playing = false; view.replay.progress = 1; emitView(); }
export function togglePlay() {
  if (!view.replay.on) { startReplay(); return; }
  view.replay.playing = !view.replay.playing; lastTick = performance.now(); if (view.replay.playing && !raf) raf = requestAnimationFrame(tick); emitView();
}
export function setSpeed(s: number) { view.replay.speed = s; emitView(); }
export function scrubReplay(p: number) {
  const [t0, t1] = replayRange(); view.replay.on = true;
  view.replay.clockMs = t0 + Math.min(1, Math.max(0, p)) * (t1 - t0); view.replay.progress = p; lastTick = performance.now(); emitView();
}
/** Jump the replay clock to a moment (a click on an item in the panel or the scrubber marks). */
export function jumpTo(ms: number) { const [t0, t1] = replayRange(); scrubReplay((ms - t0) / Math.max(1, t1 - t0)); }
function tick(now: number) {
  raf = 0;
  if (!view.replay.on || !view.replay.playing) return;
  const dt = Math.min(0.25, (now - lastTick) / 1000); lastTick = now;
  const [t0, t1] = replayRange();
  view.replay.clockMs += dt * 1000 * view.replay.speed; view.replay.progress = (view.replay.clockMs - t0) / Math.max(1, t1 - t0);
  if (view.replay.clockMs >= Date.now()) { stopReplay(); return; }
  emitView();
  raf = requestAnimationFrame(tick);
}

/** Replay cut-off in micros, or null when live. */
export function replayCut(): bigint | null {
  if (!view.replay.on) return null;
  return BigInt(Math.round(view.replay.clockMs)) * 1000n + 1n;
}
/** Events in the window and wearer filter, ignoring the asset trace (the views dim instead of hiding). Newest first. */
export function windowEvents(): Ev[] { const saved = state.assetFilter; state.assetFilter = null; try { return visibleEvents(); } finally { state.assetFilter = saved; } }
/** What a view draws: the window, narrowed by replay and, for the shift line, by scope. Newest first. */
export function shownEvents(withScope = false): Ev[] {
  let evs = windowEvents(); const cut = replayCut();
  if (cut !== null) evs = evs.filter(e => e.tMicros <= cut);
  if (withScope && view.scope) evs = evs.filter(e => view.scope!.has(e.eventId));
  return evs;
}
