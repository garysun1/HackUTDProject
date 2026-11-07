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
}

/**
 * Match strings read in the scene (plus the wearer's label and object names) against the
 * asset registry. A pattern matches when its squashed form appears inside the squashed text,
 * so "PDU-A" matches "PDU A RACK R12". Patterns of 2 characters or fewer are ignored to
 * avoid accidental hits. A pattern wrapped in slashes is a case-insensitive regex.
 */
export function matchAssets(texts: string[], assets: AssetLike[]): AssetMatch[] {
  const out: AssetMatch[] = [];
  const seen = new Set<string>();
  for (const a of assets) {
    const pats = [a.assetId, a.name, ...a.patterns].filter(p => typeof p === 'string' && p.trim());
    let hit: string | null = null;
    for (const text of texts) {
      if (typeof text !== 'string' || !text) continue;
      for (const p of pats) {
        if (p.length > 2 && p.startsWith('/') && p.endsWith('/')) {
          try {
            if (new RegExp(p.slice(1, -1), 'i').test(text)) hit = text;
          } catch {
            /* bad regex in the registry: ignore */
          }
        } else {
          const sp = squash(p);
          if (sp.length > 2 && squash(text).includes(sp)) hit = text;
        }
        if (hit) break;
      }
      if (hit) break;
    }
    if (hit && !seen.has(a.assetId)) {
      seen.add(a.assetId);
      out.push({ assetId: a.assetId, matchedText: hit });
    }
  }
  return out;
}

// ---------- alerts ----------

// Words that mean something is wrong on a panel, label, screen, or note.
export const FAULT_RE =
  /\b(FAULT(?:Y|ED)?|FAIL(?:ED|URE|ING)?|ALARM(?:ING)?|CRITICAL|OVER[- ]?TEMP(?:ERATURE)?|OVERHEAT(?:ING)?|OVERLOAD(?:ED)?|DEGRADED|TRIPPED|LEAK(?:ING)?|OFFLINE|DOWN|ERROR|ERR)\b/i;

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
