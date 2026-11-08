// Read access to the wm-physical SpacetimeDB module over its HTTP API.
// Tables are public; procedures/reducers are called through /call/<name>.
const HOST = (process.env.SPACETIME_HOST || 'https://maincloud.spacetimedb.com').replace(/\/+$/, '');
// The directory database holds demo_config.active_dataset naming the database to read (decision
// 0029). SPACETIME_DB_NAME pins one and ignores the switch.
const DIRECTORY = 'wm-physical';
const PINNED = process.env.SPACETIME_DB_NAME || '';
let dbCache = { t: 0, name: PINNED || DIRECTORY };
export async function activeDb() {
  if (PINNED) return PINNED;
  if (Date.now() - dbCache.t < 10_000) return dbCache.name;
  try {
    const r = await fetch(`${HOST}/v1/database/${DIRECTORY}/sql`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: "SELECT value FROM demo_config WHERE key = 'active_dataset'" });
    const [res] = await r.json(); const v = res?.rows?.[0]?.[0];
    dbCache = { t: Date.now(), name: (v && String(v).trim()) || DIRECTORY };
  } catch { dbCache.t = Date.now(); }
  return dbCache.name;
}
const TZ = process.env.WM_TZ || 'America/Chicago';

function decode(v) {
  // Option<T> arrives as [0, value] (some) or [1, []] (none); nested arrays of options too.
  if (Array.isArray(v) && v.length === 2 && (v[0] === 0 || v[0] === 1) && !(Array.isArray(v[1]) && v[1].length && v[0] === 0 && typeof v[1][0] === 'number' && v[1].length > 2)) {
    return v[0] === 0 ? decode(v[1]) : null;
  }
  return v;
}

export async function sql(query) {
  const DB = await activeDb();
  const r = await fetch(`${HOST}/v1/database/${DB}/sql`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: query });
  if (!r.ok) throw new Error(`sql ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const [res] = await r.json();
  const cols = res.schema.elements.map(e => e.name.some);
  return res.rows.map(row => Object.fromEntries(row.map((v, i) => [cols[i], decode(v)])));
}

export async function call(name, args) {
  const DB = await activeDb();
  const r = await fetch(`${HOST}/v1/database/${DB}/call/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${name} ${r.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return text; }
}

let schemaCache = { t: 0, names: new Set() };
export async function hasProcedure(name) {
  if (Date.now() - schemaCache.t > 30_000) {
    try {
      const r = await fetch(`${HOST}/v1/database/${DB}/schema?version=9`);
      // Procedures live under misc_exports; a table of the same name (handoff) must not count.
      const s = r.ok ? await r.json() : {};
      schemaCache = { t: Date.now(), names: new Set((s.misc_exports ?? []).map(x => x?.Procedure?.name).filter(Boolean)) };
    } catch { schemaCache = { t: Date.now(), names: new Set() }; }
  }
  return schemaCache.names.has(name);
}

// ---------- typed loaders (small tables; load whole, filter in memory) ----------
const esc = s => String(s).replace(/'/g, "''");
export const events = () => sql('SELECT event_id, device_id, client_t, t_micros, source, status, note, label, scene, location_guess, activity, summary, people_count, confidence, perception_json FROM event');
export const eventsWithEmbedding = () => sql('SELECT event_id, embedding FROM event');
export const entities = () => sql('SELECT entity_id, canonical_name, kind, aliases, first_seen_micros, last_seen_micros FROM entity');
export const edges = () => sql('SELECT edge_id, from_id, to_id, kind, props FROM edge');
export const alerts = () => sql('SELECT alert_id, event_id, t_micros, kind, text, entity_id, entity_name, device_id, wearer_name, acked, acked_micros, slack_status FROM alert');
export const wearers = () => sql('SELECT device_id, name, role, shift FROM wearer');
export const assets = () => sql('SELECT asset_id, name, asset_type, location, patterns FROM asset');
export const episodes = () => sql('SELECT episode_id, t_start_micros, t_end_micros, title, summary, event_ids FROM episode');
export const handoffs = () => sql('SELECT handoff_id, since_micros, generated_micros, text, event_ids FROM handoff');
export async function photo(eventId) {
  const rows = await sql(`SELECT mime, jpeg_b_64 FROM photo WHERE event_id = '${esc(eventId)}'`);
  return rows[0] ? { mime: rows[0].mime, b64: rows[0].jpeg_b_64 } : null;
}

// ---------- helpers ----------
export function fmtTime(micros) {
  return new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(new Date(Number(micros) / 1000));
}
export function fmtDateTime(micros) {
  return new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(Number(micros) / 1000));
}
export function parseSince(since) {
  // Accepts ISO string, "2h"/"45m"/"1d", or a unix millis number. Returns micros.
  if (since == null || since === '') return 0;
  if (typeof since === 'number') return since * 1000;
  const m = /^(\d+)\s*([mhd])$/.exec(String(since).trim());
  if (m) { const n = Number(m[1]); const ms = { m: 60e3, h: 3600e3, d: 86400e3 }[m[2]] * n; return (Date.now() - ms) * 1000; }
  const t = Date.parse(since); return Number.isNaN(t) ? 0 : t * 1000;
}
export function perception(e) { try { return e.perception_json ? JSON.parse(e.perception_json) : null; } catch { return null; } }
export function props(edge) { try { return JSON.parse(edge.props || '{}'); } catch { return {}; } }

export async function snapshot() {
  const [ev, en, ed, al, we, as, ep] = await Promise.all([events(), entities(), edges(), alerts(), wearers(), assets(), episodes()]);
  const wearerName = id => we.find(w => w.device_id === id)?.name || String(id).replace(/[-_]?(iphone|phone|device)$/i, '') || id;
  const entityById = new Map(en.map(x => [x.entity_id, x]));
  const byEvent = new Map();
  for (const e of ed) { if (!byEvent.has(e.from_id)) byEvent.set(e.from_id, []); byEvent.get(e.from_id).push(e); }
  const placeOf = id => { const e = (byEvent.get(id) || []).find(x => x.kind === 'INVOLVES' && props(x).role === 'setting'); return e ? entityById.get(e.to_id) : null; };
  const assetsOf = id => (byEvent.get(id) || []).filter(x => x.kind === 'INVOLVES' && props(x).role !== 'setting').map(x => entityById.get(x.to_id)).filter(Boolean);
  const changesOf = id => (byEvent.get(id) || []).filter(x => x.kind === 'CHANGES').map(x => ({ ...props(x), entity: entityById.get(x.to_id) }));
  // a photo's time is when it was taken (client_t); server time is the fallback (unparseable or > 7 days off)
  for (const e of ev) { const ms = Date.parse(e.client_t); if (Number.isFinite(ms)) { const c = Math.round(ms) * 1000; if (Math.abs(c - Number(e.t_micros)) <= 7 * 86_400_000_000) e.t_micros = c; } }
  ev.sort((a, b) => a.t_micros - b.t_micros);
  return { events: ev, entities: en, edges: ed, alerts: al, wearers: we, assets: as, episodes: ep, wearerName, entityById, placeOf, assetsOf, changesOf, byEvent };
}

export function matchEntity(snap, query) {
  const q = String(query || '').toLowerCase().trim(); if (!q) return [];
  const qs = q.replace(/[^a-z0-9]+/g, '_');
  return snap.entities.filter(e => e.entity_id === qs || e.entity_id.includes(qs) || e.canonical_name.toLowerCase().includes(q) || (e.aliases || []).some(a => String(a).toLowerCase().includes(q)))
    .sort((a, b) => (b.kind === 'asset') - (a.kind === 'asset'));
}

/** Shortest prefix (at least 8 chars) that names one event in this snapshot; synthetic ids share long prefixes. */
export function shortId(snap, id) {
  for (let n = 8; n <= id.length; n++) { const pre = id.slice(0, n); if (snap.events.filter(e => e.event_id.startsWith(pre)).length <= 1) return pre; }
  return id;
}
export function cite(snap, e) { return `[event:${shortId(snap, e.event_id)} ${fmtTime(e.t_micros)} ${snap.wearerName(e.device_id)}]`; }

export async function imageBlock(eventId) {
  const p = await photo(eventId); if (!p) return null;
  return { type: 'image', data: p.b64, mimeType: p.mime || 'image/jpeg' };
}

// ---------- questions: what was asked, answered by which moments (decision 0031) ----------
// Needs INGEST_TOKEN (or ADMIN_TOKEN) in the environment; without it, nothing is logged.
const QTOKEN = process.env.ADMIN_TOKEN || process.env.INGEST_TOKEN || '';
export async function logQuestion(tool, text, answerText, eventIds, asker = 'mcp client') {
  if (!QTOKEN || !text) return;
  const answer = String(answerText || '').split('\n').find(l => l.trim()) || '';
  try { await call('log_question', [QTOKEN, 'mcp', tool, String(text).slice(0, 400), answer.slice(0, 400), [...new Set(eventIds)].slice(0, 20), asker]); } catch { /* best effort */ }
}
/** Event ids cited in a block of answer text: [event:<id8> ...] back to full ids. */
export function citedIds(snap, text) {
  const out = []; for (const m of String(text || '').matchAll(/\[event:([0-9a-z-]{4,})/gi)) { const hits = snap.events.filter(x => x.event_id.startsWith(m[1])); if (hits.length === 1) out.push(hits[0].event_id); }
  return out;
}
