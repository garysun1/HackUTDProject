// The site map (#21): where each wearer walked, where each photo was taken, where the problems
// are. Leaflet over a light basemap. Photo pins carry the thumbnail in the wearer's color, red
// and pulsing while an alert is open, and settle to neutral when it is acknowledged. Pins that
// fall within accuracy of each other cluster; a cluster opens the relationship graph scoped to
// its photos, so judges see where, then what connects. Replay draws the track and drops pins in
// order. Degrades to tracks and pins on a blank canvas if tiles cannot load.
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { state, alertsFor, wearerColor, wearerName, fmtTime, placeOf, type Ev, type TrackPoint } from './store';
import { select, esc } from './timeline';
import { view, shownEvents, replayCut, setScope, onView } from './view';
import { photoCard, showTip, hideTip } from './card';
import { fitRequested } from './tools';

const host = document.getElementById('map') as HTMLElement;
const unplaced = document.getElementById('map-unplaced') as HTMLElement;
let map: L.Map | null = null; let tiles: L.TileLayer | null = null;
let userView = false; let lastFit = 0; let seenFit = fitRequested;
const pins = new Map<string, L.Marker>(); const pinUrl = new Map<string, string>(); const burning = new Set<string>();
const tracks = new Map<string, L.Polyline>(); const nowDots = new Map<string, L.CircleMarker>(); const circles = new Map<string, L.Circle>();
let clusterLayer: L.LayerGroup | null = null; let accuracyLayer: L.LayerGroup | null = null;
// Esri's topographic tiles need no key and reach building scale (z19). Dark mode inverts them in CSS.
const TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}';
const ATTR = 'Tiles &copy; Esri &mdash; Esri, HERE, Garmin, OpenStreetMap contributors';
const isDark = () => (matchMedia('(prefers-color-scheme: dark)').matches && document.documentElement.dataset.theme !== 'light') || document.documentElement.dataset.theme === 'dark';

function ensureMap(): L.Map {
  if (map) return map;
  map = L.map(host, { zoomControl: false, attributionControl: true, preferCanvas: false, zoomSnap: 0.25, wheelPxPerZoomLevel: 90 });
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  map.attributionControl.setPrefix('');
  tiles = L.tileLayer(TILES, { attribution: ATTR, maxZoom: 20, maxNativeZoom: 19, className: 'basemap' }).addTo(map);
  const theme = () => host.classList.toggle('dark', isDark()); theme();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', theme);
  accuracyLayer = L.layerGroup().addTo(map); clusterLayer = L.layerGroup().addTo(map);
  map.setView([32.9858, -96.7501], 17);
  map.on('dragstart', () => { userView = true; }); map.on('zoomstart', e => { if ((e as any).originalEvent) userView = true; });
  map.on('zoomend moveend', () => placePins());
  map.on('click', () => { if (state.selected) select(null); });
  host.addEventListener('dblclick', () => { /* Leaflet zooms; keep */ });
  return map;
}

// ---------- pins ----------
function pinHtml(e: Ev, url: string | undefined, open: boolean, sel: boolean): string {
  return `<div class="pin${open ? ' alert' : ''}${sel ? ' sel' : ''}" style="--c:${open ? 'var(--critical)' : wearerColor(e.deviceId)}">${url ? `<img src="${url}" alt="">` : '<i></i>'}<b>${fmtTime(e.tMicros)}</b></div>`;
}
function icon(html: string, w = 44, h = 34) { return L.divIcon({ className: 'pin-wrap', html, iconSize: [w, h], iconAnchor: [w / 2, h + 6] }); }

type Placed = { e: Ev; lat: number; lon: number };
let placed: Placed[] = []; let clusters: { ids: string[]; lat: number; lon: number }[] = [];

function placePins() {
  if (!map || !clusterLayer) return;
  // cluster greedily by screen distance so overlapping pins read as one stack
  placed = placed.filter(p => state.events.has(p.e.eventId)); // a dataset switch can empty the store between renders
  const pts = placed.map(p => ({ ...p, xy: map!.latLngToContainerPoint([p.lat, p.lon]) }));
  const used = new Set<string>(); clusters = [];
  const singles = new Set<string>();
  for (const p of pts) {
    if (used.has(p.e.eventId)) continue;
    const group = pts.filter(q => !used.has(q.e.eventId) && Math.abs(q.xy.x - p.xy.x) < 40 && Math.abs(q.xy.y - p.xy.y) < 34);
    for (const q of group) used.add(q.e.eventId);
    if (group.length > 1) clusters.push({ ids: group.map(q => q.e.eventId), lat: group.reduce((s, q) => s + q.lat, 0) / group.length, lon: group.reduce((s, q) => s + q.lon, 0) / group.length });
    else singles.add(p.e.eventId);
  }
  for (const [id, m] of pins) { const on = singles.has(id); if (on && !map.hasLayer(m)) m.addTo(map); if (!on && map.hasLayer(m)) m.remove(); }
  clusterLayer.clearLayers();
  for (const c of clusters) {
    const evs = c.ids.map(id => state.events.get(id)).filter((e): e is Ev => !!e).sort((a, b) => (a.tMicros < b.tMicros ? 1 : -1)); if (!evs.length) continue;
    const open = evs.some(e => alertsFor(e).some(a => !a.acked));
    const sel = evs.some(e => e.eventId === state.selected);
    const thumbs = evs.slice(0, 3).map((e, i) => { const u = state.photos.get(e.eventId); return `<span class="ct" style="--i:${i};--c:${wearerColor(e.deviceId)}">${u ? `<img src="${u}" alt="">` : ''}</span>`; }).join('');
    const m = L.marker([c.lat, c.lon], { icon: L.divIcon({ className: 'pin-wrap', html: `<div class="cluster${open ? ' alert' : ''}${sel ? ' sel' : ''}">${thumbs}<b>${evs.length}</b></div>`, iconSize: [56, 40], iconAnchor: [28, 46] }), zIndexOffset: 500, keyboard: false });
    m.on('click', () => { const place = placeOf(evs[0].eventId); setScope(new Set(c.ids), place ? place.canonicalName : `${evs.length} photos here`); });
    m.on('mouseover', (ev: L.LeafletMouseEvent) => showTip(`<div class="tb"><div class="tt"><b>${evs.length} photos here</b> · ${fmtTime(evs[evs.length - 1].tMicros)}–${fmtTime(evs[0].tMicros)}</div><div class="ts">${[...new Set(evs.map(e => wearerName(e.deviceId)))].map(esc).join(', ')}${open ? ' · <span class="ta">open alert</span>' : ''}. Click to see what connects.</div></div>`, ev.originalEvent.clientX, ev.originalEvent.clientY));
    m.on('mouseout', hideTip);
    m.addTo(clusterLayer);
  }
}

// ---------- tracks ----------
function trackSegments(cut: bigint | null): Map<string, TrackPoint[]> {
  const cutoff = state.windowMin ? BigInt(Date.now() - state.windowMin * 60_000) * 1000n : 0n;
  const by = new Map<string, TrackPoint[]>();
  for (const p of state.track.values()) {
    if (p.kind !== 'point' || p.accuracyM > 35 || p.tMicros < cutoff || state.hiddenWearers.has(p.deviceId)) continue;
    if (cut !== null && p.tMicros > cut) continue;
    const k = `${p.deviceId}|${p.shiftId}`; (by.get(k) ?? by.set(k, []).get(k)!).push(p);
  }
  for (const pts of by.values()) pts.sort((a, b) => (a.tMicros < b.tMicros ? -1 : 1));
  return by;
}

export function renderMap() {
  const active = view.mode === 'map';
  host.hidden = !active; if (!active) { hideTip(); return; }
  const m = ensureMap(); m.invalidateSize({ animate: false });
  const cut = replayCut(); const evs = shownEvents();
  // pins
  placed = [];
  const keep = new Set<string>(); let placedChanged = false;
  for (const e of evs) {
    const loc = state.locations.get(e.eventId); if (!loc) continue;
    placed.push({ e, lat: loc.lat, lon: loc.lon }); keep.add(e.eventId);
    const url = state.photos.get(e.eventId); const open = alertsFor(e).some(a => !a.acked); const sel = state.selected === e.eventId;
    const html = pinHtml(e, url, open, sel); const sig = `${html}`;
    let mk = pins.get(e.eventId);
    if (!mk) {
      mk = L.marker([loc.lat, loc.lon], { icon: icon(html), riseOnHover: true, keyboard: false, zIndexOffset: open ? 400 : 0 });
      mk.on('click', () => select(e.eventId));
      mk.on('mouseover', (ev: L.LeafletMouseEvent) => showTip(photoCard(e.eventId), ev.originalEvent.clientX, ev.originalEvent.clientY));
      mk.on('mouseout', hideTip);
      pins.set(e.eventId, mk); pinUrl.set(e.eventId, sig); placedChanged = true;
      if (open) burning.add(e.eventId);
      const el = () => mk!.getElement(); setTimeout(() => el()?.querySelector('.pin')?.classList.add('arrive'), 0);
    } else if (pinUrl.get(e.eventId) !== sig) {
      const wasBurning = burning.has(e.eventId);
      mk.setIcon(icon(html)); pinUrl.set(e.eventId, sig); mk.setZIndexOffset(open ? 400 : 0);
      if (wasBurning && !open) { burning.delete(e.eventId); setTimeout(() => mk!.getElement()?.querySelector('.pin')?.classList.add('resolved'), 0); } else if (open) burning.add(e.eventId);
    }
    // accuracy ring when the fix is loose
    const c = circles.get(e.eventId);
    if (loc.accuracyM > 15 && !c) { circles.set(e.eventId, L.circle([loc.lat, loc.lon], { radius: loc.accuracyM, weight: 1, color: wearerColor(e.deviceId), opacity: 0.35, fillOpacity: 0.06, interactive: false }).addTo(accuracyLayer!)); }
    else if (loc.accuracyM <= 15 && c) { c.remove(); circles.delete(e.eventId); }
  }
  for (const [id, mk] of pins) if (!keep.has(id)) { mk.remove(); pins.delete(id); pinUrl.delete(id); placedChanged = true; circles.get(id)?.remove(); circles.delete(id); }
  // tracks per wearer and shift
  const segs = trackSegments(cut); const liveKeys = new Set<string>();
  for (const [k, pts] of segs) {
    liveKeys.add(k); const dev = k.split('|')[0];
    const latlngs = pts.map((p, i) => { const w = pts.slice(Math.max(0, i - 2), Math.min(pts.length, i + 3)); return [w.reduce((s, q) => s + q.lat, 0) / w.length, w.reduce((s, q) => s + q.lon, 0) / w.length] as [number, number]; });
    let pl = tracks.get(k);
    if (!pl) { pl = L.polyline(latlngs, { color: wearerColor(dev), weight: 3, opacity: 0.85, lineJoin: 'round', lineCap: 'round', interactive: false }).addTo(m); tracks.set(k, pl); }
    else pl.setLatLngs(latlngs);
    const last = pts[pts.length - 1]; const ended = [...state.track.values()].some(p => p.kind === 'shift_end' && p.deviceId === dev && p.shiftId === last.shiftId && p.tMicros >= last.tMicros);
    const recent = Date.now() * 1000 - Number(last.tMicros) < 10 * 60e6;
    let dot = nowDots.get(k);
    if (!ended && (recent || cut !== null)) { if (!dot) { dot = L.circleMarker([last.lat, last.lon], { radius: 6, color: '#fff', weight: 2, fillColor: wearerColor(dev), fillOpacity: 1, className: 'now-dot', interactive: false }).addTo(m); nowDots.set(k, dot); } else dot.setLatLng([last.lat, last.lon]); }
    else if (dot) { dot.remove(); nowDots.delete(k); }
  }
  for (const [k, pl] of tracks) if (!liveKeys.has(k)) { pl.remove(); tracks.delete(k); nowDots.get(k)?.remove(); nowDots.delete(k); }
  // fit: everything, until the user takes over; Fit button hands it back
  if (fitRequested !== seenFit) { seenFit = fitRequested; userView = false; }
  const all: [number, number][] = [...placed.map(p => [p.lat, p.lon] as [number, number]), ...[...segs.values()].flat().map(p => [p.lat, p.lon] as [number, number])];
  if (!userView && all.length) {
    const b = L.latLngBounds(all); const sig = all.length + ':' + b.toBBoxString();
    if (sig !== String(lastFit)) { lastFit = sig as any; m.fitBounds(b.pad(0.25), { maxZoom: 19, animate: placedChanged || cut !== null, duration: 0.6 }); }
  }
  placePins();
  // photos without a position
  const missing = evs.filter(e => !state.locations.has(e.eventId));
  unplaced.hidden = !missing.length;
  if (missing.length) { unplaced.innerHTML = `<button type="button" class="pill" data-unplaced>${missing.length} photo${missing.length === 1 ? '' : 's'} without a position · see in graph</button>`; unplaced.querySelector('button')!.onclick = () => setScope(new Set(missing.map(e => e.eventId)), 'Photos without a position'); }
  if (evs.length && !placed.length && !segs.size && !lastFit && !view.replay.on) m.setView([32.9858, -96.7501], 16, { animate: false });
}
export function mapUserView() { return userView; }
onView(() => renderMap());
