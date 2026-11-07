#!/usr/bin/env node
// Replay a generated synthetic dataset into a wm-physical database through the same
// ingest_photo call the phone makes, in shift order, after seeding the scenario's asset
// registry and wearers.
//
//   INGEST_TOKEN=... ADMIN_TOKEN=... node demo/synth/replay.mjs <scenario-id> [--db wm-demo] [--gap 10] [--no-seed]
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
  console.log(`seeded ${sc.assets?.length ?? 0} assets, ${sc.wearers?.length ?? 0} wearers into ${db}`);
}

const start = new Date(sc.shift_start);
const offset = sc.shift_start.slice(-6); // keep the scenario's local UTC offset in client_t
const shots = [...sc.shots].sort((a, b) => a.t - b.t).filter(s => manifest.shots[s.id]);
for (const [i, shot] of shots.entries()) {
  // client_t in the scenario's local time with its offset, e.g. 2026-11-07T22:09:00.000-06:00
  const offMin = (offset[0] === '-' ? -1 : 1) * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)));
  const local = new Date(start.getTime() + shot.t * 60_000 + offMin * 60_000);
  const clientT = local.toISOString().replace('Z', '') + offset;
  const event = {
    ingest_token: ingestToken,
    event_id: `synth-${sc.id}-${shot.id}`,
    device_id: deviceId(shot.wearer),
    client_t: clientT,
    source: 'manual_upload',
    photo: { mime: 'image/jpeg', width: 1600, height: 1209 },
    ...(shot.label ? { label: { name: shot.label } } : {}),
    ...(shot.note ? { note: shot.note } : {}),
  };
  const b64 = readFileSync(join(outDir, manifest.shots[shot.id].file)).toString('base64');
  const r = await call('ingest_photo', [JSON.stringify(event), b64]);
  console.log(`${String(i + 1).padStart(2)}/${shots.length} ${shot.id} @ ${clientT.slice(11, 16)} -> ${r}`);
  if (i < shots.length - 1) await new Promise(res => setTimeout(res, gapS * 1000));
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
