// Event detail: a panel that slides over the right edge of the floor when an event is selected.
// The operations rail (alerts, coverage, handoff, ask) was removed on 2026-11-07 to put the
// graph first; it lives in git history (commit fc75319) if it comes back.
import { state, placeOf, assetsOf, displayName, fmtTime, wearerName, loadPhoto, perception } from './store';
import { select, esc } from './timeline';
import { vocab } from './workspaces';

const drawer = document.getElementById('drawer') as HTMLElement;
const drawerImg = document.getElementById('drawer-img') as HTMLImageElement;
const drawerTitle = document.getElementById('drawer-title') as HTMLElement;
const drawerFields = document.getElementById('drawer-fields') as HTMLElement;

async function renderDrawer() {
  const id = state.selected; if (!id || !state.events.has(id)) { drawer.hidden = true; return; }
  const e = state.events.get(id)!; drawer.hidden = false;
  drawerTitle.textContent = `${fmtTime(e.tMicros)} · ${wearerName(e.deviceId)}`;
  const url = state.photos.get(id) ?? await loadPhoto(id); if (url) drawerImg.src = url; else drawerImg.removeAttribute('src');
  const p = perception(e); const place = placeOf(id); const assets = assetsOf(id);
  const registry = assets.filter(a => a.kind === 'asset'), other = assets.filter(a => a.kind !== 'asset');
  const rows: [string, string][] = [
    ['Summary', e.summary && e.confidence > 0 ? esc(e.summary) : `<span class="muted">${e.status === 'failed' ? 'This photo could not be read.' : e.summary ? 'Stored. Perception has not run on this photo yet.' : 'Reading the photo…'}</span>`],
    ['Status', `<span class="st ${e.status}">${e.status.replace('_', ' ')}</span>`],
    ['Place', place ? esc(place.canonicalName) : '—'],
    [vocab().trackeds, registry.length ? registry.map(a => `<span title="${esc(a.canonicalName)}">${esc(displayName(a))}</span>`).join(', ') : '<span class="muted">none in registry</span>'],
    ...(other.length ? [['Also seen', other.map(a => esc(a.canonicalName)).join(', ')] as [string, string]] : []),
    ['Activity', esc(e.activity || '—')],
    ['People', String(e.peopleCount)],
    ['Confidence', e.confidence ? e.confidence.toFixed(2) : '—'],
  ];
  if (state.badges.has(id)) rows.unshift(['Noted', `<span class="badge"><span class="crown" aria-hidden="true">★</span>${esc(state.badges.get(id)!)}</span>`]);
  if (e.label) rows.push(['Label', `<b>${esc(e.label)}</b>`]);
  if (e.note) rows.push(['Note', `“${esc(e.note)}”`]);
  if (p?.text_in_scene?.length) rows.push(['Text read', `<ul>${p.text_in_scene.map((t: string) => `<li class="mono">${esc(String(t))}</li>`).join('')}</ul>`]);
  if (p?.changes_since_previous?.length) rows.push(['Changes', `<ul>${p.changes_since_previous.map((c: any) => `<li>${esc(String(c.entity))}: ${esc(String(c.from))} → ${esc(String(c.to))}</li>`).join('')}</ul>`]);
  const SOURCE: Record<string, string> = { shutter_button: 'glasses shutter', sdk_capture: 'app capture', camera_roll: 'camera roll import', manual_upload: 'manual upload' };
  const prov = `<details><summary>Provenance</summary><dl><dt>Source</dt><dd>${esc(SOURCE[e.source] ?? e.source)}</dd><dt>Captured</dt><dd class="mono">${esc(e.clientT.replace('T', ' ').slice(0, 19))}</dd><dt>Event</dt><dd class="mono">${e.eventId}</dd></dl></details>`;
  drawerFields.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('') + prov;
}
document.getElementById('drawer-close')!.addEventListener('click', () => select(null));
document.addEventListener('select', () => { if (state.selected) { drawer.scrollTop = 0; setTimeout(() => (document.getElementById('drawer-close') as HTMLElement)?.focus(), 50); } });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !drawer.hidden) select(null); });

export function renderRail() { renderDrawer(); }
