#!/usr/bin/env node
// track.mjs — deterministic walking-track synthesiser for the weekend workspace.
//
//   node track.mjs <input.json> > <track.json>
//
// Input:  { osm: "<path to osm-utd.json>",
//           shifts: [{ shiftId, deviceId, start, end }],
//           waypoints: [{ t, lat, lon, floor?, dwellMin?, wander? }] }
// Output: JSON array of track points in the shape MANIFEST_SCHEMA.md gives for "track".
// Stderr: one-line summary (metres walked, points, per-shift counts).
//
// Node built-ins only. Everything random comes from mulberry32 seeded by waypoint index,
// so the same input always yields the same track.

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

// ---------- constants ----------
const TZ_OFFSET_MIN = -6 * 60; // -06:00 as the schema requires
const WALK_SPEED = 1.35; // m/s nominal
const MAX_SPEED = 2.2; // m/s when late
const WANDER_SPEED = 1.0; // m/s for coffee/bathroom loops
const SNAP_M = 60; // snap-to-node radius
const SAME_BUILDING_M = 140; // both indoor ends within this = a walk inside one building (ECSW is about 120 m long)
const EMIT_DIST_M = 5;
const EMIT_SECS = 30;
const WALKABLE = new Set([
  'footway', 'path', 'pedestrian', 'steps', 'service', 'residential',
  'unclassified', 'living_street', 'corridor', 'cycleway',
]);

// ---------- PRNG ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Gaussian-ish: sum of three uniforms, variance 1/4 -> scale to unit variance.
const gauss = (rng) => (rng() + rng() + rng() - 1.5) * 2;
const uni = (rng, lo, hi) => lo + (hi - lo) * rng();

// ---------- geo ----------
const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
function haversine(aLat, aLon, bLat, bLon) {
  const dLat = rad(bLat - aLat);
  const dLon = rad(bLon - aLon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
// Local metric offsets (small distances): metres east/north -> lat/lon.
function offset(lat, lon, dEast, dNorth) {
  const dLat = (dNorth / R) * (180 / Math.PI);
  const dLon = ((dEast / (R * Math.cos(rad(lat)))) * 180) / Math.PI;
  return { lat: lat + dLat, lon: lon + dLon };
}
function lerpPos(a, b, f) {
  return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
}

// ---------- time ----------
function parseIso(s) {
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) throw new Error(`bad ISO time: ${s}`);
  return ms / 1000; // seconds since epoch (float)
}
const pad = (n, w = 2) => String(n).padStart(w, '0');
function isoLocal(sec) {
  const ms = Math.round(sec * 1000);
  const d = new Date(ms + TZ_OFFSET_MIN * 60 * 1000);
  const sign = TZ_OFFSET_MIN < 0 ? '-' : '+';
  const off = Math.abs(TZ_OFFSET_MIN);
  const frac = ms % 1000;
  const base = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return `${base}${frac ? '.' + pad(frac, 3) : ''}${sign}${pad(Math.floor(off / 60))}:${pad(off % 60)}`;
}
const micros = (sec) => String(Math.round(sec * 1000) * 1000);

// ---------- graph ----------
function buildGraph(osm) {
  const nodes = new Map(); // id -> {lat, lon}
  for (const e of osm.elements) if (e.type === 'node' && e.lat != null) nodes.set(e.id, { lat: e.lat, lon: e.lon });
  const adj = new Map(); // id -> [{to, w}]
  const link = (a, b, w) => {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a).push({ to: b, w });
    adj.get(b).push({ to: a, w });
  };
  for (const e of osm.elements) {
    if (e.type !== 'way' || !e.tags || !WALKABLE.has(e.tags.highway) || !Array.isArray(e.nodes)) continue;
    // Per-segment edges: shared nodes automatically split ways into routable pieces.
    for (let i = 1; i < e.nodes.length; i++) {
      const a = nodes.get(e.nodes[i - 1]);
      const b = nodes.get(e.nodes[i]);
      if (!a || !b) continue;
      link(e.nodes[i - 1], e.nodes[i], haversine(a.lat, a.lon, b.lat, b.lon));
    }
  }
  const walkable = [...adj.keys()].map((id) => ({ id, ...nodes.get(id) }));
  return { nodes, adj, walkable };
}

function nearestNode(graph, lat, lon) {
  let best = null;
  let bestD = Infinity;
  for (const n of graph.walkable) {
    const d = haversine(lat, lon, n.lat, n.lon);
    if (d < bestD) { bestD = d; best = n; }
  }
  return { node: best, dist: bestD };
}

// Binary heap for Dijkstra.
class MinHeap {
  constructor() { this.a = []; }
  push(k, v) {
    const a = this.a; a.push([k, v]);
    let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
  }
  pop() {
    const a = this.a; const top = a[0]; const last = a.pop();
    if (a.length) {
      a[0] = last; let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
  get size() { return this.a.length; }
}

function dijkstra(graph, from, to) {
  if (from === to) return [from];
  const dist = new Map([[from, 0]]);
  const prev = new Map();
  const heap = new MinHeap();
  heap.push(0, from);
  while (heap.size) {
    const [d, u] = heap.pop();
    if (u === to) break;
    if (d > dist.get(u)) continue;
    for (const { to: v, w } of graph.adj.get(u) || []) {
      const nd = d + w;
      if (nd < (dist.get(v) ?? Infinity)) { dist.set(v, nd); prev.set(v, u); heap.push(nd, v); }
    }
  }
  if (!dist.has(to)) return null;
  const path = [to];
  while (path[path.length - 1] !== from) path.push(prev.get(path[path.length - 1]));
  return path.reverse();
}

// Route between two positions: snap each end, route over the graph, return a polyline of
// positions starting at `a` and ending at `b`, plus its length in metres.
function route(graph, a, b, cache) {
  const sa = nearestNode(graph, a.lat, a.lon);
  const sb = nearestNode(graph, b.lat, b.lon);
  let line;
  if (!sa.node || !sb.node) {
    line = [a, b];
  } else {
    const key = `${sa.node.id}>${sb.node.id}`;
    let ids = cache.get(key);
    if (ids === undefined) { ids = dijkstra(graph, sa.node.id, sb.node.id); cache.set(key, ids); }
    if (!ids) {
      line = [a, b]; // disconnected: straight line, honest fallback
    } else {
      // Within SNAP_M the waypoint is snapped onto the node (the connector is the few metres
      // from the spot to the path); beyond SNAP_M the same straight connector to the nearest
      // node is the explicit fallback. Either way the walk starts and ends at the waypoint.
      line = [a, ...ids.map((id) => graph.nodes.get(id)), b];
    }
  }
  let len = 0;
  for (let i = 1; i < line.length; i++) len += haversine(line[i - 1].lat, line[i - 1].lon, line[i].lat, line[i].lon);
  return { line, len };
}

// Position at distance s along a polyline (with cumulative lengths precomputed).
function polylineWalker(line) {
  const cum = [0];
  for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + haversine(line[i - 1].lat, line[i - 1].lon, line[i].lat, line[i].lon));
  const total = cum[cum.length - 1];
  let seg = 1;
  return {
    total,
    at(s) {
      if (s <= 0) return line[0];
      if (s >= total) return line[line.length - 1];
      while (seg < cum.length - 1 && cum[seg] < s) seg++;
      while (seg > 1 && cum[seg - 1] > s) seg--;
      const segLen = cum[seg] - cum[seg - 1];
      const f = segLen > 0 ? (s - cum[seg - 1]) / segLen : 0;
      return lerpPos(line[seg - 1], line[seg], f);
    },
  };
}

// ---------- main ----------
function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    process.stderr.write('usage: node track.mjs <input.json> > <track.json>\n');
    process.exit(2);
  }
  const input = JSON.parse(readFileSync(inputPath, 'utf8'));
  // "osm" resolves against the cwd first, then against the input file's folder.
  const osmPath = existsSync(resolve(input.osm)) ? resolve(input.osm) : resolve(dirname(resolve(inputPath)), input.osm);
  const osm = JSON.parse(readFileSync(osmPath, 'utf8'));
  const graph = buildGraph(osm);

  const shifts = (input.shifts || []).map((s) => ({ ...s, startSec: parseIso(s.start), endSec: parseIso(s.end) }));
  const waypoints = (input.waypoints || [])
    .map((w, idx) => ({
      idx,
      tSec: parseIso(w.t),
      lat: w.lat,
      lon: w.lon,
      indoor: w.floor != null && w.floor >= 0,
      floor: w.floor != null ? w.floor : 0,
      dwellSec: (w.dwellMin || 0) * 60,
      wander: w.wander || 0,
      real: !!w.real,                 // a real fix from the phone: passed through, never routed or jittered
      acc: w.accuracyM != null ? Number(w.accuracyM) : null,
    }))
    .sort((a, b) => a.tSec - b.tSec || a.idx - b.idx);
  if (waypoints.length === 0) {
    process.stdout.write('[]\n');
    process.stderr.write('track: 0 m walked, 0 points\n');
    return;
  }

  // ---- simulation: true positions sampled at 1 s, emitted like the phone ----
  const samples = []; // {t, lat, lon, floor, indoor, moving}
  let metresWalked = 0;
  const routeCache = new Map();

  const pushDwell = (wp, from, to, rng) => {
    // Jitter: a slow random walk around the spot, a few metres indoors, ~1 m outdoors.
    const amp = wp.real ? 0.4 : wp.indoor ? 1.5 : 1;
    let dx = 0, dy = 0;
    for (let t = Math.ceil(from); t <= to; t += 1) {
      dx = dx * 0.9 + gauss(rng) * amp * 0.3;
      dy = dy * 0.9 + gauss(rng) * amp * 0.3;
      const p = offset(wp.lat, wp.lon, dx, dy);
      samples.push({ t, lat: p.lat, lon: p.lon, floor: wp.floor, indoor: wp.indoor, moving: false });
    }
  };

  // A short loop away from the spot and back (coffee / bathroom).
  const pushWander = (wp, from, rng) => {
    const r = uni(rng, 0.5, 1) * wp.wander;
    const bearing = uni(rng, 0, 2 * Math.PI);
    const bend = uni(rng, -0.6, 0.6); // curve the loop so out and back differ a little
    const pauseSec = uni(rng, 60, 180);
    const legSec = r / WANDER_SPEED;
    const total = 2 * legSec + pauseSec;
    const end = from + total;
    for (let t = Math.ceil(from); t <= end; t += 1) {
      const e = t - from;
      let frac; let side;
      if (e < legSec) { frac = e / legSec; side = 1; }
      else if (e < legSec + pauseSec) { frac = 1; side = 0; }
      else { frac = 1 - (e - legSec - pauseSec) / legSec; side = -1; }
      const along = r * frac;
      const across = side * bend * r * Math.sin(Math.PI * frac) * 0.3;
      const dEast = along * Math.sin(bearing) + across * Math.cos(bearing);
      const dNorth = along * Math.cos(bearing) - across * Math.sin(bearing);
      const p = offset(wp.lat, wp.lon, dEast, dNorth);
      samples.push({ t, lat: p.lat, lon: p.lon, floor: wp.floor, indoor: wp.indoor, moving: side !== 0 });
    }
    metresWalked += 2 * r;
    return end;
  };

  const dwellAt = (wp, from, to, rng) => {
    if (to <= from) return;
    const long = to - from > 20 * 60 && wp.wander > 0;
    let cursor = from;
    if (long) {
      let next = from + uni(rng, 25, 45) * 60;
      while (next < to) {
        const loopLen = (2 * wp.wander) / WANDER_SPEED + 180;
        if (next + loopLen > to) break;
        pushDwell(wp, cursor, next - 1, rng);
        cursor = pushWander(wp, next, rng) + 1;
        next = cursor + uni(rng, 25, 45) * 60;
      }
    }
    pushDwell(wp, cursor, to, rng);
  };

  let arrival = waypoints[0].tSec; // when the wearer reached the current waypoint
  for (let i = 0; i < waypoints.length; i++) {
    const wp = waypoints[i];
    const rng = mulberry32(0x9E3779B9 ^ (wp.idx * 2654435761));
    const next = waypoints[i + 1];
    const dwellStart = arrival;
    const dwellEndWanted = Math.max(arrival, wp.tSec) + wp.dwellSec;
    if (!next) {
      dwellAt(wp, dwellStart, dwellEndWanted, rng);
      break;
    }
    // Two real fixes close in time: the phone already measured this leg. Interpolate straight
    // between them with no routing and no added noise (the fixes carry their own).
    if (wp.real && next.real && next.tSec - wp.tSec <= 300) {
      const t0 = Math.max(Math.ceil(arrival), Math.ceil(wp.tSec)); const t1 = Math.floor(next.tSec);
      for (let t = t0; t <= t1; t += 1) {
        const f = t1 > t0 ? (t - t0) / (t1 - t0) : 1; const p = lerpPos(wp, next, f);
        samples.push({ t, lat: p.lat, lon: p.lon, floor: f < 0.5 ? wp.floor : next.floor, indoor: wp.indoor || next.indoor, moving: true, exact: true, acc: f < 0.5 ? wp.acc : next.acc });
      }
      metresWalked += haversine(wp.lat, wp.lon, next.lat, next.lon);
      arrival = next.tSec;
      continue;
    }
    // Two indoor points in the same building: walk straight between them. OSM has no indoor
    // corridors, so routing would snap both ends to footways outside and zig-zag around the block.
    const sameBuilding = wp.indoor && next.indoor && haversine(wp.lat, wp.lon, next.lat, next.lon) <= SAME_BUILDING_M;
    const { line, len } = sameBuilding
      ? { line: [{ lat: wp.lat, lon: wp.lon }, { lat: next.lat, lon: next.lon }], len: haversine(wp.lat, wp.lon, next.lat, next.lon) }
      : route(graph, wp, next, routeCache);

    // Timing: leave at the end of the dwell, or last-minute if that would make us late.
    const base = WALK_SPEED * uni(rng, 0.95, 1.05);
    let speed = base;
    const travelNominal = len / (base * 0.97); // slight margin for the speed wobble
    let depart = Math.min(dwellEndWanted, next.tSec - travelNominal);
    if (depart < arrival) {
      depart = arrival;
      const avail = next.tSec - arrival;
      speed = avail > 0 ? Math.min(MAX_SPEED, Math.max(base, len / avail)) : MAX_SPEED;
    }
    dwellAt(wp, dwellStart, depart, rng);

    // Walk the polyline at `speed` with a gentle wobble; floors per the building rule.
    const walker = polylineWalker(line);
    let s = 0;
    let wobble = 1;
    let t = Math.ceil(depart);
    while (s < walker.total) {
      wobble = Math.min(1.12, Math.max(0.88, wobble + gauss(rng) * 0.02));
      s = Math.min(walker.total, s + speed * wobble);
      const p = walker.at(s);
      const frac = walker.total > 0 ? s / walker.total : 1;
      let floor = 0; let indoor = false;
      if (sameBuilding) { floor = frac < 1 / 3 ? wp.floor : next.floor; indoor = true; }
      samples.push({ t, lat: p.lat, lon: p.lon, floor, indoor, moving: true });
      t += 1;
      if (s >= walker.total) break;
    }
    metresWalked += len;
    if (process.env.TRACK_DEBUG) {
      const straight = haversine(wp.lat, wp.lon, next.lat, next.lon);
      process.stderr.write(`leg ${wp.idx}->${next.idx}: route ${Math.round(len)} m (straight ${Math.round(straight)} m, x${(len / Math.max(1, straight)).toFixed(2)}), ${speed.toFixed(2)} m/s, depart ${isoLocal(depart)} arrive ${isoLocal(t)}${t > next.tSec ? ' LATE' : ''}\n`);
    }
    arrival = Math.max(t, depart);
    if (len === 0) arrival = depart;
  }

  // ---- emit like the phone: >= 5 m moved or 30 s elapsed, plus accuracy + noise ----
  const noiseRng = mulberry32(0xC0FFEE);
  const emitted = [];
  let last = null;
  let acc = 6;
  for (const smp of samples) {
    if (last) {
      const moved = haversine(last.lat, last.lon, smp.lat, smp.lon);
      if (moved < EMIT_DIST_M && smp.t - last.t < EMIT_SECS) continue;
    }
    if (smp.exact) { // a measured leg: the phone's own fix and accuracy, no synthetic noise
      emitted.push({ t: smp.t, lat: smp.lat, lon: smp.lon, trueLat: smp.lat, trueLon: smp.lon, floor: smp.floor, accuracyM: Math.round(smp.acc ?? acc) });
      last = smp; continue;
    }
    const [lo, hi] = smp.indoor ? [8, 18] : [4, 9];
    const target = uni(noiseRng, lo, hi);
    acc = Math.min(hi, Math.max(lo, acc * 0.6 + target * 0.4)); // accuracy drifts rather than jumps
    const sigma = acc / 6;
    const p = offset(smp.lat, smp.lon, gauss(noiseRng) * sigma, gauss(noiseRng) * sigma);
    emitted.push({ t: smp.t, lat: p.lat, lon: p.lon, trueLat: smp.lat, trueLon: smp.lon, floor: smp.floor, accuracyM: Math.round(acc) });
    last = smp;
  }

  // ---- shifts: assign, drop outside, add shift_start / shift_end rows ----
  const rows = [];
  const perShift = {};
  const positionAt = (sec, fallbackWp) => {
    // Simulated true position at `sec` when covered, else the fallback waypoint.
    if (samples.length && sec >= samples[0].t && sec <= samples[samples.length - 1].t) {
      let lo = 0, hi = samples.length - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (samples[m].t < sec) lo = m + 1; else hi = m; }
      const smp = samples[lo];
      return { lat: smp.lat, lon: smp.lon, floor: smp.floor, indoor: smp.indoor };
    }
    return fallbackWp ? { lat: fallbackWp.lat, lon: fallbackWp.lon, floor: fallbackWp.floor, indoor: fallbackWp.indoor } : null;
  };
  for (const sh of shifts) {
    perShift[sh.shiftId] = 0;
    const inShift = waypoints.filter((w) => w.tSec >= sh.startSec && w.tSec <= sh.endSec);
    const firstWp = inShift[0] || waypoints[0];
    const lastWp = inShift[inShift.length - 1] || waypoints[waypoints.length - 1];
    const sp = positionAt(sh.startSec, firstWp);
    const ep = positionAt(sh.endSec, lastWp);
    if (sp) rows.push({ order: 0, kind: 'shift_start', shift: sh, t: sh.startSec, lat: sp.lat, lon: sp.lon, floor: sp.floor, accuracyM: sp.indoor ? 12 : 6 });
    if (ep) rows.push({ order: 2, kind: 'shift_end', shift: sh, t: sh.endSec, lat: ep.lat, lon: ep.lon, floor: ep.floor, accuracyM: ep.indoor ? 12 : 6 });
  }
  for (const p of emitted) {
    const sh = shifts.find((s) => p.t >= s.startSec && p.t <= s.endSec);
    if (!sh) continue;
    rows.push({ order: 1, kind: 'point', shift: sh, t: p.t, lat: p.lat, lon: p.lon, floor: p.floor, accuracyM: p.accuracyM });
  }
  rows.sort((a, b) => a.t - b.t || a.order - b.order);
  const out = rows.map((r, i) => {
    perShift[r.shift.shiftId]++;
    return {
      pointId: `wk-t-${pad(i + 1, 6)}`,
      deviceId: r.shift.deviceId,
      shiftId: r.shift.shiftId,
      tMicros: micros(r.t),
      t: isoLocal(r.t),
      kind: r.kind,
      lat: +r.lat.toFixed(7),
      lon: +r.lon.toFixed(7),
      accuracyM: r.accuracyM,
      floor: r.floor,
    };
  });

  process.stdout.write(JSON.stringify(out) + '\n');
  const per = Object.entries(perShift).map(([k, v]) => `${k}=${v}`).join(' ');
  process.stderr.write(`track: ${Math.round(metresWalked)} m walked, ${out.length} points, per shift: ${per || '(none)'}\n`);
}

main();
