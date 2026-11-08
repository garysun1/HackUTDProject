#!/usr/bin/env node
// Seed the asset registry and wearers from CSV through the module's admin reducers.
//   ADMIN_TOKEN=... node module/scripts/seed.mjs [assets.csv] [wearers.csv] [issues.csv]
// Defaults: demo/assets.csv, demo/wearers.csv, demo/issues.csv (work orders; opened_at ISO or empty for 3 h ago). ADMIN_TOKEN is the module's ADMIN_TOKEN env
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
const [assetsPath = 'demo/assets.csv', wearersPath = 'demo/wearers.csv', issuesPath = 'demo/issues.csv'] = process.argv.slice(2);

function splitCsv(line) {
  // commas split cells; a double-quoted cell may contain commas ("" is a literal quote)
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}
function csv(path) {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#'));
  const head = splitCsv(lines.shift()).map(h => h.trim());
  return lines.map(l => {
    const cells = splitCsv(l);
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
n = 0;
try {
  for (const r of csv(issuesPath)) {
    if (!r.issue_id) continue;
    await call('upsert_issue', [token, r.issue_id, r.title, r.asset_id, r.opened_by || '', r.opened_at || '', r.status || 'open']);
    n++;
  }
  console.log(`work orders: ${n} upserted`);
} catch (e) {
  if (e.code === 'ENOENT') console.log('work orders: no file, skipped');
  else throw e;
}
