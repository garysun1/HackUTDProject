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
export type Alert = { id: string; eventId: string; kind: 'critical' | 'warning'; text: string; tMicros: bigint; assetId?: string };

export const state = {
  events: new Map<string, Ev>(),
  entities: new Map<string, Ent>(),
  edges: [] as Edge[],
  episodes: new Map<string, Episode>(),
  handoffs: [] as Handoff[],
  photos: new Map<string, string>(), // eventId -> data URL
  selected: null as string | null,
  windowMin: 0 as number, // 0 = all
  hiddenWearers: new Set<string>(),
  connected: false,
  fresh: new Set<string>(),
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
export const WEARER_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#9085e9'];
const wearerIndex = new Map<string, number>();
export function wearerColor(deviceId: string): string {
  if (!wearerIndex.has(deviceId)) wearerIndex.set(deviceId, wearerIndex.size);
  return WEARER_COLORS[wearerIndex.get(deviceId)! % WEARER_COLORS.length];
}
export function wearerName(deviceId: string): string { return deviceId.length > 12 ? deviceId.slice(0, 8) : deviceId; }
export function nowMicros(): bigint { return BigInt(Date.now()) * 1000n; }
export function fmtTime(micros: bigint): string {
  return new Date(Number(micros / 1000n)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
export function visibleEvents(): Ev[] {
  const cutoff = state.windowMin ? nowMicros() - BigInt(state.windowMin) * 60_000_000n : 0n;
  return [...state.events.values()]
    .filter(e => e.tMicros >= cutoff && !state.hiddenWearers.has(e.deviceId))
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
const WARN = /\b(FAULT|ALARM|ERROR|OVERTEMP|OVER ?CURRENT|CRITICAL|DO NOT|WARNING|TRIPPED|LEAK)\b/i;
export function alertsFor(e: Ev): Alert[] {
  const out: Alert[] = []; const p = perception(e); if (!p) return out;
  const assets = assetsOf(e.eventId); const assetId = assets[0]?.entityId;
  for (const t of (p.text_in_scene ?? [])) if (typeof t === 'string' && WARN.test(t)) out.push({ id: `${e.eventId}:${t}`, eventId: e.eventId, kind: /FAULT|ALARM|CRITICAL|TRIPPED|LEAK/i.test(t) ? 'critical' : 'warning', text: t, tMicros: e.tMicros, assetId });
  for (const c of (p.changes_since_previous ?? [])) { const to = String(c?.to ?? ''); if (WARN.test(to)) out.push({ id: `${e.eventId}:${c.entity}:${to}`, eventId: e.eventId, kind: 'critical', text: `${c.entity}: ${c.from} → ${to}`, tMicros: e.tMicros, assetId }); }
  return out;
}
export function allAlerts(): Alert[] { return visibleEvents().flatMap(alertsFor); }

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
  try { const r = await fetch(`${HOST}/v1/database/${DB}/schema?version=9`); if (!r.ok) return false; return (await r.text()).includes(`"${name}"`); } catch { return false; }
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
      conn.subscriptionBuilder()
        .onApplied(() => notify())
        .subscribe(['SELECT * FROM event', 'SELECT * FROM entity', 'SELECT * FROM edge', 'SELECT * FROM episode', 'SELECT * FROM handoff']);
    })
    .onConnectError((_ctx, err) => { state.connected = false; onState('error', String(err?.message ?? err)); })
    .onDisconnect(() => { state.connected = false; onState('connecting', 'reconnecting'); })
    .build();
}
