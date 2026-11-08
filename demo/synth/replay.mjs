#!/usr/bin/env node
// Replay a generated synthetic dataset into a wm-physical database through the same
// ingest_photo call the phone makes, in shift order, after seeding the scenario's asset
// registry and wearers.
//
//   INGEST_TOKEN=... ADMIN_TOKEN=... node demo/synth/replay.mjs <scenario-id> [--db wm-nmc2] [--gap 10] [--no-seed] [--no-location] [--reset] [--dry out.json]
//
// SPACETIME_HOST defaults to Maincloud. ADMIN_TOKEN defaults to INGEST_TOKEN.
// Each photo is sent once the previous one has been perceived, then --gap seconds later.
// Every event is marked synthetic: event_id "synth-<scenario>-<shot>", device_id
// "synth-<scenario>-<wearer>", source "manual_upload". Re-running is safe: ingest_photo is
// idempotent on event_id. Prefer a separate database for synthetic data so it never mixes
// with the real capture in wm-physical.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSite, makeWalker } from './walk.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
const id = args.find((a, i) => !a.startsWith('--') && !['--db', '--gap', '--dry'].includes(args[i - 1]));
const host = (process.env.SPACETIME_HOST || 'https://maincloud.spacetimedb.com').replace(/\/+$/, '');
const db = flag('db', process.env.SPACETIME_DB_NAME || 'wm-physical');
const gapS = Number(flag('gap', '10'));
const ingestToken = process.env.INGEST_TOKEN;
const adminToken = process.env.ADMIN_TOKEN || ingestToken;
if (!id) {
  console.error('usage: node demo/synth/replay.mjs <scenario-id> [--db name] [--gap seconds] [--no-seed]');
  process.exit(1);
}
const dry = args.includes('--dry'); // no network: print the plan and write the positions to --dry <file.json>
if (!ingestToken && !dry) {
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

const dryLog = { photos: [], track: [] };
async function call(name, argsArr) {
  if (dry) {
    if (name === 'ingest_photo') { const e = JSON.parse(argsArr[0]); dryLog.photos.push({ id: e.event_id, device: e.device_id, t: e.client_t, ...e.location }); }
    if (name === 'ingest_track') { const tr = JSON.parse(argsArr[0]); for (const p of tr.points) dryLog.track.push({ device: tr.device_id, ...p }); }
    return '[dry]';
  }
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
const seed0 = !args.includes('--no-seed');
async function openIssue(i, openedAt = i.opened_at || '') {
  await call('upsert_issue', [adminToken, i.issue_id, i.title, i.asset_id, i.opened_by || '', openedAt, i.status || 'open']);
}

// --reset: remove this scenario's earlier events and tracks first, so a rewritten story does not
// keep stale photos (ingest_photo is idempotent on event_id and would keep the old ones)
if (args.includes('--reset') && !dry) {
  const prefix = `synth-${sc.id}-`;
  const evs = (await sql('SELECT event_id FROM event')).map(r => r[0]).filter(e => String(e).startsWith(prefix));
  for (const e of evs) await call('delete_event', [adminToken, e]);
  const devs = [...new Set((await sql('SELECT device_id FROM track_point')).map(r => r[0]).filter(d => String(d).startsWith(prefix)))];
  for (const d of devs) await call('delete_track', [adminToken, d, '']);
  console.log(`reset: removed ${evs.length} events and the tracks of ${devs.length} devices`);
}

if (seed0) {
  for (const a of sc.assets || []) await call('upsert_asset', [adminToken, a.asset_id, a.name, a.type, a.location, a.patterns || []]);
  for (const w of sc.wearers || []) await call('upsert_wearer', [adminToken, deviceId(w.key), w.name, w.role, w.shift]);
  // work orders opened before the shift are seeded now; ones with `opened_t` are opened when the
  // replay reaches that minute, so the console shows them appear during the shift
  for (const i of (sc.issues || []).filter(i => i.opened_t === undefined)) await openIssue(i);
  console.log(`seeded ${sc.assets?.length ?? 0} assets, ${sc.wearers?.length ?? 0} wearers, ${(sc.issues || []).filter(i => i.opened_t === undefined).length} open work orders into ${db}`);
}

const start = new Date(sc.shift_start);
const offset = sc.shift_start.slice(-6); // keep the scenario's local UTC offset in client_t
const shots = [...sc.shots].sort((a, b) => a.t - b.t).filter(s => dry || manifest.shots[s.id]);
const offMin = (offset[0] === '-' ? -1 : 1) * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)));
const localIso = minutes => new Date(start.getTime() + minutes * 60_000 + offMin * 60_000).toISOString().replace('Z', '') + offset;

// ---- synthetic location ----
// With `site.scene` (a generated site, decision 0032): each photo is taken inside the room its
// shot names, and every wearer walks the corridors between their photos; the track goes up in
// 30 s samples after each photo, like the phone's batches. Without it: decision 0029's random
// walk around site.lat/lon, carried by the busiest wearer.
const site = args.includes('--no-location') ? null : sc.site;
const shiftId = `synth-${sc.id}-shift`;
let seed = [...sc.id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const rng = () => { seed = (seed + 0x6d2b79f5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const jit = m => (rng() - 0.5) * 2 * m;

// per wearer: where each photo was taken, and where they are at any minute
const days = new Map(); // wearer -> { fixAt(shotId), at(tMin), t0, t1 }
if (site?.scene) {
  const walker = makeWalker(loadSite(site.scene), rng);
  for (const w of new Set(shots.map(s => s.wearer))) {
    const mine = shots.filter(s => s.wearer === w);
    const missing = mine.find(s => !s.room); if (missing) throw new Error(`shot ${missing.id} has no room`);
    const day = walker.plan(mine.map(s => ({ t: s.t, room: s.room })));
    const toFix = q => ({ ...walker.ll(q.p), floor: q.lv });
    days.set(w, { fix: id => toFix(day.spots[mine.findIndex(s => s.id === id)]), at: tm => toFix(day.positionAt(tm)), moving: day.moving, t0: mine[0].t - 2, t1: mine.at(-1).t + 2 });
  }
} else if (site) {
  const way = [];
  let x = 0, y = 0, dir = rng() * Math.PI * 2;
  for (const shot of shots) {
    const step = 12 + rng() * 23; dir += (rng() - 0.5) * 1.6; x += Math.cos(dir) * step; y += Math.sin(dir) * step;
    if (Math.hypot(x, y) > site.radius_m) { x *= 0.6; y *= 0.6; dir += Math.PI; }
    way.push({ x, y, t: shot.t, id: shot.id });
  }
  const M = 111_320; // metres per degree of latitude
  const toLL = (x, y) => ({ lat: +(site.lat + y / M).toFixed(6), lon: +(site.lon + x / (M * Math.cos((site.lat * Math.PI) / 180))).toFixed(6) });
  const posAt = tMin => {
    if (tMin <= way[0].t) return way[0]; if (tMin >= way.at(-1).t) return way.at(-1);
    const i = way.findIndex(w => w.t > tMin); const a = way[i - 1], b = way[i]; const k = (tMin - a.t) / Math.max(1e-6, b.t - a.t);
    return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
  };
  const byWearer = new Map(); for (const shot of shots) byWearer.set(shot.wearer, (byWearer.get(shot.wearer) || 0) + 1);
  const main = [...byWearer.entries()].sort((a, b) => b[1] - a[1])[0][0]; // the wearer who walked most carries the track
  const fixOf = id => { const w = way.find(w => w.id === id); return toLL(w.x, w.y); };
  for (const w of byWearer.keys()) days.set(w, { fix: fixOf, at: w === main ? tm => { const p = posAt(tm); return toLL(p.x + jit(2), p.y + jit(2)); } : null, t0: shots[0].t - 1, t1: shots.at(-1).t + 1 });
}

// track batches: every 30 s per wearer, up to a given minute
const sentTo = new Map();
async function sendTrack(uptoMin, last) {
  for (const [w, d] of days) {
    if (!d.at) continue;
    const from = sentTo.get(w) ?? d.t0; const to = Math.min(d.t1, uptoMin); if (to < from) continue;
    // like the phone: a point every 30 s standing still, every ~5 m (5 s at walking pace) on the move
    const points = []; let tm = from;
    while (tm <= to + 1e-9) { const f = d.at(tm); points.push({ t: localIso(tm), ...f, accuracy_m: +(4 + rng() * 5).toFixed(1) }); tm = +(tm + (d.moving?.(tm) || d.moving?.(tm + 0.5) ? 1 / 12 : 0.5)).toFixed(4); }
    const marks = []; if (!sentTo.has(w)) marks.push({ t: localIso(d.t0), kind: 'shift_start' }); if (last || to >= d.t1) marks.push({ t: localIso(d.t1), kind: 'shift_end' });
    sentTo.set(w, tm); if (!points.length) continue;
    for (let i = 0; i < points.length; i += 900) {
      const chunk = points.slice(i, i + 900); const tail = i + 900 >= points.length;
      const track = { device_id: deviceId(w), shift_id: shiftId, ingest_token: ingestToken, app_version: 'synth-replay', points: chunk, marks: (i === 0 ? marks.filter(m => m.kind === 'shift_start') : []).concat(tail ? marks.filter(m => m.kind === 'shift_end') : []) };
      const r = await call('ingest_track', [JSON.stringify(track)]);
      console.log(`   track ${w}: ${chunk.length} points to ${localIso(to).slice(11, 16)} -> ${r}`);
    }
  }
}

const pending = (sc.issues || []).filter(i => i.opened_t !== undefined).sort((a, b) => a.opened_t - b.opened_t);
for (const [i, shot] of shots.entries()) {
  // client_t in the scenario's local time with its offset, e.g. 2026-11-07T22:09:00.000-06:00
  const clientT = localIso(shot.t);
  while (seed0 && pending.length && pending[0].opened_t <= shot.t) { const wo = pending.shift(); await openIssue(wo, localIso(wo.opened_t)); console.log(`   work order ${wo.issue_id} opened`); }
  const d = days.get(shot.wearer);
  const fix = d ? { ...d.fix(shot.id), accuracy_m: +(4 + rng() * 5).toFixed(1), t: clientT, age_ms: Math.round(rng() * 1500) } : null;
  const event = {
    ingest_token: ingestToken,
    event_id: `synth-${sc.id}-${shot.id}`,
    device_id: deviceId(shot.wearer),
    client_t: clientT,
    source: 'manual_upload',
    photo: { mime: 'image/jpeg', width: 1600, height: 1209 },
    ...(shot.label ? { label: { name: shot.label } } : {}),
    ...(shot.note ? { note: shot.note } : {}),
    ...(fix ? { shift_id: shiftId, location: fix } : {}),
  };
  const b64 = dry ? '' : readFileSync(join(outDir, manifest.shots[shot.id].file)).toString('base64');
  const r = await call('ingest_photo', [JSON.stringify(event), b64]);
  console.log(`${String(i + 1).padStart(2)}/${shots.length} ${shot.id} @ ${clientT.slice(11, 16)}${shot.room ? ` in ${shot.room}` : ''} -> ${r}`);
  if (site) await sendTrack(shot.t, i === shots.length - 1);
  // wait until this photo is perceived before sending the next: the alert and fix rules compare
  // each photo with the ones before it, and a slow model call (a fallback after a timeout) must
  // not let a later photo be perceived first
  if (!dry) {
    for (let k = 0; k < 60; k++) {
      const st = (await sql(`SELECT status FROM event WHERE event_id = '${event.event_id}'`))[0]?.[0];
      if (st && st !== 'accepted') break;
      await new Promise(res => setTimeout(res, 2000));
    }
  }
  if (i < shots.length - 1 && !dry) await new Promise(res => setTimeout(res, gapS * 1000));
}
if (site) await sendTrack(Infinity, true);
if (dry) {
  const out = args[args.indexOf('--dry') + 1];
  if (out && !out.startsWith('--')) (await import('node:fs')).writeFileSync(out, JSON.stringify(dryLog));
  console.log(`dry run: ${dryLog.photos.length} photos, ${dryLog.track.length} track points`);
  process.exit(0);
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
