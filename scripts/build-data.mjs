// Builds the website's data files from the raw sources.
//
//   node scripts/build-data.mjs
//
// Inputs (see README for how to download them):
//   data-raw/trails.kml          bike trails (Google Earth KML, one LineString per trail)
//   data-raw/gtfs-metro/*.txt    Transport Victoria GTFS Schedule, metro train feed (folder "2")
// Outputs:
//   data/trails.json   trail geometry + stats
//   data/network.json  metro stations, lines, track segments, travel times
//   data/graph.json    links that join trails to each other and to stations
//   data/rides.json    every station-to-station ride along the trail network (8–80 km)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRideGraph, dijkstra, pathEdges, summarisePath, haversine, KIND } from '../js/ridegraph.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'data-raw');
const OUT = path.join(ROOT, 'data');

// ---- tunables -------------------------------------------------------------
const SIMPLIFY_M = 4;          // Douglas–Peucker tolerance for trail geometry
const DENSIFY_M = 30;          // max spacing between trail nodes (so crossings are found)
const JUNCTION_M = 25;         // two trails closer than this are connected
const SELF_JUNCTION_M = 12;    // a trail that doubles back on itself
const GAP_M = 400;             // trail end -> other trail: short on-road connection
const STATION_M = 1000;        // station -> trail: max on-road access distance
const ACCESS_DETOUR = 1.3;     // straight-line -> street distance
const RIDE_MIN_KM = 8, RIDE_MAX_KM = 80;
const MAX_ROAD_SHARE = 0.3, MAX_ROAD_KM = 5;
const EXCLUDED_ROUTES = new Set(['RCE']); // Flemington Racecourse: event days only
// Interchanges joined by a pedestrian link (Metro Tunnel stations).
const WALKS = [['Flinders Street', 'Town Hall', 5], ['Melbourne Central', 'State Library', 5]];

const r5 = (x) => Math.round(x * 1e5) / 1e5;
const log = (...a) => console.log('•', ...a);

// ---- geometry helpers -----------------------------------------------------
const LAT0 = -37.81, KX = 111320 * Math.cos(LAT0 * Math.PI / 180), KY = 110540;
const toXY = ([lat, lon]) => [lon * KX, lat * KY];

function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const xy = pts.map(toXY);
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = xy[a], [bx, by] = xy[b];
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    let best = -1, bi = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = xy[i];
      let t = L2 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (d > best) { best = d; bi = i; }
    }
    if (best > tol) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

function densify(pts, maxM) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const [a1, o1] = pts[i - 1], [a2, o2] = pts[i];
    const d = haversine(a1, o1, a2, o2);
    const k = Math.ceil(d / maxM);
    for (let j = 1; j < k; j++) out.push([a1 + (a2 - a1) * j / k, o1 + (o2 - o1) * j / k]);
    out.push(pts[i]);
  }
  return out;
}

// ---- CSV (GTFS) ----------------------------------------------------------
function readCsv(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const head = rows.shift();
  return rows.filter((r) => r.length === head.length).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}
const hms = (t) => { const [h, m, s] = t.split(':').map(Number); return h * 60 + m + s / 60; };

// ==========================================================================
// 1. Trails
// ==========================================================================
function readTrails() {
  const kml = fs.readFileSync(path.join(RAW, 'trails.kml'), 'utf8');
  const trails = [];
  for (const pm of kml.split('<Placemark>').slice(1)) {
    const name = (pm.match(/<name>([^<]*)<\/name>/) || [])[1]?.trim();
    const coordText = (pm.match(/<coordinates>([\s\S]*?)<\/coordinates>/) || [])[1];
    if (!name || !coordText) continue;
    const h5 = ((pm.match(/<h5>([\s\S]*?)<\/h5>/) || [])[1] || '').replace(/<[^>]+>/g, ' ');
    const km = parseFloat((h5.match(/([\d.]+)\s*km/i) || [])[1]);
    const mins = (() => {
      const hr = h5.match(/([\d.]+)\s*hrs?/i), mn = h5.match(/(\d+)\s*mins?/i);
      return hr ? Math.round(parseFloat(hr[1]) * 60) : mn ? parseInt(mn[1], 10) : null;
    })();
    const grade = (h5.match(/\b(Gentle|Moderate|Steep|Easy|Hard|Challenging)\b/i) || [])[1] || null;
    let coords = coordText.trim().split(/\s+/).map((s) => { const [lon, lat] = s.split(',').map(Number); return [lat, lon]; })
      .filter(([a, b]) => isFinite(a) && isFinite(b));
    coords = coords.filter((p, i) => i === 0 || p[0] !== coords[i - 1][0] || p[1] !== coords[i - 1][1]);
    coords = densify(simplify(coords, SIMPLIFY_M), DENSIFY_M).map(([a, b]) => [r5(a), r5(b)]);
    let len = 0;
    for (let i = 1; i < coords.length; i++) len += haversine(...coords[i - 1], ...coords[i]);
    trails.push({ name, km: isFinite(km) ? km : Math.round(len / 100) / 10, mins, grade, coords, lenKm: Math.round(len / 100) / 10 });
  }
  trails.sort((a, b) => a.name.localeCompare(b.name));
  return trails;
}

// ==========================================================================
// 2. Trains (GTFS)
// ==========================================================================
function readTrains() {
  const G = path.join(RAW, 'gtfs-metro');
  const routesRaw = readCsv(path.join(G, 'routes.txt'));
  const routes = [], routeIdx = new Map();
  for (const r of routesRaw) {
    const code = (r.route_id.match(/vic-02-([A-Z]+):$/) || [])[1];
    if (!code || EXCLUDED_ROUTES.has(code)) continue; // "-R:" = replacement buses
    routeIdx.set(r.route_id, routes.length);
    routes.push({ id: code, name: r.route_short_name, color: '#' + r.route_color, text: '#' + r.route_text_color });
  }

  const stops = readCsv(path.join(G, 'stops.txt'));
  const parentOf = new Map(), parents = new Map(), urlOf = new Map();
  for (const s of stops) {
    if (s.location_type === '1') parents.set(s.stop_id, s);
    else if (s.location_type === '' || s.location_type === '0') {
      parentOf.set(s.stop_id, s.parent_station || s.stop_id);
      if (s.stop_url && s.parent_station) urlOf.set(s.parent_station, s.stop_url.split('?')[0]);
    }
  }

  const trips = new Map();
  for (const t of readCsv(path.join(G, 'trips.txt'))) {
    if (routeIdx.has(t.route_id)) trips.set(t.trip_id, { r: routeIdx.get(t.route_id), shape: t.shape_id, stops: [] });
  }
  log('trips', trips.size);
  for (const st of readCsv(path.join(G, 'stop_times.txt'))) {
    const t = trips.get(st.trip_id);
    if (!t) continue;
    t.stops.push({ seq: +st.stop_sequence, p: parentOf.get(st.stop_id), arr: hms(st.arrival_time), dep: hms(st.departure_time), d: +st.shape_dist_traveled });
  }

  // Unique stopping patterns per line.
  const patterns = new Map();
  for (const t of trips.values()) {
    t.stops.sort((a, b) => a.seq - b.seq);
    if (t.stops.length < 2) continue;
    const k = t.r + '|' + t.stops.map((s) => s.p).join(',');
    let p = patterns.get(k);
    if (!p) { p = { r: t.r, seq: t.stops.map((s) => s.p), rep: t, times: t.stops.map(() => []) }; patterns.set(k, p); }
    for (let i = 1; i < t.stops.length; i++) p.times[i].push(t.stops[i].arr - t.stops[i - 1].dep);
  }
  log('stopping patterns', patterns.size);

  // A hop a->b is "express" if another pattern of the same line stops between a and b
  // along (roughly) the same track. Those hops are left out: suggestions assume all-stops trains.
  const byRoute = new Map();
  for (const p of patterns.values()) (byRoute.get(p.r) || byRoute.set(p.r, []).get(p.r)).push(p);
  const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s[s.length >> 1]; };
  const hops = new Map(); // "a|b" (a<b) -> { a, b, routes:Set, times:[], rep:{shape, d0, d1} }
  for (const [r, pats] of byRoute) {
    const posMaps = pats.map((p) => new Map(p.seq.map((s, i) => [s, i])));
    for (const p of pats) {
      for (let i = 1; i < p.seq.length; i++) {
        const a = p.seq[i - 1], b = p.seq[i];
        const dAB = p.rep.stops[i].d - p.rep.stops[i - 1].d;
        let express = false;
        pats.forEach((q, qi) => {
          if (express || q === p) return;
          const ia = posMaps[qi].get(a), ib = posMaps[qi].get(b);
          if (ia === undefined || ib === undefined || Math.abs(ib - ia) < 2) return;
          const dq = Math.abs(q.rep.stops[ib].d - q.rep.stops[ia].d);
          if (dq <= dAB * 1.15 + 50) express = true;
        });
        if (express) continue;
        const [x, y] = a < b ? [a, b] : [b, a];
        const key = x + '|' + y;
        let h = hops.get(key);
        if (!h) {
          h = { a: x, b: y, routes: new Set(), times: [], rep: { shape: p.rep.shape, d0: p.rep.stops[i - 1].d, d1: p.rep.stops[i].d, rev: a !== x } };
          hops.set(key, h);
        }
        h.routes.add(r);
        h.times.push(median(p.times[i]));
      }
    }
  }
  log('track segments', hops.size);

  // Stations actually served.
  const used = new Set();
  for (const h of hops.values()) { used.add(h.a); used.add(h.b); }
  const stationIds = [...used].sort((a, b) => parents.get(a).stop_name.localeCompare(parents.get(b).stop_name));
  const sIdx = new Map(stationIds.map((id, i) => [id, i]));
  const stations = stationIds.map((id) => {
    const p = parents.get(id);
    return {
      name: p.stop_name.replace(/ Railway Station$| Station$/, ''),
      ll: [r5(+p.stop_lat), r5(+p.stop_lon)],
      url: urlOf.get(id) || null,
      routes: [],
    };
  });

  // Segment geometry from GTFS shapes.
  const needShapes = new Set([...hops.values()].map((h) => h.rep.shape));
  const shapes = new Map();
  for (const row of readCsv(path.join(G, 'shapes.txt'))) {
    if (!needShapes.has(row.shape_id)) continue;
    (shapes.get(row.shape_id) || shapes.set(row.shape_id, []).get(row.shape_id))
      .push({ seq: +row.shape_pt_sequence, lat: +row.shape_pt_lat, lon: +row.shape_pt_lon, d: +row.shape_dist_traveled });
  }
  for (const pts of shapes.values()) pts.sort((a, b) => a.seq - b.seq);
  const slice = (shapeId, d0, d1) => {
    const pts = shapes.get(shapeId);
    const lo = Math.min(d0, d1), hi = Math.max(d0, d1);
    const interp = (d) => {
      for (let i = 1; i < pts.length; i++) {
        if (pts[i].d >= d) {
          const a = pts[i - 1], b = pts[i], t = b.d > a.d ? (d - a.d) / (b.d - a.d) : 0;
          return [a.lat + (b.lat - a.lat) * t, a.lon + (b.lon - a.lon) * t];
        }
      }
      const z = pts[pts.length - 1]; return [z.lat, z.lon];
    };
    const out = [interp(lo)];
    for (const p of pts) if (p.d > lo && p.d < hi) out.push([p.lat, p.lon]);
    out.push(interp(hi));
    return d0 <= d1 ? out : out.reverse();
  };

  const segs = [...hops.values()].map((h) => {
    const a = sIdx.get(h.a), b = sIdx.get(h.b);
    let g = slice(h.rep.shape, h.rep.d0, h.rep.d1);
    if (h.rep.rev) g.reverse(); // orient a -> b
    g = simplify(g, 6).map(([x, y]) => [r5(x), r5(y)]);
    const r = [...h.routes].sort((x, y) => x - y);
    for (const ri of r) { if (!stations[a].routes.includes(ri)) stations[a].routes.push(ri); if (!stations[b].routes.includes(ri)) stations[b].routes.push(ri); }
    return { a, b, r, t: Math.round(median(h.times) * 10) / 10, g };
  });
  stations.forEach((s) => s.routes.sort((x, y) => x - y));

  const byName = new Map(stations.map((s, i) => [s.name, i]));
  const walks = WALKS.filter(([x, y]) => byName.has(x) && byName.has(y)).map(([x, y, m]) => [byName.get(x), byName.get(y), m]);

  return { routes, stations, segs, walks };
}

// ==========================================================================
// 3. Links: trail <-> trail, station <-> trail
// ==========================================================================
function buildLinks(trails, stations) {
  const nodes = []; // [x, y, trail, idx, global]
  let g = 0;
  trails.forEach((t, ti) => t.coords.forEach((c, j) => { const [x, y] = toXY(c); nodes.push([x, y, ti, j, g++]); }));
  const CELL = 100;
  const grid = new Map();
  const cellKey = (x, y) => Math.floor(x / CELL) + ',' + Math.floor(y / CELL);
  for (const n of nodes) { const k = cellKey(n[0], n[1]); (grid.get(k) || grid.set(k, []).get(k)).push(n); }
  const near = (x, y, r, fn) => {
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL), k = Math.ceil(r / CELL);
    for (let i = cx - k; i <= cx + k; i++) for (let j = cy - k; j <= cy + k; j++) {
      const list = grid.get(i + ',' + j);
      if (list) for (const n of list) { const d = Math.hypot(n[0] - x, n[1] - y); if (d <= r) fn(n, d); }
    }
  };
  const ll = (n) => trails[n[2]].coords[n[3]];
  const dist = (a, b) => haversine(...ll(a), ...ll(b));

  const extra = [];
  const seen = new Set();
  const addEdge = (a, b, kind) => {
    const k = Math.min(a[4], b[4]) + '|' + Math.max(a[4], b[4]);
    if (seen.has(k)) return; seen.add(k);
    extra.push([a[4], b[4], Math.round(dist(a, b) * 10) / 10, kind]);
  };

  // Junctions: nearest node of each other trail within JUNCTION_M.
  for (const n of nodes) {
    const best = new Map();
    near(n[0], n[1], JUNCTION_M, (m, d) => {
      if (m[2] === n[2]) {
        if (Math.abs(m[3] - n[3]) > 6 && d <= SELF_JUNCTION_M) {
          const b = best.get('self'); if (!b || d < b[1]) best.set('self', [m, d]);
        }
        return;
      }
      const b = best.get(m[2]); if (!b || d < b[1]) best.set(m[2], [m, d]);
    });
    for (const [m] of best.values()) addEdge(n, m, KIND.JUNCTION);
  }
  const nJunction = extra.length;

  // Short on-road gaps from each trail end to nearby trails.
  for (const t of trails.keys()) {
    for (const j of [0, trails[t].coords.length - 1]) {
      const n = nodes.find((q) => q[2] === t && q[3] === j);
      const best = new Map();
      near(n[0], n[1], GAP_M, (m, d) => {
        if (m[2] === t) return;
        const b = best.get(m[2]); if (!b || d < b[1]) best.set(m[2], [m, d]);
      });
      const list = [...best.values()].sort((a, b) => a[1] - b[1]);
      if (list.length && list[0][1] <= JUNCTION_M) continue; // already joined
      for (const [m] of list.slice(0, 3)) addEdge(n, m, KIND.ROAD);
    }
  }
  log('junction links', nJunction, 'road-gap links', extra.length - nJunction);

  // Stations -> nearest node of each trail within reach.
  const stationLinks = [];
  stations.forEach((s, si) => {
    const [x, y] = toXY(s.ll);
    const best = new Map();
    near(x, y, STATION_M, (m, d) => { const b = best.get(m[2]); if (!b || d < b[1]) best.set(m[2], [m, d]); });
    const list = [...best.values()].sort((a, b) => a[1] - b[1]).slice(0, 4);
    for (const [m] of list) {
      const d = haversine(...s.ll, ...ll(m));
      stationLinks.push([si, m[4], Math.round(d * ACCESS_DETOUR)]);
    }
  });
  log('stations near a trail', new Set(stationLinks.map((l) => l[0])).size, 'of', stations.length);
  return { extra, stationLinks };
}

// ==========================================================================
// 4. Every station -> station ride
// ==========================================================================
function computeRides(trails, net, links) {
  const g = buildRideGraph(trails, links.extra, links.stationLinks, net.stations.map((s) => s.ll));
  const linked = [...new Set(links.stationLinks.map((l) => l[0]))].sort((a, b) => a - b);
  const rides = [];
  const t0 = Date.now();
  for (const a of linked) {
    const res = dijkstra(g, g.stationNode(a), RIDE_MAX_KM * 1000 * 1.6);
    for (const b of linked) {
      if (b <= a) continue;
      const target = g.stationNode(b);
      if (!isFinite(res.dist[target])) continue;
      const sum = summarisePath(g, pathEdges(res, target));
      const km = sum.m / 1000, roadKm = sum.road / 1000;
      if (km < RIDE_MIN_KM || km > RIDE_MAX_KM) continue;
      if (roadKm > MAX_ROAD_KM || roadKm / km > MAX_ROAD_SHARE) continue;
      if (!sum.seq.length) continue;
      rides.push([a, b, Math.round(km * 10), Math.round(roadKm * 10), sum.seq.map(([t, m]) => [t, Math.round(m / 100)])]);
    }
  }
  log('rides', rides.length, 'in', Date.now() - t0, 'ms');
  return rides;
}

// ==========================================================================
const trails = readTrails();
log('trails', trails.length, 'nodes', trails.reduce((s, t) => s + t.coords.length, 0));
const net = readTrains();
log('stations', net.stations.length, 'lines', net.routes.length);
const links = buildLinks(trails, net.stations);
const rides = computeRides(trails, net, links);

fs.mkdirSync(OUT, { recursive: true });
const write = (name, obj) => {
  const file = path.join(OUT, name);
  fs.writeFileSync(file, JSON.stringify(obj));
  log(name, (fs.statSync(file).size / 1024).toFixed(0), 'KB');
};
const built = new Date().toISOString().slice(0, 10);
write('trails.json', { built, trails: trails.map(({ name, km, mins, grade, coords }) => ({ name, km, mins, grade, coords })) });
write('network.json', { built, ...net });
write('graph.json', { built, extra: links.extra, stationLinks: links.stationLinks });
write('rides.json', { built, rides });
