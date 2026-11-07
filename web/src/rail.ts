import { state, visibleEvents, allAlerts, ackAlert, edgesFrom, props, placeOf, assetsOf, fmtTime, wearerName, wearerColor, loadPhoto, perception, callProcedure, hasProcedure, nowMicros, type Ev } from './store';
import { select, esc } from './timeline';

const alertsEl = document.getElementById('alerts') as HTMLUListElement;
const alertsEmpty = document.getElementById('alerts-empty') as HTMLElement;
const alertCount = document.getElementById('alert-count') as HTMLElement;
const handoffEl = document.getElementById('handoff') as HTMLElement;
const genBtn = document.getElementById('gen-handoff') as HTMLButtonElement;
const askForm = document.getElementById('ask-form') as HTMLFormElement;
const askInput = document.getElementById('ask-input') as HTMLInputElement;
const answerEl = document.getElementById('answer') as HTMLElement;
const drawer = document.getElementById('drawer') as HTMLElement;
const drawerImg = document.getElementById('drawer-img') as HTMLImageElement;
const drawerTitle = document.getElementById('drawer-title') as HTMLElement;
const drawerFields = document.getElementById('drawer-fields') as HTMLElement;
const acking = new Set<string>();
let haveAsk = false, haveHandoff = false;
hasProcedure('ask').then(v => { haveAsk = v; renderRail(); });
hasProcedure('handoff').then(v => { haveHandoff = v; renderRail(); });

const ICON = { critical: '<svg viewBox="0 0 16 16" fill="none" stroke="#d03b3b" stroke-width="1.6"><path d="M8 1.5 15 14H1z"/><path d="M8 6v4M8 12v.5"/></svg>', warning: '<svg viewBox="0 0 16 16" fill="none" stroke="#fab219" stroke-width="1.6"><circle cx="8" cy="8" r="6.5"/><path d="M8 4.5v4M8 11v.5"/></svg>' };

const GLYPH = '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M3 1.5 6.5 5 3 8.5"/></svg>';
function cite(id: string) { const e = state.events.get(id); const who = e ? wearerName(e.deviceId) : ''; return `<button type="button" class="cite" data-id="${id}" aria-label="Open photo from ${e ? fmtTime(e.tMicros) : id}">${e ? fmtTime(e.tMicros) : id.slice(0, 6)}${who ? ` ${esc(who)}` : ''}${GLYPH}</button>`; }
handoffEl.addEventListener('click', e => { const t = (e.target as HTMLElement).closest('.cite') as HTMLElement | null; if (t?.dataset.id) select(t.dataset.id); });
answerEl.addEventListener('click', e => { const t = (e.target as HTMLElement).closest('.cite') as HTMLElement | null; if (t?.dataset.id) select(t.dataset.id); });

function renderAlerts() {
  const alerts = allAlerts();
  alertCount.textContent = alerts.length ? String(alerts.length) : ''; alertsEmpty.hidden = alerts.length > 0; alertsEl.innerHTML = '';
  for (const a of alerts) {
    const li = document.createElement('li'); li.className = 'alert';
    const asset = a.assetName || (a.assetId ? state.entities.get(a.assetId)?.canonicalName : undefined);
    const who = a.wearerName || wearerName(a.deviceId);
    const busy = acking.has(a.id);
    li.innerHTML = `<button class="alert-open" type="button" data-open="${esc(a.eventId)}" aria-label="Open photo for ${esc(a.text)}">${ICON[a.kind]}<span><span class="txt">${esc(a.text)}</span><span class="t">${fmtTime(a.tMicros)}${asset ? ` · ${esc(asset)}` : ''} · ${esc(who)} · ${esc(a.rawKind.replace('_', ' '))}</span></span></button><button class="btn ghost" type="button" data-ack="${esc(a.id)}" ${busy ? 'disabled' : ''}>${busy ? '…' : 'Acknowledge'}</button>`;
    li.querySelector('[data-open]')!.addEventListener('click', () => select(a.eventId));
    li.querySelector('[data-ack]')!.addEventListener('click', async () => { acking.add(a.id); renderRail(); try { await ackAlert(a.alertId); } catch (e) { console.error(e); } finally { acking.delete(a.id); renderRail(); } });
    alertsEl.appendChild(li);
  }
}

// Handoff skeleton: graph-derived facts; the module's `handoff` procedure adds the narrative.
function handoffSkeleton(): string {
  const evs = visibleEvents(); if (!evs.length) return '<p class="muted">Nothing in this window yet.</p>';
  const first = evs[evs.length - 1], last = evs[0];
  const wearers = [...new Set(evs.map(e => e.deviceId))];
  let html = `<p class="lead">${fmtTime(first.tMicros)}–${fmtTime(last.tMicros)} · ${evs.length} events · ${wearers.map(w => `<span class="who"><i style="background:${wearerColor(w)}"></i>${esc(wearerName(w))}</span>`).join(', ')}</p>`;
  const alerts = allAlerts();
  if (alerts.length) html += `<h3>Needs attention</h3><ul>${alerts.map(a => `<li><span>${esc(a.text)}</span>${cite(a.eventId)}</li>`).join('')}</ul>`;
  const changes: { asset: string; line: string; id: string }[] = [];
  for (const e of evs) for (const ed of edgesFrom(e.eventId, 'CHANGES')) { const p = props(ed); const asset = state.entities.get(ed.toId)?.canonicalName ?? ed.toId; changes.push({ asset, line: `${asset}${p.attr ? ` ${esc(String(p.attr))}` : ''}: ${esc(String(p.from ?? ''))} → ${esc(String(p.to ?? ''))}`, id: e.eventId }); }
  if (changes.length) html += `<h3>What changed</h3><ul>${changes.map(c => `<li><span>${c.line}</span>${cite(c.id)}</li>`).join('')}</ul>`;
  const byPlace = new Map<string, Ev[]>();
  for (const e of evs) { const p = placeOf(e.eventId)?.canonicalName ?? 'unplaced'; (byPlace.get(p) ?? byPlace.set(p, []).get(p)!).push(e); }
  html += `<h3>Where people were</h3><ul>${[...byPlace.entries()].map(([p, es]) => { const t0 = es[es.length - 1].tMicros, t1 = es[0].tMicros; return `<li><span>${esc(p)} · ${es.length} photo${es.length > 1 ? 's' : ''} · ${fmtTime(t0)}${t1 !== t0 ? `–${fmtTime(t1)}` : ''}</span>${cite(es[0].eventId)}</li>`; }).join('')}</ul>`;
  const notes = evs.filter(e => e.note || e.label);
  if (notes.length) html += `<h3>Notes left by the shift</h3><ul>${notes.map(e => `<li><span>${e.label ? `<b>${esc(e.label)}</b> ` : ''}${e.note ? `“${esc(e.note)}”` : ''}</span>${cite(e.eventId)}</li>`).join('')}</ul>`;
  const low = evs.filter(e => e.status === 'in_graph' && e.confidence > 0 && e.confidence < 0.5);
  if (low.length) html += `<h3>Uncertain</h3><ul>${low.map(e => `<li><span>${esc(e.summary)}</span>${cite(e.eventId)}</li>`).join('')}</ul>`;
  return html;
}
let narrative: string | null = null;
function renderHandoff() {
  const latest = state.handoffs[state.handoffs.length - 1];
  handoffEl.innerHTML = (narrative ? `<p class="lead">${esc(narrative)}</p>` : latest ? `<p class="lead">${esc(latest.text)}</p>` : '') + handoffSkeleton() + (haveHandoff ? '' : '<p class="muted" style="margin-top:8px">Facts from the graph, one photo per line. The written summary is not enabled yet.</p>');
  genBtn.disabled = !haveHandoff;
  genBtn.title = haveHandoff ? 'Write the narrative with Nemotron' : 'Narrative generation not deployed yet';
}
genBtn.addEventListener('click', async () => {
  genBtn.disabled = true; genBtn.textContent = 'Writing…';
  try { const since = visibleEvents().at(-1)?.tMicros ?? nowMicros(); const res = await callProcedure<any>('handoff', [since.toString()]); narrative = typeof res === 'string' ? res : (res?.text ?? JSON.stringify(res)); }
  catch (e) { console.error(e); narrative = 'The summary could not be written right now. The facts below are still current.'; }
  finally { genBtn.textContent = 'Generate'; renderRail(); }
});

askForm.addEventListener('submit', async e => {
  e.preventDefault(); const q = askInput.value.trim(); if (!q) return;
  answerEl.innerHTML = '<p class="muted">Thinking…</p>';
  if (!haveAsk) { answerEl.innerHTML = `<p class="muted">Questions are not enabled on this floor yet. The handoff above already answers “what changed” and “who was where”.</p>`; return; }
  try { const res = await callProcedure<any>('ask', [q]); const answer = typeof res === 'string' ? res : res?.answer ?? JSON.stringify(res); const cites: string[] = Array.isArray(res?.citations) ? res.citations : []; answerEl.innerHTML = `<p>${esc(String(answer))}</p>${cites.length ? `<p>${cites.map(cite).join(' ')}</p>` : ''}`; }
  catch (err) { console.error(err); answerEl.innerHTML = `<p class="muted">No answer right now. Try again in a moment, or read the handoff.</p>`; }
});

async function renderDrawer() {
  const id = state.selected; if (!id || !state.events.has(id)) { drawer.hidden = true; return; }
  const e = state.events.get(id)!; drawer.hidden = false;
  drawerTitle.textContent = `${fmtTime(e.tMicros)} · ${wearerName(e.deviceId)}`;
  const url = state.photos.get(id) ?? await loadPhoto(id); if (url) drawerImg.src = url; else drawerImg.removeAttribute('src');
  const p = perception(e); const place = placeOf(id); const assets = assetsOf(id);
  const rows: [string, string][] = [
    ['Summary', e.summary && e.confidence > 0 ? esc(e.summary) : `<span class="muted">${e.status === 'failed' ? 'This photo could not be read.' : e.summary ? 'Stored. Perception has not run on this photo yet.' : 'Reading the photo…'}</span>`],
    ['Status', `<span class="st ${e.status}">${e.status.replace('_', ' ')}</span>`],
    ['Place', place ? esc(place.canonicalName) : '—'],
    ['Assets', assets.length ? assets.map(a => esc(a.canonicalName)).join(', ') : '—'],
    ['Activity', esc(e.activity || '—')],
    ['People', String(e.peopleCount)],
    ['Confidence', e.confidence ? e.confidence.toFixed(2) : '—'],
  ];
  if (e.label) rows.push(['Label', `<b>${esc(e.label)}</b>`]);
  if (e.note) rows.push(['Note', `“${esc(e.note)}”`]);
  if (p?.text_in_scene?.length) rows.push(['Text read', `<ul>${p.text_in_scene.map((t: string) => `<li class="mono">${esc(String(t))}</li>`).join('')}</ul>`]);
  if (p?.changes_since_previous?.length) rows.push(['Changes', `<ul>${p.changes_since_previous.map((c: any) => `<li>${esc(String(c.entity))}: ${esc(String(c.from))} → ${esc(String(c.to))}</li>`).join('')}</ul>`]);
  const SOURCE: Record<string, string> = { shutter_button: 'glasses shutter', sdk_capture: 'app capture', camera_roll: 'camera roll import', manual_upload: 'manual upload' };
  const prov = `<details><summary>Provenance</summary><dl><dt>Source</dt><dd>${esc(SOURCE[e.source] ?? e.source)}</dd><dt>Captured</dt><dd class="mono">${esc(e.clientT.replace('T', ' ').slice(0, 19))}</dd><dt>Event</dt><dd class="mono">${e.eventId}</dd></dl></details>`;
  drawerFields.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('') + prov;
}
document.getElementById('drawer-close')!.addEventListener('click', () => select(null));
document.addEventListener('select', () => { if (state.selected) { (drawer.parentElement as HTMLElement).scrollTop = 0; setTimeout(() => (document.getElementById('drawer-close') as HTMLElement)?.focus(), 50); } });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !drawer.hidden) select(null); });

export function renderRail() { renderAlerts(); renderHandoff(); renderDrawer(); }
