#!/usr/bin/env node
// build.mjs — turns demo/weekend/manifest.json into web/public/weekend/weekend.json
// plus blurred/resized photos and thumbs. Node built-ins only, plus the macOS CLIs
// `sips` and `swift` (for src/blur.swift). See MANIFEST_SCHEMA.md for both shapes.
//
//   node demo/weekend/src/build.mjs [--manifest demo/weekend/manifest.json]
//       [--out web/public/weekend] [--module-photos <dir>] [--skip-blur]

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url)); // demo/weekend/src
const WEEKEND_DIR = path.resolve(SRC_DIR, '..'); // demo/weekend
const REPO_ROOT = path.resolve(WEEKEND_DIR, '..', '..');

const DEFAULT_MODULE_PHOTOS =
  '/private/tmp/claude-501/-Users-edwardkim-HackUTDProject-floor/f1ddb477-79cd-4ff6-9167-6b733fe2903e/scratchpad/module/photos';

// ---------- args ----------
function parseArgs(argv) {
  const opts = {
    manifest: path.join(WEEKEND_DIR, 'manifest.json'),
    out: path.join(REPO_ROOT, 'web', 'public', 'weekend'),
    modulePhotos: DEFAULT_MODULE_PHOTOS,
    skipBlur: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) fail(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--manifest') opts.manifest = path.resolve(next());
    else if (a === '--out') opts.out = path.resolve(next());
    else if (a === '--module-photos') opts.modulePhotos = path.resolve(next());
    else if (a === '--skip-blur') opts.skipBlur = true;
    else if (a === '-h' || a === '--help') {
      process.stderr.write(
        'usage: node demo/weekend/src/build.mjs [--manifest demo/weekend/manifest.json] [--out web/public/weekend] [--module-photos <dir>] [--skip-blur]\n',
      );
      process.exit(0);
    } else fail(`unknown argument ${a}`);
  }
  return opts;
}

function fail(msg) {
  process.stderr.write(`build.mjs: ${msg}\n`);
  process.exit(1);
}
const warnings = [];
function warn(msg) {
  warnings.push(msg);
  process.stderr.write(`warning: ${msg}\n`);
}

// ---------- helpers ----------
const micros = (iso) => String(Date.parse(iso) * 1000);
const slug = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'place';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const hasPos = (e) => isNum(e.lat) && isNum(e.lon);
const SOURCES = new Set(['shutter_button', 'sdk_capture', 'camera_roll', 'manual_upload']);
const KINDS = new Set(['fault_text', 'anomaly', 'state_change']);

// ---------- validation ----------
function validate(m) {
  const errors = [];
  const err = (s) => errors.push(s);
  if (!m || typeof m !== 'object') fail('manifest is not an object');
  if (!Array.isArray(m.wearers)) err('wearers must be an array');
  if (!Array.isArray(m.shifts)) err('shifts must be an array');
  if (!Array.isArray(m.events) || m.events.length === 0) err('events must be a non-empty array');
  m.issues ??= [];
  m.hideLive ??= [];
  m.extraWaypoints ??= [];
  if (!Array.isArray(m.issues)) err('issues must be an array');
  if (!Array.isArray(m.hideLive)) err('hideLive must be an array');
  if (!Array.isArray(m.extraWaypoints)) err('extraWaypoints must be an array');
  if (errors.length) fail(`invalid manifest:\n  - ${errors.join('\n  - ')}`);

  const devices = new Set((m.wearers ?? []).map((w) => w.deviceId));
  const shiftIds = new Set();
  for (const [i, s] of m.shifts.entries()) {
    const tag = `shift[${i}] ${s.shiftId ?? '(no id)'}`;
    if (!s.shiftId) err(`${tag}: missing shiftId`);
    else if (shiftIds.has(s.shiftId)) err(`${tag}: duplicate shiftId`);
    shiftIds.add(s.shiftId);
    if (!s.deviceId) err(`${tag}: missing deviceId`);
    else if (devices.size && !devices.has(s.deviceId)) warn(`${tag}: deviceId ${s.deviceId} is not in wearers`);
    if (Number.isNaN(Date.parse(s.start))) err(`${tag}: start does not parse (${s.start})`);
    if (Number.isNaN(Date.parse(s.end))) err(`${tag}: end does not parse (${s.end})`);
    if (Date.parse(s.start) >= Date.parse(s.end)) err(`${tag}: start is not before end`);
  }

  const eventIds = new Set();
  for (const [i, e] of m.events.entries()) {
    const tag = `event[${i}] ${e.id ?? '(no id)'}`;
    if (!e.id) err(`${tag}: missing id`);
    else if (eventIds.has(e.id)) err(`${tag}: duplicate id`);
    eventIds.add(e.id);
    if (!e.deviceId) err(`${tag}: missing deviceId`);
    else if (devices.size && !devices.has(e.deviceId)) warn(`${tag}: deviceId ${e.deviceId} is not in wearers`);
    if (Number.isNaN(Date.parse(e.t))) err(`${tag}: t does not parse (${e.t})`);
    if (!e.photo || typeof e.photo !== 'string') err(`${tag}: missing photo`);
    if (!e.place) err(`${tag}: missing place`);
    if (e.source && !SOURCES.has(e.source)) warn(`${tag}: unknown source ${e.source}`);
    const hasLat = e.lat !== undefined && e.lat !== null;
    const hasLon = e.lon !== undefined && e.lon !== null;
    if (hasLat !== hasLon) err(`${tag}: lat and lon must both be given`);
    if (hasLat && (!isNum(e.lat) || e.lat < -90 || e.lat > 90)) err(`${tag}: lat out of range (${e.lat})`);
    if (hasLon && (!isNum(e.lon) || e.lon < -180 || e.lon > 180)) err(`${tag}: lon out of range (${e.lon})`);
    if (!hasLat) warn(`${tag}: no lat/lon, it gets no location row`);
    const kf = e.keepFaces;
    if (kf !== undefined && kf !== 'all' && kf !== 'none') {
      if (!Array.isArray(kf) || !kf.every((r) => Array.isArray(r) && r.length === 4 && r.every(isNum)))
        err(`${tag}: keepFaces must be "all", "none" or an array of [x,y,w,h]`);
    }
  }

  const issueIds = new Set();
  for (const [i, is] of m.issues.entries()) {
    const tag = `issue[${i}] ${is.id ?? '(no id)'}`;
    if (!is.id) err(`${tag}: missing id`);
    else if (issueIds.has(is.id)) err(`${tag}: duplicate id`);
    issueIds.add(is.id);
    if (!is.raisedBy) err(`${tag}: missing raisedBy`);
    else if (!eventIds.has(is.raisedBy)) err(`${tag}: raisedBy ${is.raisedBy} is not an event`);
    if (is.resolvedBy && !eventIds.has(is.resolvedBy)) err(`${tag}: resolvedBy ${is.resolvedBy} is not an event`);
    if (is.kind && !KINDS.has(is.kind)) warn(`${tag}: unknown kind ${is.kind}`);
  }

  for (const [i, w] of m.extraWaypoints.entries()) {
    const tag = `extraWaypoints[${i}]`;
    if (Number.isNaN(Date.parse(w.t))) err(`${tag}: t does not parse (${w.t})`);
    if (!isNum(w.lat) || w.lat < -90 || w.lat > 90) err(`${tag}: lat out of range`);
    if (!isNum(w.lon) || w.lon < -180 || w.lon > 180) err(`${tag}: lon out of range`);
  }

  if (errors.length) fail(`invalid manifest:\n  - ${errors.join('\n  - ')}`);
}

// ---------- shift lookup ----------
function shiftFor(shifts, deviceId, tIso) {
  const t = Date.parse(tIso);
  const mine = shifts.filter((s) => s.deviceId === deviceId);
  const pool = mine.length ? mine : shifts;
  if (!pool.length) return null;
  for (const s of pool) if (t >= Date.parse(s.start) && t <= Date.parse(s.end)) return s.shiftId;
  let best = null;
  let bestD = Infinity;
  for (const s of pool) {
    const d = Math.min(Math.abs(t - Date.parse(s.start)), Math.abs(t - Date.parse(s.end)));
    if (d < bestD) {
      bestD = d;
      best = s.shiftId;
    }
  }
  return best;
}

// ---------- photos ----------
function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return r;
}

function keepArg(kf) {
  if (kf === 'all') return 'all';
  if (Array.isArray(kf)) return kf.length ? kf.map((r) => r.join(',')).join(';') : 'none';
  return 'none';
}

function isNewer(out, src) {
  try {
    return fs.statSync(out).mtimeMs >= fs.statSync(src).mtimeMs;
  } catch {
    return false;
  }
}

// ---------- main ----------
function main() {
  const opts = parseArgs(process.argv.slice(2));
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(opts.manifest, 'utf8'));
  } catch (e) {
    fail(`cannot read manifest ${opts.manifest}: ${e.message}`);
  }
  validate(manifest);

  const events = [...manifest.events].sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  const byId = new Map(events.map((e) => [e.id, e]));
  const wearerName = new Map((manifest.wearers ?? []).map((w) => [w.deviceId, w.name]));

  // events
  const outEvents = events.map((e) => ({
    eventId: e.id,
    deviceId: e.deviceId,
    clientT: e.t,
    tMicros: micros(e.t),
    source: e.source ?? 'camera_roll',
    status: 'in_graph',
    note: e.note ?? '',
    label: e.label ?? '',
    scene: e.place,
    locationGuess: e.place,
    activity: e.activity ?? '',
    summary: e.summary ?? '',
    peopleCount: e.people ?? 0,
    confidence: 0.9,
    perceptionJson: JSON.stringify({
      scene: e.place,
      text_in_scene: e.textInScene ?? [],
      people_count: e.people ?? 0,
      summary: e.summary ?? '',
    }),
  }));

  // entities (places)
  const places = new Map();
  for (const e of events) {
    const id = slug(e.place);
    const m = micros(e.t);
    const p = places.get(id);
    if (!p) places.set(id, { entityId: id, canonicalName: e.place, kind: 'place', aliases: [], firstSeenMicros: m, lastSeenMicros: m });
    else {
      if (BigInt(m) < BigInt(p.firstSeenMicros)) p.firstSeenMicros = m;
      if (BigInt(m) > BigInt(p.lastSeenMicros)) p.lastSeenMicros = m;
    }
  }
  const entities = [...places.values()];

  // edges
  let nextEdge = 900001;
  const edges = [];
  for (const e of events) edges.push({ edgeId: String(nextEdge++), fromId: e.id, toId: slug(e.place), kind: 'INVOLVES', props: '{"role":"setting"}' });
  const lastByDevice = new Map();
  for (const e of events) {
    const prev = lastByDevice.get(e.deviceId);
    if (prev) edges.push({ edgeId: String(nextEdge++), fromId: prev.id, toId: e.id, kind: 'NEXT', props: '{}' });
    lastByDevice.set(e.deviceId, e);
  }

  // locations
  const locations = events
    .filter(hasPos)
    .map((e) => ({
      eventId: e.id,
      deviceId: e.deviceId,
      shiftId: shiftFor(manifest.shifts, e.deviceId, e.t),
      tMicros: micros(e.t),
      lat: e.lat,
      lon: e.lon,
      accuracyM: e.accuracyM ?? null,
      floor: e.floor ?? 0,
      fixT: e.t,
    }));

  // alerts + resolutions
  let nextAlert = 900001;
  const alerts = [];
  const resolutions = [];
  for (const is of manifest.issues) {
    const raised = byId.get(is.raisedBy);
    const resolved = is.resolvedBy ? byId.get(is.resolvedBy) : null;
    const alertId = nextAlert++;
    alerts.push({
      id: String(alertId),
      alertId,
      eventId: raised.id,
      kind: is.kind ?? 'anomaly',
      rawKind: is.kind ?? 'anomaly',
      text: is.title ?? '',
      tMicros: micros(raised.t),
      assetName: is.asset ?? '',
      deviceId: raised.deviceId,
      wearerName: wearerName.get(raised.deviceId) ?? raised.deviceId,
      acked: !!resolved,
      ackedMicros: resolved ? micros(resolved.t) : null,
      slackStatus: 'weekend',
    });
    if (resolved) {
      resolutions.push({
        id: is.id,
        alertId,
        eventId: resolved.id,
        deviceId: resolved.deviceId,
        tMicros: micros(resolved.t),
        how: is.how ?? 'photo_shows_recovery',
        ...(is.note ? { note: is.note } : {}),
      });
    }
  }

  // output dirs
  const photosDir = path.join(opts.out, 'photos');
  fs.mkdirSync(photosDir, { recursive: true });

  // track
  const waypoints = [
    ...events.filter(hasPos).map((e) => ({
      t: e.t,
      deviceId: e.deviceId,
      lat: e.lat,
      lon: e.lon,
      floor: e.floor ?? 0,
      dwellMin: e.dwellMin ?? 0,
      ...(e.wander !== undefined ? { wander: e.wander } : {}),
      eventId: e.id,
    })),
    ...manifest.extraWaypoints.map((w) => ({
      t: w.t,
      ...(w.deviceId ? { deviceId: w.deviceId } : {}),
      lat: w.lat,
      lon: w.lon,
      floor: w.floor ?? 0,
      dwellMin: w.dwellMin ?? 0,
      ...(w.wander !== undefined ? { wander: w.wander } : {}),
    })),
    // waypointFiles: arrays of {t, lat, lon, floor?} such as the phone's real fixes converted by
    // module-waypoints.mjs; passed through as they are (a missing floor means outdoors / unknown)
    ...(manifest.waypointFiles ?? []).flatMap((f) => {
      const fp = path.resolve(WEEKEND_DIR, f);
      if (!fs.existsSync(fp)) { warn(`waypoint file ${f} not found`); return []; }
      return JSON.parse(fs.readFileSync(fp, 'utf8')).map((w) => ({ t: w.t, lat: w.lat, lon: w.lon, ...(w.floor !== undefined && w.floor !== null ? { floor: w.floor } : {}), dwellMin: w.dwellMin ?? 0, ...(w.wander !== undefined ? { wander: w.wander } : {}), ...(w.real ? { real: true } : {}), ...(w.accuracyM !== undefined ? { accuracyM: w.accuracyM } : {}) }));
    }),
  ].sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  // Where the phone's real fixes cover a moment, the walk follows them: a guessed photo position
  // nearby would pull the walker off the measured track and back. Such photos are also pinned on
  // the real track at their capture time (interpolated between the two nearest fixes).
  {
    const real = waypoints.filter((w) => w.real).map((w) => ({ ...w, ms: Date.parse(w.t) }));
    const nearest = (ms) => { let lo = 0, hi = real.length - 1; if (!real.length) return null; while (lo < hi) { const mid = (lo + hi) >> 1; if (real[mid].ms < ms) lo = mid + 1; else hi = mid; } const i = lo; const a = real[i - 1], b = real[i]; const best = !a ? b : !b ? a : (ms - a.ms <= b.ms - ms ? a : b); return { a, b, best, dt: Math.abs(best.ms - ms) };
    };
    let dropped = 0, snapped = 0;
    for (let i = waypoints.length - 1; i >= 0; i--) { const w = waypoints[i]; if (w.real) continue; const n = nearest(Date.parse(w.t)); if (n && n.dt <= 90_000) { waypoints.splice(i, 1); dropped++; } }
    for (const l of locations) { const e = events.find((x) => x.id === l.eventId); if (!e || e.snapToTrack === false) continue; const ms = Date.parse(e.t); const n = nearest(ms); if (!n || n.dt > 60_000) continue;
      let lat = n.best.lat, lon = n.best.lon; if (n.a && n.b && n.b.ms > n.a.ms && ms >= n.a.ms && ms <= n.b.ms) { const f = (ms - n.a.ms) / (n.b.ms - n.a.ms); lat = n.a.lat + (n.b.lat - n.a.lat) * f; lon = n.a.lon + (n.b.lon - n.a.lon) * f; }
      l.lat = +lat.toFixed(7); l.lon = +lon.toFixed(7); if (n.best.accuracyM != null) l.accuracyM = n.best.accuracyM; snapped++; }
    if (dropped || snapped) console.error(`track: ${dropped} guessed waypoint(s) dropped inside real coverage, ${snapped} photo position(s) snapped to the real track`);
  }

  let track = [];
  const trackScript = path.join(SRC_DIR, 'track.mjs');
  if (!fs.existsSync(trackScript)) {
    warn(`${path.relative(REPO_ROOT, trackScript)} does not exist yet; writing an empty track`);
  } else {
    const trackInput = {
      osm: path.join(WEEKEND_DIR, 'osm-utd.json'),
      shifts: manifest.shifts,
      waypoints,
    };
    const inputPath = path.join(opts.out, '.track-input.json');
    fs.writeFileSync(inputPath, JSON.stringify(trackInput));
    const r = spawnSync(process.execPath, [trackScript, inputPath], {
      encoding: 'utf8',
      input: JSON.stringify(trackInput),
      maxBuffer: 256 * 1024 * 1024,
    });
    if (r.status !== 0) {
      warn(`track.mjs failed (exit ${r.status}): ${(r.stderr || '').trim().split('\n').slice(-3).join(' | ')}; writing an empty track`);
    } else {
      try {
        const parsed = JSON.parse(r.stdout);
        track = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.track) ? parsed.track : [];
        if (!Array.isArray(parsed) && !Array.isArray(parsed?.track)) warn('track.mjs output is not an array; writing an empty track');
      } catch (e) {
        warn(`track.mjs output is not JSON (${e.message}); writing an empty track`);
      }
      if (r.stderr && r.stderr.trim()) process.stderr.write(r.stderr.endsWith('\n') ? r.stderr : r.stderr + '\n');
    }
    // make sure every point carries the fields the schema names
    track = track.map((p, i) => ({
      pointId: p.pointId ?? `wk-t-${String(i + 1).padStart(6, '0')}`,
      deviceId: p.deviceId ?? null,
      shiftId: p.shiftId ?? (p.deviceId && p.t ? shiftFor(manifest.shifts, p.deviceId, p.t) : null),
      tMicros: p.tMicros !== undefined ? String(p.tMicros) : p.t ? micros(p.t) : null,
      t: p.t ?? (p.tMicros !== undefined ? new Date(Number(BigInt(String(p.tMicros)) / 1000n)).toISOString() : null),
      kind: p.kind ?? 'point',
      lat: p.lat,
      lon: p.lon,
      accuracyM: p.accuracyM ?? null,
      floor: p.floor ?? 0,
    }));
  }

  // photos
  const blurTool = path.join(SRC_DIR, 'blur.swift');
  const thumbTool = path.join(SRC_DIR, 'thumb.sh');
  const haveBlur = !opts.skipBlur && fs.existsSync(blurTool);
  const haveThumbSh = fs.existsSync(thumbTool);
  let blurWarned = false;
  const cachePath = path.join(opts.out, '.cache.json');
  let cache = {};
  try {
    cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  } catch {
    cache = {};
  }
  const photos = {};
  const thumbs = {};
  let written = 0;
  let cached = 0;
  let missing = 0;

  for (const e of events) {
    const src = e.photo.startsWith('module:')
      ? path.join(opts.modulePhotos, `${e.photo.slice('module:'.length)}.jpg`)
      : path.resolve(WEEKEND_DIR, e.photo);
    const outJpg = path.join(photosDir, `${e.id}.jpg`);
    const outThumb = path.join(photosDir, `${e.id}.thumb.jpg`);
    const keep = keepArg(e.keepFaces);
    const mode = haveBlur ? 'blur' : 'copy';
    const key = `${keep}|${mode}|${JSON.stringify(e.extraBlur ?? [])}`;

    if (!fs.existsSync(src)) {
      warn(`event ${e.id}: photo ${src} not found; skipped`);
      missing++;
      continue;
    }
    photos[e.id] = `photos/${e.id}.jpg`;
    thumbs[e.id] = `photos/${e.id}.thumb.jpg`;

    if (cache[e.id] === key && isNewer(outJpg, src) && isNewer(outThumb, src)) {
      cached++;
      continue;
    }

    let ok = false;
    if (haveBlur) {
      // extraBlur: normalised rects (origin top-left) the manifest adds by hand where the detector misses a face
      const extra = Array.isArray(e.extraBlur) ? e.extraBlur.map((r) => r.join(',')).join(';') : '';
      const r = spawnSync('swift', [blurTool, 'blur', src, outJpg, '--keep', keep], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, BLUR_DEBUG_FACES: extra } });
      if (r.status === 0 && fs.existsSync(outJpg)) ok = true;
      else warn(`event ${e.id}: blur failed (exit ${r.status}): ${(r.stderr || '').trim().split('\n').slice(-2).join(' | ')}; falling back to copy`);
    } else if (!blurWarned) {
      blurWarned = true;
      warn(opts.skipBlur ? '--skip-blur: photos are copied and resized, faces are NOT blurred' : `${path.relative(REPO_ROOT, blurTool)} not found: photos are copied and resized, faces are NOT blurred`);
    }
    if (!ok) {
      fs.copyFileSync(src, outJpg);
      const r = run('sips', ['-Z', '1600', outJpg]);
      if (r.status !== 0) warn(`event ${e.id}: sips resize failed: ${(r.stderr || '').trim()}`);
    }
    // thumb
    if (haveThumbSh) {
      const r = run('sh', [thumbTool, outJpg, outThumb]);
      if (r.status !== 0 || !fs.existsSync(outThumb)) {
        warn(`event ${e.id}: thumb.sh failed; using sips`);
        fs.copyFileSync(outJpg, outThumb);
        run('sips', ['-Z', '320', outThumb]);
      }
    } else {
      fs.copyFileSync(outJpg, outThumb);
      const r = run('sips', ['-Z', '320', outThumb]);
      if (r.status !== 0) warn(`event ${e.id}: sips thumb failed: ${(r.stderr || '').trim()}`);
    }
    cache[e.id] = haveBlur ? key : `${keep}|copy`;
    written++;
  }
  // drop cache rows for events that are gone
  for (const id of Object.keys(cache)) if (!byId.has(id)) delete cache[id];
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2) + '\n');

  // assemble
  const staticEnd = events.length ? new Date(Math.max(...events.map((e) => Date.parse(e.t)))).toISOString() : null;
  const outJson = {
    generatedAt: new Date().toISOString(),
    staticEnd,
    ...(manifest.badgeAfter ? { badgeAfter: new Date(Date.parse(manifest.badgeAfter)).toISOString() } : {}),
    wearers: manifest.wearers ?? [],
    events: outEvents,
    locations,
    track,
    entities,
    edges,
    alerts,
    resolutions,
    photos,
    thumbs,
    hideLive: manifest.hideLive,
  };
  const outPath = path.join(opts.out, 'weekend.json');
  fs.writeFileSync(outPath, JSON.stringify(outJson) + '\n'); // compact: the track alone is thousands of rows

  // summary
  const openIssues = alerts.filter((a) => !a.acked).length;
  const rows = [
    ['events', events.length],
    ['located events', locations.length],
    ['places', entities.length],
    ['issues', `${alerts.length} (${openIssues} open / ${alerts.length - openIssues} resolved)`],
    ['track points', track.length],
    ['photos written', written],
    ['photos cached', cached],
    ['photos missing', missing],
    ['warnings', warnings.length],
  ];
  const w = Math.max(...rows.map(([k]) => k.length));
  process.stderr.write(`\nwrote ${path.relative(process.cwd(), outPath) || outPath}\n`);
  for (const [k, v] of rows) process.stderr.write(`  ${k.padEnd(w)}  ${v}\n`);
}

main();
