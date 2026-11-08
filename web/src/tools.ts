// Header tools for the memory view: Map / Graph switch, Replay with a scrubber, Fit, and the
// trace pill. One place, so both views share the same controls.
import { state, displayName, notify } from './store';
import { esc } from './timeline';
import { view, setMode, startReplay, stopReplay, scrubReplay, emitView, shownEvents, onView } from './view';
import { vocab } from './workspaces';

const tools = document.getElementById('floor-tools') as HTMLElement;
export let fitRequested = 0; // bumped when the user asks to fit; the views compare against their own copy
let key = '';

tools.addEventListener('click', e => {
  const t = e.target as HTMLElement;
  const mode = t.closest('.seg [data-mode]') as HTMLElement | null; if (mode) { setMode(mode.dataset.mode as 'map' | 'graph'); return; }
  if (t.closest('[data-replay]')) startReplay();
  if (t.closest('[data-live]')) stopReplay();
  if (t.closest('[data-fit]')) { fitRequested++; emitView(); }
  if (t.closest('[data-clear]')) { state.assetFilter = null; notify(); }
});
tools.addEventListener('input', e => { const t = e.target as HTMLInputElement; if (t.matches('[data-scrub]')) scrubReplay(Number(t.value) / 1000); });

export function renderTools(userView: boolean) {
  const traced = state.assetFilter && state.entities.get(state.assetFilter); const tracedName = traced ? displayName(traced) : '';
  const tracedCount = traced ? shownEvents().filter(e => state.edges.some(x => x.fromId === e.eventId && x.toId === traced.entityId)).length : 0;
  const hasMap = state.locations.size > 0;
  const k = `${view.mode}|${vocab().session}|${hasMap}|${view.replay.on}|${view.replay.playing}|${tracedName}|${tracedCount}|${userView}`;
  if (k !== key) {
    key = k;
    tools.innerHTML =
      (tracedName ? `<button type="button" class="pill" data-clear title="Stop tracing">Tracing <b>${esc(tracedName)}</b> · ${tracedCount} photo${tracedCount === 1 ? '' : 's'} · clear</button>` : '') +
      (view.replay.on
        ? `<label class="scrub" title="Scrub the shift"><input type="range" min="0" max="1000" value="${Math.round(view.replay.progress * 1000)}" data-scrub aria-label="Replay position"></label><button type="button" class="btn ghost" data-live>Live</button>`
        : `<button type="button" class="btn ghost" data-replay title="Rebuild the shift from the first photo">▶ Replay</button>`) +
      (userView ? `<button type="button" class="btn ghost" data-fit title="Fit everything in view">Fit</button>` : '') +
      `<span class="seg" role="group" aria-label="View"><button type="button" data-mode="map" aria-pressed="${view.mode === 'map'}" ${hasMap ? '' : 'title="No photo has a position yet"'}>Map</button><button type="button" data-mode="graph" aria-pressed="${view.mode === 'graph'}">${esc(vocab().session)}</button></span>`;
  }
  const s = tools.querySelector('[data-scrub]') as HTMLInputElement | null; if (s && view.replay.playing) s.value = String(Math.round(view.replay.progress * 1000));
}
onView(() => renderTools(false));
