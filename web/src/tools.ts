// Header tools shared by the map and the shift line: the Map / Shift switch, the replay bar
// (play, speed, scrubber over the shift's time span, clock, Live), Fit, and the trace pill.
import { state, displayName, notify, fmtTime } from './store';
import { esc } from './timeline';
import { view, setMode, togglePlay, stopReplay, scrubReplay, setSpeed, emitView, shownEvents, onView, replayRange } from './view';
import { vocab } from './workspaces';

const tools = document.getElementById('floor-tools') as HTMLElement;
export let fitRequested = 0; // bumped when the user asks to fit; the views compare against their own copy
let key = '';
const speeds = () => { const [t0, t1] = replayRange(); return (t1 - t0) / 3_600_000 > 6 ? [1, 60, 300, 1800, 3600] : [1, 10, 60, 300]; }; // a record spanning a day gets two faster steps
// Both render paths (store change, view tick) must agree on userView, or the bar is rebuilt under the pointer.
let userViewFn: () => boolean = () => false;
export function setUserViewSource(fn: () => boolean) { userViewFn = fn; }
let scrubbing = false;
tools.addEventListener('pointerdown', e => { if ((e.target as HTMLElement).matches('[data-scrub]')) scrubbing = true; });
document.addEventListener('pointerup', () => { if (scrubbing) { scrubbing = false; emitView(); } });

tools.addEventListener('click', e => {
  const t = e.target as HTMLElement;
  const mode = t.closest('.seg [data-mode]') as HTMLElement | null; if (mode) { setMode(mode.dataset.mode as 'map' | 'graph'); return; }
  if (t.closest('[data-play]')) togglePlay();
  if (t.closest('[data-exit]')) stopReplay();
  if (t.closest('[data-fit]')) { fitRequested++; emitView(); }
  if (t.closest('[data-clear]')) { state.assetFilter = null; notify(); }
});
tools.addEventListener('change', e => { const t = e.target as HTMLSelectElement; if (t.matches('[data-speed-sel]')) setSpeed(Number(t.value)); });
tools.addEventListener('input', e => { const t = e.target as HTMLInputElement; if (t.matches('[data-scrub]')) scrubReplay(Number(t.value) / 1000); });
document.addEventListener('keydown', e => {
  const tg = e.target as HTMLElement; if (e.altKey || e.ctrlKey || e.metaKey) return;
  if (tg.closest('input, select, textarea, button, a, [role="button"], [contenteditable]')) return;
  if (e.key === ' ') { e.preventDefault(); togglePlay(); } else if (e.key === 'l') stopReplay();
});

export function renderTools(userView: boolean = userViewFn()) {
  const traced = state.assetFilter && state.entities.get(state.assetFilter); const tracedName = traced ? displayName(traced) : '';
  const tracedCount = traced ? shownEvents().filter(e => state.edges.some(x => x.fromId === e.eventId && x.toId === traced.entityId)).length : 0;
  const hasMap = state.locations.size > 0 || state.track.size > 0;
  const r = view.replay;
  const k = `${view.mode}|${vocab().session}|${hasMap}|${r.on}|${r.playing}|${r.speed}|${tracedName}|${tracedCount}|${userView}|${speeds().length}`;
  if (k !== key) {
    key = k;
    tools.innerHTML =
      (tracedName ? `<button type="button" class="pill" data-clear title="Stop tracing">Tracing <b>${esc(tracedName)}</b> · ${tracedCount} photo${tracedCount === 1 ? '' : 's'} · clear</button>` : '') +
      (view.mode === 'map' ? '' : r.on
        ? `<span class="replay" role="group" aria-label="Replay"><button type="button" class="btn ghost play" data-play title="${r.playing ? 'Pause' : 'Play'} (space)">${r.playing ? '❚❚' : '▶'}</button>` +
          `<select class="speed" data-speed-sel aria-label="Replay speed">${[...new Set([...speeds(), r.speed])].sort((a, b) => a - b).map(s => `<option value="${s}"${r.speed === s ? ' selected' : ''}>${s}×</option>`).join('')}</select>` +
          `<label class="scrub" title="Scrub the ${esc(vocab().session.toLowerCase())}"><input type="range" min="0" max="1000" value="${Math.round(r.progress * 1000)}" data-scrub aria-label="Replay position"></label>` +
          `<span class="clock mono" data-clock></span><button type="button" class="btn ghost exit" data-exit aria-label="Leave the replay" title="Leave the replay (L)">✕</button></span>`
        : `<button type="button" class="btn ghost" data-play title="Replay the ${esc(vocab().session.toLowerCase())} from its first moment (space)">▶ Replay</button>`) +
      (userView ? `<button type="button" class="btn ghost" data-fit title="Fit everything in view">Fit</button>` : '') +
      `<span class="seg" role="group" aria-label="View"><button type="button" data-mode="map" aria-pressed="${view.mode === 'map'}" ${hasMap ? '' : 'title="No position yet; the site shows once a photo or track arrives"'}>Map</button><button type="button" data-mode="graph" aria-pressed="${view.mode === 'graph'}">Graph</button></span>`;
  }
  if (r.on) {
    const s = tools.querySelector('[data-scrub]') as HTMLInputElement | null; if (s && !scrubbing) { const [t0, t1] = replayRange(); s.value = String(Math.round(((r.clockMs - t0) / Math.max(1, t1 - t0)) * 1000)); }
    const c = tools.querySelector('[data-clock]') as HTMLElement | null; if (c) c.textContent = fmtTime(BigInt(Math.round(r.clockMs)) * 1000n);
  }
}
onView(() => renderTools(false));
