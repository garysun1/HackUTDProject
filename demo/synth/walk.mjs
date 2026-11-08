// Room-based synthetic walks (decision 0032). A scenario whose `site.scene` names a generated site
// (demo/synth/sites.mjs) places every photo inside the room its shot names, and each wearer walks
// the site's corridor spines between photos at walking pace, lingering in the room in between,
// changing floors at a lift. Deterministic per scenario. Positions are illustrative, like
// decision 0029's walk, but they agree with what each photo shows.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const R = 6378137, D2R = Math.PI / 180;
const WALK_MPS = 1.1;

export function loadSite(scene) {
  return JSON.parse(readFileSync(join(ROOT, 'web/src/site3d/data/sites', `${scene}.json`), 'utf8'));
}

function inRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function makeWalker(site, rng) {
  const [lon0, lat0] = site.center; const k = Math.cos(lat0 * D2R);
  const xy = ([lon, lat]) => [(lon - lon0) * D2R * R * k, (lat - lat0) * D2R * R];
  const ll = ([x, y]) => ({ lat: +(lat0 + y / (R * D2R)).toFixed(7), lon: +(lon0 + x / (R * k * D2R)).toFixed(7) });
  const rooms = new Map(site.indoor.filter(r => r.name).map(r => [r.name, { level: Number(r.level) || 0, ring: r.pts.map(xy) }]));

  // corridor graph: spine vertices (merged when they coincide), segments, lifts between levels
  const nodes = []; const adj = []; const key = (lv, [x, y]) => `${lv}:${Math.round(x)}:${Math.round(y)}`; const byKey = new Map();
  const node = (lv, p) => { const kk = key(lv, p); if (!byKey.has(kk)) { byKey.set(kk, nodes.length); nodes.push({ lv, p }); adj.push([]); } return byKey.get(kk); };
  const link = (a, b, w) => { adj[a].push([b, w]); adj[b].push([a, w]); };
  const segs = [];
  for (const sp of site.walk.spines) {
    const pts = sp.pts.map(xy);
    for (let i = 1; i < pts.length; i++) { const a = node(sp.level, pts[i - 1]), b = node(sp.level, pts[i]); link(a, b, Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])); segs.push([a, b]); }
  }
  for (const lift of site.walk.lifts ?? []) {
    const p = xy(lift); const here = nodes.map((n, i) => [n, i]).filter(([n]) => Math.hypot(n.p[0] - p[0], n.p[1] - p[1]) < 1.5);
    for (let i = 0; i < here.length; i++) for (let j = i + 1; j < here.length; j++) if (here[i][0].lv !== here[j][0].lv) link(here[i][1], here[j][1], 25);
  }

  function spotIn(name) {
    const r = rooms.get(name); if (!r) throw new Error(`room "${name}" is not in the site plan`);
    const xs = r.ring.map(p => p[0]), ys = r.ring.map(p => p[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs) + 2, Math.max(...xs) - 2, Math.min(...ys) + 2, Math.max(...ys) - 2];
    for (let i = 0; i < 50; i++) { const p = [x0 + rng() * (x1 - x0), y0 + rng() * (y1 - y0)]; if (inRing(p, r.ring)) return { p, lv: r.level, room: name }; }
    return { p: [(x0 + x1) / 2, (y0 + y1) / 2], lv: r.level, room: name };
  }
  // nearest point on a corridor segment of the same level
  function attach(pt) {
    let best = null;
    for (const [a, b] of segs) {
      if (nodes[a].lv !== pt.lv) continue; const [ax, ay] = nodes[a].p, [bx, by] = nodes[b].p;
      const dx = bx - ax, dy = by - ay; const L2 = dx * dx + dy * dy || 1; const t = Math.max(0, Math.min(1, ((pt.p[0] - ax) * dx + (pt.p[1] - ay) * dy) / L2));
      const q = [ax + t * dx, ay + t * dy]; const d = Math.hypot(q[0] - pt.p[0], q[1] - pt.p[1]);
      if (!best || d < best.d) best = { d, q, a, b };
    }
    return best;
  }
  /** Polyline [{p, lv}] from one spot to another along the corridors. */
  function route(from, to) {
    if (from.room === to.room) return [from, to];
    const A = attach(from), B = attach(to); if (!A || !B) return [from, to];
    const n = nodes.length; const S = n, T = n + 1; const extra = new Map([[S, []], [T, []]]);
    const edges = i => (i < n ? adj[i] : extra.get(i));
    const addE = (i, j, w) => { (i < n ? adj[i] : extra.get(i)).push([j, w]); };
    const dist = (i, q) => Math.hypot(nodes[i].p[0] - q[0], nodes[i].p[1] - q[1]);
    const patch = [];
    for (const [X, P] of [[S, A], [T, B]]) for (const e of [P.a, P.b]) { addE(X, e, dist(e, P.q)); adj[e].push([X, dist(e, P.q)]); patch.push(e); }
    if (A.a === B.a && A.b === B.b || A.a === B.b && A.b === B.a) { addE(S, T, Math.hypot(A.q[0] - B.q[0], A.q[1] - B.q[1])); }
    const d = new Map([[S, 0]]); const prev = new Map(); const done = new Set();
    while (true) {
      let u = null; for (const [i, v] of d) if (!done.has(i) && (u === null || v < d.get(u))) u = i;
      if (u === null || u === T) break; done.add(u);
      for (const [v, w] of edges(u)) { const nd = d.get(u) + w; if (!d.has(v) || nd < d.get(v)) { d.set(v, nd); prev.set(v, u); } }
    }
    for (const e of patch) adj[e] = adj[e].filter(([v]) => v !== S && v !== T);
    if (!prev.has(T)) return [from, to];
    const path = []; for (let u = T; u !== undefined; u = prev.get(u)) path.unshift(u);
    const pt = i => (i === S ? { p: A.q, lv: from.lv } : i === T ? { p: B.q, lv: to.lv } : { p: nodes[i].p, lv: nodes[i].lv });
    return [from, ...path.map(pt), to];
  }
  const len = poly => poly.slice(1).reduce((s, q, i) => s + Math.hypot(q.p[0] - poly[i].p[0], q.p[1] - poly[i].p[1]) + (q.lv !== poly[i].lv ? 25 : 0), 0);
  function along(poly, frac) {
    const total = len(poly); let want = frac * total;
    for (let i = 1; i < poly.length; i++) {
      const a = poly[i - 1], b = poly[i]; const L = Math.hypot(b.p[0] - a.p[0], b.p[1] - a.p[1]) + (b.lv !== a.lv ? 25 : 0);
      if (want <= L || i === poly.length - 1) { const t = L ? Math.min(1, want / L) : 1; return { p: [a.p[0] + (b.p[0] - a.p[0]) * t, a.p[1] + (b.p[1] - a.p[1]) * t], lv: t < 0.5 ? a.lv : b.lv }; }
      want -= L;
    }
    return poly.at(-1);
  }

  /**
   * One wearer's day: stops = [{t (minutes), room}] in time order. Returns the photo spots
   * and positionAt(tMin) for the track sampler.
   */
  function plan(stops) {
    const spots = stops.map(s => ({ ...spotIn(s.room), t: s.t }));
    const legs = [];
    for (let i = 1; i < spots.length; i++) {
      const poly = route(spots[i - 1], spots[i]); const walkMin = len(poly) / WALK_MPS / 60;
      const arrive = spots[i].t - Math.min(1.5, (spots[i].t - spots[i - 1].t) / 4); const leave = Math.max(spots[i - 1].t + 0.5, arrive - walkMin);
      legs.push({ poly, leave, arrive: Math.max(leave + 0.1, arrive) });
    }
    function positionAt(tm) {
      if (tm <= spots[0].t) return spots[0];
      for (let i = 0; i < legs.length; i++) {
        const L = legs[i];
        if (tm < L.leave) return linger(spots[i], tm);
        if (tm <= L.arrive) return along(L.poly, (tm - L.leave) / (L.arrive - L.leave));
      }
      return linger(spots.at(-1), tm);
    }
    // standing and working near where the photo was taken, drifting a metre or two
    function linger(s, tm) { return { p: [s.p[0] + Math.sin(tm * 1.7 + s.p[0]) * 1.2, s.p[1] + Math.cos(tm * 1.3 + s.p[1]) * 1.2], lv: s.lv }; }
    const moving = tm => legs.some(L => tm >= L.leave && tm <= L.arrive);
    return { spots, positionAt, moving };
  }
  return { plan, ll };
}
