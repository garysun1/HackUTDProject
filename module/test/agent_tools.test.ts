// Run: node --experimental-strip-types --test test/agent_tools.test.ts   (from module/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeIndex, matchEntity, bestMatches, runTool, toolResultJson, eventIdsIn, stripMarkdown, groundCitations, fallbackAnswer, segments } from '../spacetimedb/src/agent_tools.ts';

const T0 = 1794110400000000n; // 22:00 CT
const min = (n: number) => BigInt(n) * 60_000_000n;
const ev = (id: string, dt: number, wearer: string, o: Partial<Parameters<typeof makeIndex>[1][number]> = {}) => ({
  id, t: T0 + min(dt), wearer, summary: '', scene: '', activity: '', locationGuess: '', note: '', label: '', textInScene: [], objects: [], peopleCount: 0, place: '', assets: [], entityIds: [], changes: [], ...o,
});
const entities = [
  { id: 'pdu_a', name: 'PDU A (Rack R12)', kind: 'asset', aliases: ['PDU-A'] },
  { id: 'r12', name: 'Rack R12', kind: 'asset', aliases: ['R12'] },
  { id: 'crac_2', name: 'CRAC unit 2', kind: 'asset', aliases: ['CRAC-2'] },
  { id: 'place_cold_aisle_3', name: 'Cold Aisle 3', kind: 'place', aliases: [] },
  { id: 'patch_cable', name: 'patch cable', kind: 'object', aliases: [] },
];
const events = [
  ev('e1', 0, 'Maria', { summary: 'Cold aisle 3 sign', place: 'Cold Aisle 3', entityIds: ['place_cold_aisle_3'], textInScene: ['COLD AISLE 3'] }),
  ev('e2', 9, 'Maria', { summary: 'PDU-A reads 10.9 kW, PSU2 OK', place: 'Cold Aisle 3', assets: ['PDU A (Rack R12)', 'Rack R12'], entityIds: ['pdu_a', 'r12'], textInScene: ['PDU-A', 'PSU2 OK'] }),
  ev('e3', 42, 'Maria', { summary: 'PDU-A shows PSU2 FAULT', place: 'Cold Aisle 3', assets: ['PDU A (Rack R12)', 'Rack R12'], entityIds: ['pdu_a', 'r12'], textInScene: ['PDU-A', 'PSU2 FAULT'], changes: [{ entityId: 'pdu_a', entity: 'PDU A (Rack R12)', attr: 'PSU2 status', from: 'OK', to: 'FAULT' }] }),
  ev('e4', 70, 'Dev', { summary: 'CRAC-2 supply 18.2C', place: 'Row 1 end', assets: ['CRAC unit 2'], entityIds: ['crac_2'], note: 'Handoff: watch PDU-A', objects: ['CRAC unit'] }),
];
const alerts = [{ alertId: 1n, eventId: 'e3', t: T0 + min(42), kind: 'state_change', text: 'PSU2 status: OK -> FAULT', entityId: 'pdu_a', entityName: 'PDU A (Rack R12)', wearer: 'Maria', acked: false }];
const idx = makeIndex(T0 + min(80), events.reverse(), entities, alerts, [], null);

test('index sorts events and matchEntity ranks exact aliases first', () => {
  assert.deepEqual(idx.events.map(e => e.id), ['e1', 'e2', 'e3', 'e4']);
  assert.deepEqual(matchEntity(idx, 'PDU-A').map(e => e.id), ['pdu_a']);
  assert.equal(matchEntity(idx, 'rack 12')[0].id, 'r12');
  assert.equal(matchEntity(idx, 'crac')[0].id, 'crac_2');
  assert.deepEqual(matchEntity(idx, 'x'), []);
  // the rack, not the PDU whose name contains the rack
  assert.deepEqual(bestMatches(idx, 'Rack R12').map(e => e.id), ['r12']);
  assert.deepEqual(bestMatches(idx, 'rack 12').map(e => e.id), ['r12']);
  assert.deepEqual(matchEntity(idx, 'Rack R12').map(e => e.id), ['r12', 'pdu_a']);
});

test('search_memory ranks by keywords and respects since', () => {
  const r = runTool(idx, 'search_memory', { query: 'PSU2 fault' }) as any;
  assert.equal(r.matches[0].event, 'e3');
  assert.equal(r.matches[0].changes[0], 'PDU A (Rack R12) PSU2 status: OK -> FAULT');
  const late = runTool(idx, 'search_memory', { query: 'PSU2', since: (T0 + min(30)).toString() }) as any;
  assert.deepEqual(late.matches.map((m: any) => m.event), ['e3']);
  assert.equal((runTool(idx, 'search_memory', { query: 'unicorn' }) as any).matches.length, 0);
  assert.ok((runTool(idx, 'search_memory', {}) as any).error);
});

test('get_timeline segments on place change and gaps over 20 minutes', () => {
  const segs = segments(idx, 0n, idx.now);
  assert.deepEqual(segs.map(s => [s.title, s.eventIds.length]), [['Cold Aisle 3, Maria', 2], ['Cold Aisle 3, Maria', 1], ['Row 1 end, Dev', 1]]);
  const r = runTool(idx, 'get_timeline', {}) as any;
  assert.equal(r.episodes.length, 3);
  assert.equal(r.episodes[0].first_event, 'e1');
});

test('what_changed, explain_change and find_object use entity matching', () => {
  const w = runTool(idx, 'what_changed', { entity: 'pdu-a' }) as any;
  assert.equal(w.changes.length, 1);
  assert.equal(w.changes[0].event, 'e3');
  assert.equal(w.seen_in_photos, 2);
  assert.equal(w.last_seen.event, 'e3');
  assert.ok((runTool(idx, 'what_changed', { entity: 'nothing' }) as any).error);
  const x = runTool(idx, 'explain_change', { entity: 'Rack R12' }) as any;
  assert.equal(x.changes.length, 0);
  assert.equal(x.current.event, 'e3');
  const f = runTool(idx, 'find_object', { name: 'CRAC-2' }) as any;
  assert.equal(f.last_seen.event, 'e4');
  assert.equal(f.times_seen, 1);
});

test('current context, provenance by prefix, open alerts, handoff', () => {
  const c = runTool(idx, 'get_current_context', {}) as any;
  assert.equal(c.latest.event, 'e4');
  assert.equal(c.minutes_ago, 10);
  assert.equal(c.open_alerts.length, 1);
  const p = runTool(idx, 'get_provenance', { id: 'e3' }) as any;
  assert.deepEqual(p.text_read, ['PDU-A', 'PSU2 FAULT']);
  assert.equal(p.alerts[0].text, 'PSU2 status: OK -> FAULT');
  assert.ok((runTool(idx, 'get_provenance', { id: 'zz' }) as any).error);
  assert.equal((runTool(idx, 'list_open_alerts', {}) as any).open[0].asset, 'PDU A (Rack R12)');
  const h = runTool(idx, 'summarize_handoff', {}) as any;
  assert.equal(h.source, 'graph');
  assert.match(h.handoff, /NEEDS ATTENTION\nPDU A \(Rack R12\): PSU2 status: OK -> FAULT/);
  assert.match(h.handoff, /Dev: Handoff: watch PDU-A \[event:e4\]/);
  const cached = makeIndex(idx.now, events, entities, alerts, [], 'CACHED TEXT');
  assert.deepEqual(runTool(cached, 'summarize_handoff', {}), { handoff: 'CACHED TEXT', source: 'cached' });
  assert.ok((runTool(idx, 'nope', {}) as any).error);
});

test('tool results are bounded and surface event ids', () => {
  const big = { matches: Array.from({ length: 200 }, (_, i) => ({ event: 'e' + i, summary: 'x'.repeat(100) })) };
  const s = toolResultJson(big);
  assert.ok(s.length <= 6000 && s.endsWith('"truncated":true}'));
  const known = new Set(['e1', 'e2', 'e3', 'e4']);
  assert.deepEqual(eventIdsIn(runTool(idx, 'get_timeline', {}), known), ['e1', 'e2', 'e3', 'e4']);
  assert.deepEqual(eventIdsIn({ nested: { list: [{ event: 'e3' }, { event: 'bogus' }] } }, known), ['e3']);
});

test('answers are stripped of markdown and grounded', () => {
  assert.equal(stripMarkdown('## Status\n**PSU2** went to `FAULT`\n* item'), 'Status\nPSU2 went to FAULT\n- item');
  const g = groundCitations('PSU2 faulted [event:e3] and [event:zzz]. Later fine [event:e4, event:e9]', new Set(['e3', 'e4']));
  assert.deepEqual(g.citations, ['e3', 'e4']);
  assert.equal(g.text, 'PSU2 faulted [event:e3] and . Later fine [event:e4]');
  const bare = groundCitations('First event synth-x-01, last synth-x-07. Also [event:synth-x-07].', new Set(['synth-x-01', 'synth-x-07', 'synth-x-070']));
  assert.deepEqual(bare.citations, ['synth-x-07', 'synth-x-01']);
  assert.equal(bare.text, 'First event [event:synth-x-01], last [event:synth-x-07]. Also [event:synth-x-07].');
  assert.equal(groundCitations('Event: synth-x-07 [event:synth-x-07].', new Set(['synth-x-07'])).text, 'Event: [event:synth-x-07].');
  const fb = fallbackAnswer(idx, 'what happened to PDU-A');
  assert.match(fb.answer, /floor agent is unavailable/);
  assert.ok(fb.citations.includes('e3'));
});

test('wearer_rounds answers questions about a person on shift by name', () => {
  const r = runTool(idx, 'wearer_rounds', { wearer: 'dev' }) as any;
  assert.equal(r.wearer, 'Dev');
  assert.equal(r.photos, 1);
  assert.equal(r.last_seen.event, 'e4');
  assert.deepEqual(r.places, ['Row 1 end']);
  const m = runTool(idx, 'wearer_rounds', { wearer: 'Maria', since: (T0 + min(30)).toString() }) as any;
  assert.equal(m.photos, 1);
  assert.equal(m.last_seen.event, 'e3');
  assert.ok((runTool(idx, 'wearer_rounds', { wearer: 'Nobody' }) as any).error);
  assert.equal((runTool(idx, 'search_memory', { query: 'Dev' }) as any).matches[0].event, 'e4');
});
