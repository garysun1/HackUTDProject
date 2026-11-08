#!/usr/bin/env node
// Switch which dataset the console and MCP server show, without touching the frontend
// (decision 0029). Writes demo_config.active_dataset on the directory database (wm-physical).
//
//   ADMIN_TOKEN=... node module/scripts/dataset.mjs            # show the current dataset and the known ones
//   ADMIN_TOKEN=... node module/scripts/dataset.mjs wm-nmc2    # switch; the console follows within a second
//   ADMIN_TOKEN=... node module/scripts/dataset.mjs live       # back to the real capture (wm-physical)
//
// ADMIN_TOKEN is the module's ADMIN_TOKEN env value, or INGEST_TOKEN if ADMIN_TOKEN is unset.
const HOST = (process.env.SPACETIME_HOST || 'https://maincloud.spacetimedb.com').replace(/\/+$/, '');
const DIRECTORY = 'wm-physical';
const KNOWN = {
  live: { db: 'wm-physical', what: 'the real capture: our photos, Edward\'s walk' },
  'wm-physical': { db: 'wm-physical', what: 'the real capture: our photos, Edward\'s walk' },
  'wm-nmc2': { db: 'wm-nmc2', what: 'NMC² data center night shift (synthetic, 10 photos, PDU-A PSU2 OK → FAULT → OK)' },
  'wm-plant': { db: 'wm-plant', what: 'automotive plant second shift: CNC-07 spindle overtemp fixed, HP-2 leak left open (synthetic, 14 photos)' },
  'wm-hospital': { db: 'wm-hospital', what: 'hospital biomed rounds: BBR-2 fridge alarm fixed, pump 10442 tagged out (synthetic, 15 photos)' },
  'wm-substation': { db: 'wm-substation', what: 'Northlake substation: CB-12 trip found and restored, T2 oil low left open (synthetic, 15 photos)' },
  'wm-warehouse': { db: 'wm-warehouse', what: 'distribution center early shift: aisle 22 upright replaced, FZ-1 freezer left open (synthetic, 15 photos)' },
};
const token = process.env.ADMIN_TOKEN || process.env.INGEST_TOKEN;
const arg = process.argv[2];

async function current() {
  const r = await fetch(`${HOST}/v1/database/${DIRECTORY}/sql`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: "SELECT value FROM demo_config WHERE key = 'active_dataset'" });
  const [res] = await r.json(); return res?.rows?.[0]?.[0] || DIRECTORY;
}
async function count(db) {
  try { const r = await fetch(`${HOST}/v1/database/${db}/sql`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'SELECT event_id FROM event' }); const [res] = await r.json(); return res?.rows?.length ?? 0; } catch { return '?'; }
}
if (!arg) {
  const cur = await current();
  console.log(`active: ${cur}\n`);
  for (const [name, k] of Object.entries(KNOWN)) if (name !== 'live') console.log(`${name === cur ? '*' : ' '} ${name.padEnd(14)} ${String(await count(k.db)).padStart(3)} photos  ${k.what}`);
  console.log('\nnode module/scripts/dataset.mjs <name>   (or "live")');
  process.exit(0);
}
if (!token) { console.error('Set ADMIN_TOKEN (or INGEST_TOKEN).'); process.exit(1); }
const target = KNOWN[arg]?.db || arg;
const r = await fetch(`${HOST}/v1/database/${DIRECTORY}/call/set_config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([token, 'active_dataset', target]) });
if (!r.ok) { console.error(`set_config failed: ${r.status} ${(await r.text()).slice(0, 200)}`); process.exit(1); }
console.log(`active dataset → ${target}${KNOWN[arg] ? `  (${KNOWN[arg].what})` : ''}`);
