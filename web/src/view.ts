// View state shared by the map, the graph and the header tools: which view is up, the replay
// clock, and an optional scope (a cluster of photos the graph is narrowed to). Separate from the
// store so a replay tick re-renders the canvases without rebuilding the timeline DOM.
import { state, visibleEvents, type Ev } from './store';

export type Mode = 'map' | 'graph';
export const view = {
  mode: 'graph' as Mode,
  modeChosen: false, // the user picked a mode; stop auto-switching to the map when positions appear
  replay: { on: false, playing: false, start: 0, progress: 1, dur: 10000 },
  scope: null as Set<string> | null, // graph narrowed to these events (opened from a map cluster)
  scopeLabel: '',
};
try { const m = localStorage.getItem('wm.mode'); if (m === 'map' || m === 'graph') { view.mode = m; view.modeChosen = true; } } catch { /* private mode */ }

type Fn = () => void; const listeners = new Set<Fn>();
export function onView(fn: Fn) { listeners.add(fn); }
export function emitView() { for (const l of listeners) l(); }

export function setMode(m: Mode, byUser = true) {
  if (view.mode === m) return; view.mode = m; if (byUser) { view.modeChosen = true; try { localStorage.setItem('wm.mode', m); } catch { /* ignore */ } }
  if (m === 'graph') view.scope = null;
  emitView();
}
export function setScope(ids: Set<string> | null, label = '') { view.scope = ids; view.scopeLabel = label; emitView(); }

// ---------- replay: ten seconds from the first visible photo to the last ----------
let raf = 0;
export function startReplay() { view.replay.on = true; view.replay.playing = true; view.replay.progress = 0; view.replay.start = performance.now(); tick(); }
export function stopReplay() { view.replay.on = false; view.replay.playing = false; view.replay.progress = 1; emitView(); }
export function scrubReplay(p: number) { view.replay.playing = false; view.replay.progress = Math.min(1, Math.max(0, p)); emitView(); }
function tick() {
  if (!view.replay.playing) { raf = 0; return; }
  view.replay.progress = Math.min(1, (performance.now() - view.replay.start) / view.replay.dur);
  if (view.replay.progress >= 1) view.replay.playing = false;
  emitView();
  raf = view.replay.playing ? requestAnimationFrame(tick) : 0;
}

/** Replay cut-off in micros for the current window, or null when not replaying. */
export function replayCut(): bigint | null {
  if (!view.replay.on) return null;
  const evs = windowEvents(); if (!evs.length) return null;
  const t0 = Number(evs[evs.length - 1].tMicros), t1 = Number(evs[0].tMicros);
  return BigInt(Math.round(t0 + (t1 - t0) * view.replay.progress)) + 1n;
}
/** Events in the window and wearer filter, ignoring the asset trace (the views dim instead of hiding). Newest first. */
export function windowEvents(): Ev[] { const saved = state.assetFilter; state.assetFilter = null; try { return visibleEvents(); } finally { state.assetFilter = saved; } }
/** What a view draws: the window, narrowed by replay and, for the graph, by scope. Newest first. */
export function shownEvents(withScope = false): Ev[] {
  let evs = windowEvents(); const cut = replayCut();
  if (cut !== null) evs = evs.filter(e => e.tMicros <= cut);
  if (withScope && view.scope) evs = evs.filter(e => view.scope!.has(e.eventId));
  return evs;
}
