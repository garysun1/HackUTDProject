#!/usr/bin/env node
// Generated 3D sites for the sample workspaces (decision 0032): one building per site, laid out
// in metres here and written in the same SiteData shape as the real ECSW scene (OpenStreetMap),
// so the console draws them the same way. Fictional companies; each building sits on open land
// in the satellite imagery near its city so it does not cover a real building.
//
//   node demo/synth/sites.mjs        -> web/src/site3d/data/sites/<id>.json (+ site3d/src/data/sites/)
//
// `details` is the opaque site furniture the scene draws around the translucent working building (columns, roofs,
// docks, trailers, transformers, bus gantries, fences, parking, helipad...), per typology, so no site is a bare box.
// Besides the SiteData fields (center, main, indoor, neighbors, paths, details) each file carries `walk`:
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
    neighbors: [['Plant office', 'office', 8, [-74, -20, -52, 20]], ['Utilities', 'industrial', 6, [-74, -44, -56, -26]]],
    paths: [[[-80, -52], [60, -52], [60, 38], [-80, 38], [-80, -52]], [[60, -40], [100, -40]], [[-52, 0], [-80, 0]]],
    details: [
      { kind: 'columns', rect: [-50, -32, 50, 32], bayM: 12, height: 11 },
      { kind: 'sawtooth', rect: [-50, 3, 50, 32], height: 11, rise: 2.6, bays: 5 },
      { kind: 'roof_monitor', rect: [-48, -30, 20, -4], height: 11, rise: 1.8, bays: 3 },
      { kind: 'dock_doors', a: [24, -32], b: [48, -32], n: 4, height: 3.4 },
      { kind: 'trailer', a: [27, -34.5], b: [27, -48] }, { kind: 'trailer', a: [39, -34.5], b: [39, -48] }, { kind: 'truck', a: [45, -34.5], b: [45, -52] },
      { kind: 'tank', rect: [1, -38, 5, -34], height: 6, name: 'Air receiver' }, { kind: 'tank', rect: [-14, -40, -8, -34], height: 4, name: 'Coolant' },
      { kind: 'stack', at: [-62, -32], height: 22, r: 1 }, { kind: 'cooler', rect: [-72, -26, -58, -22], height: 3 },
      { kind: 'canopy', rect: [-52, -6, -48, 6], height: 4.5 }, { kind: 'guard', rect: [-80, -58, -76, -54], height: 3, name: 'Gate' },
      { kind: 'parking', rect: [-50, 42, 56, 62], a: [-48, 44], b: [54, 44], n: 34 },
      { kind: 'parking', rect: [-50, 42, 56, 62], a: [-48, 60], b: [54, 60], n: 34 },
      { kind: 'fence', pts: [[-86, -64], [66, -64], [66, 44], [-86, 44], [-86, -64]] },
    ],
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
    neighbors: [['Medical office building', 'office', 13, [56, -28, 86, 2]], ['Parking structure', 'parking', 14, [-100, -28, -66, 28]], ['Central plant', 'industrial', 7, [-62, -28, -48, -8]]],
    paths: [[[-108, -40], [92, -40], [92, 40], [-108, 40], [-108, -40]], [[45, 16], [92, 16]], [[-45, -16], [-62, -16]], [[0, 40], [0, 70]]],
    details: [
      { kind: 'columns', rect: [-45, -28, 45, 28], bayM: 9, height: 22 },
      { kind: 'box', rect: [-10, 5, 20, 27], height: 3.2, lift: 22, name: 'Mechanical penthouse' },
      { kind: 'cooler', rect: [-40, -24, -18, -18], height: 2.4, lift: 22 }, { kind: 'cooler', rect: [-40, -12, -18, -6], height: 2.4, lift: 22 },
      { kind: 'mast', at: [38, -24], height: 12, lift: 22 },
      { kind: 'helipad', at: [0, 52], r: 10 },
      { kind: 'canopy', rect: [45, 6, 53, 26], height: 5 }, { kind: 'canopy', rect: [-10, 28, 10, 34], height: 4.5 },
      { kind: 'dock_doors', a: [-45, -24], b: [-45, -8], n: 3, height: 3.4 }, { kind: 'truck', a: [-47, -20], b: [-60, -20] },
      { kind: 'generator', rect: [-26, -38, -17, -31], height: 3, name: 'Gen 1' }, { kind: 'generator', rect: [-15, -38, -6, -31], height: 3, name: 'Gen 2' },
      { kind: 'tank', rect: [-3, -37, 1, -33], height: 4, name: 'Diesel' }, { kind: 'tank', rect: [4, -37, 8, -33], height: 4, name: 'Bulk O2' },
      { kind: 'cooler', rect: [-60, -6, -50, 0], height: 3 },
      { kind: 'fence', pts: [[-28, -40], [10, -40], [10, -30], [-28, -30], [-28, -40]] },
      { kind: 'parking', rect: [-45, -66, 50, -44], a: [-43, -46], b: [48, -46], n: 30 }, { kind: 'parking', rect: [-45, -66, 50, -44], a: [-43, -58], b: [48, -58], n: 30 },
    ],
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
    neighbors: [],
    paths: [[[-34, -30], [-34, -62], [-90, -62]], [[-38, -10], [38, -10]], [[-38, 12], [38, 12]]],
    details: [
      { kind: 'fence', pts: [[-44, -32], [44, -32], [44, 32], [-44, 32], [-44, -32]], height: 2.4 },
      { kind: 'transformer', rect: [-19, -26, -11, -18], height: 4.5, name: 'T1' }, { kind: 'transformer', rect: [3, -26, 11, -18], height: 4.5, name: 'T2' },
      { kind: 'tank', rect: [-24, -28, -21, -25], height: 3 }, { kind: 'tank', rect: [-2, -28, 1, -25], height: 3 },
      { kind: 'control_house', rect: [24, -27, 38, -16], height: 3.6, name: 'Control house' },
      { kind: 'bus', pts: [[-40, 16], [40, 16]], height: 9 }, { kind: 'bus', pts: [[-40, 22], [40, 22]], height: 9 }, { kind: 'bus', pts: [[-40, 27], [40, 27]], height: 11 },
      { kind: 'bus', pts: [[-31, 10], [-31, 16]], height: 7 }, { kind: 'bus', pts: [[-11, 10], [-11, 16]], height: 7 }, { kind: 'bus', pts: [[9, 10], [9, 16]], height: 7 }, { kind: 'bus', pts: [[30, 10], [30, 16]], height: 7 },
      { kind: 'box', rect: [-36, -4, -34, 8], height: 3.2, name: 'CB-11' }, { kind: 'box', rect: [-31, -4, -29, 8], height: 3.2 }, { kind: 'box', rect: [-26, -4, -24, 8], height: 3.2 },
      { kind: 'box', rect: [-16, -4, -14, 8], height: 3.2, name: 'CB-12' }, { kind: 'box', rect: [-11, -4, -9, 8], height: 3.2 }, { kind: 'box', rect: [-6, -4, -4, 8], height: 3.2 },
      { kind: 'box', rect: [4, -4, 6, 8], height: 3.2, name: 'CB-13' }, { kind: 'box', rect: [9, -4, 11, 8], height: 3.2 }, { kind: 'box', rect: [14, -4, 16, 8], height: 3.2 },
      { kind: 'box', rect: [24, -4, 26, 8], height: 3.2, name: 'CB-14' }, { kind: 'box', rect: [29, -4, 31, 8], height: 3.2 }, { kind: 'box', rect: [34, -4, 36, 8], height: 3.2 },
      { kind: 'mast', at: [-42, -30], height: 18 }, { kind: 'mast', at: [42, -30], height: 18 }, { kind: 'mast', at: [-42, 30], height: 18 }, { kind: 'mast', at: [42, 30], height: 18 },
      { kind: 'guard', rect: [-39, -27, -35, -23], height: 2.8, name: 'Gate' },
      { kind: 'parking', rect: [-62, -30, -46, -14], a: [-60, -28], b: [-60, -16], n: 4 },
    ],
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
    neighbors: [['Guard shack', 'guard', 3, [-98, -72, -91, -65]], ['Truck maintenance', 'industrial', 7, [40, 56, 84, 78]]],
    paths: [[[-85, -55], [85, -55], [85, 55], [-85, 55], [-85, -55]], [[-85, -68], [85, -68]], [[-94, -65], [-94, -55]], [[85, 0], [110, 0]]],
    details: [
      { kind: 'columns', rect: [-75, -45, 75, 45], bayM: 15, height: 12 },
      { kind: 'roof_monitor', rect: [-73, -17, 39, 31], height: 12, rise: 1.6, bays: 4 },
      { kind: 'dock_doors', a: [-73, -45], b: [-3, -45], n: 10, height: 3.6 }, { kind: 'dock_doors', a: [-1, -45], b: [55, -45], n: 10, height: 3.6 },
      { kind: 'trailer', a: [-66, -47.5], b: [-66, -62] }, { kind: 'trailer', a: [-52, -47.5], b: [-52, -62] }, { kind: 'trailer', a: [-31, -47.5], b: [-31, -62] }, { kind: 'truck', a: [-10, -47.5], b: [-10, -66] },
      { kind: 'trailer', a: [12, -47.5], b: [12, -62] }, { kind: 'trailer', a: [34, -47.5], b: [34, -62] }, { kind: 'truck', a: [48, -47.5], b: [48, -66] },
      { kind: 'parking', rect: [-85, -92, 85, -70], a: [-83, -72], b: [83, -72], n: 24 },
      { kind: 'cooler', rect: [77, -6, 81, 6], height: 2.6, name: 'FZ-1 condensers' }, { kind: 'cooler', rect: [77, 12, 81, 24], height: 2.6 }, { kind: 'cooler', rect: [77, 28, 81, 40], height: 2.6 },
      { kind: 'box', rect: [60, -47, 72, -46], height: 2 },
      { kind: 'canopy', rect: [-80, 33, -75, 43], height: 3.6 },
      { kind: 'parking', rect: [-75, 50, 20, 70], a: [-73, 52], b: [18, 52], n: 24 }, { kind: 'parking', rect: [-75, 50, 20, 70], a: [-73, 66], b: [18, 66], n: 24 },
      { kind: 'fence', pts: [[-104, -96], [100, -96], [100, 82], [-104, 82], [-104, -96]] },
    ],
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
    details: (s.details ?? []).map(d => {
      const o = { ...d }; delete o.rect;
      if (d.rect) o.pts = rect(d.rect).map(ll);
      if (d.pts && !d.rect) o.pts = d.pts.map(ll);
      for (const k of ['a', 'b', 'at']) if (d[k]) o[k] = ll(d[k]);
      return o;
    }),
    tileRadius: 4,
    walk: { spines: s.spines.map(sp => ({ level: sp.level, pts: sp.pts.map(ll) })), lifts: (s.lifts ?? []).map(ll) },
  };
}

for (const dir of ['web/src/site3d/data/sites', 'site3d/src/data/sites']) {
  mkdirSync(join(ROOT, dir), { recursive: true });
  for (const s of SITES) writeFileSync(join(ROOT, dir, `${s.id}.json`), JSON.stringify(build(s)) + '\n');
}
console.log(`wrote ${SITES.length} sites: ${SITES.map(s => s.id).join(', ')}`);
