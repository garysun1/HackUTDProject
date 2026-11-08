// Live tables over the Spacetime HTTP SQL endpoint (the same path the phone and the MCP server use).
// Polled every few seconds; the directory database's demo_config row names the dataset (decision 0029).
export const HOST = 'https://maincloud.spacetimedb.com';
export const DIRECTORY_DB = 'wm-physical';
const pinned = new URLSearchParams(location.search).get('db');

export type Wearer = { deviceId: string; name: string; role: string; shift: string };
export type Asset = { assetId: string; name: string; assetType: string; location: string };
export type Alert = { alertId: number; eventId: string; tMs: number; kind: string; text: string; entityId: string; entityName: string; deviceId: string; wearerName: string; acked: boolean; ackedMs?: number };
export type Ev = { eventId: string; deviceId: string; clientT: string; tMs: number; source: string; status: string; note?: string; label?: string; scene: string; locationGuess: string; activity: string; summary: string; peopleCount: number };
export type Loc = { eventId: string; deviceId: string; shiftId: string; tMs: number; lat: number; lon: number; accuracyM: number; altM?: number; floor?: number };
export type TrackPoint = { pointId: number; deviceId: string; shiftId: string; tMs: number; kind: string; lat: number; lon: number; accuracyM: number; altM?: number; floor?: number };
export type Handoff = { handoffId: number; sinceMs: number; generatedMs: number; text: string; eventIds: string[] };
export type Edge = { edgeId: number; fromId: string; toId: string; kind: string; props: any };
export type Entity = { entityId: string; canonicalName: string; kind: string };

export const state = {
  db: pinned || DIRECTORY_DB,
  pinned: !!pinned,
  connected: 'connecting' as 'connecting' | 'live' | 'error',
  version: 0,
  wearers: new Map<string, Wearer>(),
  assets: new Map<string, Asset>(),
  alerts: [] as Alert[],
  events: new Map<string, Ev>(),
  locations: new Map<string, Loc>(),
  track: [] as TrackPoint[],
  handoffs: [] as Handoff[],
  edges: [] as Edge[],
  entities: new Map<string, Entity>(),
  photos: new Map<string, string>(),
  lastError: '' as string,
};

type Listener = () => void;
const listeners = new Set<Listener>();
export function onChange(fn: Listener) { listeners.add(fn); return () => listeners.delete(fn); }
function bump() { state.version++; for (const l of listeners) l(); }

// ---------- SQL ----------
type Row = Record<string, any>;
function opt(v: any): any { return Array.isArray(v) ? (v[0] === 0 ? v[1] : undefined) : v; }
export async function sql(db: string, q: string): Promise<Row[]> {
  const r = await fetch(`${HOST}/v1/database/${db}/sql`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: q });
  if (!r.ok) throw new Error(`SQL ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const [res] = await r.json();
  const names: string[] = res.schema.elements.map((e: any) => e.name.some);
  return (res.rows as any[][]).map(row => { const o: Row = {}; names.forEach((n, i) => (o[n] = row[i])); return o; });
}
const us = (micros: any) => Number(micros) / 1000;

async function pull(db: string) {
  const [wearers, assets, alerts, events, locs, track, handoffs, edges, entities] = await Promise.all([
    sql(db, 'SELECT device_id, name, role, shift FROM wearer'),
    sql(db, 'SELECT asset_id, name, asset_type, location FROM asset'),
    sql(db, 'SELECT alert_id, event_id, t_micros, kind, text, entity_id, entity_name, device_id, wearer_name, acked, acked_micros FROM alert'),
    sql(db, 'SELECT event_id, device_id, client_t, t_micros, source, status, note, label, scene, location_guess, activity, summary, people_count FROM event'),
    sql(db, 'SELECT * FROM event_location') /* floor is a SQL keyword */,
    sql(db, 'SELECT * FROM track_point'),
    sql(db, 'SELECT handoff_id, since_micros, generated_micros, text, event_ids FROM handoff'),
    sql(db, 'SELECT edge_id, from_id, to_id, kind, props FROM edge'),
    sql(db, 'SELECT entity_id, canonical_name, kind FROM entity'),
  ]);
  if (db !== state.db) return; // dataset switched while in flight
  state.wearers = new Map(wearers.map(r => [r.device_id, { deviceId: r.device_id, name: r.name, role: r.role, shift: r.shift }]));
  state.assets = new Map(assets.map(r => [r.asset_id, { assetId: r.asset_id, name: r.name, assetType: r.asset_type, location: r.location }]));
  // story time: the phone's client_t (capture) rather than t_micros (receipt), so a replayed shift
  // plays at the hour it happened and photos land on the track at the same clock as their fixes
  const capMs = (r: any) => { const c = Date.parse(r.client_t); return Number.isFinite(c) ? c : us(r.t_micros); };
  const evCap = new Map<string, number>(events.map(r => [r.event_id, capMs(r)]));
  const shift = (serverMs: number) => { // the capture time of the photo received nearest to a server stamp
    let best: any = null; for (const r of events) { const d = Math.abs(us(r.t_micros) - serverMs); if (!best || d < best.d) best = { d, r }; }
    return best && best.d < 120_000 ? serverMs - us(best.r.t_micros) + capMs(best.r) : serverMs;
  };
  state.alerts = alerts.map(r => ({ alertId: Number(r.alert_id), eventId: r.event_id, tMs: evCap.get(r.event_id) ?? us(r.t_micros), kind: r.kind, text: r.text, entityId: r.entity_id, entityName: r.entity_name, deviceId: r.device_id, wearerName: r.wearer_name, acked: !!r.acked, ackedMs: opt(r.acked_micros) !== undefined ? shift(us(opt(r.acked_micros))) : undefined })).sort((a, b) => a.tMs - b.tMs);
  state.events = new Map(events.map(r => [r.event_id, { eventId: r.event_id, deviceId: r.device_id, clientT: r.client_t, tMs: capMs(r), source: r.source, status: r.status, note: opt(r.note), label: opt(r.label), scene: r.scene, locationGuess: r.location_guess, activity: r.activity, summary: r.summary, peopleCount: Number(r.people_count) }]));
  state.locations = new Map(locs.map(r => [r.event_id, { eventId: r.event_id, deviceId: r.device_id, shiftId: r.shift_id, tMs: evCap.get(r.event_id) ?? us(r.t_micros), lat: r.lat, lon: r.lon, accuracyM: r.accuracy_m, altM: opt(r.alt_m), floor: opt(r.floor) }]));
  state.track = track.map(r => ({ pointId: Number(r.point_id), deviceId: r.device_id, shiftId: r.shift_id, tMs: us(r.t_micros), kind: r.kind, lat: r.lat, lon: r.lon, accuracyM: r.accuracy_m, altM: opt(r.alt_m), floor: opt(r.floor) })).sort((a, b) => a.tMs - b.tMs);
  state.handoffs = handoffs.map(r => ({ handoffId: Number(r.handoff_id), sinceMs: us(r.since_micros), generatedMs: us(r.generated_micros), text: r.text, eventIds: r.event_ids ?? [] })).sort((a, b) => a.generatedMs - b.generatedMs);
  state.edges = edges.map(r => { let p: any = {}; try { p = JSON.parse(r.props || '{}'); } catch { } return { edgeId: Number(r.edge_id), fromId: r.from_id, toId: r.to_id, kind: r.kind, props: p }; });
  state.entities = new Map(entities.map(r => [r.entity_id, { entityId: r.entity_id, canonicalName: r.canonical_name, kind: r.kind }]));
}

// ---------- photos (lazy) ----------
const inflight = new Set<string>();
export async function loadPhoto(eventId: string): Promise<string | undefined> {
  if (state.photos.has(eventId)) return state.photos.get(eventId);
  if (inflight.has(eventId)) return; inflight.add(eventId);
  const db = state.db;
  try {
    const rows = await sql(db, `SELECT mime, jpeg_b_64 FROM photo WHERE event_id = '${eventId.replace(/'/g, '')}'`);
    const row = rows[0]; if (!row || db !== state.db) return;
    const url = `data:${row.mime};base64,${row.jpeg_b_64}`; state.photos.set(eventId, url); bump(); return url;
  } catch { return; } finally { inflight.delete(eventId); }
}

// ---------- loop ----------
function reset() {
  state.wearers.clear(); state.assets.clear(); state.alerts = []; state.events.clear(); state.locations.clear(); state.track = [];
  state.handoffs = []; state.edges = []; state.entities.clear(); state.photos.clear();
}
let timer: number | undefined;
export function start(intervalMs = 4000) {
  const tick = async () => {
    try {
      if (!state.pinned) {
        const rows = await sql(DIRECTORY_DB, "SELECT value FROM demo_config WHERE key = 'active_dataset'");
        const want = rows[0]?.value === 'live' || !rows[0]?.value ? DIRECTORY_DB : String(rows[0].value);
        if (want !== state.db) { state.db = want; reset(); bump(); }
      }
      await pull(state.db);
      state.connected = 'live'; state.lastError = '';
    } catch (e: any) {
      state.connected = 'error'; state.lastError = String(e?.message || e);
    }
    bump();
    timer = window.setTimeout(tick, intervalMs);
  };
  tick();
  return () => { if (timer) clearTimeout(timer); };
}

// ---------- derived helpers ----------
export const WEARER_COLORS = ['--w1', '--w2', '--w3', '--w4', '--w5', '--w6'];
const wearerIndex = new Map<string, number>();
export function cssVar(n: string) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
export function wearerColor(deviceId: string): string {
  if (!wearerIndex.has(deviceId)) wearerIndex.set(deviceId, wearerIndex.size);
  return cssVar(WEARER_COLORS[wearerIndex.get(deviceId)! % WEARER_COLORS.length]) || '#2a78d6';
}
export function wearerName(deviceId: string): string {
  const w = state.wearers.get(deviceId); if (w?.name) return w.name;
  return deviceId.replace(/^synth-[a-z0-9]+-[a-z]+-/, '').replace(/[-_]?(iphone|phone|device)$/i, '').replace(/^\w/, c => c.toUpperCase()) || deviceId;
}
export function fmtTime(ms: number): string { return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
export function fmtTimeS(ms: number): string { return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
export function alertsFor(eventId: string): Alert[] { return state.alerts.filter(a => a.eventId === eventId); }
export function placeOf(eventId: string): string | undefined {
  const e = state.edges.find(x => x.fromId === eventId && x.kind === 'INVOLVES' && x.props?.role === 'setting');
  return e ? state.entities.get(e.toId)?.canonicalName : undefined;
}
export function changesTo(eventId: string): { fromId: string; text: string }[] {
  return state.edges.filter(x => x.kind === 'CHANGES' && x.toId === eventId).map(x => ({ fromId: x.fromId, text: x.props?.text || x.props?.summary || x.props?.change || 'changed' }));
}
