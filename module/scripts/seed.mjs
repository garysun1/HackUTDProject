#!/usr/bin/env node
// Seed the asset registry and wearers from CSV through the module's admin reducers.
//   ADMIN_TOKEN=... node module/scripts/seed.mjs [assets.csv] [wearers.csv]
// Defaults: demo/assets.csv, demo/wearers.csv. ADMIN_TOKEN is the module's ADMIN_TOKEN env
// value (or INGEST_TOKEN if ADMIN_TOKEN is unset). SPACETIME_HOST / SPACETIME_DB_NAME default
// to Maincloud / wm-physical. Rows whose device_id starts with REPLACE are skipped.
import { readFileSync } from 'node:fs';

const host = (process.env.SPACETIME_HOST || 'https://maincloud.spacetimedb.com').replace(/\/+$/, '');
const db = process.env.SPACETIME_DB_NAME || 'wm-physical';
const token = process.env.ADMIN_TOKEN;
if (!token) {
  console.error('Set ADMIN_TOKEN (or the INGEST_TOKEN value if ADMIN_TOKEN is not configured).');
  process.exit(1);
}
const [assetsPath = 'demo/assets.csv', wearersPath = 'demo/wearers.csv'] = process.argv.slice(2);

function csv(path) {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#'));
  const head = lines.shift().split(',').map(h => h.trim());
  return lines.map(l => {
    const cells = l.split(',');
    // last column may contain commas only if it is the final one; keep it simple: join the rest
    const row = {};
    head.forEach((h, i) => (row[h] = (i === head.length - 1 ? cells.slice(i).join(',') : cells[i] ?? '').trim()));
    return row;
  });
}

async function call(reducer, args) {
  const res = await fetch(`${host}/v1/database/${db}/call/${reducer}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`${reducer} ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

let n = 0;
for (const r of csv(assetsPath)) {
  const patterns = (r.patterns || '').split(';').map(s => s.trim()).filter(Boolean);
  await call('upsert_asset', [token, r.asset_id, r.name, r.type, r.location, patterns]);
  n++;
}
console.log(`assets: ${n} upserted`);
n = 0;
try {
  for (const r of csv(wearersPath)) {
    if (!r.device_id || r.device_id.startsWith('REPLACE')) continue;
    await call('upsert_wearer', [token, r.device_id, r.name, r.role, r.shift]);
    n++;
  }
  console.log(`wearers: ${n} upserted`);
} catch (e) {
  if (e.code === 'ENOENT') console.log('wearers: no file, skipped');
  else throw e;
}
