// Live state fed by SpacetimeDB subscriptions. One store, many lenses.
import { DbConnection } from './module_bindings';

export const DB = new URLSearchParams(location.search).get('db') || 'wm-physical';
export const HOST = 'https://maincloud.spacetimedb.com';
export const WS = 'wss://maincloud.spacetimedb.com';

export type Ev = {
  eventId: string; deviceId: string; clientT: string; tMicros: bigint; source: string; status: string;
  note?: string; label?: string; scene: string; locationGuess: string; activity: string; summary: string;
  peopleCount: number; confidence: number; perceptionJson: string;
};
export type Ent = { entityId: string; canonicalName: string; kind: string; aliases: string[]; firstSeenMicros: bigint; lastSeenMicros: bigint };
export type Edge = { edgeId: bigint; fromId: string; toId: string; kind: string; props: string };
export type Episode = { episodeId: bigint; tStartMicros: bigint; tEndMicros: bigint; title: string; summary: string; eventIds: string[] };
export type Handoff = { handoffId: bigint; sinceMicros: bigint; generatedMicros: bigint; text: string; eventIds: string[] };
export type Alert = { id: string; alertId: bigint; eventId: string; kind: 'critical' | 'warning'; rawKind: string; text: string; tMicros: bigint; assetId?: string; assetName?: string; deviceId: string; wearerName: string; acked: boolean; slackStatus: string };
export type Wearer = { deviceId: string; name: string; role: string; shift: string };
export type Asset = { assetId: string; name: string; assetType: string; location: string; patterns: string[] };
export type Loc = { eventId: string; deviceId: string; shiftId: string; tMicros: bigint; lat: number; lon: number; accuracyM: number; altM?: number; floor?: number; fixT: string; ageMs?: number };
export type TrackPoint = { pointId: string; deviceId: string; shiftId: string; tMicros: bigint; kind: string; lat: number; lon: number; accuracyM: number; floor?: number };

export const state = {
  events: new Map<string, Ev>(),
  entities: new Map<string, Ent>(),
  edges: [] as Edge[],
  episodes: new Map<string, Episode>(),
  handoffs: [] as Handoff[],
  alerts: new Map<string, Alert>(),
  wearers: new Map<string, Wearer>(),
  assets: new Map<string, Asset>(),
  photos: new Map<string, string>(), // eventId -> data URL
  locations: new Map<string, Loc>(), // eventId -> where the photo was taken (#20)
  track: new Map<string, TrackPoint>(), // pointId -> shift track point (#20)
  selected: null as string | null,
  windowMin: 0 as number, // 0 = all
  hiddenWearers: new Set<string>(),
  connected: false,
  fresh: new Set<string>(),
  assetFilter: null as string | null,
};

type Listener = () => void;
const listeners = new Set<Listener>();
let scheduled = false;
export function onChange(fn: Listener) { listeners.add(fn); return () => listeners.delete(fn); }
export function notify() {
  if (scheduled) return; scheduled = true;
  requestAnimationFrame(() => { scheduled = false; for (const l of listeners) l(); });
}

// ---------- derived ----------
const cssVar = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
export const WEARER_COLORS = ['--w1', '--w2', '--w3', '--w4', '--w5', '--w6'];
const wearerIndex = new Map<string, number>();
export function wearerColor(deviceId: string): string {
  if (!wearerIndex.has(deviceId)) wearerIndex.set(deviceId, wearerIndex.size);
  return cssVar(WEARER_COLORS[wearerIndex.get(deviceId)! % WEARER_COLORS.length]) || '#2a78d6';
}
export function wearerName(deviceId: string): string {
  const w = state.wearers.get(deviceId); if (w?.name) return w.name;
  return deviceId.replace(/[-_]?(iphone|phone|device)$/i, '') || deviceId;
}
export function nowMicros(): bigint { return BigInt(Date.now()) * 1000n; }
export function fmtTime(micros: bigint): string {
  return new Date(Number(micros / 1000n)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
export function visibleEvents(): Ev[] {
  const cutoff = state.windowMin ? nowMicros() - BigInt(state.windowMin) * 60_000_000n : 0n;
  return [...state.events.values()]
    .filter(e => e.tMicros >= cutoff && !state.hiddenWearers.has(e.deviceId))
    .filter(e => !state.assetFilter || edgesFrom(e.eventId).some(ed => ed.toId === state.assetFilter))
    .sort((a, b) => (a.tMicros < b.tMicros ? 1 : a.tMicros > b.tMicros ? -1 : 0));
}
export function perception(e: Ev): any { try { return e.perceptionJson ? JSON.parse(e.perceptionJson) : null; } catch { return null; } }
export function edgesFrom(id: string, kind?: string) { return state.edges.filter(x => x.fromId === id && (!kind || x.kind === kind)); }
export function props(e: Edge): any { try { return JSON.parse(e.props || '{}'); } catch { return {}; } }
export function placeOf(eventId: string): Ent | undefined {
  const e = edgesFrom(eventId, 'INVOLVES').find(x => props(x).role === 'setting');
  return e ? state.entities.get(e.toId) : undefined;
}
export function assetsOf(eventId: string): Ent[] {
  return edgesFrom(eventId, 'INVOLVES').filter(x => props(x).role !== 'setting').map(x => state.entities.get(x.toId)).filter((x): x is Ent => !!x);
}
// One name per asset on every surface: the registry code (PDU-A) when the registry name is long,
// otherwise the name itself. Objects that are not in the registry keep their perceived name.
export function displayName(ent: Ent): string {
  if (ent.kind === 'asset' && ent.canonicalName.length > 12) {
    const code = ent.entityId.toUpperCase().replace(/_/g, '-');
    if (state.assets.has(code)) return code;
  }
  return ent.canonicalName;
}
// Alerts are rows written by the module's rule in `perceive`; the browser derives nothing.
export function alertsFor(e: Ev): Alert[] { return [...state.alerts.values()].filter(a => a.eventId === e.eventId); }
export function openAlerts(): Alert[] {
  const vis = new Set(visibleEvents().map(e => e.eventId));
  return [...state.alerts.values()].filter(a => !a.acked && vis.has(a.eventId)).sort((a, b) => (a.tMicros < b.tMicros ? 1 : -1));
}
export function allAlerts(): Alert[] { return openAlerts(); }
export async function ackAlert(alertId: bigint) { await callProcedure('ack_alert', [Number(alertId)]); }

// ---------- photos (lazy, via SQL endpoint) ----------
const photoCol = 'jpeg_b_64';
const inflight = new Set<string>();
export async function loadPhoto(eventId: string): Promise<string | undefined> {
  if (state.photos.has(eventId)) return state.photos.get(eventId);
  if (inflight.has(eventId)) return; inflight.add(eventId);
  try {
    const r = await fetch(`${HOST}/v1/database/${DB}/sql`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: `SELECT mime, ${photoCol} FROM photo WHERE event_id = '${eventId.replace(/'/g, '')}'` });
    const [res] = await r.json(); const row = res.rows?.[0]; if (!row) return;
    const url = `data:${row[0]};base64,${row[1]}`; state.photos.set(eventId, url); notify(); return url;
  } finally { inflight.delete(eventId); }
}

// ---------- procedures over HTTP (same path the phone uses) ----------
export async function callProcedure<T = any>(name: string, args: unknown[]): Promise<T> {
  const r = await fetch(`${HOST}/v1/database/${DB}/call/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  const text = await r.text(); try { return JSON.parse(text); } catch { return text as unknown as T; }
}
export async function hasProcedure(name: string): Promise<boolean> {
  // Procedures are listed under misc_exports; a table of the same name (handoff) must not count.
  try { const r = await fetch(`${HOST}/v1/database/${DB}/schema?version=9`); if (!r.ok) return false; const s = await r.json(); return (s.misc_exports ?? []).some((x: any) => x?.Procedure?.name === name); } catch { return false; }
}

// ---------- connection ----------
export function connect(onState: (s: 'connecting' | 'live' | 'error', msg?: string) => void) {
  const toEv = (r: any): Ev => ({ eventId: r.eventId, deviceId: r.deviceId, clientT: r.clientT, tMicros: BigInt(r.tMicros), source: r.source, status: r.status, note: r.note ?? undefined, label: r.label ?? undefined, scene: r.scene, locationGuess: r.locationGuess, activity: r.activity, summary: r.summary, peopleCount: Number(r.peopleCount), confidence: Number(r.confidence), perceptionJson: r.perceptionJson });
  DbConnection.builder()
    .withUri(WS)
    .withDatabaseName(DB)
    .onConnect((conn) => {
      state.connected = true; onState('live');
      conn.db.event.onInsert((_c, r) => { const e = toEv(r); state.events.set(e.eventId, e); state.fresh.add(e.eventId); setTimeout(() => { state.fresh.delete(e.eventId); notify(); }, 1200); notify(); });
      conn.db.event.onUpdate((_c, _o, r) => { const e = toEv(r); state.events.set(e.eventId, e); notify(); });
      conn.db.event.onDelete((_c, r) => { state.events.delete(r.eventId); notify(); });
      conn.db.entity.onInsert((_c, r) => { state.entities.set(r.entityId, { ...r, firstSeenMicros: BigInt(r.firstSeenMicros), lastSeenMicros: BigInt(r.lastSeenMicros), aliases: [...r.aliases] }); notify(); });
      conn.db.entity.onUpdate((_c, _o, r) => { state.entities.set(r.entityId, { ...r, firstSeenMicros: BigInt(r.firstSeenMicros), lastSeenMicros: BigInt(r.lastSeenMicros), aliases: [...r.aliases] }); notify(); });
      conn.db.edge.onInsert((_c, r) => { state.edges.push({ ...r, edgeId: BigInt(r.edgeId) }); notify(); });
      conn.db.edge.onDelete((_c, r) => { state.edges = state.edges.filter(x => x.edgeId !== BigInt(r.edgeId)); notify(); });
      conn.db.episode.onInsert((_c, r) => { state.episodes.set(String(r.episodeId), { ...r, episodeId: BigInt(r.episodeId), tStartMicros: BigInt(r.tStartMicros), tEndMicros: BigInt(r.tEndMicros), eventIds: [...r.eventIds] }); notify(); });
      conn.db.episode.onUpdate((_c, _o, r) => { state.episodes.set(String(r.episodeId), { ...r, episodeId: BigInt(r.episodeId), tStartMicros: BigInt(r.tStartMicros), tEndMicros: BigInt(r.tEndMicros), eventIds: [...r.eventIds] }); notify(); });
      conn.db.handoff.onInsert((_c, r) => { state.handoffs.push({ ...r, handoffId: BigInt(r.handoffId), sinceMicros: BigInt(r.sinceMicros), generatedMicros: BigInt(r.generatedMicros), eventIds: [...r.eventIds] }); notify(); });
      const toAlert = (r: any): Alert => ({ id: String(r.alertId), alertId: BigInt(r.alertId), eventId: r.eventId, rawKind: r.kind, kind: r.kind === 'anomaly' ? 'warning' : 'critical', text: r.text, tMicros: BigInt(r.tMicros), assetId: r.entityId || undefined, assetName: r.entityName || undefined, deviceId: r.deviceId, wearerName: r.wearerName, acked: !!r.acked, slackStatus: r.slackStatus });
      conn.db.alert.onInsert((_c, r) => { const a = toAlert(r); state.alerts.set(a.id, a); state.fresh.add(a.eventId); setTimeout(() => { state.fresh.delete(a.eventId); notify(); }, 1200); notify(); });
      conn.db.alert.onUpdate((_c, _o, r) => { const a = toAlert(r); state.alerts.set(a.id, a); notify(); });
      conn.db.alert.onDelete((_c, r) => { state.alerts.delete(String(r.alertId)); notify(); });
      const toLoc = (r: any): Loc => ({ eventId: r.eventId, deviceId: r.deviceId, shiftId: r.shiftId, tMicros: BigInt(r.tMicros), lat: Number(r.lat), lon: Number(r.lon), accuracyM: Number(r.accuracyM), altM: r.altM ?? undefined, floor: r.floor ?? undefined, fixT: r.fixT, ageMs: r.ageMs ?? undefined });
      conn.db.eventLocation.onInsert((_c, r) => { state.locations.set(r.eventId, toLoc(r)); notify(); });
      conn.db.eventLocation.onUpdate((_c, _o, r) => { state.locations.set(r.eventId, toLoc(r)); notify(); });
      conn.db.eventLocation.onDelete((_c, r) => { state.locations.delete(r.eventId); notify(); });
      const toPt = (r: any): TrackPoint => ({ pointId: String(r.pointId), deviceId: r.deviceId, shiftId: r.shiftId, tMicros: BigInt(r.tMicros), kind: r.kind, lat: Number(r.lat), lon: Number(r.lon), accuracyM: Number(r.accuracyM), floor: r.floor ?? undefined });
      conn.db.trackPoint.onInsert((_c, r) => { const p = toPt(r); state.track.set(p.pointId, p); notify(); });
      conn.db.trackPoint.onDelete((_c, r) => { state.track.delete(String(r.pointId)); notify(); });
      conn.db.wearer.onInsert((_c, r) => { state.wearers.set(r.deviceId, { ...r }); notify(); });
      conn.db.wearer.onUpdate((_c, _o, r) => { state.wearers.set(r.deviceId, { ...r }); notify(); });
      conn.db.asset.onInsert((_c, r) => { state.assets.set(r.assetId, { ...r, patterns: [...r.patterns] }); notify(); });
      conn.db.asset.onUpdate((_c, _o, r) => { state.assets.set(r.assetId, { ...r, patterns: [...r.patterns] }); notify(); });
      conn.subscriptionBuilder()
        .onApplied(() => notify())
        .subscribe(['SELECT * FROM event', 'SELECT * FROM entity', 'SELECT * FROM edge', 'SELECT * FROM episode', 'SELECT * FROM handoff', 'SELECT * FROM alert', 'SELECT * FROM wearer', 'SELECT * FROM asset', 'SELECT * FROM event_location', 'SELECT * FROM track_point']);
    })
    .onConnectError((_ctx, err) => { state.connected = false; onState('error', String(err?.message ?? err)); })
    .onDisconnect(() => { state.connected = false; onState('connecting', 'reconnecting'); })
    .build();
}
