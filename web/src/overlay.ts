// A static dataset laid over the live database: the weekend workspace (decision 0033). The
// overlay is built by demo/weekend/src/build.mjs from the photos Edward took on the glasses; it
// is store-ready JSON, so applying it is the same as receiving the rows from a subscription.
// While it is active, live rows older than its end are replaced by its curated copies; live
// photos taken after it (the judging table) land on top and carry the workspace's badge.
import { state, notify, setOverlayLoader, liveRowOk, badgeLive, type Ev, type Loc, type TrackPoint, type Alert, type Ent, type Edge } from './store';
import { WORKSPACES } from './workspaces';

export type OverlayJson = {
  generatedAt: string; staticEnd: string; badgeAfter?: string; hideLive?: string[];
  wearers?: { deviceId: string; name: string; role: string; shift: string }[];
  events: any[]; locations?: any[]; track?: any[]; entities?: any[]; edges?: any[]; alerts?: any[]; resolutions?: any[];
  photos?: Record<string, string>; thumbs?: Record<string, string>;
};
const cache = new Map<string, Promise<OverlayJson | null>>();
function fetchOverlay(url: string): Promise<OverlayJson | null> {
  if (!cache.has(url)) cache.set(url, fetch(url, { cache: 'no-cache' }).then(r => (r.ok ? r.json() : null)).catch(() => null));
  return cache.get(url)!;
}
const big = (v: any) => BigInt(String(v));
let applied = 0; // generation: a workspace switch while the fetch is in flight drops the stale apply

/** Called by the store whenever it (re)connects: apply the current workspace's overlay, if any. */
setOverlayLoader((db, wsId) => {
  const ws = WORKSPACES.find(w => w.id === wsId && w.db === db && w.overlay);
  const gen = ++applied;
  if (!ws) return;
  const base = ws.overlay!.replace(/[^/]*$/, '');
  fetchOverlay(ws.overlay!).then(o => {
    if (gen !== applied || !o) return;
    const ids = new Set<string>(o.events.map(e => String(e.eventId)));
    const endMicros = BigInt(Date.parse(o.staticEnd)) * 1000n;
    const after = o.badgeAfter ? BigInt(Date.parse(o.badgeAfter)) * 1000n : endMicros;
    state.overlay = { url: ws.overlay!, endMicros, badgeAfterMicros: after > endMicros ? after : endMicros, ids, hideLive: new Set(o.hideLive ?? []), badge: ws.badge ?? '' };
    // live rows that arrived before the overlay did and belong to its period go; the overlay's copies replace them
    for (const [id, e] of [...state.events]) if (!liveRowOk(id, e.tMicros)) { state.events.delete(id); state.locations.delete(id); } else badgeLive(e);
    for (const [id, a] of [...state.alerts]) if (!liveRowOk(a.eventId, a.tMicros)) state.alerts.delete(id);
    for (const [id, p] of [...state.track]) if (!liveRowOk(null, p.tMicros)) state.track.delete(id);
    for (const [id, r] of [...state.resolutions]) if (!liveRowOk(r.eventId, r.tMicros)) state.resolutions.delete(id);
    state.issues.clear();
    for (const w of o.wearers ?? []) state.wearers.set(w.deviceId, { ...w });
    for (const r of o.events) {
      const e: Ev = { eventId: String(r.eventId), deviceId: r.deviceId, clientT: r.clientT, tMicros: big(r.tMicros), source: r.source, status: r.status ?? 'in_graph', note: r.note ?? undefined, label: r.label ?? undefined, scene: r.scene ?? '', locationGuess: r.locationGuess ?? '', activity: r.activity ?? '', summary: r.summary ?? '', peopleCount: Number(r.peopleCount ?? 0), confidence: Number(r.confidence ?? 0.9), perceptionJson: r.perceptionJson ?? '' };
      state.events.set(e.eventId, e);
    }
    for (const r of o.locations ?? []) { const l: Loc = { eventId: r.eventId, deviceId: r.deviceId, shiftId: r.shiftId, tMicros: big(r.tMicros), lat: Number(r.lat), lon: Number(r.lon), accuracyM: Number(r.accuracyM ?? 10), altM: r.altM ?? undefined, floor: r.floor ?? undefined, fixT: r.fixT ?? r.clientT ?? '', ageMs: 0 }; state.locations.set(l.eventId, l); }
    for (const r of o.track ?? []) { const p: TrackPoint = { pointId: String(r.pointId), deviceId: r.deviceId, shiftId: r.shiftId, tMicros: big(r.tMicros), kind: r.kind, lat: Number(r.lat), lon: Number(r.lon), accuracyM: Number(r.accuracyM ?? 10), floor: r.floor ?? undefined }; state.track.set(p.pointId, p); }
    for (const r of o.entities ?? []) { const en: Ent = { entityId: r.entityId, canonicalName: r.canonicalName, kind: r.kind, aliases: r.aliases ?? [], firstSeenMicros: big(r.firstSeenMicros ?? 0), lastSeenMicros: big(r.lastSeenMicros ?? 0) }; state.entities.set(en.entityId, en); }
    const have = new Set(state.edges.map(x => x.edgeId));
    for (const r of o.edges ?? []) { const ed: Edge = { edgeId: big(r.edgeId), fromId: r.fromId, toId: r.toId, kind: r.kind, props: typeof r.props === 'string' ? r.props : JSON.stringify(r.props ?? {}) }; if (!have.has(ed.edgeId)) state.edges.push(ed); }
    for (const r of o.alerts ?? []) { const a: Alert = { id: String(r.id ?? r.alertId), alertId: big(r.alertId), eventId: r.eventId, rawKind: r.rawKind ?? r.kind ?? 'anomaly', kind: (r.rawKind ?? r.kind) === 'anomaly' ? 'warning' : 'critical', text: r.text, tMicros: big(r.tMicros), assetId: r.assetId ?? undefined, assetName: r.assetName ?? undefined, deviceId: r.deviceId, wearerName: r.wearerName ?? '', acked: !!r.acked, ackedMicros: r.ackedMicros != null ? big(r.ackedMicros) : undefined, slackStatus: r.slackStatus ?? 'overlay' }; state.alerts.set(a.id, a); }
    for (const r of o.resolutions ?? []) state.resolutions.set(String(r.id), { id: String(r.id), alertId: String(r.alertId), eventId: r.eventId, deviceId: r.deviceId, tMicros: big(r.tMicros), how: r.how ?? 'photo_shows_recovery' });
    for (const [id, rel] of Object.entries(o.photos ?? {})) state.staticPhotos.set(id, base + rel);
    notify();
  });
});

/** Overlay active for the current connection? (brain and map widen their scope to the whole record) */
export function overlayActive() { return !!state.overlay; }
export function badgeOf(eventId: string): string | undefined { return state.badges.get(eventId); }
