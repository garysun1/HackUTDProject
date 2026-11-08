#!/usr/bin/env node
// Generated 3D sites for the sample workspaces (decision 0032): one building per site, laid out
// in metres here and written in the same SiteData shape as the real ECSW scene (OpenStreetMap),
// so the console draws them the same way. Fictional companies; each building sits on open land
// in the satellite imagery near its city so it does not cover a real building.
//
//   node demo/synth/sites.mjs        -> web/src/site3d/data/sites/<id>.json (+ site3d/src/data/sites/)
//
// Besides the SiteData fields (center, main, indoor, neighbors, paths) each file carries `walk`:
// corridor spines per level and lift points, which replay.mjs routes the synthetic wearer along.
// Room names are what the map says under the wearer, and what scenario shots name as `room`.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const R = 6378137, D2R = Math.PI / 180;
const rect = ([x0, y0, x1, y1]) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

const SITES = [
  {
    id: 'plant', name: 'Arlington Assembly Plant', center: [-97.12418, 32.70721], levels: 1, height: 11,
    outer: rect([-50, -32, 50, 32]),
    rooms: [
      ['Cell 1', [-48, 3, -26, 30]], ['Cell 2', [-24, 3, -2, 30]], ['Cell 3', [0, 3, 22, 30]],
      ['Cell 3 outfeed', [24, 3, 35, 30]], ['Press line', [37, 3, 48, 30]],
      ['Main aisle', [-48, -2, 48, 2]],
      ['Maintenance shop', [-48, -30, -30, -4]], ['Tool crib', [-28, -30, -20, -4]], ['QA lab', [-18, -30, -4, -4]],
      ['Compressor room', [-2, -30, 8, -4]], ['Break room', [10, -30, 20, -4]], ['Shipping dock', [22, -30, 48, -4]],
    ],
    neighbors: [],
    paths: [[[-56, -38], [56, -38], [56, 38], [-56, 38], [-56, -38]]],
    spines: [{ level: 0, pts: [[-46, 0], [46, 0]] }],
  },
  {
    id: 'hospital', name: 'Mercy General Hospital', center: [-96.83862, 32.8111], levels: 5, height: 22,
    outer: rect([-45, -28, 45, 28]),
    rooms: [
      ['Loading dock', [-43, -26, -27, -6]], ['Generator room', [-25, -26, -9, -6]], ['Biomed shop', [-7, -26, 13, -6]],
      ['Central supply', [15, -26, 43, -6]], ['Ground corridor', [-43, -4, 43, 4]],
      ['Blood bank', [-43, 6, -15, 26]], ['Lab', [-13, 6, 13, 26]], ['Elevator lobby', [15, 6, 25, 26]], ['Main entrance', [27, 6, 43, 26]],
      ['4 West ward', [-43, 6, 13, 26], 3], ['Elevator lobby 4', [15, 6, 25, 26], 3], ['4 West nurse station', [27, 6, 43, 26], 3],
      ['4 West corridor', [-43, -4, 43, 4], 3], ['Clean utility', [-43, -26, -20, -6], 3], ['4 West patient rooms', [-18, -26, 43, -6], 3],
    ],
    neighbors: [],
    paths: [[[-50, -36], [50, -36], [50, 36], [-50, 36], [-50, -36]]],
    spines: [{ level: 0, pts: [[-41, 0], [20, 0], [41, 0]] }, { level: 0, pts: [[20, 0], [20, 10]] }, { level: 3, pts: [[-41, 0], [20, 0], [41, 0]] }, { level: 3, pts: [[20, 0], [20, 10]] }],
    lifts: [[20, 10]],
  },
  {
    id: 'substation', name: 'Northlake Substation', center: [-96.74588, 33.0345], levels: 1, height: 2.4,
    outer: rect([-42, -30, 42, 30]),
    rooms: [
      ['Entrance gate', [-40, -28, -28, -16]], ['Transformer T1', [-24, -28, -6, -14]], ['Transformer T2', [-2, -28, 16, -14]], ['Control house', [22, -28, 40, -14]],
      ['Bay 1', [-40, -6, -22, 10]], ['Bay 2', [-20, -6, -2, 10]], ['Bay 3', [0, -6, 18, 10]], ['Bay 4', [20, -6, 40, 10]],
      ['138 kV bus', [-40, 14, 40, 28]],
    ],
    neighbors: [['T1', 'transformer', 4.5, [-19, -28.5, -11, -24.5]], ['T2', 'transformer', 4.5, [3, -28.5, 11, -24.5]]],
    paths: [[[-34, -30], [-34, -62], [-90, -62]], [[-38, -10], [38, -10]], [[-38, 12], [38, 12]]],
    spines: [{ level: 0, pts: [[-34, -18], [-34, -10], [-38, -10], [-38, 12], [38, 12], [38, -10], [-34, -10]] }],
  },
  {
    id: 'warehouse', name: 'DFW Distribution Center', center: [-97.02089, 32.93921], levels: 1, height: 12,
    outer: rect([-75, -45, 75, 45]),
    rooms: [
      ['Docks 1–10', [-73, -43, -3, -31]], ['Docks 11–20', [-1, -43, 55, -31]], ['Charging bay', [57, -43, 73, -19]],
      ['Staging', [-73, -29, 55, -19]],
      ['Aisles 18–21', [-73, -17, -20, 31]], ['Aisle 22', [-18, -17, -10, 31]], ['Aisles 23–26', [-8, -17, 38, 31]],
      ['Freezer FZ-1', [41, -10, 73, 43]], ['Shipping office', [-73, 33, -50, 43]], ['Back aisle', [-48, 33, 39, 43]],
    ],
    neighbors: [['Guard shack', 'guard', 3, [-98, -72, -91, -65]]],
    paths: [[[-85, -55], [85, -55], [85, 55], [-85, 55], [-85, -55]], [[-85, -68], [85, -68]], [[-94, -65], [-94, -55]]],
    spines: [{ level: 0, pts: [[-71, -24], [-14, -24], [39, -24], [65, -24]] }, { level: 0, pts: [[-14, -24], [-14, 37], [-70, 37]] }, { level: 0, pts: [[-14, 37], [39, 37], [39, -24]] }],
  },
];

function build(s) {
  const [lon0, lat0] = s.center; const k = Math.cos(lat0 * D2R);
  const ll = ([x, y]) => [+(lon0 + x / (R * k * D2R)).toFixed(7), +(lat0 + y / (R * D2R)).toFixed(7)];
  return {
    source: 'Generated floor plan (demo/synth/sites.mjs); fictional site, not a real building',
    synthetic: true,
    center: s.center,
    main: { name: s.name, levels: s.levels, height: s.height, outer: s.outer.map(ll), inner: [] },
    indoor: s.rooms.map(([name, r, level = 0]) => ({ name, indoor: 'room', level: String(level), pts: rect(r).map(ll) })),
    neighbors: s.neighbors.map(([name, kind, height, r]) => ({ name, kind, height, pts: rect(r).map(ll) })),
    paths: s.paths.map(pts => ({ highway: 'service', pts: pts.map(ll) })),
    tileRadius: 4,
    walk: { spines: s.spines.map(sp => ({ level: sp.level, pts: sp.pts.map(ll) })), lifts: (s.lifts ?? []).map(ll) },
  };
}

for (const dir of ['web/src/site3d/data/sites', 'site3d/src/data/sites']) {
  mkdirSync(join(ROOT, dir), { recursive: true });
  for (const s of SITES) writeFileSync(join(ROOT, dir, `${s.id}.json`), JSON.stringify(build(s)) + '\n');
}
console.log(`wrote ${SITES.length} sites: ${SITES.map(s => s.id).join(', ')}`);
