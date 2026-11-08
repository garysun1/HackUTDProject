// Working Memory for the Physical World — SpacetimeDB module (TypeScript).
// Tables: event, photo, entity, edge, episode, handoff, alert, asset, wearer, perceive_job.
// Procedures: ping, ingestPhoto (ingest_photo), perceive (scheduled), slackTest (slack_test).
// Reducers: setLabel, setNote, ackAlert; admin: upsertAsset, deleteAsset, upsertWearer.
// See docs/DESIGN.md §5–§8 and docs/CONTRACT.md. Pure rules (alerts, asset matching) in rules.ts.

import { schema, table, t, SenderError, Range } from 'spacetimedb/server';
import { ScheduleAt, TimeDuration } from 'spacetimedb';
import {
  slug,
  squash,
  matchAssets,
  detectAlerts,
  base64ToBytes,
  cosine,
  parseJsonObject,
  summarizeFindings,
  type AssetLike,
} from './rules';

// ---------- tables ----------

const event = table(
  { name: 'event', public: true },
  {
    eventId: t.string().primaryKey(),
    deviceId: t.string(),
    clientT: t.string(),
    tMicros: t.u64().index('btree'), // server receive time, micros since epoch
    serverT: t.timestamp(),
    source: t.string(),
    status: t.string(), // accepted | in_graph | failed
    note: t.option(t.string()),
    label: t.option(t.string()),
    clockOffsetMs: t.option(t.i64()),
    width: t.option(t.u32()),
    height: t.option(t.u32()),
    scene: t.string(),
    locationGuess: t.string(),
    activity: t.string(),
    summary: t.string(),
    peopleCount: t.u32(),
    confidence: t.f32(),
    perceptionJson: t.string(), // full model output plus _meta {model, ms, fallback_reason}
    embedding: t.array(t.f32()), // Azure AI Vision image vector (1024-d), [] if unavailable
  }
);

const photo = table(
  { name: 'photo', public: true },
  {
    eventId: t.string().primaryKey(),
    mime: t.string(),
    jpegB64: t.string(),
  }
);

const entity = table(
  { name: 'entity', public: true },
  {
    entityId: t.string().primaryKey(),
    canonicalName: t.string().index('btree'),
    kind: t.string(), // object | place | asset
    aliases: t.array(t.string()),
    firstSeenMicros: t.u64(),
    lastSeenMicros: t.u64(),
  }
);

const edge = table(
  { name: 'edge', public: true },
  {
    edgeId: t.u64().primaryKey().autoInc(),
    fromId: t.string().index('btree'),
    toId: t.string().index('btree'),
    kind: t.string(), // NEXT | INVOLVES | CHANGES | EVIDENCED_BY | SIMILAR_TO
    props: t.string(), // JSON
  }
);

const episode = table(
  { name: 'episode', public: true },
  {
    episodeId: t.u64().primaryKey().autoInc(),
    tStartMicros: t.u64().index('btree'),
    tEndMicros: t.u64(),
    title: t.string(),
    summary: t.string(),
    eventIds: t.array(t.string()),
  }
);

const handoff = table(
  { name: 'handoff', public: true },
  {
    handoffId: t.u64().primaryKey().autoInc(),
    sinceMicros: t.u64(),
    generatedMicros: t.u64(),
    text: t.string(),
    eventIds: t.array(t.string()),
  }
);

// #17: written by perceive when the alert rule fires; posted to Slack.
const alert = table(
  { name: 'alert', public: true },
  {
    alertId: t.u64().primaryKey().autoInc(),
    eventId: t.string().index('btree'),
    tMicros: t.u64().index('btree'),
    kind: t.string(), // fault_text | state_change | anomaly
    text: t.string(), // what was read or observed, e.g. "PSU2: FAULT"
    entityId: t.string(), // asset or entity the alert is about ('' if unknown)
    entityName: t.string(),
    deviceId: t.string(),
    wearerName: t.string(), // resolved from wearer at alert time ('' if unknown)
    acked: t.bool(),
    ackedMicros: t.option(t.u64()),
    slackStatus: t.string(), // pending | posted | no_webhook | http_<code> | error
  }
);

// #16: asset registry, seeded by an admin reducer from demo/assets.csv.
const asset = table(
  { name: 'asset', public: true },
  {
    assetId: t.string().primaryKey(), // e.g. "PDU-A"; entity id is slug(assetId)
    name: t.string(),
    assetType: t.string(), // pdu | rack | crac | switch | ...
    location: t.string(),
    patterns: t.array(t.string()), // extra strings matched against text_in_scene; /regex/ allowed
  }
);

// #15: wearer attribution, keyed by the phone's device_id.
const wearer = table(
  { name: 'wearer', public: true },
  {
    deviceId: t.string().primaryKey(),
    name: t.string(),
    role: t.string(),
    shift: t.string(),
  }
);

const perceiveJob = table(
  { name: 'perceive_job' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    eventId: t.string(),
  }
);

// #20: where a photo was taken (from event_json.location, contract v3.1). A separate table, not new
// columns on `event`, because adding columns to a populated table is not an automatic migration.
const eventLocation = table(
  { name: 'event_location', public: true },
  {
    eventId: t.string().primaryKey(),
    deviceId: t.string().index('btree'),
    shiftId: t.string(),
    tMicros: t.u64().index('btree'), // the event's server receive time, for time-ordered joins
    lat: t.f64(),
    lon: t.f64(),
    accuracyM: t.f32(),
    altM: t.option(t.f64()),
    floor: t.option(t.i32()),
    speedMps: t.option(t.f32()),
    courseDeg: t.option(t.f32()),
    fixT: t.string(), // when the fix was taken (phone clock, ISO)
    ageMs: t.option(t.u32()),
  }
);

// #20: the wearer's walking track, batched from the phone by ingest_track. Idempotent on (device, t).
const trackPoint = table(
  { name: 'track_point', public: true, indexes: [{ accessor: 'by_device_t', algorithm: 'btree', columns: ['deviceId', 'tMicros'] }] },
  {
    pointId: t.u64().primaryKey().autoInc(),
    deviceId: t.string(),
    shiftId: t.string().index('btree'),
    tMicros: t.u64(), // phone clock of the fix, micros since epoch
    t: t.string(),
    kind: t.string(), // point | shift_start | shift_end
    lat: t.f64(),
    lon: t.f64(),
    accuracyM: t.f32(),
    altM: t.option(t.f64()),
    floor: t.option(t.i32()),
    speedMps: t.option(t.f32()),
    courseDeg: t.option(t.f32()),
  }
);

const spacetimedb = schema(
  { event, photo, entity, edge, episode, handoff, alert, asset, wearer, perceiveJob, eventLocation, trackPoint },
  {
    // #14: secrets live in the database's environment, set with
    //   spacetime publish wm-physical --env-only --server maincloud  (see module/README.md)
    // never in the repo. Every value but INGEST_TOKEN is optional and degrades gracefully.
    env: {
      INGEST_TOKEN: t.string(),
      ADMIN_TOKEN: t.option(t.string()), // admin reducers; falls back to INGEST_TOKEN
      NVIDIA_API_KEY: t.option(t.string()),
      NVIDIA_VL_MODEL: t.option(t.string()),
      AZURE_AI_KEY: t.option(t.string()), // one key for Azure OpenAI and AI Vision
      AZURE_OPENAI_ENDPOINT: t.option(t.string()),
      AZURE_VLM_DEPLOYMENT: t.option(t.string()),
      AZURE_AI_SERVICES_ENDPOINT: t.option(t.string()),
      SLACK_WEBHOOK_URL: t.option(t.string()),
    },
  }
);
export default spacetimedb;

// ---------- helpers (not exported) ----------

const IngestResult = t.object('IngestResult', {
  eventId: t.string(),
  serverT: t.string(),
  status: t.string(),
});
const Pong = t.object('Pong', { serverT: t.string(), tMicros: t.string() });
const TrackResult = t.object('TrackResult', { accepted: t.u32(), duplicates: t.u32() });

/** Contract v3.1 location object → event_location/track_point columns, or null when unusable. */
function readFix(loc: any) {
  if (!loc || typeof loc !== 'object') return null;
  const lat = Number(loc.lat), lon = Number(loc.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const num = (v: any) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  return {
    lat,
    lon,
    accuracyM: num(loc.accuracy_m) ?? 0,
    altM: num(loc.alt_m),
    floor: typeof loc.floor === 'number' && Number.isFinite(loc.floor) ? Math.round(loc.floor) : undefined,
    speedMps: num(loc.speed_mps),
    courseDeg: num(loc.course_deg),
    fixT: typeof loc.t === 'string' ? loc.t : '',
    ageMs: num(loc.age_ms) !== undefined ? Math.max(0, Math.round(loc.age_ms)) : undefined,
  };
}
function microsFromIso(s: string): bigint | null {
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? BigInt(Math.round(ms)) * 1000n : null;
}
const SlackTestResult = t.object('SlackTestResult', { status: t.string() });

const DEFAULT_VL_MODEL = 'nvidia/nemotron-3.5-super-vl-120b-a12b';
const DEFAULT_AZURE_OPENAI = 'https://hackutd-wm-garysun.openai.azure.com/';
const DEFAULT_AZURE_SERVICES = 'https://hackutd-wm-garysun.cognitiveservices.azure.com/';
const AZURE_OPENAI_API_VERSION = '2024-10-21';
const ALERT_DEDUPE_MICROS = 30n * 60n * 1_000_000n; // an unacked alert on the same asset within 30 min absorbs new findings
const SIMILAR_MIN = 0.85; // cosine threshold for SIMILAR_TO edges
const SIMILAR_TOP = 3;
const CONTEXT_EVENTS = 6; // recent perceived events given to the model as history

function isoFromMicros(micros: bigint): string {
  return new Date(Number(micros / 1000n)).toISOString();
}

/** "14:32 CT" — the venue is in Dallas; CST (UTC-6) after 2026-11-01. */
function clockCT(micros: bigint): string {
  const d = new Date(Number(micros / 1000n) - 6 * 3600 * 1000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} CT`;
}

/** Wall clock for latency metadata only; 0 if the runtime does not provide one. */
function wallMs(): number {
  try {
    return Date.now();
  } catch {
    return 0;
  }
}

function trimSlash(u: string): string {
  return u.replace(/\/+$/, '');
}

const PERCEPTION_PROMPT =
  'You are the perception step of an operational memory system for data center operators. ' +
  'Look at the photo and return ONLY a JSON object with keys: ' +
  'scene (short phrase), location_guess (room/row/rack if you can tell, else ""), ' +
  'objects (array of {name, attributes, position}; use the exact label printed on equipment as the name when one is visible), ' +
  'people_count (integer; never identify anyone), activity, ' +
  'text_in_scene (array of every string you can read: rack and asset labels, panel readouts, status words, cable tags, notes; copy them exactly, one string per label or line), ' +
  'changes_since_previous (array of {entity, attr, from, to}: compare each piece of equipment in this photo ONLY with the most recent earlier observation of that same equipment (same label or asset); never compare different equipment, and leave it empty when nothing in this photo was observed before or nothing changed), ' +
  'anomalies (array of {entity, description, severity: "low"|"medium"|"high"} for anything that looks abnormal: fault or alarm lights, error codes, warning notes, open panels, disconnected or loose cables, leaks; empty if none), ' +
  'summary (one sentence), confidence (0-1).';

type Perception = any;
interface PerceiveOutcome {
  perception: Perception | null;
  model: string;
  ms: number;
  failure: string;
}

// ---------- lifecycle ----------

export const init = spacetimedb.init(_ctx => {
  console.info('wm-physical module initialized');
});

// ---------- procedures ----------

export const ping = spacetimedb.procedure(Pong, ctx => ({
  serverT: isoFromMicros(ctx.timestamp.microsSinceUnixEpoch),
  tMicros: ctx.timestamp.microsSinceUnixEpoch.toString(),
}));

export const ingestPhoto = spacetimedb.procedure(
  { eventJson: t.string(), photoB64: t.string() },
  IngestResult,
  (ctx, { eventJson, photoB64 }) => {
    let ev: any;
    try {
      ev = JSON.parse(eventJson);
    } catch {
      throw new SenderError('invalid_event_json');
    }
    if (typeof ev.ingest_token !== 'string' || ev.ingest_token !== ctx.env.INGEST_TOKEN) {
      throw new SenderError('invalid_token');
    }
    for (const k of ['event_id', 'device_id', 'client_t', 'source']) {
      if (typeof ev[k] !== 'string' || !ev[k]) throw new SenderError(`missing_${k}`);
    }
    if (!photoB64 || photoB64.length < 100) throw new SenderError('missing_photo');

    const nowMicros = ctx.timestamp.microsSinceUnixEpoch;
    const serverT = isoFromMicros(nowMicros);

    return ctx.withTx(tx => {
      const existing = tx.db.event.eventId.find(ev.event_id);
      if (existing) {
        return { eventId: existing.eventId, serverT: isoFromMicros(existing.tMicros), status: 'duplicate' };
      }
      tx.db.event.insert({
        eventId: ev.event_id,
        deviceId: ev.device_id,
        clientT: ev.client_t,
        tMicros: nowMicros,
        serverT: ctx.timestamp,
        source: ev.source,
        status: 'accepted',
        note: typeof ev.note === 'string' ? ev.note : undefined,
        label: ev.label && typeof ev.label.name === 'string' ? ev.label.name : undefined,
        clockOffsetMs: typeof ev.clock_offset_ms === 'number' ? BigInt(Math.round(ev.clock_offset_ms)) : undefined,
        width: ev.photo && typeof ev.photo.width === 'number' ? ev.photo.width : undefined,
        height: ev.photo && typeof ev.photo.height === 'number' ? ev.photo.height : undefined,
        scene: '',
        locationGuess: '',
        activity: '',
        summary: '',
        peopleCount: 0,
        confidence: 0,
        perceptionJson: '',
        embedding: [],
      });
      tx.db.photo.insert({
        eventId: ev.event_id,
        mime: ev.photo && typeof ev.photo.mime === 'string' ? ev.photo.mime : 'image/jpeg',
        jpegB64: photoB64,
      });
      const fix = readFix(ev.location);
      if (fix) {
        tx.db.eventLocation.insert({
          eventId: ev.event_id,
          deviceId: ev.device_id,
          shiftId: typeof ev.shift_id === 'string' ? ev.shift_id : '',
          tMicros: nowMicros,
          ...fix,
        });
      }
      tx.db.perceiveJob.insert({
        scheduledId: 0n,
        scheduledAt: ScheduleAt.time(nowMicros),
        eventId: ev.event_id,
      });
      return { eventId: ev.event_id, serverT, status: 'accepted' };
    });
  }
);

// #20: the phone batches its shift track every 30 s: {device_id, shift_id, ingest_token, points[], marks[]}.
// Idempotent on (device_id, t) so the phone can retry a batch until it gets a reply.
export const ingestTrack = spacetimedb.procedure(
  { trackJson: t.string() },
  TrackResult,
  (ctx, { trackJson }) => {
    let tr: any;
    try {
      tr = JSON.parse(trackJson);
    } catch {
      throw new SenderError('invalid_track_json');
    }
    if (typeof tr.ingest_token !== 'string' || tr.ingest_token !== ctx.env.INGEST_TOKEN) {
      throw new SenderError('invalid_token');
    }
    if (typeof tr.device_id !== 'string' || !tr.device_id) throw new SenderError('missing_device_id');
    const shiftId = typeof tr.shift_id === 'string' ? tr.shift_id : '';
    const points: any[] = Array.isArray(tr.points) ? tr.points : [];
    const marks: any[] = Array.isArray(tr.marks) ? tr.marks : [];
    if (points.length + marks.length > 1000) throw new SenderError('batch_too_large');

    type Row = { tMicros: bigint; t: string; kind: string; fix: NonNullable<ReturnType<typeof readFix>> };
    const rows: Row[] = [];
    for (const p of points) {
      const fix = readFix(p);
      const tm = typeof p?.t === 'string' ? microsFromIso(p.t) : null;
      if (fix && tm !== null) rows.push({ tMicros: tm, t: p.t, kind: 'point', fix });
    }
    for (const m of marks) {
      const tm = typeof m?.t === 'string' ? microsFromIso(m.t) : null;
      const kind = m?.kind === 'shift_start' || m?.kind === 'shift_end' ? m.kind : null;
      if (tm === null || !kind) continue;
      // a mark carries no fix of its own; borrow the nearest point's position in this batch, else 0/0 is refused
      const near = rows.length ? rows.reduce((a, b) => (abs(b.tMicros - tm) < abs(a.tMicros - tm) ? b : a)) : null;
      if (near) rows.push({ tMicros: tm, t: m.t, kind, fix: { ...near.fix, fixT: m.t } });
    }

    return ctx.withTx(tx => {
      let accepted = 0, duplicates = 0;
      for (const r of rows) {
        const dup = [...tx.db.trackPoint.by_device_t.filter([tr.device_id, r.tMicros])].some(x => x.kind === r.kind);
        if (dup) {
          duplicates++;
          continue;
        }
        tx.db.trackPoint.insert({
          pointId: 0n,
          deviceId: tr.device_id,
          shiftId,
          tMicros: r.tMicros,
          t: r.t,
          kind: r.kind,
          lat: r.fix.lat,
          lon: r.fix.lon,
          accuracyM: r.fix.accuracyM,
          altM: r.fix.altM,
          floor: r.fix.floor,
          speedMps: r.fix.speedMps,
          courseDeg: r.fix.courseDeg,
        });
        accepted++;
      }
      return { accepted, duplicates };
    });
  }
);
function abs(x: bigint): bigint {
  return x < 0n ? -x : x;
}

// Scheduled: one job per ingested photo. Network I/O happens outside transactions:
// read → embed (Azure Vision) → perceive (Nemotron VL, Azure gpt-4o fallback) → write graph
// and alerts → post new alerts to Slack → record post status.
export const perceive = spacetimedb.procedure(
  { onSchedule: perceiveJob },
  { arg: perceiveJob.rowType },
  t.unit(),
  (ctx, { arg }) => {
    const eventId = arg.eventId;
    const env = ctx.env;
    const azureKey = env.AZURE_AI_KEY;

    // 1. read what we need
    const snap = ctx.withTx(tx => {
      const ev = tx.db.event.eventId.find(eventId);
      const ph = tx.db.photo.eventId.find(eventId);
      if (!ev || !ph) return null;
      // NEXT follows capture order, whether or not the previous photo is perceived yet.
      // Context for "changes" is the recent perceived history, each line tagged with the
      // registry assets it involved, so the model compares like with like.
      let prev: typeof ev | null = null;
      const earlier: (typeof ev)[] = [];
      for (const other of tx.db.event.iter()) {
        if (other.eventId === eventId || other.tMicros >= ev.tMicros) continue;
        if (!prev || other.tMicros > prev.tMicros) prev = other;
        if (other.status === 'in_graph' && other.summary) earlier.push(other);
      }
      earlier.sort((a, b) => (a.tMicros < b.tMicros ? -1 : a.tMicros > b.tMicros ? 1 : 0));
      const history = earlier.slice(-CONTEXT_EVENTS).map(o => {
        const assetIds = [...tx.db.edge.fromId.filter(o.eventId)]
          .filter(e => e.kind === 'INVOLVES' && e.props.includes('"role":"asset"'))
          .map(e => tx.db.entity.entityId.find(e.toId)?.canonicalName ?? e.toId);
        return `- ${clockCT(o.tMicros)}${assetIds.length ? ` [${assetIds.join(', ')}]` : ''}: ${o.summary}`;
      });
      return { ev, ph, prevId: prev ? prev.eventId : null, history };
    });
    if (!snap) return {};

    // 2. image embedding (Azure AI Vision). Optional: failure leaves embedding empty.
    let embedding: number[] = [];
    if (azureKey) {
      try {
        const base = trimSlash(env.AZURE_AI_SERVICES_ENDPOINT ?? DEFAULT_AZURE_SERVICES);
        const res = ctx.http.fetch(
          `${base}/computervision/retrieval:vectorizeImage?api-version=2024-02-01&model-version=2023-04-15`,
          {
            method: 'POST',
            headers: { 'Ocp-Apim-Subscription-Key': azureKey, 'Content-Type': 'application/octet-stream' },
            timeout: TimeDuration.fromMillis(10_000),
            body: base64ToBytes(snap.ph.jpegB64),
          }
        );
        if (res.status === 200) {
          const v = res.json()?.vector;
          if (Array.isArray(v)) embedding = v.map(Number);
        } else {
          console.warn(`vectorizeImage ${eventId}: http ${res.status}`);
        }
      } catch (e) {
        console.warn(`vectorizeImage ${eventId}: ${String(e).slice(0, 200)}`);
      }
    }

    // 3. perception: Nemotron VL first, Azure gpt-4o on any failure, stub if no keys at all
    const userText =
      PERCEPTION_PROMPT +
      (snap.history.length
        ? ` Earlier observations this shift, oldest first, with the registered assets each involved:\n${snap.history.join('\n')}\n`
        : ' Earlier observations: none.') +
      (snap.ev.label ? ` The wearer labeled the main object in this photo: ${JSON.stringify(snap.ev.label)}.` : '') +
      (snap.ev.note ? ` Wearer note: ${JSON.stringify(snap.ev.note)}.` : '');
    const imageUrl = `data:${snap.ph.mime};base64,${snap.ph.jpegB64}`;
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: userText },
          { type: 'image_url', image_url: { url: imageUrl } },
        ],
      },
    ];

    const callModel = (who: 'nvidia' | 'azure'): PerceiveOutcome => {
      const t0 = wallMs();
      let model = '';
      try {
        let res;
        if (who === 'nvidia') {
          model = env.NVIDIA_VL_MODEL ?? DEFAULT_VL_MODEL;
          res = ctx.http.fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${env.NVIDIA_API_KEY}`, 'Content-Type': 'application/json' },
            timeout: TimeDuration.fromMillis(25_000),
            body: JSON.stringify({
              model,
              max_tokens: 1500,
              temperature: 0.1,
              chat_template_kwargs: { enable_thinking: false },
              messages,
            }),
          });
        } else {
          const deployment = env.AZURE_VLM_DEPLOYMENT ?? 'vlm-gpt-4o';
          model = `azure/${deployment}`;
          const base = trimSlash(env.AZURE_OPENAI_ENDPOINT ?? DEFAULT_AZURE_OPENAI);
          res = ctx.http.fetch(
            `${base}/openai/deployments/${deployment}/chat/completions?api-version=${AZURE_OPENAI_API_VERSION}`,
            {
              method: 'POST',
              headers: { 'api-key': azureKey ?? '', 'Content-Type': 'application/json' },
              timeout: TimeDuration.fromMillis(30_000),
              body: JSON.stringify({
                max_tokens: 1500,
                temperature: 0.1,
                response_format: { type: 'json_object' },
                messages,
              }),
            }
          );
        }
        if (res.status !== 200) {
          return { perception: null, model, ms: wallMs() - t0, failure: `${who}_http_${res.status}` };
        }
        const content: string = res.json()?.choices?.[0]?.message?.content ?? '';
        return { perception: parseJsonObject(content), model, ms: wallMs() - t0, failure: '' };
      } catch (e) {
        return { perception: null, model, ms: wallMs() - t0, failure: `${who}_error:${String(e).slice(0, 200)}` };
      }
    };

    let outcome: PerceiveOutcome = { perception: null, model: '', ms: 0, failure: '' };
    const failures: string[] = [];
    if (env.NVIDIA_API_KEY) {
      outcome = callModel('nvidia');
      if (!outcome.perception) failures.push(outcome.failure);
    }
    if (!outcome.perception && azureKey) {
      outcome = callModel('azure');
      if (!outcome.perception) failures.push(outcome.failure);
    }
    if (!outcome.perception && !env.NVIDIA_API_KEY && !azureKey) {
      outcome = {
        model: 'stub',
        ms: 0,
        failure: '',
        perception: {
          scene: 'unperceived',
          location_guess: '',
          objects: [],
          people_count: 0,
          activity: '',
          text_in_scene: [],
          changes_since_previous: [],
          anomalies: [],
          summary: 'Photo stored; perception keys not configured.',
          confidence: 0,
        },
      };
    }
    for (const f of failures) console.warn(`perceive ${eventId}: ${f}`);

    // 4. write results, graph edges, and alerts
    const newAlerts = ctx.withTx(tx => {
      const ev = tx.db.event.eventId.find(eventId);
      if (!ev) return [];
      const p = outcome.perception;
      if (!p) {
        tx.db.event.eventId.update({
          ...ev,
          status: 'failed',
          embedding,
          perceptionJson: JSON.stringify({ error: failures.join('; ') }),
        });
        return [];
      }
      const objects: any[] = Array.isArray(p.objects) ? p.objects : [];
      const changes: any[] = Array.isArray(p.changes_since_previous) ? p.changes_since_previous : [];
      const anomalies: any[] = Array.isArray(p.anomalies) ? p.anomalies : [];
      const texts: string[] = (Array.isArray(p.text_in_scene) ? p.text_in_scene : []).filter(
        (x: unknown): x is string => typeof x === 'string'
      );
      const meta = { model: outcome.model, ms: outcome.ms, fallback_reason: failures.join('; ') || undefined };
      tx.db.event.eventId.update({
        ...ev,
        status: 'in_graph',
        scene: String(p.scene ?? ''),
        locationGuess: String(p.location_guess ?? ''),
        activity: String(p.activity ?? ''),
        summary: String(p.summary ?? ''),
        peopleCount: Number.isFinite(p.people_count) ? Math.max(0, Math.trunc(p.people_count)) : 0,
        confidence: Number.isFinite(p.confidence) ? p.confidence : 0,
        perceptionJson: JSON.stringify({ ...p, _meta: meta }),
        embedding,
      });

      const assets: (AssetLike & { location: string; assetType: string })[] = [...tx.db.asset.iter()];
      const assetById = new Map(assets.map(a => [a.assetId, a]));
      const now = ev.tMicros;

      // Upsert an entity; assets are entities with kind 'asset' keyed by slug(assetId).
      const upsertEntity = (id: string, name: string, kind: string) => {
        const existing = tx.db.entity.entityId.find(id);
        if (existing) {
          const aliases = existing.aliases.includes(name) ? existing.aliases : [...existing.aliases, name];
          tx.db.entity.entityId.update({
            ...existing,
            kind: kind === 'asset' ? 'asset' : existing.kind,
            canonicalName: kind === 'asset' ? (assetById.get(name)?.name ?? existing.canonicalName) : existing.canonicalName,
            aliases,
            lastSeenMicros: now,
          });
        } else {
          tx.db.entity.insert({
            entityId: id,
            canonicalName: kind === 'asset' ? (assetById.get(name)?.name ?? name) : name,
            kind,
            aliases: [name],
            firstSeenMicros: now,
            lastSeenMicros: now,
          });
        }
      };
      // Resolve a free-text name: an asset if it matches the registry, else a slug entity.
      const resolve = (name: string): { id: string; name: string; isAsset: boolean } => {
        const m = assets.length ? matchAssets([name], assets) : [];
        if (m.length) {
          const a = assetById.get(m[0].assetId)!;
          return { id: slug(a.assetId), name: a.assetId, isAsset: true };
        }
        return { id: slug(name), name, isAsset: false };
      };

      // EVIDENCED_BY: event -> photo (photo id = event id)
      tx.db.edge.insert({ edgeId: 0n, fromId: eventId, toId: eventId, kind: 'EVIDENCED_BY', props: '{}' });
      // NEXT: previous -> this
      if (snap.prevId) {
        tx.db.edge.insert({ edgeId: 0n, fromId: snap.prevId, toId: eventId, kind: 'NEXT', props: '{}' });
      }

      // INVOLVES: label (subject), assets read in the scene, object names
      const involved = new Set<string>();
      const involve = (name: string, role: string, extra: Record<string, string> = {}) => {
        const r = resolve(name);
        if (!r.id || involved.has(r.id)) return;
        involved.add(r.id);
        upsertEntity(r.id, r.name, r.isAsset ? 'asset' : 'object');
        tx.db.edge.insert({
          edgeId: 0n,
          fromId: eventId,
          toId: r.id,
          kind: 'INVOLVES',
          props: JSON.stringify({ role: r.isAsset && role === 'target' ? 'asset' : role, ...extra }),
        });
      };
      if (ev.label) involve(ev.label, 'subject');
      const sceneAssets = assets.length ? matchAssets(texts, assets) : [];
      // the photo's primary asset: equipment before the rack it sits in
      const primary =
        sceneAssets.find(m => assetById.get(m.assetId)?.assetType !== 'rack') ?? sceneAssets[0] ?? null;
      const isRack = (name: string) => assetById.get(name)?.assetType === 'rack';
      const primaryIsEquipment = !!primary && !isRack(primary.assetId);
      for (const m of sceneAssets) involve(m.assetId, 'asset', { matched: m.matchedText });
      for (const o of objects) if (o && typeof o.name === 'string') involve(o.name, 'target');

      // place entity + INVOLVES setting
      const place = String(p.location_guess ?? '').trim();
      if (place) {
        const pid = 'place_' + slug(place);
        if (pid !== 'place_') {
          upsertEntity(pid, place, 'place');
          tx.db.edge.insert({ edgeId: 0n, fromId: eventId, toId: pid, kind: 'INVOLVES', props: JSON.stringify({ role: 'setting' }) });
        }
      }

      // CHANGES
      for (const c of changes) {
        const ename = typeof c?.entity === 'string' ? c.entity : '';
        if (!ename) continue;
        // a first sighting ("" -> value) is not a change
        if (!String(c.from ?? '').trim()) continue;
        let r = resolve(ename);
        // "Rack R12: PSU2 OK -> FAULT" in a photo of PDU-A is PDU-A's change
        if (r.isAsset && isRack(r.name) && primaryIsEquipment) r = resolve(primary!.assetId);
        if (!r.id) continue;
        upsertEntity(r.id, r.name, r.isAsset ? 'asset' : 'object');
        tx.db.edge.insert({
          edgeId: 0n,
          fromId: eventId,
          toId: r.id,
          kind: 'CHANGES',
          props: JSON.stringify({ attr: c.attr ?? '', from: c.from ?? '', to: c.to ?? '' }),
        });
      }

      // SIMILAR_TO: top cosine neighbours among earlier events
      if (embedding.length) {
        const scored: { id: string; s: number }[] = [];
        for (const other of tx.db.event.iter()) {
          if (other.eventId === eventId || other.status !== 'in_graph' || !other.embedding.length) continue;
          const s = cosine(embedding, other.embedding);
          if (s >= SIMILAR_MIN) scored.push({ id: other.eventId, s });
        }
        scored.sort((a, b) => b.s - a.s);
        for (const n of scored.slice(0, SIMILAR_TOP)) {
          tx.db.edge.insert({
            edgeId: 0n,
            fromId: eventId,
            toId: n.id,
            kind: 'SIMILAR_TO',
            props: JSON.stringify({ score: Math.round(n.s * 1000) / 1000 }),
          });
        }
      }

      // ALERTS (#17)
      const candidates = detectAlerts(texts, changes, anomalies);
      if (!candidates.length) return [];
      const w = tx.db.wearer.deviceId.find(ev.deviceId);
      const wearerName = w ? w.name : '';
      const recent = [...tx.db.alert.tMicros.filter(
          new Range<bigint>(
            { tag: 'included', value: now > ALERT_DEDUPE_MICROS ? now - ALERT_DEDUPE_MICROS : 0n },
            { tag: 'unbounded' }
          )
        )];
      // Group findings by the asset they are about: one alert per asset per photo.
      // Target: the rule's entity if it is a registry asset, else an asset named in the same
      // text, else the photo's primary asset (equipment before the rack it sits in), else the
      // wearer's label, else none. Part names like "PSU2" or "TEMP" are not targets: they
      // stay in the alert text and the alert lands on the asset that contains them.
      const groups = new Map<string, { entityId: string; entityName: string; location: string; kind: string; items: { kind: string; text: string }[] }>();
      const rank = (k: string) => (k === 'state_change' ? 0 : k === 'fault_text' ? 1 : 2);
      const fallback = primary ? resolve(primary.assetId) : ev.label ? resolve(ev.label) : null;
      for (const c of candidates) {
        let target = c.entity ? resolve(c.entity) : null;
        if (!target || !target.isAsset) {
          const inText = assets.length ? matchAssets([c.text], assets) : [];
          target = inText.length ? resolve(inText[0].assetId) : fallback;
        }
        // A finding that names the rack while the photo shows equipment inside it belongs to
        // the equipment ("Rack R12: PSU2 FAULT" is PDU-A's fault), so both land on one alert.
        if (target?.isAsset && isRack(target.name) && primaryIsEquipment) target = resolve(primary!.assetId);
        const entityId = target?.id ?? '';
        const a = target?.isAsset ? assetById.get(target.name) : undefined;
        let g = groups.get(entityId);
        if (!g) {
          g = { entityId, entityName: a ? a.name || a.assetId : (target?.name ?? ''), location: a?.location ?? '', kind: c.kind, items: [] };
          groups.set(entityId, g);
        }
        if (rank(c.kind) < rank(g.kind)) g.kind = c.kind;
        // drop the entity name from a state change filed under that same entity
        const sameEntity = c.short && c.entity && resolve(c.entity).id === entityId;
        g.items.push({ kind: c.kind, text: sameEntity ? c.short! : c.text });
      }

      const inserted: { alertId: bigint; text: string; kind: string; entityName: string; location: string }[] = [];
      for (const g of groups.values()) {
        // Findings with no asset never absorb other photos' alerts.
        // A finding on a rack also folds into an open alert on equipment inside that rack
        // (its registry location names the rack): a note on R12 about PSU2 is PDU-A's incident.
        const rackAsset = assets.find(a => slug(a.assetId) === g.entityId && a.assetType === 'rack');
        const inRack = (entityId: string) => {
          if (!rackAsset) return false;
          const a = assets.find(x => slug(x.assetId) === entityId);
          if (!a || a.assetType === 'rack') return false;
          const loc = squash(a.location);
          return [rackAsset.assetId, rackAsset.name].some(n => squash(n).length > 2 && loc.includes(squash(n)));
        };
        const open = g.entityId
          ? (recent.find(r => !r.acked && r.entityId === g.entityId) ?? recent.find(r => !r.acked && inRack(r.entityId)))
          : undefined;
        if (open) {
          // One open alert per asset: fold in new readings from the equipment (fault text),
          // up to 5 lines, no new Slack post. A repeat photo's "changes" compare against the
          // already-faulted previous photo, so they are not folded in.
          const lines = open.text.split(' · ');
          const keys = lines.map(squash);
          for (const i of g.items) {
            const k = squash(i.text);
            if (i.kind !== 'fault_text' || lines.length >= 5 || keys.some(x => x.includes(k) || k.includes(x))) continue;
            lines.push(i.text);
            keys.push(k);
          }
          if (lines.length !== open.text.split(' · ').length) tx.db.alert.alertId.update({ ...open, text: lines.join(' · ') });
          continue;
        }
        const text = summarizeFindings(g.items).join(' · ');
        const row = tx.db.alert.insert({
          alertId: 0n,
          eventId,
          tMicros: now,
          kind: g.kind,
          text,
          entityId: g.entityId,
          entityName: g.entityName,
          deviceId: ev.deviceId,
          wearerName,
          acked: false,
          ackedMicros: undefined,
          slackStatus: env.SLACK_WEBHOOK_URL ? 'pending' : 'no_webhook',
        });
        inserted.push({ alertId: row.alertId, text, kind: g.kind, entityName: g.entityName, location: g.location });
      }
      return inserted.map(i => ({ ...i, wearerName, deviceId: ev.deviceId, tMicros: now }));
    });

    // 5. post new alerts to Slack, then record the outcome on each alert row
    const hook = env.SLACK_WEBHOOK_URL;
    if (hook && newAlerts.length) {
      const results: { alertId: bigint; status: string }[] = [];
      for (const a of newAlerts) {
        const where = [a.entityName, a.location].filter(Boolean).join(' · ');
        const who = a.wearerName || a.deviceId;
        const label = a.kind === 'state_change' ? 'STATE CHANGE' : a.kind === 'anomaly' ? 'ANOMALY' : 'FAULT';
        const text =
          `:rotating_light: *${label}*${where ? ` — ${where}` : ''}\n> ${a.text}\n` +
          `Seen by ${who} at ${clockCT(a.tMicros)} · event \`${eventId}\``;
        let status = 'posted';
        try {
          const res = ctx.http.fetch(hook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            timeout: TimeDuration.fromMillis(5_000),
            body: JSON.stringify({ text }),
          });
          if (res.status !== 200) status = `http_${res.status}`;
        } catch (e) {
          status = 'error';
          console.warn(`slack post ${eventId}: ${String(e).slice(0, 200)}`);
        }
        results.push({ alertId: a.alertId, status });
      }
      ctx.withTx(tx => {
        for (const r of results) {
          const row = tx.db.alert.alertId.find(r.alertId);
          if (row) tx.db.alert.alertId.update({ ...row, slackStatus: r.status });
        }
      });
    }
    return {};
  }
);

// Admin: post a test message to the configured Slack webhook to verify it end to end.
export const slackTest = spacetimedb.procedure({ adminToken: t.string() }, SlackTestResult, (ctx, { adminToken }) => {
  if (adminToken !== (ctx.env.ADMIN_TOKEN ?? ctx.env.INGEST_TOKEN)) throw new SenderError('unauthorized');
  const hook = ctx.env.SLACK_WEBHOOK_URL;
  if (!hook) return { status: 'no_webhook' };
  try {
    const res = ctx.http.fetch(hook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: TimeDuration.fromMillis(5_000),
      body: JSON.stringify({ text: ':white_check_mark: wm-physical is connected to this channel. Alerts and shift handoffs will post here.' }),
    });
    return { status: res.status === 200 ? 'posted' : `http_${res.status}` };
  } catch (e) {
    return { status: `error:${String(e).slice(0, 200)}` };
  }
});

// ---------- reducers ----------

export const setLabel = spacetimedb.reducer({ eventId: t.string(), label: t.string() }, (ctx, { eventId, label }) => {
  const ev = ctx.db.event.eventId.find(eventId);
  if (!ev) throw new SenderError('not_found');
  ctx.db.event.eventId.update({ ...ev, label });
});

export const setNote = spacetimedb.reducer({ eventId: t.string(), note: t.string() }, (ctx, { eventId, note }) => {
  const ev = ctx.db.event.eventId.find(eventId);
  if (!ev) throw new SenderError('not_found');
  ctx.db.event.eventId.update({ ...ev, note });
});

export const ackAlert = spacetimedb.reducer({ alertId: t.u64() }, (ctx, { alertId }) => {
  const row = ctx.db.alert.alertId.find(alertId);
  if (!row) throw new SenderError('not_found');
  if (row.acked) return;
  ctx.db.alert.alertId.update({ ...row, acked: true, ackedMicros: ctx.timestamp.microsSinceUnixEpoch });
});

// ---------- admin reducers (token from env: ADMIN_TOKEN, else INGEST_TOKEN) ----------

export const upsertAsset = spacetimedb.reducer(
  {
    adminToken: t.string(),
    assetId: t.string(),
    name: t.string(),
    assetType: t.string(),
    location: t.string(),
    patterns: t.array(t.string()),
  },
  (ctx, { adminToken, assetId, name, assetType, location, patterns }) => {
    if (adminToken !== (ctx.env.ADMIN_TOKEN ?? ctx.env.INGEST_TOKEN)) throw new SenderError('unauthorized');
    if (!assetId.trim()) throw new SenderError('missing_asset_id');
    const row = { assetId: assetId.trim(), name, assetType, location, patterns };
    if (ctx.db.asset.assetId.find(row.assetId)) ctx.db.asset.assetId.update(row);
    else ctx.db.asset.insert(row);
    // keep the matching entity in step so the graph shows the canonical name
    const id = slug(row.assetId);
    const ent = ctx.db.entity.entityId.find(id);
    if (ent) ctx.db.entity.entityId.update({ ...ent, kind: 'asset', canonicalName: name || row.assetId });
  }
);

export const deleteAsset = spacetimedb.reducer(
  { adminToken: t.string(), assetId: t.string() },
  (ctx, { adminToken, assetId }) => {
    if (adminToken !== (ctx.env.ADMIN_TOKEN ?? ctx.env.INGEST_TOKEN)) throw new SenderError('unauthorized');
    ctx.db.asset.assetId.delete(assetId);
  }
);

export const upsertWearer = spacetimedb.reducer(
  { adminToken: t.string(), deviceId: t.string(), name: t.string(), role: t.string(), shift: t.string() },
  (ctx, { adminToken, deviceId, name, role, shift }) => {
    if (adminToken !== (ctx.env.ADMIN_TOKEN ?? ctx.env.INGEST_TOKEN)) throw new SenderError('unauthorized');
    if (!deviceId.trim()) throw new SenderError('missing_device_id');
    const row = { deviceId: deviceId.trim(), name, role, shift };
    if (ctx.db.wearer.deviceId.find(row.deviceId)) ctx.db.wearer.deviceId.update(row);
    else ctx.db.wearer.insert(row);
  }
);

// Re-run perception on one event, or ('') on every event that is failed or was perceived
// by the keyless stub. Clears the edges that event's perceive wrote so it can rebuild them
// without duplicates. Alerts already raised are kept.
export const reperceive = spacetimedb.reducer(
  { adminToken: t.string(), eventId: t.string() },
  (ctx, { adminToken, eventId }) => {
    if (adminToken !== (ctx.env.ADMIN_TOKEN ?? ctx.env.INGEST_TOKEN)) throw new SenderError('unauthorized');
    const targets = eventId
      ? [ctx.db.event.eventId.find(eventId)].filter(e => !!e)
      : [...ctx.db.event.iter()].filter(e => e.status === 'failed' || e.scene === 'unperceived');
    targets.sort((a, b) => (a!.tMicros < b!.tMicros ? -1 : a!.tMicros > b!.tMicros ? 1 : 0));
    if (eventId && !targets.length) throw new SenderError('not_found');
    const now = ctx.timestamp.microsSinceUnixEpoch;
    let i = 0n;
    for (const ev of targets) {
      if (!ev) continue;
      // edges this event's perceive wrote: everything outgoing except NEXT (the next event
      // owns that one), plus the incoming NEXT from its predecessor
      for (const e of [...ctx.db.edge.fromId.filter(ev.eventId)]) if (e.kind !== 'NEXT') ctx.db.edge.edgeId.delete(e.edgeId);
      for (const e of [...ctx.db.edge.toId.filter(ev.eventId)]) if (e.kind === 'NEXT') ctx.db.edge.edgeId.delete(e.edgeId);
      ctx.db.event.eventId.update({ ...ev, status: 'accepted' });
      // oldest first, 8 s apart: each sees its predecessor in the graph, and we stay well
      // under the NVIDIA free-tier rate limit
      ctx.db.perceiveJob.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.time(now + i * 8_000_000n), eventId: ev!.eventId });
      i++;
    }
  }
);
