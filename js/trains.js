// Metro train network: journey times between stations, with line changes.
// Graph nodes: one "hub" per station plus one node per (station, line).
// Boarding a line costs CHANGE_PENALTY minutes (an allowance for waiting / changing);
// the first boarding's penalty is removed from reported times.

export const CHANGE_PENALTY = 8;

export function buildTrainGraph(net) {
  const nS = net.stations.length;
  const key = new Map(); // "s:r" -> node id
  let n = nS;
  const nodeStation = [], nodeRoute = [];
  for (let s = 0; s < nS; s++) { nodeStation.push(s); nodeRoute.push(-1); }
  const nodeFor = (s, r) => {
    const k = s * 64 + r;
    let id = key.get(k);
    if (id === undefined) { id = n++; key.set(k, id); nodeStation.push(s); nodeRoute.push(r); }
    return id;
  };
  const adj = [];
  const link = (a, b, w, seg) => { (adj[a] ||= []).push({ to: b, w, seg }); };

  net.segs.forEach((sg, i) => {
    for (const r of sg.r) {
      const a = nodeFor(sg.a, r), b = nodeFor(sg.b, r);
      link(a, b, sg.t, i); link(b, a, sg.t, i);
    }
  });
  for (let id = nS; id < n; id++) {
    const s = nodeStation[id];
    link(s, id, CHANGE_PENALTY, -1); // board
    link(id, s, 0, -1);              // alight
  }
  for (const [a, b, mins] of net.walks || []) { link(a, b, mins, -2); link(b, a, mins, -2); }
  return { n, nS, adj, nodeStation, nodeRoute };
}

/** Train cost (minutes, incl. change allowances) from station `src` to every station. */
export function trainSearch(tg, src) {
  const dist = new Float64Array(tg.n).fill(Infinity);
  const prev = new Int32Array(tg.n).fill(-1);
  const prevSeg = new Int32Array(tg.n).fill(-1);
  const boards = new Int32Array(tg.n);
  const done = new Uint8Array(tg.n);
  dist[src] = 0;
  // Graph is tiny (a few hundred nodes): a simple O(n^2) Dijkstra is plenty.
  for (;;) {
    let u = -1, best = Infinity;
    for (let i = 0; i < tg.n; i++) if (!done[i] && dist[i] < best) { best = dist[i]; u = i; }
    if (u < 0) break;
    done[u] = 1;
    for (const e of tg.adj[u] || []) {
      const nd = best + e.w;
      if (nd < dist[e.to]) {
        dist[e.to] = nd; prev[e.to] = u; prevSeg[e.to] = e.seg;
        boards[e.to] = boards[u] + (e.seg === -1 && tg.nodeRoute[e.to] !== -1 ? 1 : 0);
      }
    }
  }
  // minutes: travel time incl. change allowances, without the first boarding's allowance.
  // walkOnly: reachable on foot from the source (e.g. Flinders Street <-> Town Hall).
  const minutes = new Float64Array(tg.nS);
  const walkOnly = new Uint8Array(tg.nS);
  for (let s = 0; s < tg.nS; s++) {
    minutes[s] = s === src ? 0 : dist[s] - (boards[s] > 0 ? CHANGE_PENALTY : 0);
    walkOnly[s] = s !== src && boards[s] === 0 && isFinite(dist[s]) ? 1 : 0;
  }
  return { src, dist, prev, prevSeg, minutes, walkOnly };
}

/**
 * Journey legs from the search's source to station `dst`:
 * [{ type: 'train', routes: [routeIdx...], from, to, mins, stops, segs: [{seg, reverse}] } | { type: 'walk', from, to, mins }]
 */
export function trainJourney(tg, net, res, dst) {
  if (dst === res.src) return [];
  if (!isFinite(res.dist[dst])) return null;
  const path = [];
  for (let v = dst; v !== -1; v = res.prev[v]) path.push(v);
  path.reverse();
  const legs = [];
  let cur = null;
  for (let i = 1; i < path.length; i++) {
    const u = path[i - 1], v = path[i];
    const seg = res.prevSeg[v];
    if (seg >= 0) {
      const sg = net.segs[seg];
      const fromS = tg.nodeStation[u], toS = tg.nodeStation[v];
      if (!cur) cur = { type: 'train', route: tg.nodeRoute[v], from: fromS, to: toS, mins: 0, stops: 0, segs: [] };
      cur.to = toS; cur.mins += sg.t; cur.stops++;
      cur.segs.push({ seg, reverse: sg.a !== fromS });
    } else if (seg === -2) {
      legs.push({ type: 'walk', from: tg.nodeStation[u], to: tg.nodeStation[v], mins: res.dist[v] - res.dist[u] });
    } else if (cur && tg.nodeRoute[v] === -1) { // alighted
      legs.push(cur); cur = null;
    }
  }
  if (cur) legs.push(cur);
  // Every line that serves the whole leg (e.g. "Lilydale or Belgrave").
  for (const leg of legs) {
    if (leg.type !== 'train') continue;
    let set = null;
    for (const { seg } of leg.segs) {
      const rs = net.segs[seg].r;
      set = set ? set.filter((r) => rs.includes(r)) : rs.slice();
    }
    leg.routes = set && set.length ? set : [leg.route];
    leg.mins = Math.round(leg.mins);
  }
  return legs;
}

export function journeyStats(legs) {
  if (!legs) return null;
  let mins = 0, changes = -1;
  for (const l of legs) { mins += l.mins; if (l.type === 'train') changes++; }
  if (legs.length && legs.some((l) => l.type === 'train')) mins += Math.max(0, changes) * 5; // typical connection wait
  return { mins: Math.round(mins), changes: Math.max(0, changes) };
}
