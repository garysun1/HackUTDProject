import { state, visibleEvents, wearerColor, wearerName, fmtTime, loadPhoto, placeOf, alertsFor, notify, type Ev } from './store';

const list = document.getElementById('timeline') as HTMLOListElement;
const empty = document.getElementById('timeline-empty') as HTMLElement;
const count = document.getElementById('count') as HTMLElement;
const nodes = new Map<string, HTMLLIElement>();

export function select(id: string | null) { state.selected = id; notify(); document.dispatchEvent(new CustomEvent('select', { detail: id })); }

function card(e: Ev): HTMLLIElement {
  const li = document.createElement('li'); li.className = 'ev'; li.tabIndex = 0; li.dataset.id = e.eventId; li.setAttribute('role', 'button');
  li.addEventListener('click', () => select(e.eventId));
  li.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); select(e.eventId); } });
  return li;
}
function fill(li: HTMLLIElement, e: Ev) {
  const place = placeOf(e.eventId); const alerts = alertsFor(e);
  const img = state.photos.get(e.eventId);
  li.innerHTML = `<img alt="" ${img ? `src="${img}"` : ''}><div>
    <div class="meta"><span>${fmtTime(e.tMicros)}</span><span class="who"><i style="background:${wearerColor(e.deviceId)}"></i>${wearerName(e.deviceId)}</span><span class="st ${e.status}">${e.status.replace('_', ' ')}</span></div>
    <p class="sum ${e.summary && e.confidence > 0 ? '' : 'processing'}">${e.summary && e.confidence > 0 ? esc(e.summary) : e.status === 'failed' ? 'could not read this photo' : e.summary ? 'stored, awaiting perception' : 'reading the photo…'}</p>
    <div class="tags">${e.label ? `<span><b>${esc(e.label)}</b></span>` : ''}${place ? `<span>${esc(place.canonicalName)}</span>` : ''}${alerts.length ? `<span style="color:var(--critical)">${alerts.length} alert${alerts.length > 1 ? 's' : ''}</span>` : ''}${e.note ? `<span>“${esc(e.note)}”</span>` : ''}</div></div>`;
  li.setAttribute('aria-pressed', String(state.selected === e.eventId)); li.dataset.selected = String(state.selected === e.eventId);
  li.classList.toggle('fresh', state.fresh.has(e.eventId));
  if (!img) loadPhoto(e.eventId);
}
export function esc(s: string) { return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string)); }

export function renderTimeline() {
  const evs = visibleEvents();
  count.textContent = `${evs.length} event${evs.length === 1 ? '' : 's'}`;
  empty.hidden = evs.length > 0;
  const want = new Set(evs.map(e => e.eventId));
  for (const [id, li] of nodes) if (!want.has(id)) { li.remove(); nodes.delete(id); }
  let prev: HTMLLIElement | null = null;
  for (const e of evs) {
    let li = nodes.get(e.eventId);
    if (!li) { li = card(e); nodes.set(e.eventId, li); }
    fill(li, e);
    if (prev) { if (prev.nextSibling !== li) prev.after(li); } else if (list.firstChild !== li) list.prepend(li);
    prev = li;
  }
}
