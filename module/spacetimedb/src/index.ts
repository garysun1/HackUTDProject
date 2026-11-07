// Working Memory for the Physical World — SpacetimeDB module (TypeScript).
// Tables: event, photo, entity, edge, episode, handoff, perceive_job.
// Procedures: ping, ingestPhoto (ingest_photo), perceive (scheduled).
// Reducers: setLabel, setNote.
// See docs/DESIGN.md §5–§8 and docs/CONTRACT.md.

import { schema, table, t, SenderError } from 'spacetimedb/server';
import { ScheduleAt, TimeDuration } from 'spacetimedb';

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
    perceptionJson: t.string(),
    embedding: t.array(t.f32()),
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
    kind: t.string(), // object | place
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

const perceiveJob = table(
  { name: 'perceive_job' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    eventId: t.string(),
  }
);

const spacetimedb = schema(
  { event, photo, entity, edge, episode, handoff, perceiveJob },
  {
    env: {
      INGEST_TOKEN: t.string(),
      NVIDIA_API_KEY: t.option(t.string()),
      NVIDIA_VL_MODEL: t.option(t.string()),
      AZURE_AI_KEY: t.option(t.string()),
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

function isoFromMicros(micros: bigint): string {
  return new Date(Number(micros / 1000n)).toISOString();
}

function slug(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

const PERCEPTION_PROMPT =
  'You are the perception step of a physical-world memory system for data center operators. ' +
  'Return ONLY a JSON object with keys: scene, location_guess, objects (array of {name, attributes, position}), ' +
  'people_count (integer, never identities), activity, text_in_scene (array of strings you can read), ' +
  'changes_since_previous (array of {entity, attr, from, to}; empty if no previous or nothing changed), ' +
  'summary (one sentence), confidence (0-1).';

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
      tx.db.perceiveJob.insert({
        scheduledId: 0n,
        scheduledAt: ScheduleAt.time(nowMicros),
        eventId: ev.event_id,
      });
      return { eventId: ev.event_id, serverT, status: 'accepted' };
    });
  }
);

// Scheduled: one job per ingested photo. Network I/O happens outside transactions.
export const perceive = spacetimedb.procedure(
  { onSchedule: perceiveJob },
  { arg: perceiveJob.rowType },
  t.unit(),
  (ctx, { arg }) => {
    const eventId = arg.eventId;

    // 1. read what we need
    const snap = ctx.withTx(tx => {
      const ev = tx.db.event.eventId.find(eventId);
      const ph = tx.db.photo.eventId.find(eventId);
      if (!ev || !ph) return null;
      let prev: typeof ev | null = null;
      for (const other of tx.db.event.iter()) {
        if (other.eventId !== eventId && other.tMicros < ev.tMicros && other.status === 'in_graph') {
          if (!prev || other.tMicros > prev.tMicros) prev = other;
        }
      }
      return { ev, ph, prevId: prev ? prev.eventId : null, prevSummary: prev ? prev.summary : '' };
    });
    if (!snap) return {};

    // 2. perception call (Nemotron VL) or stub when no key is configured
    let perception: any = null;
    let failure = '';
    const key = ctx.env.NVIDIA_API_KEY;
    if (key) {
      const model = ctx.env.NVIDIA_VL_MODEL ?? 'nvidia/nemotron-3.5-super-vl-120b-a12b';
      const userText =
        PERCEPTION_PROMPT +
        (snap.prevSummary ? ` Previous event summary: ${JSON.stringify(snap.prevSummary)}.` : ' Previous event summary: none.') +
        (snap.ev.label ? ` The wearer labeled the main object in this photo: ${JSON.stringify(snap.ev.label)}.` : '') +
        (snap.ev.note ? ` Wearer note: ${JSON.stringify(snap.ev.note)}.` : '');
      try {
        const res = ctx.http.fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          timeout: TimeDuration.fromMillis(60_000),
          body: JSON.stringify({
            model,
            max_tokens: 1200,
            temperature: 0.1,
            chat_template_kwargs: { enable_thinking: false },
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: userText },
                  { type: 'image_url', image_url: { url: `data:${snap.ph.mime};base64,${snap.ph.jpegB64}` } },
                ],
              },
            ],
          }),
        });
        if (res.status !== 200) {
          failure = `nvidia_http_${res.status}`;
        } else {
          const body = res.json();
          const content: string = body?.choices?.[0]?.message?.content ?? '';
          const s = content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1);
          perception = JSON.parse(s);
        }
      } catch (e) {
        failure = `nvidia_error:${String(e).slice(0, 200)}`;
      }
    } else {
      perception = {
        scene: 'unperceived',
        location_guess: '',
        objects: [],
        people_count: 0,
        activity: '',
        text_in_scene: [],
        changes_since_previous: [],
        summary: 'Photo stored; perception key not configured.',
        confidence: 0,
      };
    }

    // 3. write results and graph edges
    ctx.withTx(tx => {
      const ev = tx.db.event.eventId.find(eventId);
      if (!ev) return;
      if (!perception) {
        tx.db.event.eventId.update({ ...ev, status: 'failed', perceptionJson: JSON.stringify({ error: failure }) });
        return;
      }
      const objects: any[] = Array.isArray(perception.objects) ? perception.objects : [];
      const changes: any[] = Array.isArray(perception.changes_since_previous) ? perception.changes_since_previous : [];
      tx.db.event.eventId.update({
        ...ev,
        status: 'in_graph',
        scene: String(perception.scene ?? ''),
        locationGuess: String(perception.location_guess ?? ''),
        activity: String(perception.activity ?? ''),
        summary: String(perception.summary ?? ''),
        peopleCount: Number.isFinite(perception.people_count) ? Math.max(0, Math.trunc(perception.people_count)) : 0,
        confidence: Number.isFinite(perception.confidence) ? perception.confidence : 0,
        perceptionJson: JSON.stringify(perception),
      });

      // EVIDENCED_BY: event -> photo
      tx.db.edge.insert({ edgeId: 0n, fromId: eventId, toId: eventId, kind: 'EVIDENCED_BY', props: '{}' });
      // NEXT: previous -> this
      if (snap.prevId) {
        tx.db.edge.insert({ edgeId: 0n, fromId: snap.prevId, toId: eventId, kind: 'NEXT', props: '{}' });
      }
      // entities + INVOLVES
      const names: string[] = [];
      if (ev.label) names.push(ev.label);
      for (const o of objects) if (o && typeof o.name === 'string') names.push(o.name);
      const seen = new Set<string>();
      for (const name of names) {
        const id = slug(name);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const existing = tx.db.entity.entityId.find(id);
        if (existing) {
          const aliases = existing.aliases.includes(name) ? existing.aliases : [...existing.aliases, name];
          tx.db.entity.entityId.update({ ...existing, aliases, lastSeenMicros: ev.tMicros });
        } else {
          tx.db.entity.insert({
            entityId: id,
            canonicalName: name,
            kind: 'object',
            aliases: [name],
            firstSeenMicros: ev.tMicros,
            lastSeenMicros: ev.tMicros,
          });
        }
        const role = ev.label && slug(ev.label) === id ? 'subject' : 'target';
        tx.db.edge.insert({ edgeId: 0n, fromId: eventId, toId: id, kind: 'INVOLVES', props: JSON.stringify({ role }) });
      }
      // place entity + INVOLVES setting
      const place = String(perception.location_guess ?? '').trim();
      if (place) {
        const pid = 'place_' + slug(place);
        const existing = tx.db.entity.entityId.find(pid);
        if (existing) tx.db.entity.entityId.update({ ...existing, lastSeenMicros: ev.tMicros });
        else
          tx.db.entity.insert({
            entityId: pid,
            canonicalName: place,
            kind: 'place',
            aliases: [place],
            firstSeenMicros: ev.tMicros,
            lastSeenMicros: ev.tMicros,
          });
        tx.db.edge.insert({ edgeId: 0n, fromId: eventId, toId: pid, kind: 'INVOLVES', props: JSON.stringify({ role: 'setting' }) });
      }
      // CHANGES
      for (const c of changes) {
        const ename = typeof c?.entity === 'string' ? c.entity : '';
        if (!ename) continue;
        const id = slug(ename);
        if (!tx.db.entity.entityId.find(id)) {
          tx.db.entity.insert({
            entityId: id,
            canonicalName: ename,
            kind: 'object',
            aliases: [ename],
            firstSeenMicros: ev.tMicros,
            lastSeenMicros: ev.tMicros,
          });
        }
        tx.db.edge.insert({
          edgeId: 0n,
          fromId: eventId,
          toId: id,
          kind: 'CHANGES',
          props: JSON.stringify({ attr: c.attr ?? '', from: c.from ?? '', to: c.to ?? '' }),
        });
      }
    });
    return {};
  }
);

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
