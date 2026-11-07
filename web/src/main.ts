import { connect, onChange, state, visibleEvents, wearerColor, wearerName, notify, DB } from './store';
import { renderTimeline } from './timeline';
import { renderFloor } from './floor';
import { renderRail } from './rail';

document.getElementById('db')!.textContent = DB;
const conn = document.getElementById('conn')!; const connText = document.getElementById('conn-text')!;
const windowSel = document.getElementById('window') as HTMLSelectElement;
const wearersEl = document.getElementById('wearers')!;

windowSel.addEventListener('change', () => { state.windowMin = Number(windowSel.value === 'all' ? 0 : windowSel.value); notify(); });

function renderChips() {
  const ids = [...new Set([...state.events.values()].map(e => e.deviceId))];
  wearersEl.innerHTML = ids.map(id => `<button class="chip" type="button" data-id="${id}" aria-pressed="${!state.hiddenWearers.has(id)}"><i style="background:${wearerColor(id)}"></i>${wearerName(id)}</button>`).join('');
}
wearersEl.addEventListener('click', e => { const b = (e.target as HTMLElement).closest('.chip') as HTMLElement | null; if (!b) return; const id = b.dataset.id!; if (state.hiddenWearers.has(id)) state.hiddenWearers.delete(id); else state.hiddenWearers.add(id); notify(); });

onChange(() => { renderChips(); renderTimeline(); renderFloor(); renderRail(); });
document.addEventListener('select', () => notify());
setInterval(() => { if (visibleEvents().length) renderFloor(); }, 15000); // the "now" edge of the time axis advances

connect((s, msg) => { conn.dataset.state = s; connText.textContent = s === 'live' ? 'live' : msg || s; });
