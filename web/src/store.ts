// Live state fed by SpacetimeDB subscriptions. One store, many lenses.
import { DbConnection } from './module_bindings';

// The directory database holds demo_config.active_dataset, which names the database to read
// (decision 0029). `?db=` in the URL pins one and ignores the switch.
export const DIRECTORY_DB = 'wm-physical';
const pinned = new URLSearchParams(location.search).get('db');
let chosen: string | null = null; try { chosen = localStorage.getItem('wm.db'); } catch { /* private mode */ }
export let DB = pinned || chosen || DIRECTORY_DB;
export function dbChosen() { return !!(pinned || chosen); }
// Which workspace, when several share a database (the weekend overlay sits on the live capture).
// `?ws=` pins one; otherwise the choice is remembered per browser next to the database.
const pinnedWs = new URLSearchParams(location.search).get('ws');
let chosenWs: string | null = null; try { chosenWs = localStorage.getItem('wm.ws'); } catch { /* private mode */ }
export let WS_ID: string | null = pinnedWs || (pinned ? null : chosenWs); // a URL that names the database means its first workspace, not the one this browser last chose
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
export type Alert = { id: string; alertId: bigint; eventId: string; kind: 'critical' | 'warning'; rawKind: string; text: string; tMicros: bigint; assetId?: string; assetName?: string; deviceId: string; wearerName: string; acked: boolean; ackedMicros?: bigint; slackStatus: string };
export type Wearer = { deviceId: string; name: string; role: string; shift: string };
export type Asset = { assetId: string; name: string; assetType: string; location: string; patterns: string[] };
export type Loc = { eventId: string; deviceId: string; shiftId: string; tMicros: bigint; lat: number; lon: number; accuracyM: number; altM?: number; floor?: number; fixT: string; ageMs?: number };
export type Question = { questionId: string; tMicros: bigint; source: string; tool: string; text: string; answer: string; eventIds: string[]; asker: string };
export type Issue = { issueId: string; title: string; assetId: string; openedBy: string; openedMicros: bigint; status: string; resolvedEventId?: string; resolvedMicros?: bigint; resolutionNote?: string };
export type Resolution = { id: string; alertId: string; eventId: string; deviceId: string; tMicros: bigint; how: string };
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
  questions: new Map<string, Question>(), // what was asked of the memory (decision 0031)
  issues: new Map<string, Issue>(), // work orders (#23)
  resolutions: new Map<string, Resolution>(), // alert resolutions with the photo that proved it (#23)
  selected: null as string | null,
  windowMin: 0 as number, // 0 = all
  // A static overlay laid over the live database (the weekend workspace). While one is active,
  // live rows older than its end are replaced by its curated copies; later live rows are shown
  // on top of it, and the ones the workspace names get a badge (decision 0033).
  overlay: null as null | { url: string; endMicros: bigint; badgeAfterMicros: bigint; ids: Set<string>; hideLive: Set<string>; badge: string },
  staticPhotos: new Map<string, string>(), // eventId -> URL of a photo shipped with an overlay
  badges: new Map<string, string>(), // eventId -> badge text
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
export function fmtTimeS(micros: bigint): string { return new Date(Number(micros / 1000n)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
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
// Photos load at most PHOTO_SLOTS at a time; a failed or empty fetch is not retried until its backoff
// has passed (the map and panel ask for every missing photo on every frame, so without this a slow or
// failing Maincloud turns into a stream of large requests that starves the page). A response that
// arrives after the workspace changed is dropped.
const PHOTO_SLOTS = 4; let photoActive = 0; const photoQueue: (() => void)[] = [];
const photoRetry = new Map<string, { at: number; n: number }>();
export async function loadPhoto(eventId: string): Promise<string | undefined> {
  if (state.photos.has(eventId)) return state.photos.get(eventId);
  const st = state.staticPhotos.get(eventId); if (st) { state.photos.set(eventId, st); return st; }
  if (inflight.has(eventId)) return;
  const wait = photoRetry.get(eventId); if (wait && Date.now() < wait.at) return;
  inflight.add(eventId);
  const db = DB, gen = generation;
  if (photoActive >= PHOTO_SLOTS) await new Promise<void>(r => photoQueue.push(r));
  photoActive++;
  let ok = false;
  try {
    if (gen !== generation) return; // the workspace changed while this waited in the queue
    const r = await fetch(`${HOST}/v1/database/${db}/sql`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: `SELECT mime, ${photoCol} FROM photo WHERE event_id = '${eventId.replace(/'/g, '')}'` });
    if (!r.ok) return;
    const [res] = await r.json(); const row = res?.rows?.[0]; if (!row) return;
    if (gen !== generation) return;
    const url = `data:${row[0]};base64,${row[1]}`; state.photos.set(eventId, url); ok = true; photoRetry.delete(eventId); notify(); return url;
  } catch { return; } finally {
    inflight.delete(eventId); photoActive--; photoQueue.shift()?.();
    if (!ok && gen === generation) { const n = (photoRetry.get(eventId)?.n ?? 0) + 1; photoRetry.set(eventId, { n, at: Date.now() + Math.min(60_000, 2_000 * 2 ** (n - 1)) }); }
  }
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
type OnState = (s: 'connecting' | 'live' | 'error', msg?: string) => void;
let generation = 0; let dataConn: any = null;
function resetState() {
  state.events.clear(); state.entities.clear(); state.edges = []; state.episodes.clear(); state.handoffs = []; state.alerts.clear();
  wearerIndex.clear(); // colours are per workspace: its first wearer is always blue, whatever was visited before
  state.wearers.clear(); state.assets.clear(); state.photos.clear(); state.locations.clear(); state.track.clear(); state.questions.clear(); state.issues.clear(); state.resolutions.clear();
  state.selected = null; state.fresh.clear(); state.assetFilter = null; state.hiddenWearers.clear();
  state.overlay = null; state.staticPhotos.clear(); state.badges.clear(); photoRetry.clear();
}
// The overlay module (overlay.ts) registers itself here, so the store need not know the workspace list.
let overlayLoader: ((db: string, wsId: string | null) => void) | null = null;
export function setOverlayLoader(fn: (db: string, wsId: string | null) => void) { overlayLoader = fn; }
/** Does a live row belong on screen while an overlay is active? Rows the overlay already carries,
 *  rows it hides, and rows older than its end (which it replaces) do not. */
export function liveRowOk(id: string | null, tMicros: bigint | null): boolean {
  const o = state.overlay; if (!o) return true;
  if (id && (o.ids.has(id) || o.hideLive.has(id))) return false;
  if (tMicros !== null && tMicros <= o.endMicros) return false;
  return true;
}
/** A live photo that arrives after the overlay ends is the moment the workspace was built for. */
/** A live photo with people in it, taken after the record and after `badgeAfter` (the demo), is the
 *  moment the workspace was built for; a photo of a panel or a cable on stage is not. Called on
 *  insert and again on update, since the people count arrives with perception. */
export function badgeLive(e: Ev) { const o = state.overlay; if (o && o.badge && !o.ids.has(e.eventId) && e.tMicros > o.badgeAfterMicros && e.peopleCount >= 1 && !state.badges.has(e.eventId)) state.badges.set(e.eventId, o.badge); }
function connectData(onState: OnState) {
  const gen = ++generation;
  if (dataConn) { try { dataConn.disconnect(); } catch { /* already closed */ } dataConn = null; }
  resetState(); notify();
  overlayLoader?.(DB, WS_ID);
  const live = () => gen === generation; // callbacks from a replaced connection are ignored
  // A photo's time is when it was taken (client_t); the server receive time is the fallback when the
  // phone clock is unparseable or more than a week off. Replays of past shifts keep their own clock.
  const takenMicros = (r: any): bigint => { const ms = Date.parse(r.clientT); const srv = BigInt(r.tMicros); if (!Number.isFinite(ms)) return srv; const c = BigInt(Math.round(ms)) * 1000n; const d = c > srv ? c - srv : srv - c; return d > 7n * 86_400_000_000n ? srv : c; };
  const toEv = (r: any): Ev => ({ eventId: r.eventId, deviceId: r.deviceId, clientT: r.clientT, tMicros: takenMicros(r), source: r.source, status: r.status, note: r.note ?? undefined, label: r.label ?? undefined, scene: r.scene, locationGuess: r.locationGuess, activity: r.activity, summary: r.summary, peopleCount: Number(r.peopleCount), confidence: Number(r.confidence), perceptionJson: r.perceptionJson });
  dataConn = DbConnection.builder()
    .withUri(WS)
    .withDatabaseName(DB)
    .onConnect((conn) => {
      if (!live()) return;
      state.connected = true; onState('live');
      const on = <T extends any[]>(fn: (...a: T) => void) => (...a: T) => { if (live()) fn(...a); };
      conn.db.event.onInsert(on((_c: any, r: any) => { const e = toEv(r); if (!liveRowOk(e.eventId, e.tMicros)) return; badgeLive(e); state.events.set(e.eventId, e); state.fresh.add(e.eventId); setTimeout(() => { state.fresh.delete(e.eventId); notify(); }, 1200); notify(); }));
      conn.db.event.onUpdate(on((_c: any, _o: any, r: any) => { const e = toEv(r); if (!liveRowOk(e.eventId, e.tMicros)) return; badgeLive(e); state.events.set(e.eventId, e); notify(); }));
      conn.db.event.onDelete(on((_c: any, r: any) => { if (state.overlay?.ids.has(r.eventId)) return; state.events.delete(r.eventId); notify(); }));
      conn.db.entity.onInsert(on((_c: any, r: any) => { state.entities.set(r.entityId, { ...r, firstSeenMicros: BigInt(r.firstSeenMicros), lastSeenMicros: BigInt(r.lastSeenMicros), aliases: [...r.aliases] }); notify(); }));
      conn.db.entity.onUpdate(on((_c: any, _o: any, r: any) => { state.entities.set(r.entityId, { ...r, firstSeenMicros: BigInt(r.firstSeenMicros), lastSeenMicros: BigInt(r.lastSeenMicros), aliases: [...r.aliases] }); notify(); }));
      conn.db.edge.onInsert(on((_c: any, r: any) => { state.edges.push({ ...r, edgeId: BigInt(r.edgeId) }); notify(); }));
      conn.db.edge.onDelete(on((_c: any, r: any) => { state.edges = state.edges.filter(x => x.edgeId !== BigInt(r.edgeId)); notify(); }));
      conn.db.episode.onInsert(on((_c: any, r: any) => { state.episodes.set(String(r.episodeId), { ...r, episodeId: BigInt(r.episodeId), tStartMicros: BigInt(r.tStartMicros), tEndMicros: BigInt(r.tEndMicros), eventIds: [...r.eventIds] }); notify(); }));
      conn.db.episode.onUpdate(on((_c: any, _o: any, r: any) => { state.episodes.set(String(r.episodeId), { ...r, episodeId: BigInt(r.episodeId), tStartMicros: BigInt(r.tStartMicros), tEndMicros: BigInt(r.tEndMicros), eventIds: [...r.eventIds] }); notify(); }));
      conn.db.handoff.onInsert(on((_c: any, r: any) => { state.handoffs.push({ ...r, handoffId: BigInt(r.handoffId), sinceMicros: BigInt(r.sinceMicros), generatedMicros: BigInt(r.generatedMicros), eventIds: [...r.eventIds] }); notify(); }));
      const toAlert = (r: any): Alert => ({ id: String(r.alertId), alertId: BigInt(r.alertId), eventId: r.eventId, rawKind: r.kind, kind: r.kind === 'anomaly' ? 'warning' : 'critical', text: r.text, tMicros: BigInt(r.tMicros), assetId: r.entityId || undefined, assetName: r.entityName || undefined, deviceId: r.deviceId, wearerName: r.wearerName, acked: !!r.acked, ackedMicros: r.ackedMicros != null ? BigInt(r.ackedMicros) : undefined, slackStatus: r.slackStatus });
      conn.db.alert.onInsert(on((_c: any, r: any) => { const a = toAlert(r); if (!liveRowOk(a.eventId, a.tMicros)) return; state.alerts.set(a.id, a); state.fresh.add(a.eventId); setTimeout(() => { state.fresh.delete(a.eventId); notify(); }, 1200); notify(); }));
      conn.db.alert.onUpdate(on((_c: any, _o: any, r: any) => { const a = toAlert(r); if (!liveRowOk(a.eventId, a.tMicros)) return; state.alerts.set(a.id, a); notify(); }));
      conn.db.alert.onDelete(on((_c: any, r: any) => { state.alerts.delete(String(r.alertId)); notify(); }));
      const toLoc = (r: any): Loc => ({ eventId: r.eventId, deviceId: r.deviceId, shiftId: r.shiftId, tMicros: BigInt(r.tMicros), lat: Number(r.lat), lon: Number(r.lon), accuracyM: Number(r.accuracyM), altM: r.altM ?? undefined, floor: r.floor ?? undefined, fixT: r.fixT, ageMs: r.ageMs ?? undefined });
      conn.db.eventLocation.onInsert(on((_c: any, r: any) => { const l = toLoc(r); if (!liveRowOk(l.eventId, l.tMicros)) return; state.locations.set(r.eventId, l); notify(); }));
      conn.db.eventLocation.onUpdate(on((_c: any, _o: any, r: any) => { const l = toLoc(r); if (!liveRowOk(l.eventId, l.tMicros)) return; state.locations.set(r.eventId, l); notify(); }));
      conn.db.eventLocation.onDelete(on((_c: any, r: any) => { if (state.overlay?.ids.has(r.eventId)) return; state.locations.delete(r.eventId); notify(); }));
      // A track point's time is the phone's clock (`t`), like a photo's capture time; the server
      // micros are the fallback, and the only time a replayed dataset would otherwise show (#26).
      const walkedMicros = (r: any): bigint => { const srv = BigInt(r.tMicros); const ms = Date.parse(r.t); if (!Number.isFinite(ms)) return srv; const c = BigInt(Math.round(ms)) * 1000n; const d = c > srv ? c - srv : srv - c; return d > 7n * 86_400_000_000n ? srv : c; };
      const toPt = (r: any): TrackPoint => ({ pointId: String(r.pointId), deviceId: r.deviceId, shiftId: r.shiftId, tMicros: walkedMicros(r), kind: r.kind, lat: Number(r.lat), lon: Number(r.lon), accuracyM: Number(r.accuracyM), floor: r.floor ?? undefined });
      conn.db.trackPoint.onInsert(on((_c: any, r: any) => { const p = toPt(r); if (!liveRowOk(null, p.tMicros)) return; state.track.set(p.pointId, p); notify(); }));
      conn.db.trackPoint.onDelete(on((_c: any, r: any) => { state.track.delete(String(r.pointId)); notify(); }));
      const toQ = (r: any): Question => ({ questionId: String(r.questionId), tMicros: BigInt(r.tMicros), source: r.source, tool: r.tool, text: r.text, answer: r.answer, eventIds: [...r.eventIds], asker: r.asker });
      conn.db.question.onInsert(on((_c: any, r: any) => { const q = toQ(r); state.questions.set(q.questionId, q); state.fresh.add('q:' + q.questionId); setTimeout(() => { state.fresh.delete('q:' + q.questionId); notify(); }, 1500); notify(); }));
      conn.db.question.onDelete(on((_c: any, r: any) => { state.questions.delete(String(r.questionId)); notify(); }));
      const toIssue = (r: any): Issue => ({ issueId: r.issueId, title: r.title, assetId: r.assetId, openedBy: r.openedBy, openedMicros: BigInt(r.openedMicros), status: r.status, resolvedEventId: r.resolvedEventId ?? undefined, resolvedMicros: r.resolvedMicros != null ? BigInt(r.resolvedMicros) : undefined, resolutionNote: r.resolutionNote ?? undefined });
      conn.db.issue.onInsert(on((_c: any, r: any) => { if (state.overlay) return; state.issues.set(r.issueId, toIssue(r)); notify(); })); // an overlay carries its own problems; the live sample work orders stay out of it
      conn.db.issue.onUpdate(on((_c: any, _o: any, r: any) => { if (state.overlay) return; state.issues.set(r.issueId, toIssue(r)); notify(); }));
      conn.db.issue.onDelete(on((_c: any, r: any) => { state.issues.delete(r.issueId); notify(); }));
      conn.db.alertResolution.onInsert(on((_c: any, r: any) => { if (!liveRowOk(r.eventId, BigInt(r.tMicros))) return; state.resolutions.set(String(r.id), { id: String(r.id), alertId: String(r.alertId), eventId: r.eventId, deviceId: r.deviceId, tMicros: BigInt(r.tMicros), how: r.how }); notify(); }));
      conn.db.wearer.onInsert(on((_c: any, r: any) => { state.wearers.set(r.deviceId, { ...r }); notify(); }));
      conn.db.wearer.onUpdate(on((_c: any, _o: any, r: any) => { state.wearers.set(r.deviceId, { ...r }); notify(); }));
      conn.db.asset.onInsert(on((_c: any, r: any) => { state.assets.set(r.assetId, { ...r, patterns: [...r.patterns] }); notify(); }));
      conn.db.asset.onUpdate(on((_c: any, _o: any, r: any) => { state.assets.set(r.assetId, { ...r, patterns: [...r.patterns] }); notify(); }));
      conn.subscriptionBuilder()
        .onApplied(() => { if (live()) notify(); })
        .subscribe(['SELECT * FROM event', 'SELECT * FROM entity', 'SELECT * FROM edge', 'SELECT * FROM episode', 'SELECT * FROM handoff', 'SELECT * FROM alert', 'SELECT * FROM wearer', 'SELECT * FROM asset', 'SELECT * FROM event_location', 'SELECT * FROM track_point', 'SELECT * FROM question', 'SELECT * FROM issue', 'SELECT * FROM alert_resolution']);
    })
    .onConnectError((_ctx, err) => { if (live()) { state.connected = false; onState('error', String(err?.message ?? err)); } })
    .onDisconnect(() => { if (live()) { state.connected = false; onState('connecting', 'reconnecting'); } })
    .build();
}
let lastOnState: OnState | null = null;
/** Switch the workspace from the UI. null = follow the server's demo_config again. */
export function setDb(db: string | null) { setWorkspace(db, null); }
/** Choose a workspace: its database and, when several share one, its id. null = follow the server's demo_config again. */
export function setWorkspace(db: string | null, wsId: string | null) {
  chosen = db; try { if (db) localStorage.setItem('wm.db', db); else localStorage.removeItem('wm.db'); } catch { /* ignore */ }
  const prevWs = WS_ID; WS_ID = pinnedWs || wsId; try { if (wsId) localStorage.setItem('wm.ws', wsId); else localStorage.removeItem('wm.ws'); } catch { /* ignore */ }
  const next = pinned || chosen || serverDb || DIRECTORY_DB;
  // a URL that pins ?db= would keep the old database: open the chosen workspace as its own page instead
  if (pinned && db && db !== pinned) { location.href = `${location.pathname}?ws=${encodeURIComponent(wsId ?? '')}`; return; }
  if (next !== DB || WS_ID !== prevWs) { DB = next; if (lastOnState) connectData(lastOnState); } else notify();
}
let serverDb: string | null = null;
export function connect(onState: OnState) {
  lastOnState = onState;
  connectData(onState);
  if (pinned) return;
  // Follow the switch: demo_config.active_dataset on the directory database. Changing it live
  // swaps the data connection; nothing in the UI needs to know.
  DbConnection.builder()
    .withUri(WS)
    .withDatabaseName(DIRECTORY_DB)
    .onConnect((conn) => {
      const apply = (r: any) => { if (r.key !== 'active_dataset') return; serverDb = String(r.value || '').trim() || DIRECTORY_DB; if (chosen) return; if (serverDb !== DB) { DB = serverDb; connectData(onState); } };
      conn.db.demoConfig.onInsert((_c: any, r: any) => apply(r));
      conn.db.demoConfig.onUpdate((_c: any, _o: any, r: any) => apply(r));
      conn.subscriptionBuilder().subscribe(['SELECT * FROM demo_config']);
    })
    .onConnectError(() => { /* the data connection reports its own state */ })
    .build();
}
