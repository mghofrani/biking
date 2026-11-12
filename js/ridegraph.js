// Bike-trail network graph + shortest-path search.
// Shared by the offline build script (Node) and the website (browser), so the
// rides precomputed at build time are exactly the rides the map later draws.

export const KIND = { JUNCTION: -1, ROAD: -2, ACCESS: -3 };

// Routing preferences: a metre on a road "costs" more than a metre on a trail,
// so the search prefers staying on trails even if that is a little longer.
const ROAD_WEIGHT = 2.0;
const ACCESS_WEIGHT = 1.5;

const R_EARTH = 6371008.8;
export function haversine(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(a));
}

/**
 * trails:       [{ coords: [[lat, lon], ...] }, ...]   (node ids are assigned trail by trail)
 * extra:        [[u, v, metres, kind], ...]             junction / road-gap links between trail nodes
 * stationLinks: [[stationIdx, node, metres], ...]       station <-> trail access (metres already include detour)
 * stations:     [[lat, lon], ...]
 */
export function buildRideGraph(trails, extra, stationLinks, stations) {
  const offsets = [];
  let n = 0;
  for (const t of trails) { offsets.push(n); n += t.coords.length; }
  const nTrail = n;
  const total = n + stations.length;
  const lat = new Float64Array(total);
  const lon = new Float64Array(total);
  const trailOf = new Int32Array(total).fill(-1);
  trails.forEach((t, ti) => t.coords.forEach(([a, b], j) => {
    lat[offsets[ti] + j] = a; lon[offsets[ti] + j] = b; trailOf[offsets[ti] + j] = ti;
  }));
  stations.forEach(([a, b], s) => { lat[nTrail + s] = a; lon[nTrail + s] = b; });

  const eu = [], ev = [], elen = [], ekind = [];
  const add = (u, v, len, kind) => { eu.push(u); ev.push(v); elen.push(len); ekind.push(kind); };
  trails.forEach((t, ti) => {
    for (let j = 1; j < t.coords.length; j++) {
      const u = offsets[ti] + j - 1, v = u + 1;
      add(u, v, haversine(lat[u], lon[u], lat[v], lon[v]), ti);
    }
  });
  for (const [u, v, len, kind] of extra) add(u, v, len, kind);
  for (const [s, node, len] of stationLinks) add(nTrail + s, node, len, KIND.ACCESS);

  // Compressed adjacency (both directions).
  const deg = new Int32Array(total + 1);
  for (let i = 0; i < eu.length; i++) { deg[eu[i] + 1]++; deg[ev[i] + 1]++; }
  for (let i = 1; i <= total; i++) deg[i] += deg[i - 1];
  const start = deg;
  const fill = start.slice(0, total);
  const m2 = eu.length * 2;
  const to = new Int32Array(m2), len = new Float64Array(m2), w = new Float64Array(m2), kind = new Int32Array(m2);
  const put = (a, b, l, k) => {
    const p = fill[a]++;
    to[p] = b; len[p] = l; kind[p] = k;
    w[p] = k === KIND.ROAD ? l * ROAD_WEIGHT : k === KIND.ACCESS ? l * ACCESS_WEIGHT : l;
  };
  for (let i = 0; i < eu.length; i++) { put(eu[i], ev[i], elen[i], ekind[i]); put(ev[i], eu[i], elen[i], ekind[i]); }

  return { n: total, nTrail, offsets, lat, lon, trailOf, start, to, len, w, kind,
    stationNode: (s) => nTrail + s };
}

// Minimal binary heap keyed by float priority.
class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(v, k) {
    const K = this.k, V = this.v;
    let i = K.length; K.push(k); V.push(v);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (K[p] <= k) break;
      K[i] = K[p]; V[i] = V[p]; i = p;
    }
    K[i] = k; V[i] = v;
  }
  pop() {
    const K = this.k, V = this.v;
    const topV = V[0], topK = K[0];
    const lk = K.pop(), lv = V.pop();
    if (K.length) {
      let i = 0; const n = K.length;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && K[c + 1] < K[c]) c++;
        if (K[c] >= lk) break;
        K[i] = K[c]; V[i] = V[c]; i = c;
      }
      K[i] = lk; V[i] = lv;
    }
    this.lastKey = topK;
    return topV;
  }
}

/** Shortest paths from `src`. Station nodes are sinks: a ride never passes "through" a station. */
export function dijkstra(g, src, maxWeight = Infinity) {
  const dist = new Float64Array(g.n).fill(Infinity);
  const prevEdge = new Int32Array(g.n).fill(-1);
  const prevNode = new Int32Array(g.n).fill(-1);
  const h = new Heap();
  dist[src] = 0; h.push(src, 0);
  while (h.size) {
    const u = h.pop();
    const d = h.lastKey;
    if (d > dist[u]) continue;
    if (u !== src && u >= g.nTrail) continue;
    for (let p = g.start[u], e = g.start[u + 1]; p < e; p++) {
      const v = g.to[p];
      const nd = d + g.w[p];
      if (nd < dist[v] && nd <= maxWeight) {
        dist[v] = nd; prevEdge[v] = p; prevNode[v] = u; h.push(v, nd);
      }
    }
  }
  return { src, dist, prevEdge, prevNode };
}

/** Edge (CSR index) list along the shortest path to `target`, in travel order. */
export function pathEdges(res, target) {
  if (!isFinite(res.dist[target])) return null;
  const edges = [];
  for (let v = target; v !== res.src; v = res.prevNode[v]) edges.push(res.prevEdge[v]);
  return edges.reverse();
}

export function pathNodes(res, target) {
  const nodes = [];
  for (let v = target; v !== -1; v = res.prevNode[v]) { nodes.push(v); if (v === res.src) break; }
  return nodes.reverse();
}

/**
 * Turns a path into { m, road, seq } where seq is the ordered list of [trailId, metres]
 * the ride follows (tiny brushes with other trails are folded away).
 */
export function summarisePath(g, edges, minSegment = 400) {
  let m = 0, road = 0;
  let seq = [];
  for (const p of edges) {
    const l = g.len[p], k = g.kind[p];
    m += l;
    if (k === KIND.ROAD || k === KIND.ACCESS) { road += l; continue; }
    if (k < 0) continue; // junction hop: negligible length, keep current trail
    const last = seq[seq.length - 1];
    if (last && last[0] === k) last[1] += l; else seq.push([k, l]);
  }
  // Fold short fragments into their neighbours.
  for (let pass = 0; pass < 2; pass++) {
    const out = [];
    for (const s of seq) {
      const last = out[out.length - 1];
      if (last && last[0] === s[0]) { last[1] += s[1]; continue; }
      if (s[1] < minSegment && last) { last[1] += s[1]; continue; }
      out.push([s[0], s[1]]);
    }
    if (out.length > 1 && out[0][1] < minSegment) { out[1][1] += out[0][1]; out.shift(); }
    seq = out;
  }
  // Where two trails share the same path (e.g. Main Yarra / Capital City) the route can
  // flip between them; list each trail once, in the order it is first reached.
  const once = new Map();
  for (const [t, l] of seq) once.set(t, (once.get(t) || 0) + l);
  return { m, road, seq: [...once] };
}

/** [[lat, lon], ...] along a node path. */
export function pathCoords(g, nodes) {
  return nodes.map((v) => [g.lat[v], g.lon[v]]);
}

/** Splits a ride into drawable pieces: [{ road: bool, coords }]. */
export function pathPieces(g, res, target) {
  const edges = pathEdges(res, target);
  if (!edges) return [];
  const nodes = pathNodes(res, target);
  const pieces = [];
  edges.forEach((p, i) => {
    const road = g.kind[p] === KIND.ROAD || g.kind[p] === KIND.ACCESS;
    const a = nodes[i], b = nodes[i + 1];
    const last = pieces[pieces.length - 1];
    if (last && last.road === road) last.coords.push([g.lat[b], g.lon[b]]);
    else pieces.push({ road, coords: [[g.lat[a], g.lon[a]], [g.lat[b], g.lon[b]]] });
  });
  return pieces;
}
