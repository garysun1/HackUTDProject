#!/usr/bin/env node
// The team's weekend through the real pipeline, into its own database (default wm-weekend), so the
// MCP server and the console read a memory the system actually built, not a curated overlay.
//
//   INGEST_TOKEN=... node demo/weekend/src/ingest-real.mjs [--db wm-weekend] [--dry-run]
//
// What goes in: only photos taken on the Ray-Ban Meta glasses.
//   - the capture app's uploads in wm-physical (source shutter_button | sdk_capture), minus the
//     manifest's hideLive test shots; the JPEG is the one the phone uploaded (faces already blurred)
//   - the weekend manifest's camera-roll photos (exported from the glasses via the Meta AI app),
//     using the face-blurred copies the builder published in web/public/weekend/photos/
// What is carried: each photo's capture time and wearer; the wearer's own note and the phone's
// real location fix only where the capture app recorded them; the phone's real walking track.
// What is NOT carried: the overlay's curated captions, notes, entities, issues, guessed positions
// and synthesised walk. Perception (Nemotron VL) reads every photo afresh and builds the graph.
//
// Every photo is sent as an import (camera_roll for camera-roll photos, manual_upload for the
// re-imported capture-app photos) so the module keeps its capture time; the original source is
// written to provenance.json next to this script. Each photo waits for perception before the next,
// which keeps NEXT edges, change history and the model's rate limit in order. Idempotent on event id.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const HOST = (process.env.SPACETIME_HOST || 'https://maincloud.spacetimedb.com').replace(/\/+$/, '');
const SRC = 'wm-physical';
const DB = flag('db', 'wm-weekend');
const DRY = args.includes('--dry-run');
const token = process.env.INGEST_TOKEN;
if (!token && !DRY) { console.error('INGEST_TOKEN is required.'); process.exit(1); }
const GLASSES_SOURCES = new Set(['shutter_button', 'sdk_capture']);

async function sql(db, q) {
  const r = await fetch(`${HOST}/v1/database/${db}/sql`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: q });
  if (!r.ok) throw new Error(`sql ${db} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const [res] = await r.json(); const cols = res.schema.elements.map(e => e.name.some);
  const un = v => (Array.isArray(v) && v.length === 2 && (v[0] === 0 || v[0] === 1) ? (v[0] === 0 ? v[1] : null) : v);
  return res.rows.map(row => Object.fromEntries(row.map((v, i) => [cols[i], un(v)])));
}
async function call(name, a) {
  const r = await fetch(`${HOST}/v1/database/${DB}/call/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(a) });
  const t = await r.text(); if (!r.ok) throw new Error(`${name} ${r.status}: ${t.slice(0, 200)}`); return t;
}
const esc = s => String(s).replace(/'/g, "''");
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- the set ----
const manifest = JSON.parse(readFileSync(join(HERE, '..', 'manifest.json'), 'utf8'));
const overlay = JSON.parse(readFileSync(join(ROOT, 'web', 'public', 'weekend', 'weekend.json'), 'utf8'));
const hidden = new Set(manifest.hideLive || []);
const live = (await sql(SRC, 'SELECT event_id, device_id, client_t, source, note, label FROM event'))
  .filter(e => GLASSES_SOURCES.has(e.source) && !hidden.has(e.event_id));
const fixes = new Map((await sql(SRC, 'SELECT * FROM event_location')).map(l => [l.event_id, l]));
const items = [];
for (const e of live) items.push({ id: e.event_id, deviceId: e.device_id, t: e.client_t, origin: e.source, send: 'manual_upload', note: e.note || undefined, label: e.label || undefined, fix: fixes.get(e.event_id), photo: { from: 'wm-physical' } });
for (const e of manifest.events) {
  if (e.source !== 'camera_roll') continue; // the manifest's shutter/sdk rows are the live ones above
  const rel = overlay.photos[e.id]; const file = rel && join(ROOT, 'web', 'public', 'weekend', rel);
  if (!file || !existsSync(file)) { console.warn(`skip ${e.id}: no published photo`); continue; }
  items.push({ id: e.id, deviceId: e.deviceId, t: e.t, origin: 'camera_roll (Meta AI app export)', send: 'camera_roll', photo: { file } });
}
items.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
console.log(`${items.length} glasses photos: ${items.filter(i => i.photo.from).length} from the capture app, ${items.filter(i => i.photo.file).length} from the camera roll → ${DB}`);
writeFileSync(join(HERE, 'provenance.json'), JSON.stringify({ db: DB, generatedAt: new Date().toISOString(), photos: items.map(i => ({ id: i.id, deviceId: i.deviceId, t: i.t, origin: i.origin, sentAs: i.send, note: !!i.note, fix: !!i.fix })) }, null, 1) + '\n');
if (DRY) { for (const i of items) console.log(`  ${i.t} ${i.deviceId.padEnd(14)} ${i.origin}`); process.exit(0); }

// ---- wearers ----
const wearers = await sql(SRC, 'SELECT device_id, name, role, shift FROM wearer');
for (const d of new Set(items.map(i => i.deviceId))) {
  const w = wearers.find(x => x.device_id === d) || { name: d, role: 'Builder', shift: 'Weekend' };
  await call('upsert_wearer', [token, d, w.name, 'Builder', 'All weekend']);
}

// ---- photos, oldest first, one at a time ----
const done = new Map((await sql(DB, 'SELECT event_id, status FROM event')).map(r => [r.event_id, r.status]));
for (const [n, it] of items.entries()) {
  const tag = `${String(n + 1).padStart(2)}/${items.length} ${it.t.slice(0, 16)} ${it.id.slice(0, 10)}`;
  if (done.get(it.id) === 'in_graph') { console.log(`${tag} already in graph`); continue; }
  let b64, mime = 'image/jpeg';
  if (it.photo.file) b64 = readFileSync(it.photo.file).toString('base64');
  else { const [p] = await sql(SRC, `SELECT mime, jpeg_b_64 FROM photo WHERE event_id = '${esc(it.id)}'`); if (!p) { console.warn(`${tag} no photo in ${SRC}, skipped`); continue; } b64 = p.jpeg_b_64; mime = p.mime || mime; }
  const ev = { ingest_token: token, event_id: it.id, device_id: it.deviceId, client_t: it.t, source: it.send, photo: { mime },
    ...(it.note ? { note: it.note } : {}), ...(it.label ? { label: { name: it.label } } : {}),
    ...(it.fix ? { shift_id: it.fix.shift_id, location: { lat: it.fix.lat, lon: it.fix.lon, accuracy_m: it.fix.accuracy_m, ...(it.fix.alt_m != null ? { alt_m: it.fix.alt_m } : {}), ...(it.fix.floor != null ? { floor: it.fix.floor } : {}), t: it.fix.fix_t || it.t, ...(it.fix.age_ms != null ? { age_ms: it.fix.age_ms } : {}) } } : {}) };
  const res = await call('ingest_photo', [JSON.stringify(ev), b64]);
  let status = 'accepted', summary = '';
  for (let k = 0; k < 40 && status === 'accepted'; k++) { await sleep(2500); const [r] = await sql(DB, `SELECT status, summary FROM event WHERE event_id = '${esc(it.id)}'`); status = r?.status || status; summary = r?.summary || ''; }
  console.log(`${tag} ${JSON.parse(res)[2]} → ${status} | ${summary.slice(0, 90)}`);
}

// ---- the phone's real walking track, shift by shift ----
const devices = new Set(items.map(i => i.deviceId));
const pts = (await sql(SRC, 'SELECT * FROM track_point')).filter(p => devices.has(p.device_id));
const byShift = new Map(); for (const p of pts) { const k = `${p.device_id}|${p.shift_id}`; (byShift.get(k) ?? byShift.set(k, []).get(k)).push(p); }
for (const [k, list] of byShift) {
  const [device_id, shift_id] = k.split('|'); list.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  for (let i = 0; i < list.length; i += 800) {
    const chunk = list.slice(i, i + 800);
    const points = chunk.filter(p => p.kind === 'point').map(p => ({ t: p.t, lat: p.lat, lon: p.lon, accuracy_m: p.accuracy_m, ...(p.alt_m != null ? { alt_m: p.alt_m } : {}), ...(p.floor != null ? { floor: p.floor } : {}), ...(p.speed_mps != null ? { speed_mps: p.speed_mps } : {}), ...(p.course_deg != null ? { course_deg: p.course_deg } : {}) }));
    const marks = chunk.filter(p => p.kind !== 'point').map(p => ({ t: p.t, kind: p.kind }));
    const r = await call('ingest_track', [JSON.stringify({ device_id, shift_id, ingest_token: token, app_version: 'weekend-reimport', points, marks })]);
    console.log(`track ${shift_id.slice(0, 8)} ${points.length} points ${marks.length} marks → ${r}`);
  }
}
const final = await sql(DB, 'SELECT status FROM event'); const alerts = await sql(DB, 'SELECT text, entity_name FROM alert');
console.log(`\n${final.filter(r => r.status === 'in_graph').length}/${final.length} in graph · ${alerts.length} alerts raised by the pipeline`);
for (const a of alerts) console.log(`  ALERT ${a.entity_name || '-'}: ${a.text}`);
