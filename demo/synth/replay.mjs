#!/usr/bin/env node
// Replay a generated synthetic dataset into a wm-physical database through the same
// ingest_photo call the phone makes, in shift order, after seeding the scenario's asset
// registry and wearers.
//
//   INGEST_TOKEN=... ADMIN_TOKEN=... node demo/synth/replay.mjs <scenario-id> [--db wm-nmc2] [--gap 10] [--no-seed] [--no-location]
//
// SPACETIME_HOST defaults to Maincloud. ADMIN_TOKEN defaults to INGEST_TOKEN.
// Every event is marked synthetic: event_id "synth-<scenario>-<shot>", device_id
// "synth-<scenario>-<wearer>", source "manual_upload". Re-running is safe: ingest_photo is
// idempotent on event_id. Prefer a separate database for synthetic data so it never mixes
// with the real capture in wm-physical.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
const id = args.find((a, i) => !a.startsWith('--') && !['--db', '--gap'].includes(args[i - 1]));
const host = (process.env.SPACETIME_HOST || 'https://maincloud.spacetimedb.com').replace(/\/+$/, '');
const db = flag('db', process.env.SPACETIME_DB_NAME || 'wm-physical');
const gapS = Number(flag('gap', '10'));
const ingestToken = process.env.INGEST_TOKEN;
const adminToken = process.env.ADMIN_TOKEN || ingestToken;
if (!id) {
  console.error('usage: node demo/synth/replay.mjs <scenario-id> [--db name] [--gap seconds] [--no-seed]');
  process.exit(1);
}
if (!ingestToken) {
  console.error('INGEST_TOKEN is required.');
  process.exit(1);
}

const sc = JSON.parse(readFileSync(join(HERE, 'scenarios', `${id}.json`), 'utf8'));
const outDir = join(HERE, 'out', id);
const manifestPath = join(outDir, 'manifest.json');
if (!existsSync(manifestPath)) {
  console.error(`No generated images for ${id}. Run: node demo/synth/generate.mjs ${id}`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

async function call(name, argsArr) {
  const res = await fetch(`${host}/v1/database/${db}/call/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(argsArr),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${name} ${res.status}: ${text.slice(0, 200)}`);
  return text;
}
async function sql(q) {
  const res = await fetch(`${host}/v1/database/${db}/sql`, { method: 'POST', body: q });
  return (await res.json())?.[0]?.rows ?? [];
}

const deviceId = key => `synth-${sc.id}-${key}`;

if (!args.includes('--no-seed')) {
  for (const a of sc.assets || []) await call('upsert_asset', [adminToken, a.asset_id, a.name, a.type, a.location, a.patterns || []]);
  for (const w of sc.wearers || []) await call('upsert_wearer', [adminToken, deviceId(w.key), w.name, w.role, w.shift]);
  for (const i of sc.issues || []) await call('upsert_issue', [adminToken, i.issue_id, i.title, i.asset_id, i.opened_by || '', i.opened_at || '', i.status || 'open']);
  console.log(`seeded ${sc.assets?.length ?? 0} assets, ${sc.wearers?.length ?? 0} wearers, ${sc.issues?.length ?? 0} work orders into ${db}`);
}

const start = new Date(sc.shift_start);
const offset = sc.shift_start.slice(-6); // keep the scenario's local UTC offset in client_t
const shots = [...sc.shots].sort((a, b) => a.t - b.t).filter(s => manifest.shots[s.id]);
const offMin = (offset[0] === '-' ? -1 : 1) * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)));
const localIso = minutes => new Date(start.getTime() + minutes * 60_000 + offMin * 60_000).toISOString().replace('Z', '') + offset;

// ---- synthetic location (decision 0029): a plausible walk around the scenario's site ----
// Deterministic per scenario. Photos get a fix at their waypoint; the track is sampled every 30 s
// along the walk with small jitter, like the phone's own sampler, and sent through ingest_track.
const site = args.includes('--no-location') ? null : sc.site;
const shiftId = `synth-${sc.id}-shift`;
let seed = [...sc.id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const rng = () => { seed = (seed + 0x6d2b79f5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const way = [];
if (site) {
  let x = 0, y = 0, dir = rng() * Math.PI * 2;
  for (const shot of shots) {
    const step = 12 + rng() * 23; dir += (rng() - 0.5) * 1.6; x += Math.cos(dir) * step; y += Math.sin(dir) * step;
    if (Math.hypot(x, y) > site.radius_m) { x *= 0.6; y *= 0.6; dir += Math.PI; }
    way.push({ x, y, t: shot.t });
  }
}
const M = 111_320; // metres per degree of latitude
const toLL = (x, y) => ({ lat: +(site.lat + y / M).toFixed(6), lon: +(site.lon + x / (M * Math.cos((site.lat * Math.PI) / 180))).toFixed(6) });
const posAt = tMin => {
  if (tMin <= way[0].t) return way[0]; if (tMin >= way.at(-1).t) return way.at(-1);
  const i = way.findIndex(w => w.t > tMin); const a = way[i - 1], b = way[i]; const k = (tMin - a.t) / Math.max(1e-6, b.t - a.t);
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
};
for (const [i, shot] of shots.entries()) {
  // client_t in the scenario's local time with its offset, e.g. 2026-11-07T22:09:00.000-06:00
  const clientT = localIso(shot.t);
  const fix = site ? { ...toLL(way[i].x, way[i].y), accuracy_m: +(5 + rng() * 7).toFixed(1), t: clientT, age_ms: Math.round(rng() * 1500) } : null;
  const event = {
    ingest_token: ingestToken,
    event_id: `synth-${sc.id}-${shot.id}`,
    device_id: deviceId(shot.wearer),
    client_t: clientT,
    source: 'manual_upload',
    photo: { mime: 'image/jpeg', width: 1600, height: 1209 },
    ...(shot.label ? { label: { name: shot.label } } : {}),
    ...(shot.note ? { note: shot.note } : {}),
    ...(site ? { shift_id: shiftId, location: fix } : {}),
  };
  const b64 = readFileSync(join(outDir, manifest.shots[shot.id].file)).toString('base64');
  const r = await call('ingest_photo', [JSON.stringify(event), b64]);
  console.log(`${String(i + 1).padStart(2)}/${shots.length} ${shot.id} @ ${clientT.slice(11, 16)} -> ${r}`);
  if (i < shots.length - 1) await new Promise(res => setTimeout(res, gapS * 1000));
}

// the shift track: one batch per wearer, every 30 s from one minute before the first photo to one minute after the last
if (site && shots.length) {
  const byWearer = new Map();
  for (const shot of shots) byWearer.set(shot.wearer, (byWearer.get(shot.wearer) || 0) + 1);
  const main = [...byWearer.entries()].sort((a, b) => b[1] - a[1])[0][0]; // the wearer who walked most carries the track
  const t0 = shots[0].t - 1, t1 = shots.at(-1).t + 1; const points = [];
  for (let tm = t0; tm <= t1; tm += 0.5) { const p = posAt(tm); const ll = toLL(p.x + (rng() - 0.5) * 4, p.y + (rng() - 0.5) * 4); points.push({ t: localIso(tm), ...ll, accuracy_m: +(4 + rng() * 6).toFixed(1) }); }
  const track = { device_id: deviceId(main), shift_id: shiftId, ingest_token: ingestToken, app_version: 'synth-replay', points, marks: [{ t: localIso(t0), kind: 'shift_start' }, { t: localIso(t1), kind: 'shift_end' }] };
  const r = await call('ingest_track', [JSON.stringify(track)]);
  console.log(`track: ${points.length} points for ${main} -> ${r}`);
}

// wait for the last photo to be perceived, then report
const ids = shots.map(s => `'synth-${sc.id}-${s.id}'`).join(',');
for (let k = 0; k < 20; k++) {
  const rows = await sql(`SELECT event_id, status FROM event WHERE event_id = 'synth-${sc.id}-${shots.at(-1).id}'`);
  if (rows[0]?.[1] && rows[0][1] !== 'accepted') break;
  await new Promise(res => setTimeout(res, 3000));
}
const statuses = await sql(`SELECT event_id, status, summary FROM event`);
const mine = statuses.filter(r => ids.includes(`'${r[0]}'`));
console.log(`\n${mine.filter(r => r[1] === 'in_graph').length}/${shots.length} in graph`);
for (const r of mine) console.log(`  ${r[0].replace(`synth-${sc.id}-`, '')}: ${r[1]} | ${String(r[2]).slice(0, 100)}`);
const alerts = await sql(`SELECT event_id, text, entity_name FROM alert`);
for (const a of alerts.filter(a => String(a[0]).startsWith(`synth-${sc.id}-`))) console.log(`  ALERT ${a[2]}: ${a[1]}`);
