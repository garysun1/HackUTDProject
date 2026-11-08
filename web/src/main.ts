import { connect, onChange, state, visibleEvents, wearerColor, wearerName, notify, DB, fmtTime, setDb, dbChosen, HOST } from './store';
import { WORKSPACES, current, vocab } from './workspaces';
import { renderTimeline } from './timeline';
import { renderFloor, floorUserView } from './floor';
import { renderRail } from './rail';
import { renderMap, mapUserView } from './map';
import { renderTools } from './tools';
import { view, setMode, onView } from './view';

const dbEl = document.getElementById('db')!;
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

// ---- workspace switcher: swaps the dataset client-side; the words follow the workspace ----
const wsBtn = document.getElementById('ws-btn') as HTMLButtonElement; const wsMenu = document.getElementById('ws-menu') as HTMLElement;
const wsName = document.getElementById('ws-name')!; const wsSub = document.getElementById('ws-sub')!;
const counts = new Map<string, number>(); let countsAt = 0;
async function refreshCounts() {
  if (Date.now() - countsAt < 30_000) return; countsAt = Date.now();
  await Promise.all(WORKSPACES.map(async w => { try { const r = await fetch(`${HOST}/v1/database/${w.db}/sql`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'SELECT event_id FROM event' }); const [res] = await r.json(); counts.set(w.db, res?.rows?.length ?? 0); } catch { /* offline */ } }));
  renderMenu();
}
function renderMenu() {
  const cur = current();
  wsMenu.innerHTML = `<div class="ws-head">Workspaces</div>` + WORKSPACES.map(w => `<button type="button" class="ws-item" role="menuitemradio" aria-checked="${w.db === cur.db}" data-db="${w.db}"><span class="n">${w.db === cur.db ? '<i class="dot"></i>' : ''}${w.name}${w.sample ? '<span class="tag">sample</span>' : ''}</span><span class="s">${w.subtitle}</span><span class="c">${counts.has(w.db) ? `${counts.get(w.db)} photo${counts.get(w.db) === 1 ? '' : 's'}` : ''}</span></button>`).join('') +
    `<div class="ws-foot"><span>${dbChosen() ? 'Chosen here' : 'Following the server default'}</span>${dbChosen() ? '<button type="button" data-follow>Follow server default</button>' : ''}</div>`;
}
function renderWorkspace() { const w = current(); wsName.textContent = w.name; wsSub.textContent = w.subtitle; wsBtn.title = `${w.name} · ${w.db}`; dbEl.textContent = DB;
  const h2 = document.querySelector('.floor .colhead h2'); if (h2) h2.textContent = vocab().session;
  const lg = document.querySelector('.floor .legend'); if (lg && view.mode === 'map') { const v = vocab(); lg.innerHTML = `<i class="k k-walk"></i>walk <i class="k k-heat"></i>time spent <i class="k k-ph"></i>photo <i class="k k-al"></i>open ${v.flag.toLowerCase()}`; }
  else if (lg) { const v = vocab(); lg.innerHTML = `<i class="k k-ph"></i>photo <i class="k k-as"></i>${v.tracked.toLowerCase()} <i class="k k-al"></i>${v.flag.toLowerCase()} <i class="k k-chg"></i>change <i class="k k-nt"></i>${v.note.toLowerCase()}${state.questions.size ? ' <i class="k k-q"></i>question' : ''}`; }
}
function openMenu(open: boolean) { wsMenu.hidden = !open; wsBtn.setAttribute('aria-expanded', String(open)); if (open) { renderMenu(); refreshCounts(); (wsMenu.querySelector('[aria-checked="true"]') as HTMLElement | null)?.focus(); } }
wsBtn.addEventListener('click', () => openMenu(wsMenu.hidden));
wsMenu.addEventListener('click', e => { const t = e.target as HTMLElement; const it = t.closest('[data-db]') as HTMLElement | null; if (it) { setDb(it.dataset.db!); openMenu(false); return; } if (t.closest('[data-follow]')) { setDb(null); openMenu(false); } });
document.addEventListener('click', e => { if (!wsMenu.hidden && !(e.target as HTMLElement).closest('.ws')) openMenu(false); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !wsMenu.hidden) { openMenu(false); wsBtn.focus(); } });

onChange(() => {
  if (!view.modeChosen && state.locations.size && view.mode !== 'map') setMode('map', false); // the first positioned photo brings the map up
  renderWorkspace(); // follows the dataset switch
  renderChips(); renderTimeline(); renderRail(); // detail panel first: it changes the canvas width
  renderTools(view.mode === 'map' ? mapUserView() : floorUserView()); renderMap(); renderFloor();
});

// Timeline collapse: the floor takes the width. Remembered per browser.
const grid = document.querySelector('.grid') as HTMLElement; const tlToggle = document.getElementById('tl-toggle') as HTMLButtonElement;
function setTimeline(open: boolean, remember = true) {
  grid.dataset.tl = open ? 'open' : 'collapsed';
  tlToggle.setAttribute('aria-expanded', String(open)); tlToggle.title = open ? 'Hide timeline' : 'Show timeline';
  if (remember) { try { localStorage.setItem('wm.timeline', open ? 'open' : 'collapsed'); } catch { /* private mode */ } }
  renderFloor(); renderMap();
}
// One list on screen: the map carries the shift-memory panel with its own event feed, so the
// console's timeline folds away while the map is up and comes back when you leave (not remembered).
let autoFolded = false; let lastMode = view.mode;
function foldForMode() {
  if (view.mode === 'map' && grid.dataset.tl !== 'collapsed') { autoFolded = true; setTimeline(false, false); }
  else if (view.mode !== 'map' && autoFolded) { autoFolded = false; setTimeline(true, false); }
}
onView(() => { if (view.mode !== lastMode) { lastMode = view.mode; foldForMode(); renderWorkspace(); } });
foldForMode();
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
