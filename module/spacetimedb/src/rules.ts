// Pure helpers for perceive: no SpacetimeDB imports, so they can be tested with plain Node.
// Alert rule (#17), asset matching (#16), base64 decoding for image upload, cosine similarity.

export function slug(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

/** Uppercase alphanumerics only: "PDU-A", "pdu a", "PDU_A" all become "PDUA". */
export function squash(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// ---------- assets ----------

export interface AssetLike {
  assetId: string;
  name: string;
  patterns: string[];
}

export interface AssetMatch {
  assetId: string;
  matchedText: string;
  specificity: number; // length of the matched pattern; longer is a more specific match
}

/**
 * Match strings read in the scene (plus the wearer's label and object names) against the
 * asset registry. A pattern matches when its squashed form appears inside the squashed text,
 * so "PDU-A" matches "PDU A RACK R12". Patterns of 2 characters or fewer are ignored to
 * avoid accidental hits. A pattern wrapped in slashes is a case-insensitive regex.
 */
export function matchAssets(texts: string[], assets: AssetLike[]): AssetMatch[] {
  const out: AssetMatch[] = [];
  for (const a of assets) {
    const pats = [a.assetId, a.name, ...a.patterns].filter(p => typeof p === 'string' && p.trim());
    let best: AssetMatch | null = null;
    for (const text of texts) {
      if (typeof text !== 'string' || !text) continue;
      const st = squash(text);
      for (const p of pats) {
        let spec = 0;
        if (p.length > 2 && p.startsWith('/') && p.endsWith('/')) {
          try {
            const m = new RegExp(p.slice(1, -1), 'i').exec(text);
            if (m) spec = Math.max(3, squash(m[0]).length);
          } catch {
            /* bad regex in the registry: ignore */
          }
        } else {
          const sp = squash(p);
          if (sp.length > 2 && st.includes(sp)) spec = sp.length;
        }
        if (spec && (!best || spec > best.specificity)) best = { assetId: a.assetId, matchedText: text, specificity: spec };
      }
    }
    if (best) out.push(best);
  }
  // most specific first, so "PDU A (Rack R12)" resolves to the PDU, not the rack it names
  return out.sort((x, y) => y.specificity - x.specificity);
}

// ---------- alerts ----------

// Words that mean something is wrong on a panel, label, screen, or note.
export const FAULT_RE =
  /\b(FAULT(?:Y|ED)?|FAIL(?:ED|URE|ING)?|ALARM(?:ING)?|CRITICAL|OVER[- ]?TEMP(?:ERATURE)?|OVERHEAT(?:ING)?|OVERLOAD(?:ED)?|DEGRADED|TRIPPED|LEAK(?:ING)?|OFFLINE|DOWN|ERROR|ERR)\b/i;

// Values that mean "healthy"; a change from a FAULT_RE value to one of these is a recovery.
export const HEALTHY_RE = /\b(OK|OKAY|NORMAL|GOOD|ONLINE|UP|GREEN|HEALTHY|RUNNING|ACTIVE|READY|CLEAR(?:ED)?|NOMINAL|RESTORED|CLOSED|PASS(?:ED)?)\b/i;
// A wearer note that says the problem was dealt with.
export const FIXED_NOTE_RE = /\b(fixed|repaired|reset|resolved|replaced|swapped|reseated|back (?:on|online|up|to normal)|cleared|restored|working again)\b/i;

/** A change that takes an asset out of a fault state: "PSU2 FAULT" -> "PSU2 OK". */
export function isRecovery(from: string, to: string): boolean {
  return FAULT_RE.test(from) && !FAULT_RE.test(to) && HEALTHY_RE.test(to);
}

export interface ChangeLike {
  entity?: unknown;
  attr?: unknown;
  from?: unknown;
  to?: unknown;
}

export interface AnomalyLike {
  entity?: unknown;
  description?: unknown;
  severity?: unknown;
}

export interface AlertCandidate {
  kind: 'fault_text' | 'state_change' | 'anomaly';
  text: string;
  entity: string; // entity or asset name the alert is about, '' if unknown
  short?: string; // text without the entity name (state changes only)
}

/**
 * The alert rule from DESIGN.md §5: fault-like text read in the scene, a change into a
 * fault-like state, or a high-severity anomaly reported by perception.
 */
export function detectAlerts(
  textInScene: unknown[],
  changes: ChangeLike[],
  anomalies: AnomalyLike[]
): AlertCandidate[] {
  const out: AlertCandidate[] = [];
  const seen = new Set<string>();
  const push = (c: AlertCandidate) => {
    const k = squash(c.text);
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push(c);
  };

  for (const c of changes) {
    const to = String(c?.to ?? '');
    const from = String(c?.from ?? '');
    if (FAULT_RE.test(to) && !FAULT_RE.test(from)) {
      const entity = String(c?.entity ?? '');
      const attr = String(c?.attr ?? '');
      // `short` omits the entity, for when the alert is already filed under that entity's
      // asset: "PSU2 status: OK → FAULT" instead of "PDU-A PSU2 status: OK → FAULT".
      const change = `${from.trim() ? from.trim() + ' → ' : ''}${to.trim()}`;
      push({
        kind: 'state_change',
        entity,
        text: `${[entity, attr].filter(Boolean).join(' ')}: ${change}`,
        short: `${attr || entity}: ${change}`,
      });
    }
  }
  for (const t of textInScene) {
    if (typeof t !== 'string') continue;
    if (FAULT_RE.test(t)) push({ kind: 'fault_text', entity: '', text: t.trim() });
  }
  for (const a of anomalies) {
    if (String(a?.severity ?? '').toLowerCase() !== 'high') continue;
    const d = String(a?.description ?? '').trim();
    if (!d) continue;
    push({ kind: 'anomaly', entity: String(a?.entity ?? ''), text: d });
  }
  return out;
}

// ---------- misc ----------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = (() => {
  const m = new Int16Array(256).fill(-1);
  for (let i = 0; i < B64.length; i++) m[B64.charCodeAt(i)] = i;
  m['-'.charCodeAt(0)] = 62; // base64url
  m['_'.charCodeAt(0)] = 63;
  return m;
})();

/** Decode standard or url-safe base64 (whitespace and padding tolerated). */
export function base64ToBytes(b64: string): Uint8Array {
  const out = new Uint8Array(Math.floor((b64.length * 3) / 4) + 3);
  let buf = 0;
  let bits = 0;
  let n = 0;
  for (let i = 0; i < b64.length; i++) {
    const v = B64_LOOKUP[b64.charCodeAt(i) & 0xff];
    if (v < 0) continue; // '=', whitespace, data-URL junk
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (buf >> bits) & 0xff;
    }
  }
  return out.slice(0, n);
}

export function cosine(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Pull the first {...} JSON object out of a model reply (tolerates ```json fences and prose). */
export function parseJsonObject(content: string): any {
  const s = content.indexOf('{');
  const e = content.lastIndexOf('}');
  if (s < 0 || e <= s) throw new Error('no_json_object');
  return JSON.parse(content.slice(s, e + 1));
}

const KIND_RANK: Record<string, number> = { state_change: 0, fault_text: 1, anomaly: 2 };

/**
 * The lines an alert shows: concrete findings first (state changes, then text read on the
 * equipment); prose anomalies only when there is nothing concrete. Near-duplicates dropped.
 */
export function summarizeFindings(items: { kind: string; text: string }[], max = 3): string[] {
  const concrete = items.some(i => i.kind !== 'anomaly');
  const sorted = items
    .filter(i => !concrete || i.kind !== 'anomaly')
    .sort((a, b) => (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9));
  const out: string[] = [];
  const keys: string[] = [];
  for (const i of sorted) {
    const k = squash(i.text);
    if (!k || keys.some(x => x.includes(k) || k.includes(x))) continue;
    keys.push(k);
    out.push(i.text);
    if (out.length >= max) break;
  }
  return out;
}

// ---------- time ----------

/** "14:32 CT": the venue is in Dallas; CST (UTC-6) after 2026-11-01. */
export function clockCT(micros: bigint): string {
  const d = new Date(Number(micros / 1000n) - 6 * 3600 * 1000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} CT`;
}

export function microsFromIso(s: string): bigint | null {
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? BigInt(Math.round(ms)) * 1000n : null;
}

/**
 * A handoff window start. '' means since the last handoff (null); '0' the whole record;
 * digits are micros (>= 15 digits), millis (>= 12) or seconds; '2h' / '45m' / '1d' are
 * relative to now; anything else is parsed as ISO-8601; unparseable means ''.
 */
export function parseSinceArg(s: string, now: bigint): bigint | null {
  const v = (s ?? '').trim();
  if (!v) return null;
  if (/^\d+$/.test(v)) {
    if (v === '0') return 0n;
    if (v.length >= 15) return BigInt(v);
    if (v.length >= 12) return BigInt(v) * 1000n;
    return BigInt(v) * 1_000_000n;
  }
  const rel = /^(\d+)\s*([mhd])$/i.exec(v);
  if (rel) {
    const unit = { m: 60n, h: 3600n, d: 86400n }[rel[2].toLowerCase() as 'm' | 'h' | 'd'];
    return now - BigInt(rel[1]) * unit * 1_000_000n;
  }
  return microsFromIso(v);
}

// ---------- handoff text ----------

export interface HEvent {
  id: string;
  t: bigint;
  wearer: string;
  assets: string[];
  place: string;
  summary: string;
  note: string;
  label: string;
  changes: string[];
}
export interface HAlert {
  t: bigint;
  open: boolean;
  asset: string;
  text: string;
  eventId: string;
  wearer: string;
  resolvedBy?: string; // event that closed it, when recorded
}
export interface HIssue {
  id: string;
  title: string;
  asset: string;
  status: string; // open | in_progress | resolved
  openedBy: string;
  resolvedEventId: string;
  resolutionNote: string;
}
export interface HandoffSnap {
  sinceMicros: bigint;
  anchor: string;
  events: HEvent[];
  alerts: HAlert[];
  total: number;
  issues?: HIssue[]; // work orders: open ones however old, resolved ones in the window
}

export const cite = (id: string) => `[event:${id}]`;
export const MODEL_SECTIONS = ['SUMMARY', 'ROUNDS'] as const; // what the model writes; the facts sections come from the graph
const HEADER_RE = new RegExp(`^(${MODEL_SECTIONS.join('|')})\\s*:?\\s*(.*)$`, 'i');

/** Wearer notes, close to verbatim, Handoff: notes first. */
export function notesLines(snap: HandoffSnap): string[] {
  const isHandoff = (e: HEvent) => (e.note.trim().startsWith('Handoff:') ? 1 : 0);
  const notes = snap.events.filter(e => e.note.trim()).sort((a, b) => isHandoff(b) - isHandoff(a));
  return notes.length ? notes.map(e => `${e.wearer}: ${e.note.trim()} ${cite(e.id)}`) : ['none'];
}

/** Assets seen in the window with no open alert and no recorded change. */
export function quietLines(snap: HandoffSnap): string[] {
  const flagged = new Set<string>([...snap.alerts.filter(a => a.open).map(a => a.asset), ...snap.events.filter(e => e.changes.length).flatMap(e => e.assets)]);
  const quiet: string[] = [];
  for (const e of snap.events) for (const a of e.assets) if (!flagged.has(a) && !quiet.includes(a)) quiet.push(a);
  if (!quiet.length) return ['none'];
  const cites = snap.events.filter(e => e.assets.some(a => quiet.includes(a))).slice(-3).map(e => cite(e.id));
  return [`${quiet.join(', ')} ${cites.join(' ')}`];
}

/** NEEDS ATTENTION from the graph: open alerts, then work orders still open or in progress. */
export function attentionLines(snap: HandoffSnap): string[] {
  const open = snap.alerts.filter(a => a.open);
  const openIssues = (snap.issues ?? []).filter(i => i.status !== 'resolved');
  const lines = [
    ...open.map(a => `${a.asset}: ${a.text} (${clockCT(a.t)}, ${a.wearer}) ${cite(a.eventId)}`),
    ...openIssues.map(i => `Work order ${i.id} ${i.status.replace('_', ' ')}: ${i.title} (${i.asset}, opened by ${i.openedBy}) [wo:${i.id}]`),
  ];
  return lines.length ? lines : ['none'];
}

/** WHAT CHANGED from the graph: change edges in time order, then alerts and work orders resolved in the window. */
export function changedLines(snap: HandoffSnap): string[] {
  const issues = snap.issues ?? [];
  const changed = snap.events.flatMap(e => e.changes.map(c => `${c} (${clockCT(e.t)}) ${cite(e.id)}`));
  const resolved = [
    ...snap.alerts.filter(a => !a.open).map(a => `${a.asset}: ${a.text} (${clockCT(a.t)}), resolved ${cite(a.resolvedBy || a.eventId)}`),
    ...issues.filter(i => i.status === 'resolved').map(i => `Work order ${i.id} resolved: ${i.title}${i.resolutionNote ? ', ' + i.resolutionNote : ''}${i.resolvedEventId ? ' ' + cite(i.resolvedEventId) : ` [wo:${i.id}]`}`),
  ];
  const lines = [...changed, ...resolved];
  return lines.length ? lines : ['none'];
}

/** ROUNDS from the graph, one line per wearer; used when the models fail. */
export function roundsLines(snap: HandoffSnap): string[] {
  const byWearer = new Map<string, HEvent[]>();
  for (const e of snap.events) {
    if (!byWearer.has(e.wearer)) byWearer.set(e.wearer, []);
    byWearer.get(e.wearer)!.push(e);
  }
  const L: string[] = [];
  for (const [w, evs] of byWearer) {
    // distinct assets, then distinct places; a place that contains one already listed is the same area
    const assets: string[] = [];
    const places: string[] = [];
    for (const e of evs) {
      for (const n of e.assets) if (n && !assets.includes(n)) assets.push(n);
      if (e.place) {
        const dup = places.findIndex(x => samePlace(x, e.place));
        if (dup < 0) places.push(e.place);
        else if (e.place.length < places[dup].length) places[dup] = e.place; // keep the more general name
      }
    }
    const seen = [...assets, ...places];
    const first = evs[0];
    const last = evs[evs.length - 1];
    const cites = first === last ? cite(first.id) : `${cite(first.id)} ${cite(last.id)}`;
    const span = first === last ? clockCT(first.t) : `${clockCT(first.t)} to ${clockCT(last.t)}`;
    L.push(`${w}: ${evs.length} photo${evs.length === 1 ? '' : 's'} ${span}${seen.length ? ', ' + seen.join(', ') : ''} ${cites}`);
  }
  return L.length ? L : ['none'];
}

/** A plain SUMMARY line when the model wrote none. */
export function plainSummary(snap: HandoffSnap): string[] {
  const open = snap.alerts.filter(a => a.open).length;
  const wo = (snap.issues ?? []).filter(i => i.status !== 'resolved').length;
  const fixed = snap.alerts.filter(a => !a.open).length + (snap.issues ?? []).filter(i => i.status === 'resolved').length;
  return [`${snap.events.length} photos since ${snap.anchor}; ${open} open alert${open === 1 ? '' : 's'}, ${wo} work order${wo === 1 ? '' : 's'} outstanding, ${fixed} resolved.`];
}

/** Kept for callers that want the whole handoff from the graph alone. */
export function graphSections(snap: HandoffSnap): string[] {
  return ['NEEDS ATTENTION', ...attentionLines(snap), '', 'WHAT CHANGED', ...changedLines(snap), '', 'ROUNDS', ...roundsLines(snap)];
}

/**
 * Keep only what the model was allowed to write: the three section headers, "none", and
 * lines that cite at least one known event id (unknown ids are dropped from a line; a line
 * left with no citation is dropped). Returns null when a section is missing or nothing
 * grounded survives, so the caller falls back to the graph.
 */
export function groundModelSections(text: string, known: Set<string>, knownWorkOrders: Set<string> = new Set()): string[] | null {
  const out: string[] = [];
  const present = new Set<string>();
  let current = '';
  let bodyLines = 0;
  const woUpper = new Map([...knownWorkOrders].map(id => [id.toUpperCase(), id]));
  for (const raw of text.split('\n')) {
    let line = raw.replace(/^[\s\-*•]+/, '').trim();
    if (!line) continue;
    // "SUMMARY" alone, "SUMMARY:", or "SUMMARY: first line" all open the section
    const m = HEADER_RE.exec(line);
    const header = m ? m[1].toUpperCase() : '';
    if (header) {
      if (!present.has(header)) {
        present.add(header);
        current = header;
        if (out.length) out.push('');
        out.push(header);
      }
      line = (m![2] ?? '').trim();
      if (!line) continue;
    }
    if (!current) continue;
    if (/^none\.?$/i.test(line)) {
      out.push('none');
      continue;
    }
    let ok = 0;
    const cleaned = line
      .replace(/\[event:([^\]]+)\]/g, (_m, inner: string) => {
        const ids = inner.split(/[\s,]+/).map(x => x.replace(/^event:/, '')).filter(x => x && x !== 'through' && x !== 'to' && x !== 'and');
        const parts: string[] = [];
        for (const id of ids) {
          if (known.has(id)) parts.push(cite(id));
          else if (woUpper.has(id.toUpperCase())) parts.push(`[wo:${woUpper.get(id.toUpperCase())}]`); // a work order filed as an event
          else continue;
          ok++;
        }
        return parts.join(' ');
      })
      .replace(/\[wo:([^\]]+)\]/g, (_m, inner: string) => {
        // a work order has no photo of its own; its id is the citation
        const good = inner.split(/[\s,]+/).map(x => x.replace(/^wo:/i, '')).map(x => woUpper.get(x.toUpperCase())).filter((x): x is string => !!x);
        ok += good.length;
        return good.map(id => `[wo:${id}]`).join(' ');
      });
    if (!ok) continue;
    out.push(cleaned.replace(/\s{2,}/g, ' ').trim());
    bodyLines++;
  }
  if (present.size !== MODEL_SECTIONS.length || bodyLines === 0) return null;
  // a section whose lines were all dropped gets "none"
  const final: string[] = [];
  for (let i = 0; i < out.length; i++) {
    final.push(out[i]);
    const isHeader = (MODEL_SECTIONS as readonly string[]).includes(out[i]);
    const next = out[i + 1];
    if (isHeader && (next === undefined || next === '' || (MODEL_SECTIONS as readonly string[]).includes(next))) final.push('none');
  }
  return final;
}

/** Lines under one section header in a grounded model output. */
export function sectionLines(sections: string[], header: string): string[] {
  const i = sections.indexOf(header);
  if (i < 0) return [];
  const out: string[] = [];
  for (let k = i + 1; k < sections.length && sections[k] !== '' && !(MODEL_SECTIONS as readonly string[]).includes(sections[k]); k++) out.push(sections[k]);
  return out;
}

/**
 * The model's summary paragraph, grounded sentence by sentence: a sentence stays only if it
 * cites a known event or work order; unknown citations are removed; markdown, bullets and a
 * leading "SUMMARY:" are stripped. Returns null when nothing cited survives.
 */
export function groundSummary(text: string, known: Set<string>, knownWorkOrders: Set<string> = new Set()): string[] | null {
  const woUpper = new Map([...knownWorkOrders].map(id => [id.toUpperCase(), id]));
  const body = text
    .replace(/\*\*|__|`/g, '')
    .replace(/^\s*(summary|rounds)\s*:?\s*/gim, '')
    .replace(/^[\s\-*•]+/gm, '');
  const sentences = body.split(/\n+|(?<=[.!?\]])\s+(?=[A-Z0-9])/).map(x => x.trim()).filter(Boolean);
  const out: string[] = [];
  for (const sentence of sentences) {
    let ok = 0;
    const cleaned = sentence
      .replace(/\[(?:event|wo):([^\]]+)\]/gi, (_m, inner: string) => {
        const parts: string[] = [];
        for (const raw of inner.split(/[\s,]+/)) {
          const id = raw.replace(/^(event|wo):/i, '');
          if (!id) continue;
          if (known.has(id)) parts.push(cite(id));
          else if (woUpper.has(id.toUpperCase())) parts.push(`[wo:${woUpper.get(id.toUpperCase())}]`);
          else continue;
          ok++;
        }
        return parts.join(' ');
      })
      .replace(/\s{2,}/g, ' ')
      .replace(/\s+([.,;])/g, '$1')
      .trim();
    if (ok && cleaned.length > 3) out.push(cleaned);
  }
  // the same citation twice in a row reads once
  const lines = out.map(l => l.replace(/(\[(?:event|wo):[^\]]+\])(?:[ ,]+\1)+/g, '$1'));
  return lines.length ? [lines.join(' ')] : null;
}

/**
 * Full handoff text. Facts (NEEDS ATTENTION, WHAT CHANGED, ROUNDS, NOTES, QUIET) always come
 * from the graph; the model contributes the SUMMARY when it was grounded, else a plain count.
 */
export function assembleHandoff(summary: string[] | null, snap: HandoffSnap): string {
  return [
    'SUMMARY',
    ...(summary && summary.length ? summary : plainSummary(snap)),
    '',
    'NEEDS ATTENTION',
    ...attentionLines(snap),
    '',
    'WHAT CHANGED',
    ...changedLines(snap),
    '',
    'ROUNDS',
    ...roundsLines(snap),
    '',
    'NOTES FROM THE SHIFT',
    ...notesLines(snap),
    '',
    'QUIET',
    ...quietLines(snap),
  ].join('\n');
}

// ---------- episodes (#6) ----------

export interface SegEvent {
  id: string;
  t: bigint;
  place: string; // '' when no place was identified
  wearer: string;
  summary: string;
  embedding?: number[];
}
export interface Segment {
  start: bigint;
  end: bigint;
  place: string;
  wearers: string[];
  eventIds: string[];
  summaries: string[];
}
export const EPISODE_GAP_MICROS = 20n * 60n * 1_000_000n;
export const EPISODE_JUMP_COSINE = 0.3; // when no place is known, consecutive photos less similar than this are a scene change
export const NO_PLACE = 'no place identified';

/**
 * Split a shift into episodes: a new one starts on a place change, a gap over 20 minutes, or,
 * only while no place is identified, an image-embedding jump between consecutive photos (a
 * known shared place already says the photos belong together). The same rule serves the
 * module's segment procedure and the agent's timeline fallback.
 */
/** "Cold Aisle 3" and "Cold Aisle 3, Rack R12" are the same place: one name contains the other. */
export function samePlace(a: string, b: string): boolean {
  const x = squash(a);
  const y = squash(b);
  return x === y || (x.length > 2 && y.length > 2 && (x.includes(y) || y.includes(x)));
}

export function segmentEvents(events: SegEvent[]): Segment[] {
  const sorted = [...events].sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  const out: Segment[] = [];
  let cur: Segment | null = null;
  let prev: SegEvent | null = null;
  for (const e of sorted) {
    const place = e.place || NO_PLACE;
    const jump =
      place === NO_PLACE && prev && prev.embedding && prev.embedding.length && e.embedding && e.embedding.length ? cosine(prev.embedding, e.embedding) < EPISODE_JUMP_COSINE : false;
    if (!cur || !samePlace(cur.place, place) || e.t - cur.end > EPISODE_GAP_MICROS || jump) {
      cur = { start: e.t, end: e.t, place, wearers: [], eventIds: [], summaries: [] };
      out.push(cur);
    }
    // the episode is named after its most general place
    if (place !== NO_PLACE && (cur.place === NO_PLACE || place.length < cur.place.length)) cur.place = place;
    cur.end = e.t;
    cur.eventIds.push(e.id);
    if (!cur.wearers.includes(e.wearer)) cur.wearers.push(e.wearer);
    if (e.summary) cur.summaries.push(e.summary);
    prev = e;
  }
  return out;
}

/** Title and summary for an episode when no model is available. */
export function plainEpisodeTitle(s: Segment): { title: string; summary: string } {
  return { title: `${s.place}, ${s.wearers.join(', ')}`, summary: s.summaries.slice(0, 2).join(' ') };
}
