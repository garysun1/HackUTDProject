// Run: node --experimental-strip-types --test test/rules.test.ts   (from module/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchAssets, detectAlerts, base64ToBytes, cosine, parseJsonObject, squash } from '../spacetimedb/src/rules.ts';

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
