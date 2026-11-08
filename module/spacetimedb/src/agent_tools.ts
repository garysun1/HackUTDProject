// Pure tools for the ask loop (#7): read-only functions over one in-memory snapshot of the
// tables, with the same semantics as the MCP server's tools (mcp/src/tools.mjs), so an
// agent gets the same answers whether it goes through Claude Desktop or the module.
// No SpacetimeDB imports: tested with plain Node (module/test/agent_tools.test.ts).
import { squash, clockCT, parseSinceArg, graphSections, assembleHandoff, type HandoffSnap, type HEvent, type HAlert } from './rules.ts';

export interface AChange {
  entityId: string;
  entity: string;
  attr: string;
  from: string;
  to: string;
}
export interface AEvent {
  id: string;
  t: bigint;
  wearer: string;
  summary: string;
  scene: string;
  activity: string;
  locationGuess: string;
  note: string;
  label: string;
  textInScene: string[];
  objects: string[];
  peopleCount: number;
  place: string;
  assets: string[]; // canonical names of INVOLVES entities with role asset
  entityIds: string[]; // every INVOLVES target (subject, target, asset)
  changes: AChange[];
}
export interface AEntity {
  id: string;
  name: string;
  kind: string;
  aliases: string[];
}
export interface AAlert {
  alertId: bigint;
  eventId: string;
  t: bigint;
  kind: string;
  text: string;
  entityId: string;
  entityName: string;
  wearer: string;
  acked: boolean;
}
export interface AEpisode {
  start: bigint;
  end: bigint;
  title: string;
  summary: string;
  eventIds: string[];
}
export interface AgentIndex {
  now: bigint;
  events: AEvent[]; // oldest first
  byId: Map<string, AEvent>;
  entities: AEntity[];
  alerts: AAlert[];
  episodes: AEpisode[];
  lastHandoff: string | null;
}

export function makeIndex(now: bigint, events: AEvent[], entities: AEntity[], alerts: AAlert[], episodes: AEpisode[], lastHandoff: string | null): AgentIndex {
  const sorted = [...events].sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  return { now, events: sorted, byId: new Map(sorted.map(e => [e.id, e])), entities, alerts, episodes, lastHandoff };
}

// ---------- small helpers ----------

const MAX_RESULT_CHARS = 6000;

function eventOut(e: AEvent, full = false) {
  const o: Record<string, unknown> = { event: e.id, time: clockCT(e.t), wearer: e.wearer, summary: e.summary };
  if (e.place) o.place = e.place;
  if (e.assets.length) o.assets = e.assets;
  if (e.note) o.note = e.note;
  if (e.label) o.label = e.label;
  if (e.changes.length) o.changes = e.changes.map(c => `${c.entity}${c.attr ? ' ' + c.attr : ''}: ${c.from} -> ${c.to}`);
  if (full) {
    o.scene = e.scene;
    o.activity = e.activity;
    o.text_read = e.textInScene;
    o.objects = e.objects;
    o.people_count = e.peopleCount;
  }
  return o;
}

function sinceMicros(s: unknown, idx: AgentIndex): bigint {
  const v = parseSinceArg(typeof s === 'string' ? s : '', idx.now);
  return v === null ? 0n : v;
}

/** Letter and digit runs of a query: "rack 12" -> RACK, 12; "PDU-A" -> PDU, A. */
function tokens(q: string): string[] {
  return (q.toUpperCase().match(/[A-Z]+|\d+/g) ?? []).filter(t => t.length >= 2 || /^\d+$/.test(t));
}

function rankEntities(idx: AgentIndex, query: string): { e: AEntity; s: number; len: number }[] {
  const q = squash(query);
  if (q.length < 2) return [];
  const toks = tokens(query);
  const out: { e: AEntity; s: number; len: number }[] = [];
  for (const e of idx.entities) {
    const names = [e.name, e.id, ...e.aliases].map(squash).filter(Boolean);
    let s = 0;
    let len = Infinity;
    for (const n of names) {
      let v = 0;
      if (n === q) v = 4;
      else if (n.length > 2 && (n.startsWith(q) || q.startsWith(n))) v = 3;
      else if (n.length > 2 && (n.includes(q) || q.includes(n))) v = 2;
      else if (toks.length && toks.every(t => n.includes(t))) v = 1; // "rack 12" within "RACKR12"
      if (v > s || (v === s && n.length < len)) {
        s = v;
        len = n.length;
      }
    }
    if (s) out.push({ e, s, len });
  }
  return out.sort((x, y) => y.s - x.s || x.len - y.len);
}

/** Entities whose name, alias or id matches the query; most exact first. */
export function matchEntity(idx: AgentIndex, query: string): AEntity[] {
  return rankEntities(idx, query).map(x => x.e);
}

/** The entities a query is really about: the top match tier, shortest names on a tie, so "Rack R12" is the rack, not the PDU whose name contains it. */
export function bestMatches(idx: AgentIndex, query: string): AEntity[] {
  const r = rankEntities(idx, query);
  if (!r.length) return [];
  const top = r.filter(x => x.s === r[0].s);
  const minLen = Math.min(...top.map(x => x.len));
  return top.filter(x => x.len === minLen).map(x => x.e);
}

function terms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9.#-]+/)
    .filter(t => t.length > 1);
}

export function keywordScore(e: AEvent, ts: string[]): number {
  const hay = [e.summary, e.scene, e.activity, e.locationGuess, e.note, e.label, e.place, e.wearer, ...e.assets, ...e.textInScene, ...e.objects, ...e.changes.map(c => `${c.entity} ${c.attr} ${c.from} ${c.to}`)]
    .filter(Boolean)
    .join(' \n ')
    .toLowerCase();
  let s = 0;
  for (const t of ts) {
    const n = hay.split(t).length - 1;
    s += n ? 1 + Math.min(n, 3) * 0.25 : 0;
  }
  return s;
}

/** Timeline segments: stored episodes when present, else a new segment on place change or a gap over 20 minutes. */
export function segments(idx: AgentIndex, from: bigint, to: bigint) {
  const evs = idx.events.filter(e => e.t >= from && e.t <= to);
  if (idx.episodes.length) {
    return idx.episodes
      .filter(ep => ep.end >= from && ep.start <= to)
      .map(ep => ({ start: ep.start, end: ep.end, title: ep.title, summary: ep.summary, eventIds: ep.eventIds }));
  }
  const out: { start: bigint; end: bigint; title: string; summary: string; eventIds: string[]; place: string; who: Set<string> }[] = [];
  let cur: (typeof out)[number] | null = null;
  for (const e of evs) {
    const place = e.place || 'no place identified';
    if (!cur || cur.place !== place || e.t - cur.end > 20n * 60n * 1_000_000n) {
      cur = { start: e.t, end: e.t, title: '', summary: '', eventIds: [], place, who: new Set() };
      out.push(cur);
    }
    cur.end = e.t;
    cur.eventIds.push(e.id);
    cur.who.add(e.wearer);
  }
  return out.map(s => ({
    start: s.start,
    end: s.end,
    title: `${s.place}, ${[...s.who].join(', ')}`,
    summary: s.eventIds
      .map(id => idx.byId.get(id)?.summary)
      .filter(Boolean)
      .slice(0, 2)
      .join(' '),
    eventIds: s.eventIds,
  }));
}

// ---------- the tools ----------

export const TOOL_SPECS = [
  { name: 'search_memory', description: 'Find photographed events matching free text: text read in the scene, objects, places, assets, notes, summaries. Returns ranked events with their ids.', parameters: { type: 'object', properties: { query: { type: 'string' }, since: { type: 'string', description: 'window start: ISO time, or 2h, 45m, 1d; empty for everything' }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, required: ['query'] } },
  { name: 'get_timeline', description: 'The shift in order as episodes: time span, place, who, what happened, with event ids.', parameters: { type: 'object', properties: { since: { type: 'string' }, until: { type: 'string' } } } },
  { name: 'what_changed', description: 'State changes recorded for an asset or object (from, to, when, who), with event ids.', parameters: { type: 'object', properties: { entity: { type: 'string', description: 'asset or object name or id, e.g. PDU-A, PSU 2, rack 12' }, since: { type: 'string' } }, required: ['entity'] } },
  { name: 'find_object', description: 'Where something was last seen: place, time, who photographed it.', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'get_current_context', description: 'The most recent photographed event: who, where, what the scene shows, what text was read, and the open alerts.', parameters: { type: 'object', properties: {} } },
  { name: 'explain_change', description: 'How an asset got to its current state: its recorded changes in order with the events that evidence them.', parameters: { type: 'object', properties: { entity: { type: 'string' } }, required: ['entity'] } },
  { name: 'get_provenance', description: 'The full record behind an event id (or its first 8 characters): wearer, place, perception fields, text read, changes, note.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'wearer_rounds', description: 'What one wearer did: their photos in order, where they were last, which assets and places they covered. Use for questions about a person on shift by the name the record uses.', parameters: { type: 'object', properties: { wearer: { type: 'string' }, since: { type: 'string' } }, required: ['wearer'] } },
  { name: 'list_open_alerts', description: 'Alerts that nobody has acknowledged: asset, what was seen, since when, by whom, event id.', parameters: { type: 'object', properties: {} } },
  { name: 'summarize_handoff', description: 'The shift handoff: needs attention, what changed, rounds, notes, quiet assets, every line citing an event.', parameters: { type: 'object', properties: { since: { type: 'string', description: 'window start; empty for the latest handoff' } } } },
] as const;

export function toolSpecsForChat() {
  return TOOL_SPECS.map(s => ({ type: 'function', function: { name: s.name, description: s.description, parameters: s.parameters } }));
}

function openAlertsOut(idx: AgentIndex) {
  return idx.alerts.filter(a => !a.acked).map(a => ({ alert_id: a.alertId.toString(), asset: a.entityName || 'unassigned', text: a.text, since: clockCT(a.t), wearer: a.wearer, event: a.eventId }));
}

function toHandoffSnap(idx: AgentIndex, from: bigint): HandoffSnap {
  const events: HEvent[] = idx.events.filter(e => e.t >= from).map(e => ({ id: e.id, t: e.t, wearer: e.wearer, assets: e.assets, place: e.place, summary: e.summary, note: e.note, label: e.label, changes: e.changes.map(c => `${c.entity}${c.attr ? ' ' + c.attr : ''}: ${c.from} -> ${c.to}`) }));
  const alerts: HAlert[] = idx.alerts.filter(a => !a.acked || a.t >= from).map(a => ({ t: a.t, open: !a.acked, asset: a.entityName || a.entityId || 'unassigned', text: a.text, eventId: a.eventId, wearer: a.wearer }));
  return { sinceMicros: from, anchor: from > 0n ? clockCT(from) : 'the start of the record', events, alerts, total: events.length };
}

/** Run one tool. Always returns a JSON-able object; unknown tools and bad arguments return an error field. */
export function runTool(idx: AgentIndex, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const a = args || {};
  switch (name) {
    case 'search_memory': {
      const query = String(a.query ?? '').trim();
      if (!query) return { error: 'query is required' };
      const from = sinceMicros(a.since, idx);
      const limit = Math.min(20, Math.max(1, Number(a.limit) || 8));
      const ts = terms(query);
      const scored = idx.events
        .filter(e => e.t >= from)
        .map(e => ({ e, s: keywordScore(e, ts) }))
        .filter(x => x.s > 0)
        .sort((x, y) => y.s - x.s || (y.e.t > x.e.t ? 1 : -1))
        .slice(0, limit);
      return { query, matches: scored.map(x => eventOut(x.e)), total_events: idx.events.length, hint: scored.length ? undefined : 'no match; try other words or get_timeline' };
    }
    case 'get_timeline': {
      const from = sinceMicros(a.since, idx);
      const to = a.until ? sinceMicros(a.until, idx) : idx.now;
      const segs = segments(idx, from, to);
      if (!segs.length) return { episodes: [], note: 'no events in that window' };
      return {
        from: clockCT(segs[0].start),
        to: clockCT(segs[segs.length - 1].end),
        episodes: segs.slice(0, 40).map(s => ({ start: clockCT(s.start), end: clockCT(s.end), title: s.title, photos: s.eventIds.length, summary: s.summary, first_event: s.eventIds[0], last_event: s.eventIds[s.eventIds.length - 1] })),
      };
    }
    case 'what_changed': {
      const entity = String(a.entity ?? '').trim();
      const matches = matchEntity(idx, entity);
      if (!matches.length) return { error: `no entity matches "${entity}"`, known_assets: idx.entities.filter(e => e.kind === 'asset').map(e => e.name).slice(0, 30) };
      const ids = new Set(bestMatches(idx, entity).map(m => m.id));
      const from = sinceMicros(a.since, idx);
      const changes: Record<string, unknown>[] = [];
      const seen: AEvent[] = [];
      for (const e of idx.events) {
        if (e.t < from) continue;
        if (e.entityIds.some(id => ids.has(id))) seen.push(e);
        for (const c of e.changes) if (ids.has(c.entityId)) changes.push({ time: clockCT(e.t), entity: c.entity, attr: c.attr, from: c.from, to: c.to, wearer: e.wearer, event: e.id });
      }
      const last = seen[seen.length - 1];
      return { matched: matches.slice(0, 3).map(m => `${m.name} (${m.kind})`), seen_in_photos: seen.length, last_seen: last ? { time: clockCT(last.t), event: last.id, summary: last.summary } : null, changes, note: changes.length ? undefined : 'no recorded state changes' };
    }
    case 'find_object': {
      const name = String(a.name ?? '').trim();
      const matches = matchEntity(idx, name);
      if (!matches.length) return { error: `nothing called "${name}" has been photographed; try search_memory` };
      const ids = new Set(bestMatches(idx, name).map(m => m.id));
      const seen = idx.events.filter(e => e.entityIds.some(id => ids.has(id)) || e.changes.some(c => ids.has(c.entityId)));
      if (!seen.length) return { name: matches[0].name, note: 'known but no photo involves it yet' };
      const last = seen[seen.length - 1];
      return { name: matches[0].name, last_seen: eventOut(last), first_seen: { time: clockCT(seen[0].t), event: seen[0].id }, times_seen: seen.length };
    }
    case 'get_current_context': {
      const last = idx.events[idx.events.length - 1];
      if (!last) return { note: 'no events yet' };
      const ageMin = Number((idx.now - last.t) / 60_000_000n);
      return { latest: eventOut(last, true), minutes_ago: ageMin, open_alerts: openAlertsOut(idx) };
    }
    case 'explain_change': {
      const entity = String(a.entity ?? '').trim();
      const matches = matchEntity(idx, entity);
      if (!matches.length) return { error: `no entity matches "${entity}"` };
      const ids = new Set(bestMatches(idx, entity).map(m => m.id));
      const chain: Record<string, unknown>[] = [];
      for (const e of idx.events) for (const c of e.changes) if (ids.has(c.entityId)) chain.push({ time: clockCT(e.t), entity: c.entity, attr: c.attr, from: c.from, to: c.to, wearer: e.wearer, event: e.id });
      const seen = idx.events.filter(e => e.entityIds.some(id => ids.has(id)));
      const last = seen[seen.length - 1];
      return { entity: matches[0].name, changes: chain, photos: seen.length, current: last ? eventOut(last) : null, note: chain.length ? undefined : 'no state changes recorded; the current state is whatever the latest photo shows' };
    }
    case 'get_provenance': {
      const id = String(a.id ?? '').trim();
      const e = idx.byId.get(id) ?? idx.events.find(x => x.id.startsWith(id));
      if (!e) return { error: `no event matches "${id}"` };
      return { ...eventOut(e, true), alerts: idx.alerts.filter(x => x.eventId === e.id).map(x => ({ text: x.text, asset: x.entityName, acked: x.acked })) };
    }
    case 'wearer_rounds': {
      const who = squash(String(a.wearer ?? ''));
      if (who.length < 2) return { error: 'wearer is required' };
      const from = sinceMicros(a.since, idx);
      const names = [...new Set(idx.events.map(e => e.wearer))];
      const match = names.filter(n => squash(n) === who) .concat(names.filter(n => squash(n) !== who && (squash(n).includes(who) || who.includes(squash(n)))));
      if (!match.length) return { error: `no wearer called "${a.wearer}"`, wearers: names };
      const mine = idx.events.filter(e => e.wearer === match[0] && e.t >= from);
      if (!mine.length) return { wearer: match[0], note: 'no photos in that window' };
      const places: string[] = [];
      const assets: string[] = [];
      for (const e of mine) {
        if (e.place && !places.includes(e.place)) places.push(e.place);
        for (const x of e.assets) if (!assets.includes(x)) assets.push(x);
      }
      return { wearer: match[0], photos: mine.length, first: { time: clockCT(mine[0].t), event: mine[0].id }, last_seen: eventOut(mine[mine.length - 1]), places, assets, recent: mine.slice(-6).map(e => eventOut(e)) };
    }
    case 'list_open_alerts':
      return { open: openAlertsOut(idx) };
    case 'summarize_handoff': {
      const since = typeof a.since === 'string' ? a.since.trim() : '';
      if (!since && idx.lastHandoff) return { handoff: idx.lastHandoff, source: 'cached' };
      const snap = toHandoffSnap(idx, since ? sinceMicros(since, idx) : 0n);
      if (!snap.events.length && !snap.alerts.some(x => x.open)) return { handoff: `No photos since ${snap.anchor}.`, source: 'graph' };
      return { handoff: assembleHandoff(graphSections(snap), snap), source: 'graph' };
    }
    default:
      return { error: `unknown tool ${name}` };
  }
}

/** JSON for the tool message, bounded so a wide search cannot blow the context. */
export function toolResultJson(result: Record<string, unknown>): string {
  const s = JSON.stringify(result);
  return s.length <= MAX_RESULT_CHARS ? s : s.slice(0, MAX_RESULT_CHARS - 20) + '..."truncated":true}';
}

/** Event ids a tool result surfaced, for grounding the final answer. */
export function eventIdsIn(result: Record<string, unknown>, known: Set<string>): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) (k === 'event' || k === 'first_event' || k === 'last_event') && typeof x === 'string' && known.has(x) && !out.includes(x) ? out.push(x) : walk(x);
  };
  walk(result);
  return out;
}

// ---------- answer post-processing ----------

/** Remove markdown emphasis and headers the small model likes to add. */
export function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[*•]\s+/gm, '- ')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

/** Citations in the text that name known events, in order; unknown ones are removed from the text. */
export function groundCitations(text: string, known: Set<string>): { text: string; citations: string[] } {
  const citations: string[] = [];
  const cleaned = text.replace(/\[event:([^\]]+)\]/g, (_m, inner: string) => {
    const good = inner
      .split(/[\s,]+/)
      .map(x => x.replace(/^event:/, ''))
      .filter(x => x && known.has(x));
    for (const id of good) if (!citations.includes(id)) citations.push(id);
    return good.map(id => `[event:${id}]`).join(' ');
  });
  return { text: cleaned.replace(/[ \t]{2,}/g, ' ').replace(/ +\n/g, '\n').trim(), citations };
}

/** When no model is reachable: the closest evidence for the question, cited. */
export function fallbackAnswer(idx: AgentIndex, question: string): { answer: string; citations: string[] } {
  const r = runTool(idx, 'search_memory', { query: question, limit: 5 }) as { matches: Record<string, unknown>[] };
  const open = openAlertsOut(idx);
  const lines: string[] = ['The floor agent is unavailable right now; here is the closest evidence.'];
  if (open.length) lines.push(`Open alerts: ${open.map(o => `${o.asset}: ${o.text} since ${o.since} [event:${o.event}]`).join('; ')}`);
  const cites: string[] = [];
  for (const m of r.matches || []) {
    lines.push(`${m.time} ${m.wearer}${m.place ? ` at ${m.place}` : ''}: ${m.summary} [event:${m.event}]`);
    cites.push(String(m.event));
  }
  for (const o of open) if (!cites.includes(o.event)) cites.push(o.event);
  if (!r.matches?.length && !open.length) lines.push('No photographed event matches the question.');
  return { answer: lines.join('\n'), citations: cites };
}
