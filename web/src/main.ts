import { connect, onChange, state, visibleEvents, wearerColor, wearerName, notify, DB, fmtTime } from './store';
import { renderTimeline } from './timeline';
import { renderFloor, floorUserView } from './floor';
import { renderRail } from './rail';
import { renderMap, mapUserView } from './map';
import { renderTools } from './tools';
import { view, setMode } from './view';

const dbEl = document.getElementById('db')!; dbEl.textContent = DB;
const conn = document.getElementById('conn')!; const connText = document.getElementById('conn-text')!;
const windowSel = document.getElementById('window') as HTMLSelectElement;
const wearersEl = document.getElementById('wearers')!;

windowSel.addEventListener('change', () => { state.windowMin = Number(windowSel.value === 'all' ? 0 : windowSel.value); notify(); });

function renderChips() {
  // one chip per wearer name; a wearer with two devices (phone + glasses) is still one person
  const byName = new Map<string, string[]>();
  for (const id of new Set([...state.events.values()].map(e => e.deviceId))) { const n = wearerName(id); (byName.get(n) ?? byName.set(n, []).get(n)!).push(id); }
  const focused = (document.activeElement as HTMLElement | null)?.dataset?.id;
  for (const [name, ids] of byName) {
    const key = ids.join(',');
    let b = wearersEl.querySelector(`[data-id="${CSS.escape(key)}"]`) as HTMLButtonElement | null;
    if (!b) { b = document.createElement('button'); b.className = 'chip'; b.type = 'button'; b.dataset.id = key; wearersEl.appendChild(b); }
    b.setAttribute('aria-pressed', String(!ids.every(id => state.hiddenWearers.has(id))));
    const cutoff = state.windowMin ? BigInt(Date.now() - state.windowMin * 60_000) * 1000n : 0n;
    const n = [...state.events.values()].filter(e => ids.includes(e.deviceId) && e.tMicros >= cutoff).length;
    b.innerHTML = `<i style="background:${wearerColor(ids[0])}"></i>${name}<span class="n">${n}</span>`;
  }
  for (const b of [...wearersEl.children] as HTMLElement[]) if (![...byName.values()].some(ids => ids.join(',') === b.dataset.id)) b.remove();
  if (focused) (wearersEl.querySelector(`[data-id="${CSS.escape(focused)}"]`) as HTMLElement | null)?.focus();
}
wearersEl.addEventListener('click', e => { const b = (e.target as HTMLElement).closest('.chip') as HTMLElement | null; if (!b) return; const ids = b.dataset.id!.split(','); const hidden = ids.every(id => state.hiddenWearers.has(id)); for (const id of ids) { if (hidden) state.hiddenWearers.delete(id); else state.hiddenWearers.add(id); } notify(); });

onChange(() => {
  if (!view.modeChosen && state.locations.size && view.mode !== 'map') setMode('map', false); // the first positioned photo brings the map up
  dbEl.textContent = DB; // follows the dataset switch
  renderChips(); renderTimeline(); renderRail(); // detail panel first: it changes the canvas width
  renderTools(view.mode === 'map' ? mapUserView() : floorUserView()); renderMap(); renderFloor();
});

// Timeline collapse: the floor takes the width. Remembered per browser.
const grid = document.querySelector('.grid') as HTMLElement; const tlToggle = document.getElementById('tl-toggle') as HTMLButtonElement;
function setTimeline(open: boolean) {
  grid.dataset.tl = open ? 'open' : 'collapsed';
  tlToggle.setAttribute('aria-expanded', String(open)); tlToggle.title = open ? 'Hide timeline' : 'Show timeline';
  try { localStorage.setItem('wm.timeline', open ? 'open' : 'collapsed'); } catch { /* private mode */ }
  renderFloor(); renderMap();
}
tlToggle.addEventListener('click', () => setTimeline(grid.dataset.tl === 'collapsed'));
grid.addEventListener('transitionend', e => { if (e.propertyName === 'grid-template-columns') { renderFloor(); renderMap(); } });
try { if (localStorage.getItem('wm.timeline') === 'collapsed') setTimeline(false); } catch { /* ignore */ }
document.addEventListener('select', () => notify());
setInterval(() => { if (visibleEvents().length) { renderFloor(); renderMap(); renderRail(); } }, 15000); // "now" advances: time axis and ages

const stale = document.getElementById('stale')!;
connect((s, msg) => {
  conn.dataset.state = s; document.body.dataset.conn = s;
  connText.textContent = s === 'live' ? 'live' : msg || s;
  if (s !== 'live') { const last = [...state.events.values()].sort((a, b) => (a.tMicros < b.tMicros ? 1 : -1))[0]; stale.textContent = `${s === 'error' ? 'Connection error' : 'Reconnecting'} · showing data as of ${last ? fmtTime(last.tMicros) : 'page load'}`; }
});
// honest empty states: say why the list is empty and offer the way out
const tlEmpty = document.getElementById('timeline-empty')!; const flEmpty = document.getElementById('floor-empty')!;
function emptyCopy() {
  const total = state.events.size; const shown = visibleEvents().length;
  if (shown || !total) return;
  const reasons: string[] = [];
  if (state.hiddenWearers.size) reasons.push(`${state.hiddenWearers.size} wearer${state.hiddenWearers.size > 1 ? 's' : ''} hidden`);
  if (state.windowMin) reasons.push(`window is ${windowSel.options[windowSel.selectedIndex].text}`);
  if (state.assetFilter) reasons.push(`showing only ${state.entities.get(state.assetFilter)?.canonicalName ?? 'one asset'}`);
  const why = reasons.join(', ');
  tlEmpty.innerHTML = `No events match: ${why}. <a id="clear-filters" role="button" tabindex="0">Show everything</a>`;
  flEmpty.textContent = `Nothing to draw with the current filters.`;
  tlEmpty.querySelector('#clear-filters')!.addEventListener('click', () => { state.hiddenWearers.clear(); state.windowMin = 0; state.assetFilter = null; windowSel.value = 'all'; notify(); });
}
onChange(emptyCopy);
