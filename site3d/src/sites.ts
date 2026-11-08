// Known sites (decision 0032): the real ECSW building (OpenStreetMap) and the generated sample
// sites (demo/synth/sites.mjs; the Northstar data center is a two-hall campus after a real one). The map picks the one the data sits in, by distance, so a
// workspace needs no configuration: UTD capture lands on ECSW, a replayed sample on its own plant.
import type { SiteData, Room } from './scene';
import { haversineM, pointInRing } from './geo';
import ecsw from './data/ecsw.json';
import plant from './data/sites/plant.json';
import hospital from './data/sites/hospital.json';
import substation from './data/sites/substation.json';
import warehouse from './data/sites/warehouse.json';
import nmc2 from './data/sites/nmc2.json';

export type KnownSite = { key: string; label: string; data: SiteData; rooms: { name: string; level: number; ring: [number, number][] }[]; outer: [number, number][] };
const levelOf = (r: Room) => (/^\d+$/.test(String(r.level ?? '')) ? Number(r.level) : 0);
function known(key: string, label: string, data: SiteData): KnownSite {
  return { key, label, data, outer: data.main!.outer, rooms: (data.indoor ?? []).filter(r => r.name && r.pts.length >= 3).map(r => ({ name: r.name!, level: levelOf(r), ring: r.pts })) };
}
const ECSW: SiteData = { center: ecsw.center as any, main: { name: ecsw.ecsw.name, levels: ecsw.ecsw.levels, height: ecsw.ecsw.height, outer: ecsw.ecsw.outer as any, inner: ecsw.ecsw.inner as any }, indoor: ecsw.indoor as any, neighbors: ecsw.neighbors as any, paths: ecsw.paths as any, tileRadius: 4 };
export const SITES: KnownSite[] = [
  known('ecsw', 'ECSW', ECSW),
  ...[plant, hospital, substation, warehouse, nmc2].map((d: any, i) => known(['plant', 'hospital', 'substation', 'warehouse', 'nmc2'][i], d.main.name, d as SiteData)),
];
/** The known site the data sits in (within 400 m of its centre); ECSW when there is no data yet. */
export function siteFor(c: [number, number] | null): KnownSite | null {
  if (!c) return SITES[0];
  let best: KnownSite | null = null; let bd = 400;
  for (const s of SITES) { const d = haversineM(c[1], c[0], s.data.center[1], s.data.center[0]); if (d < bd) { bd = d; best = s; } }
  return best;
}
/** Room under a point on a floor, else inside/outside the building. */
export function locateIn(s: KnownSite, lat: number, lon: number, floor?: number | null): string {
  const pt: [number, number] = [lon, lat]; const lv = floor ?? 0;
  for (const r of s.rooms) if (r.level === lv && pointInRing(pt, r.ring)) return r.name;
  return pointInRing(pt, s.outer) ? `inside ${s.label}` : 'outside the building';
}
