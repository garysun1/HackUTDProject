// The hover card shared by the map and the graph: the photo, time, wearer, place, open alert,
// summary and note. One fixed element, positioned beside the cursor.
import { state, alertsFor, placeOf, wearerColor, wearerName, fmtTime, loadPhoto } from './store';
import { esc } from './timeline';

const tip = document.createElement('div'); tip.className = 'floor-tip'; tip.style.display = 'none'; document.body.appendChild(tip);
let current: string | null = null;

export function photoCard(id: string): string {
  const ev = state.events.get(id); if (!ev) return '';
  const url = state.photos.get(id); if (!url) loadPhoto(id).then(() => { if (current === id) { tip.innerHTML = photoCard(id); } });
  const alerts = alertsFor(ev).filter(a => !a.acked); const place = placeOf(id); const loc = state.locations.get(id);
  return `${url ? `<img src="${url}" alt="">` : '<div class="ph"></div>'}<div class="tb"><div class="tt"><span class="mono">${fmtTime(ev.tMicros)}</span> · <i style="background:${wearerColor(ev.deviceId)}"></i>${esc(wearerName(ev.deviceId))}${place ? ` · ${esc(place.canonicalName)}` : ''}${loc ? ` · ±${Math.round(loc.accuracyM)} m` : ''}</div>${alerts.length ? `<div class="ta">${esc(alerts[0].text)}${alerts[0].assetName ? ` · ${esc(alerts[0].assetName)}` : ''}</div>` : ''}<div class="ts">${esc(ev.summary || 'reading the photo…')}</div>${ev.note ? `<div class="tn">“${esc(ev.note)}”</div>` : ''}</div>`;
}
export function showTip(html: string, clientX: number, clientY: number, id: string | null = null) {
  current = id; tip.innerHTML = html; tip.style.display = 'block';
  const pad = 14; const w = tip.offsetWidth || 260, h = tip.offsetHeight || 120;
  tip.style.left = `${clientX + pad + w > innerWidth ? clientX - pad - w : clientX + pad}px`;
  tip.style.top = `${clientY + pad + h > innerHeight ? clientY - pad - h : clientY + pad}px`;
}
export function moveTip(clientX: number, clientY: number) { if (tip.style.display === 'block') showTip(tip.innerHTML, clientX, clientY, current); }
export function hideTip() { current = null; tip.style.display = 'none'; }
document.addEventListener('select', hideTip);
