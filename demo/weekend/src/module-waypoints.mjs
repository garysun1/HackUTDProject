#!/usr/bin/env node
// The phone's real track (a SQL dump of wm-physical.track_point) → waypoints for track.mjs, so the
// synthesised walk follows the real fixes wherever they exist and only fills the gaps between them.
// Usage: node module-waypoints.mjs <track_point.json> [--floor-offset shiftPrefix=+3,...] > module-waypoints.json
import { readFileSync } from 'node:fs';
const [, , file, ...rest] = process.argv;
if (!file) { console.error('usage: module-waypoints.mjs <track_point.json> [--floor-offset prefix=+n,...] [--thin seconds]'); process.exit(2); }
const offsets = new Map(); let thin = 20;
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === '--floor-offset') for (const kv of rest[++i].split(',')) { const [k, v] = kv.split('='); offsets.set(k, Number(v)); }
  if (rest[i] === '--thin') thin = Number(rest[++i]);
}
const [res] = JSON.parse(readFileSync(file, 'utf8'));
const cols = res.schema.elements.map(c => (typeof c.name === 'object' ? c.name.some : c.name));
const opt = v => (Array.isArray(v) && v.length === 2 && v[0] === 0 ? v[1] : Array.isArray(v) ? undefined : v);
const rows = res.rows.map(r => Object.fromEntries(cols.map((c, i) => [c, r[i]]))).filter(r => r.kind === 'point').sort((a, b) => (a.t < b.t ? -1 : 1));
const out = []; let lastT = -Infinity; let lastKey = '';
for (const r of rows) {
  const t = Date.parse(r.t); if (!Number.isFinite(t)) continue;
  if (t - lastT < thin * 1000 && r.shift_id === lastKey) continue; lastT = t; lastKey = r.shift_id;
  let floor = opt(r.floor); const off = [...offsets].find(([k]) => r.shift_id.startsWith(k)); if (off) floor = (floor ?? 0) + off[1];
  const acc = Number(r.accuracy_m);
  const w = { t: r.t, lat: Number(r.lat), lon: Number(r.lon), accuracyM: acc, real: true, shiftRef: r.shift_id.slice(0, 8) };
  if (floor !== undefined && floor !== null) w.floor = floor; // a floor marks the fix as indoors
  out.push(w);
}
process.stdout.write(JSON.stringify(out));
console.error(`${out.length} waypoints from ${rows.length} real fixes (thinned to one per ${thin} s)`);
