// Run: node --experimental-strip-types --test test/rules.test.ts   (from module/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchAssets, detectAlerts, base64ToBytes, cosine, parseJsonObject, squash, summarizeFindings } from '../spacetimedb/src/rules.ts';

const assets = [
  { assetId: 'PDU-A', name: 'PDU A (Rack R12)', patterns: ['R12 PDU'] },
  { assetId: 'CRAC-2', name: 'CRAC unit 2', patterns: ['/crac\\s*0?2/'] },
  { assetId: 'R12', name: 'Rack R12', patterns: [] },
];

test('asset matching tolerates punctuation and spacing', () => {
  const m = matchAssets(['PDU A  RACK R12', 'PSU2: FAULT'], assets);
  assert.deepEqual(m.map(x => x.assetId).sort(), ['PDU-A', 'R12']);
});

test('asset regex patterns', () => {
  assert.equal(matchAssets(['Crac 02 return air 24C'], assets)[0].assetId, 'CRAC-2');
});

test('short patterns never match', () => {
  assert.deepEqual(matchAssets(['A1 B2'], [{ assetId: 'A1', name: '', patterns: [] }]), []);
});

test('fault text raises an alert; healthy text does not', () => {
  const a = detectAlerts(['PSU2: FAULT', 'LOAD 11.8 kW', 'PSU1: OK'], [], []);
  assert.equal(a.length, 1);
  assert.equal(a[0].kind, 'fault_text');
  assert.equal(a[0].text, 'PSU2: FAULT');
  assert.equal(detectAlerts(['DEFAULT GATEWAY 10.0.0.1', 'Downstream port 4'], [], []).length, 0);
});

test('OK -> FAULT change raises a state_change alert; FAULT -> FAULT does not', () => {
  const a = detectAlerts([], [{ entity: 'PSU2', attr: 'status', from: 'OK', to: 'FAULT' }], []);
  assert.equal(a.length, 1);
  assert.equal(a[0].kind, 'state_change');
  assert.match(a[0].text, /PSU2 status: OK → FAULT/);
  assert.equal(detectAlerts([], [{ entity: 'PSU2', attr: 'status', from: 'FAULT', to: 'FAULT' }], []).length, 0);
  assert.equal(detectAlerts([], [{ entity: 'load', attr: 'kW', from: '10.9', to: '11.8' }], []).length, 0);
});

test('only high-severity anomalies alert', () => {
  const a = detectAlerts([], [], [
    { entity: 'cable', description: 'loose patch cable', severity: 'low' },
    { entity: 'floor', description: 'water pooling under rack', severity: 'high' },
  ]);
  assert.deepEqual(a.map(x => x.text), ['water pooling under rack']);
});

test('duplicate alert texts collapse', () => {
  assert.equal(detectAlerts(['PSU2: FAULT', 'psu2 fault'], [], []).length, 1);
});

test('base64 round trip incl. url-safe and whitespace', () => {
  const bytes = new Uint8Array(1000).map((_, i) => (i * 37) & 0xff);
  const b64 = Buffer.from(bytes).toString('base64');
  assert.deepEqual(base64ToBytes(b64), bytes);
  assert.deepEqual(base64ToBytes(Buffer.from(bytes).toString('base64url')), bytes);
  assert.deepEqual(base64ToBytes(b64.replace(/(.{76})/g, '$1\n')), bytes);
});

test('cosine and JSON extraction', () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([], []), 0);
  assert.deepEqual(parseJsonObject('```json\n{"a": {"b": 1}}\n```'), { a: { b: 1 } });
  assert.equal(squash('PDU-a 1'), 'PDUA1');
});

test('alert summary: concrete first, anomalies only as a last resort, near-duplicates dropped', () => {
  const lines = summarizeFindings([
    { kind: 'anomaly', text: 'PSU2 fault indicated' },
    { kind: 'fault_text', text: 'PSU2: FAULT' },
    { kind: 'state_change', text: 'PSU2 status: OK → FAULT' },
    { kind: 'fault_text', text: 'TEMP 41C OVERTEMP' },
    { kind: 'state_change', text: 'temperature: 27C → 41C OVERTEMP' },
  ]);
  assert.deepEqual(lines, ['PSU2 status: OK → FAULT', 'temperature: 27C → 41C OVERTEMP', 'PSU2: FAULT']);
  assert.deepEqual(summarizeFindings([{ kind: 'anomaly', text: 'water under rack' }]), ['water under rack']);
});

// ---------- handoff helpers (#8) ----------
import { parseSinceArg, clockCT, groundModelSections, groundSummary, graphSections, assembleHandoff, notesLines, quietLines, sectionLines } from '../spacetimedb/src/rules.ts';

const NOW = 1794100000000000n; // 2026-11-07T23:46:40Z

test('parseSinceArg accepts the forms the console and MCP send', () => {
  assert.equal(parseSinceArg('', NOW), null); // since the last handoff
  assert.equal(parseSinceArg('0', NOW), 0n); // whole record
  assert.equal(parseSinceArg('1794084000000000', NOW), 1794084000000000n); // micros (web)
  assert.equal(parseSinceArg('1794084000000', NOW), 1794084000000000n); // millis
  assert.equal(parseSinceArg('1794084000', NOW), 1794084000000000n); // seconds
  assert.equal(parseSinceArg('2h', NOW), NOW - 7200n * 1_000_000n);
  assert.equal(parseSinceArg('45 m', NOW), NOW - 2700n * 1_000_000n);
  assert.equal(parseSinceArg('2026-11-07T22:00:00-06:00', NOW), 1794110400000000n);
  assert.equal(parseSinceArg('garbage', NOW), null);
  assert.equal(clockCT(1794110400000000n), '22:00 CT');
});

const snap = {
  sinceMicros: 0n,
  anchor: 'the start of the record',
  total: 3,
  events: [
    { id: 'e1', t: 1794110400000000n, wearer: 'Maria', assets: ['PDU A (Rack R12)', 'Rack R12'], place: 'Cold Aisle 3', summary: 'PDU-A OK', note: '', label: '', changes: [] },
    { id: 'e2', t: 1794112200000000n, wearer: 'Maria', assets: ['PDU A (Rack R12)'], place: 'Cold Aisle 3', summary: 'PDU-A FAULT', note: 'reseated PSU2', label: '', changes: ['PDU A (Rack R12) status: OK -> FAULT'] },
    { id: 'e3', t: 1794113400000000n, wearer: 'Dev', assets: ['UPS 1'], place: '', summary: 'UPS online', note: 'Handoff: watch PDU-A tonight', label: '', changes: [] },
  ],
  alerts: [
    { t: 1794112200000000n, open: true, asset: 'PDU A (Rack R12)', text: 'PSU2 FAULT', eventId: 'e2', wearer: 'Maria' },
    { t: 1794100000000000n, open: false, asset: 'CRAC unit 2', text: 'OVERTEMP', eventId: 'e0', wearer: 'Dev' },
  ],
};

test('notes lead with Handoff:, quiet excludes alerted and changed assets', () => {
  assert.deepEqual(notesLines(snap), ['Dev: Handoff: watch PDU-A tonight [event:e3]', 'Maria: reseated PSU2 [event:e2]']);
  assert.deepEqual(quietLines(snap), ['Rack R12, UPS 1 [event:e1] [event:e3]']);
  assert.deepEqual(notesLines({ ...snap, events: [snap.events[0]] }), ['none']);
});

test('graph sections cite every line and group rounds by wearer', () => {
  const text = assembleHandoff(null, snap);
  assert.match(text, /^SUMMARY\n3 photos since the start of the record; 1 open alert, 0 work orders outstanding, 1 resolved\./);
  const lines = text.split('\n').filter(l => l && !/^[A-Z ]+$/.test(l) && l !== 'none' && !l.startsWith('3 photos since'));
  for (const l of lines) assert.match(l, /\[event:[^\]]+\]|\[wo:[^\]]+\]/, l);
  assert.match(text, /NEEDS ATTENTION\nPDU A \(Rack R12\): PSU2 FAULT \(22:30 CT, Maria\) \[event:e2\]/);
  assert.match(text, /CRAC unit 2: OVERTEMP \(19:06 CT\), resolved \[event:e0\]/);
  const withResolver = assembleHandoff(null, { ...snap, alerts: [{ ...snap.alerts[1], resolvedBy: 'e3' }] });
  assert.match(withResolver, /CRAC unit 2: OVERTEMP \(19:06 CT\), resolved \[event:e3\]/);
  assert.match(text, /Maria: 2 photos 22:00 CT to 22:30 CT, PDU A \(Rack R12\), Rack R12, Cold Aisle 3 \[event:e1\] \[event:e2\]/);
  // nested places collapse to the most general name in rounds
  const nested = assembleHandoff(null, { ...snap, events: [{ ...snap.events[0], place: 'Cold Aisle 3, Row R12' }, { ...snap.events[1], place: 'Cold Aisle 3' }] });
  assert.match(nested, /Maria: 2 photos 22:00 CT to 22:30 CT, PDU A \(Rack R12\), Rack R12, Cold Aisle 3 \[event:e1\] \[event:e2\]/);
  assert.match(text, /Dev: 1 photo 22:50 CT, UPS 1 \[event:e3\]/);
});

test('model output is grounded: bullets stripped, ranges split, unknown ids dropped, uncited lines dropped', () => {
  const known = new Set(['e1', 'e2', 'e3']);
  const model = [
    'SUMMARY',
    '- PDU A faulted on R12 and needs eyes first [event:e2]',
    'Something I made up with no citation',
    '',
    'ROUNDS:',
    '* Maria walked the aisle [event:e1 through event:e3] [event:zzz]',
    'Dev checked UPS [event:nope]',
  ].join('\n');
  const g2 = groundModelSections(model, known);
  assert.deepEqual(g2, ['SUMMARY', 'PDU A faulted on R12 and needs eyes first [event:e2]', '', 'ROUNDS', 'Maria walked the aisle [event:e1] [event:e3]']);
  assert.deepEqual(sectionLines(g2!, 'ROUNDS'), ['Maria walked the aisle [event:e1] [event:e3]']);
  // a section emptied by grounding reads none; a missing section rejects the whole text
  assert.deepEqual(groundModelSections('SUMMARY\nfake [event:q]\nROUNDS\nok [event:e1]', known), ['SUMMARY', 'none', '', 'ROUNDS', 'ok [event:e1]']);
  assert.equal(groundModelSections('SUMMARY\nx [event:e1]', known), null);
  assert.equal(groundModelSections('SUMMARY\nnone\nROUNDS\nnone', known), null);
  // inline headers and work orders filed as events
  assert.deepEqual(groundModelSections('SUMMARY: fixed PDU [event:e3] [event:wo-7]\nROUNDS: Maria walked [event:e1]', known, new Set(['WO-7'])),
    ['SUMMARY', 'fixed PDU [event:e3] [wo:WO-7]', '', 'ROUNDS', 'Maria walked [event:e1]']);
  // work orders cite their own id; unknown ones are dropped
  assert.deepEqual(groundModelSections('SUMMARY\nCRAC-2 work order still open [wo:WO-1043] [wo:WO-9]\nROUNDS\nok [event:e1]', known, new Set(['WO-1043'])),
    ['SUMMARY', 'CRAC-2 work order still open [wo:WO-1043]', '', 'ROUNDS', 'ok [event:e1]']);
  // the summary paragraph: cited sentences survive, uncited ones go, headings and markdown are stripped
  const sum = groundSummary('SUMMARY: **PDU A** faulted on R12 and needs eyes first [event:e2]. Everything else was fine. CRAC-2 work order is still open [wo:wo-7] [event:nope]. Dev left a note [event:e3] [event:e3].', known, new Set(['WO-7']));
  assert.deepEqual(sum, ['PDU A faulted on R12 and needs eyes first [event:e2]. CRAC-2 work order is still open [wo:WO-7]. Dev left a note [event:e3].']);
  assert.equal(groundSummary('All clear, nothing to report.', known), null);
  const full = assembleHandoff(sum, snap);
  assert.match(full, /^SUMMARY\nPDU A faulted on R12 and needs eyes first \[event:e2\]\. CRAC-2 work order is still open \[wo:WO-7\]\. Dev left a note \[event:e3\]\.\n\nNEEDS ATTENTION\nPDU A \(Rack R12\): PSU2 FAULT/);
  assert.match(full, /ROUNDS\nMaria: 2 photos 22:00 CT to 22:30 CT, PDU A \(Rack R12\), Rack R12, Cold Aisle 3 \[event:e1\] \[event:e2\]\nDev: 1 photo 22:50 CT, UPS 1 \[event:e3\]\n\nNOTES FROM THE SHIFT/);
});

test('the most specific asset wins when a name mentions several', () => {
  const regs = [{ assetId: 'R12', name: 'Rack R12', patterns: [] }, { assetId: 'PDU-A', name: 'PDU A (Rack R12)', patterns: [] }];
  assert.deepEqual(matchAssets(['PDU A (Rack R12)'], regs).map(x => x.assetId), ['PDU-A', 'R12']);
  assert.deepEqual(matchAssets(['RACK R12'], regs).map(x => x.assetId), ['R12']);
});

// ---------- episodes (#6) ----------
import { segmentEvents, plainEpisodeTitle, isRecovery, FIXED_NOTE_RE } from '../spacetimedb/src/rules.ts';

test('episodes split on place change, long gaps and embedding jumps', () => {
  const m = (n: number) => 1794110400000000n + BigInt(n) * 60_000_000n;
  const segs = segmentEvents([
    { id: 'a', t: m(0), place: 'Cold Aisle 3', wearer: 'Maria', summary: 'sign', embedding: [1, 0] },
    { id: 'b', t: m(5), place: 'Cold Aisle 3, Rack R12', wearer: 'Maria', summary: 'rack', embedding: [0.9, 0.1] }, // nested place: same episode
    { id: 'c', t: m(8), place: 'Cold Aisle 3', wearer: 'Dev', summary: 'pdu', embedding: [0, 1] }, // dissimilar, but the place is known: same episode
    { id: 'd', t: m(9), place: '', wearer: 'Dev', summary: 'cable', embedding: [0, 1] }, // place change to unknown
    { id: 'e', t: m(10), place: '', wearer: 'Dev', summary: 'ups', embedding: [1, 0] }, // no place: embedding jump splits
    { id: 'f', t: m(40), place: '', wearer: 'Dev', summary: '' }, // gap
  ].reverse());
  assert.deepEqual(segs.map(s => s.eventIds), [['a', 'b', 'c'], ['d'], ['e'], ['f']]);
  assert.deepEqual(segs[0].wearers, ['Maria', 'Dev']);
  assert.equal(segs[0].place, 'Cold Aisle 3');
  assert.equal(segs[1].place, 'no place identified');
  assert.deepEqual(plainEpisodeTitle(segs[2]), { title: 'no place identified, Dev', summary: 'ups' });
});

test('recovery and fixed-note signals (#23)', () => {
  assert.equal(isRecovery('PSU2 FAULT', 'PSU2 OK'), true);
  assert.equal(isRecovery('FAULT', 'normal'), true);
  assert.equal(isRecovery('OK', 'FAULT'), false);
  assert.equal(isRecovery('FAULT', 'FAULT'), false);
  assert.equal(isRecovery('10.9 kW', '11.8 kW'), false);
  assert.equal(isRecovery('FAULT', 'unknown'), false);
  assert.equal(FIXED_NOTE_RE.test('Swapped PSU2 under INC-4821; PDU-A back to normal'), true);
  assert.equal(FIXED_NOTE_RE.test('still faulting, parts on order'), false);
  const withIssues = assembleHandoff(null, { ...snap, issues: [
    { id: 'WO-1', title: 'CRAC-2 high return temp', asset: 'CRAC unit 2', status: 'open', openedBy: 'Dana', resolvedEventId: '', resolutionNote: '' },
    { id: 'WO-2', title: 'PDU A breaker tripped', asset: 'PDU A (Rack R12)', status: 'resolved', openedBy: 'Dana', resolvedEventId: 'e3', resolutionNote: 'reset' },
  ] });
  assert.match(withIssues, /Work order WO-1 open: CRAC-2 high return temp \(CRAC unit 2, opened by Dana\) \[wo:WO-1\]/);
  assert.match(withIssues, /Work order WO-2 resolved: PDU A breaker tripped, reset \[event:e3\]/);
});
