import { state, visibleEvents, allAlerts, ackAlert, edgesFrom, props, placeOf, assetsOf, displayName, fmtTime, wearerName, wearerColor, loadPhoto, perception, callProcedure, hasProcedure, nowMicros, notify, type Ev, type Asset } from './store';
import { select, esc } from './timeline';

const alertsEl = document.getElementById('alerts') as HTMLUListElement;
const alertsEmpty = document.getElementById('alerts-empty') as HTMLElement;
const alertCount = document.getElementById('alert-count') as HTMLElement;
const handoffEl = document.getElementById('handoff') as HTMLElement;
const kpisEl = document.getElementById('kpis') as HTMLElement;
const coverageEl = document.getElementById('coverage') as HTMLElement; const coverageCount = document.getElementById('coverage-count') as HTMLElement;
const changesEl = document.getElementById('changes') as HTMLElement; const changesCount = document.getElementById('changes-count') as HTMLElement;
const notesEl = document.getElementById('notes') as HTMLElement;
const askPanel = document.getElementById('ask-panel') as HTMLElement;
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
for (const el of [handoffEl, answerEl, coverageEl, changesEl, notesEl, kpisEl]) el.addEventListener('click', e => {
  const c = (e.target as HTMLElement).closest('.cite') as HTMLElement | null; if (c?.dataset.id) { select(c.dataset.id); return; }
  const f = (e.target as HTMLElement).closest('[data-asset]') as HTMLElement | null; if (f) { state.assetFilter = state.assetFilter === f.dataset.asset ? null : f.dataset.asset!; notify(); }
});

// Age of a moment, for operators: "4 min", "2 h 10 min", "3 d".
function ago(micros: bigint): string {
  const m = Math.max(0, Math.round(Number((nowMicros() - micros) / 60_000_000n)));
  if (m < 1) return 'just now'; if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60); if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  return `${Math.floor(h / 24)} d`;
}
function whenSeen(micros: bigint): string {
  const d = new Date(Number(micros / 1000n)); const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? fmtTime(micros) : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${fmtTime(micros)}`;
}
const entityIdOf = (assetId: string) => assetId.toLowerCase().replace(/-/g, '_');

// Registry coverage: which assets the shift has and has not laid eyes on in this window.
function coverage() {
  const evs = visibleEvents(); const lastInWindow = new Map<string, Ev>();
  for (const e of evs) for (const a of assetsOf(e.eventId)) if (!lastInWindow.has(a.entityId)) lastInWindow.set(a.entityId, e); // evs are newest first
  const seen: { asset: Asset; ev: Ev }[] = [], missed: { asset: Asset; last?: bigint }[] = [];
  for (const asset of state.assets.values()) {
    const id = entityIdOf(asset.assetId); const ev = lastInWindow.get(id);
    if (ev) seen.push({ asset, ev }); else missed.push({ asset, last: state.entities.get(id)?.lastSeenMicros });
  }
  missed.sort((a, b) => Number((a.last ?? 0n) - (b.last ?? 0n)));
  return { seen, missed, total: state.assets.size };
}
function changes() {
  const out: { asset: string; line: string; id: string; t: bigint }[] = [];
  for (const e of visibleEvents()) for (const ed of edgesFrom(e.eventId, 'CHANGES')) { const p = props(ed); const ent = state.entities.get(ed.toId); const asset = ent ? displayName(ent) : ed.toId; out.push({ asset, line: `<b>${esc(asset)}</b>${p.attr ? ` ${esc(String(p.attr))}` : ''}: ${esc(String(p.from ?? '—'))} → ${esc(String(p.to ?? '—'))}`, id: e.eventId, t: e.tMicros }); }
  return out;
}

function renderKpis() {
  const evs = visibleEvents(); const alerts = allAlerts(); const cov = coverage(); const chg = changes();
  const oldest = alerts.length ? alerts.reduce((m, a) => (a.tMicros < m ? a.tMicros : m), alerts[0].tMicros) : null;
  const last = evs[0]; const lastAge = last ? Number((nowMicros() - last.tMicros) / 60_000_000n) : null;
  const pct = cov.total ? Math.round((cov.seen.length / cov.total) * 100) : 0;
  const tile = (label: string, value: string, sub: string, tone = '', extra = '') => `<div class="kpi ${tone}"><span class="kl">${label}</span><span class="kv">${value}</span>${extra}<span class="ks">${sub}</span></div>`;
  kpisEl.innerHTML =
    tile('Open alerts', String(alerts.length), alerts.length ? `oldest ${ago(oldest!)}` : 'all clear', alerts.length ? 'crit' : 'good') +
    tile('Assets inspected', cov.total ? `${cov.seen.length}<span class="kof"> of ${cov.total}</span>` : '—', cov.total ? (cov.missed.length ? `${cov.missed.length} not seen` : 'full coverage') : 'no registry loaded', cov.total && cov.missed.length ? 'warn' : '', cov.total ? `<span class="meter" role="img" aria-label="${pct}% of registry assets seen"><i style="width:${pct}%"></i></span>` : '') +
    tile('State changes', String(chg.length), chg.length ? `latest ${ago(chg[0].t)} ago` : 'none recorded') +
    tile('Last capture', last ? ago(last.tMicros) : '—', last ? `${esc(wearerName(last.deviceId))}${placeOf(last.eventId) ? ` · ${esc(placeOf(last.eventId)!.canonicalName)}` : ''}` : 'no photos in window', lastAge != null && lastAge > 60 ? 'warn' : '');
}
function renderCoverage() {
  const cov = coverage();
  coverageCount.textContent = cov.total ? `${cov.missed.length} of ${cov.total}` : '';
  if (!cov.total) { coverageEl.innerHTML = '<p class="muted">No asset registry loaded. Seed it with module/scripts/seed.mjs.</p>'; return; }
  let html = cov.missed.length
    ? `<ul>${cov.missed.map(m => `<li><span><b>${esc(m.asset.assetId)}</b> <span class="muted">${esc(m.asset.name)}${m.asset.location ? ` · ${esc(m.asset.location)}` : ''}</span></span><span class="when ${m.last ? '' : 'never'}">${m.last ? `last ${whenSeen(m.last)}` : 'never seen'}</span></li>`).join('')}</ul>`
    : '<p class="good">Every registry asset was photographed in this window.</p>';
  if (cov.seen.length) html += `<p class="seen">Seen: ${cov.seen.map(s => `<button type="button" class="asset-chip" data-asset="${entityIdOf(s.asset.assetId)}" aria-pressed="${state.assetFilter === entityIdOf(s.asset.assetId)}" title="Last ${fmtTime(s.ev.tMicros)} by ${esc(wearerName(s.ev.deviceId))}">${esc(s.asset.assetId)}</button>`).join(' ')}</p>`;
  coverageEl.innerHTML = html;
}
function renderChanges() {
  const chg = changes(); changesCount.textContent = chg.length ? String(chg.length) : '';
  changesEl.innerHTML = chg.length ? `<ul>${chg.map(c => `<li><span>${c.line}</span>${cite(c.id)}</li>`).join('')}</ul>` : '<p class="muted">No state changes recorded in this window.</p>';
}
function renderNotes() {
  const evs = visibleEvents().filter(e => e.note || e.label);
  const low = visibleEvents().filter(e => e.status === 'in_graph' && e.confidence > 0 && e.confidence < 0.5);
  let html = evs.length ? `<ul>${evs.map(e => `<li><span>${e.label ? `<b>${esc(e.label)}</b> ` : ''}${e.note ? `“${esc(e.note)}”` : ''}</span>${cite(e.eventId)}</li>`).join('')}</ul>` : '<p class="muted">No notes left in this window.</p>';
  if (low.length) html += `<h3>Uncertain reads</h3><ul>${low.map(e => `<li><span>${esc(e.summary)}</span>${cite(e.eventId)}</li>`).join('')}</ul>`;
  notesEl.innerHTML = html;
}

function renderAlerts() {
  const alerts = allAlerts();
  alertCount.textContent = alerts.length ? String(alerts.length) : ''; alertsEmpty.hidden = alerts.length > 0; alertsEl.innerHTML = '';
  for (const a of alerts) {
    const li = document.createElement('li'); li.className = 'alert';
    const assetEnt = a.assetId ? state.entities.get(a.assetId) : undefined;
    const asset = assetEnt ? displayName(assetEnt) : a.assetName;
    const who = a.wearerName || wearerName(a.deviceId);
    const busy = acking.has(a.id);
    li.innerHTML = `<button class="alert-open" type="button" data-open="${esc(a.eventId)}" aria-label="Open photo for ${esc(a.text)}">${ICON[a.kind]}<span><span class="txt">${asset ? `${esc(asset)} · ` : ''}${esc(a.text)}</span><span class="t">open ${ago(a.tMicros)} · ${fmtTime(a.tMicros)} · ${esc(who)} · ${esc(a.rawKind.replace('_', ' '))}</span></span></button><button class="btn ghost" type="button" data-ack="${esc(a.id)}" ${busy ? 'disabled' : ''}>${busy ? '…' : 'Acknowledge'}</button>`;
    li.querySelector('[data-open]')!.addEventListener('click', () => select(a.eventId));
    li.querySelector('[data-ack]')!.addEventListener('click', async () => { acking.add(a.id); renderRail(); try { await ackAlert(a.alertId); } catch (e) { console.error(e); } finally { acking.delete(a.id); renderRail(); } });
    alertsEl.appendChild(li);
  }
}

// Handoff: the written narrative from the module's `handoff` procedure. The panels above are the facts.
let narrative: string | null = null;
function renderHandoff() {
  const evs = visibleEvents(); const latest = state.handoffs[state.handoffs.length - 1];
  const wearers = [...new Set(evs.map(e => e.deviceId))];
  const scope = evs.length ? `<p class="lead">${fmtTime(evs[evs.length - 1].tMicros)}–${fmtTime(evs[0].tMicros)} · ${evs.length} photos · ${wearers.map(w => `<span class="who"><i style="background:${wearerColor(w)}"></i>${esc(wearerName(w))}</span>`).join(', ')}</p>` : '<p class="muted">Nothing in this window yet.</p>';
  const text = narrative ?? latest?.text ?? null;
  handoffEl.innerHTML = scope + (text ? `<p class="narrative">${esc(text)}</p>` : `<p class="muted">${haveHandoff ? 'Generate writes the handoff from the facts above, every line cited.' : 'The written handoff is not enabled on this floor yet. The panels above are the handoff.'}</p>`);
  genBtn.disabled = !haveHandoff; genBtn.classList.toggle('primary', haveHandoff);
  genBtn.title = haveHandoff ? 'Write the narrative with Nemotron' : 'Narrative generation not deployed yet';
  askPanel.hidden = !haveAsk;
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
    ['Assets', assets.filter(a => a.kind === 'asset').length ? assets.filter(a => a.kind === 'asset').map(a => `<span title="${esc(a.canonicalName)}">${esc(displayName(a))}</span>`).join(', ') : '<span class="muted">none in registry</span>'],
    ...(assets.some(a => a.kind !== 'asset') ? [['Also seen', assets.filter(a => a.kind !== 'asset').map(a => esc(a.canonicalName)).join(', ')] as [string, string]] : []),
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

export function renderRail() { renderKpis(); renderAlerts(); renderCoverage(); renderChanges(); renderNotes(); renderHandoff(); renderDrawer(); }
