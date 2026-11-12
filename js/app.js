import { buildRideGraph, dijkstra, pathPieces, pathEdges, summarisePath, haversine } from './ridegraph.js';
import { buildTrainGraph, trainSearch, trainJourney, journeyStats } from './trains.js';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
const RANGES = [[10, 20], [20, 30], [30, 45], [45, 80]];
const DEFAULT_RANGE = 1;
const DEFAULT_TRAIN_STATION = 'Flinders Street'; // first suggestion when a train is added
const RIDE_KMH = 15;          // relaxed average incl. stops
const MAX_TRAIN_MIN = 90;     // each way
const N_SUGGEST = 6;
const SOURCE_SITE = 'https://melbournebiketrails.yolasite.com/';

const MOBILE = window.matchMedia('(max-width: 760px)');
const DARK = window.matchMedia('(prefers-color-scheme: dark)');
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

const ICON = {
  train: '<svg viewBox="0 0 24 24"><rect x="5" y="3" width="14" height="13" rx="3"/><path d="M5 10h14M8.5 21l2-5M15.5 21l-2-5"/><path d="M9 13h.01M15 13h.01"/></svg>',
  bike: '<svg viewBox="0 0 24 24"><circle cx="5.5" cy="16" r="3.8"/><circle cx="18.5" cy="16" r="3.8"/><path d="M5.5 16l4-7.5h6l3 7.5M9.5 8.5l3 7.5h-7M15.5 8.5l-3 7.5M8 5.5h3"/></svg>',
  walk: '<svg viewBox="0 0 24 24"><circle cx="13" cy="4.5" r="1.8"/><path d="M10 21l2-6 3 3v3M8 12l3-4 3 1 2 3M12 15l-1-6"/></svg>',
  home: '<svg viewBox="0 0 24 24"><path d="M4 11.5L12 5l8 6.5V20H4z"/><path d="M10 20v-5h4v5"/></svg>',
  flag: '<svg viewBox="0 0 24 24"><path d="M6 21V4M6 4h11l-2.5 4L17 12H6"/></svg>',
};

const fmtDur = (m) => {
  m = Math.round(m);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} h ${String(r).padStart(2, '0')} min` : `${h} h`;
};
const fmtKm = (km) => (km >= 10 ? Math.round(km) : Math.round(km * 10) / 10);
const dayNumber = () => Math.floor((Date.now() - new Date().getTimezoneOffset() * 60000) / 864e5);
function rnd(seed, a, b) { // deterministic 0..1
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(a + 1, 0xc2b2ae35) ^ Math.imul(b + 7, 0x27d4eb2f);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let trails, net, rides, g, tg;
let rideStations;             // stations next to a trail: where a ride can start or finish
const trailStations = new Map(); // trail index -> stations linked to it
// The plan is built around the ride:
//   start / finish   where the ride starts and ends (finish null = suggest finishes by distance)
//   trainFrom        optional train trip to the start
//   trainTo          optional train trip onwards from the finish
const state = {
  start: null, finish: null, range: DEFAULT_RANGE, trainFrom: null, trainTo: null,
  seed: dayNumber(), shuffled: false, list: [], sel: -1, sharedEnd: null, picking: null,
};
const rideCache = new Map();

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------
const map = L.map('map', { zoomControl: false, minZoom: 9, maxZoom: 18, attributionControl: true })
  .setView([-37.83, 145.03], 11);
if (!MOBILE.matches) L.control.zoom({ position: 'bottomright' }).addTo(map);
map.attributionControl.setPrefix(false);

// OpenStreetMap tiles, recoloured in the browser: parks, woods and grass stay green and
// water stays blue, while roads, buildings and labels turn grey so the orange trails and
// the coloured train lines stand out. In the dark theme the greys are inverted.
const band = (h, lo, hi, soft) => (h < lo - soft || h > hi + soft ? 0 : h < lo ? (h - lo + soft) / soft : h > hi ? (hi + soft - h) / soft : 1);
function recolour(px, dark) {
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i], g = px[i + 1], b = px[i + 2];
    const max = Math.max(r, g, b), min = Math.min(r, g, b), c = max - min;
    const grey = 0.299 * r + 0.587 * g + 0.114 * b;
    let keep = 0;
    if (c > 10) {
      let h = max === r ? ((g - b) / c) % 6 : max === g ? (b - r) / c + 2 : (r - g) / c + 4;
      h *= 60; if (h < 0) h += 360;
      // Greens (parks, woods, grass, sports fields) and blues (rivers, lakes, sea, water labels).
      // Yellows (secondary roads, farmland), oranges and pinks (main roads) are left out.
      keep = Math.max(band(h, 80, 170, 12), band(h, 178, 235, 10));
    }
    let base, k;
    if (dark) { base = (0.9 * (255 - grey - 128) + 128) * 0.82; k = 0.75 * keep; }
    else { base = 0.88 * (grey - 128) + 136; k = 1.25 * keep; }
    px[i] = base + (r - grey) * k;
    px[i + 1] = base + (g - grey) * k;
    px[i + 2] = base + (b - grey) * k;
  }
}
const NatureTiles = L.TileLayer.extend({
  createTile(coords, done) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    canvas.complete = false; // Leaflet checks this when cancelling tiles on zoom
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, 256, 256);
      try {
        const data = ctx.getImageData(0, 0, 256, 256);
        recolour(data.data, isDark());
        ctx.putImageData(data, 0, 0);
      } catch { /* image not readable: show it unchanged */ }
      canvas.complete = true;
      done(null, canvas);
    };
    img.onerror = (e) => { canvas.complete = true; done(e, canvas); };
    img.src = this.getTileUrl(coords);
    return canvas;
  },
});
const base = new NatureTiles('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

// Stacked canvases only deliver taps to the top one, so: everything tappable (trails +
// stations) shares one canvas, and the decorative canvases let taps fall through.
for (const [name, z, clickThrough] of [['trains', 410, true], ['network', 420, false], ['trip', 450, true], ['movers', 630, true], ['pins', 640, false]]) {
  const pane = map.createPane(name);
  pane.style.zIndex = z;
  if (clickThrough) pane.style.pointerEvents = 'none';
}
const R = (pane) => L.canvas({ pane, tolerance: 9, padding: 0.4 });
const rTrains = R('trains'), rTrails = R('network'), rStations = rTrails, rTrip = R('trip');

const trainsLayer = L.layerGroup().addTo(map);
const trailsLayer = L.layerGroup().addTo(map);
const stationsLayer = L.layerGroup().addTo(map);
const tripLayer = L.layerGroup().addTo(map);
const trainLines = [], trailLines = [], trailHalos = [], stationDots = [];

function drawNetwork() {
  const halo = cssVar('--panel') || '#fff';
  // Train lines: one stroke per line colour, side by side where lines share track.
  const colourOrder = [...new Set(net.routes.map((r) => r.color))];
  net.segs.forEach((sg) => {
    const colours = [...new Set(sg.r.map((r) => net.routes[r].color))].sort((a, b) => colourOrder.indexOf(a) - colourOrder.indexOf(b));
    const k = colours.length, w = 3.2;
    colours.forEach((c, i) => {
      const line = L.polyline(sg.g, {
        renderer: rTrains, color: c, weight: w, opacity: 0.9, offset: (i - (k - 1) / 2) * w, interactive: false,
      }).addTo(trainsLayer);
      trainLines.push(line);
    });
  });

  trails.forEach((t, i) => {
    trailHalos.push(L.polyline(t.coords, { renderer: rTrails, color: halo, weight: 7.5, opacity: 0.9, interactive: false }).addTo(trailsLayer));
  });
  trails.forEach((t, i) => {
    const line = L.polyline(t.coords, { renderer: rTrails, color: cssVar('--trail'), weight: 3.6, opacity: 1, lineCap: 'round' })
      .bindPopup(() => trailPopup(i), { maxWidth: 260 })
      .addTo(trailsLayer);
    line.on('mouseover', () => line.setStyle({ weight: 6 }));
    line.on('mouseout', () => line.setStyle({ weight: 3.6 }));
    trailLines.push(line);
  });

  net.stations.forEach((s, i) => {
    const groups = new Set(s.routes.map((r) => net.routes[r].color)).size;
    const dot = L.circleMarker(s.ll, {
      renderer: rStations, radius: 3, weight: groups > 1 ? 2.2 : 1.6, color: '#1d232a', fillColor: '#fff', fillOpacity: 1,
    }).bindPopup(() => stationPopup(i), { maxWidth: 260 }).addTo(stationsLayer);
    dot.big = groups > 1;
    stationDots.push(dot);
  });
  sizeStations();
}

function sizeStations() {
  const z = map.getZoom();
  const r = z < 11 ? 2.2 : z < 12 ? 3 : z < 14 ? 4 : 5.5;
  stationDots.forEach((d) => d.setRadius(d.big ? r + 1.2 : r));
}
map.on('zoomend', sizeStations);

function dimNetwork(dim) {
  trainLines.forEach((l) => l.setStyle({ opacity: dim ? 0.28 : 0.9 }));
  trailLines.forEach((l) => l.setStyle({ opacity: dim ? 0.4 : 1 }));
  trailHalos.forEach((l) => l.setStyle({ opacity: dim ? 0.35 : 0.9 }));
  stationDots.forEach((d) => d.setStyle({ opacity: dim ? 0.5 : 1, fillOpacity: dim ? 0.6 : 1 }));
}

function restyle() {
  const halo = cssVar('--panel') || '#fff';
  trailHalos.forEach((l) => l.setStyle({ color: halo }));
  trailLines.forEach((l) => l.setStyle({ color: cssVar('--trail') }));
  base.redraw(); // re-colour the map for the new theme (tiles come from the browser cache)
  if (state.sel >= 0) drawTrip(state.list[state.sel], false);
}
DARK.addEventListener?.('change', () => { restyle(); renderThemeBtn(); });

// Light / dark switch. The page starts light (set in index.html) unless dark was chosen before.
const SUN = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const MOON = '<svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></svg>';
function isDark() {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'dark' : DARK.matches;
}
function renderThemeBtn() {
  const btn = $('themeBtn');
  const label = isDark() ? 'Switch to light theme' : 'Switch to dark theme';
  btn.innerHTML = isDark() ? SUN : MOON;
  btn.setAttribute('aria-label', label);
  btn.title = label;
}
$('themeBtn').addEventListener('click', () => {
  const next = isDark() ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  store.set('tt.theme', next);
  renderThemeBtn();
  restyle();
});
renderThemeBtn();

// Legend + layer toggles
const Legend = L.Control.extend({
  options: { position: 'topright' },
  onAdd() {
    const div = L.DomUtil.create('div', 'legend');
    div.innerHTML = `
      <label><input type="checkbox" checked data-layer="trails"><span class="swatch trail"></span>Bike trails</label>
      <label><input type="checkbox" checked data-layer="trains"><span class="swatch train"></span>Train lines</label>`;
    L.DomEvent.disableClickPropagation(div);
    div.addEventListener('change', (e) => {
      const which = e.target.dataset.layer;
      const layers = which === 'trails' ? [trailsLayer] : [trainsLayer, stationsLayer];
      layers.forEach((l) => (e.target.checked ? l.addTo(map) : map.removeLayer(l)));
    });
    return div;
  },
});
new Legend().addTo(map);

// ---------------------------------------------------------------------------
// Your location: a blue dot that follows you, with a ring showing GPS accuracy.
// Browsers only share location with secure (https or localhost) pages.
// ---------------------------------------------------------------------------
function toast(msg, ms = 4500) {
  let el = document.querySelector('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), ms);
}

const me = {
  watch: null, wanted: false, fix: null, centred: false,
  dot: null, ring: null, btn: null,
};
const LOCATE_ICON = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.5" class="core"/><circle cx="12" cy="12" r="7.5"/><path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3"/></svg>';

function setLocateState(s) { if (me.btn) me.btn.dataset.state = s; } // off | searching | on

function showFix(pos) {
  const { latitude: la, longitude: lo, accuracy } = pos.coords;
  me.fix = { ll: [la, lo], accuracy, at: Date.now() };
  if (!me.dot) {
    me.ring = L.circle([la, lo], { renderer: rTrip, radius: accuracy, color: '#1a73e8', weight: 1, opacity: 0.35, fillColor: '#1a73e8', fillOpacity: 0.12, interactive: false }).addTo(map);
    me.dot = L.marker([la, lo], {
      pane: 'pins', keyboard: false, interactive: false,
      icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [22, 22], iconAnchor: [11, 11] }),
    }).addTo(map);
  } else {
    me.ring.setLatLng([la, lo]).setRadius(accuracy);
    me.dot.setLatLng([la, lo]);
  }
  setLocateState('on');
  if (!me.centred) { me.centred = true; centreOnMe(); }
}

function centreOnMe() {
  if (!me.fix) return;
  const zoom = Math.max(map.getZoom(), 15);
  let target = L.latLng(me.fix.ll);
  if (MOBILE.matches) {
    // Centre the dot in the part of the map not covered by the bottom sheet.
    const covered = panel.offsetHeight - sheetY(panel.dataset.state);
    const p = map.project(target, zoom).add([0, covered / 2]);
    target = map.unproject(p, zoom);
  }
  map.flyTo(target, zoom, { duration: 0.8 });
}

function startWatch() {
  if (me.watch != null) return;
  me.watch = navigator.geolocation.watchPosition(showFix, (err) => {
    stopWatch();
    me.wanted = false;
    setLocateState('off');
    if (err.code === 1) toast('Location is blocked for this site. You can allow it in your browser’s site settings.');
    else toast('Couldn’t find your location. Try again outdoors or with GPS turned on.');
  }, { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 });
}
function stopWatch() {
  if (me.watch != null) navigator.geolocation.clearWatch(me.watch);
  me.watch = null;
}

/** centre: move the map to you once the first position arrives. */
function startLocating({ centre = true } = {}) {
  if (!('geolocation' in navigator)) { toast('This browser can’t share your location.'); return; }
  if (!window.isSecureContext) {
    toast('Your location only works on a secure (https) page, e.g. the published site on github.io.');
    return;
  }
  me.wanted = true;
  me.centred = !centre;
  if (!me.fix) setLocateState('searching');
  startWatch();
}

const Locate = L.Control.extend({
  options: { position: 'topright' },
  onAdd() {
    const btn = L.DomUtil.create('button', 'locate-btn');
    btn.type = 'button';
    btn.innerHTML = LOCATE_ICON;
    btn.title = 'Show my location';
    btn.setAttribute('aria-label', 'Show my location');
    btn.dataset.state = 'off';
    L.DomEvent.disableClickPropagation(btn);
    btn.addEventListener('click', () => (me.fix && me.wanted ? centreOnMe() : startLocating()));
    me.btn = btn;
    return btn;
  },
});
new Locate().addTo(map);

// Save battery: stop GPS while the app is in the background, resume when it comes back.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopWatch();
  else if (me.wanted) startWatch();
});
// If location was allowed before, show the dot straight away (no prompt, no map jump).
if (window.isSecureContext && navigator.permissions?.query) {
  navigator.permissions.query({ name: 'geolocation' })
    .then((p) => { if (p.state === 'granted') startLocating({ centre: false }); })
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// Popups
// ---------------------------------------------------------------------------
const lineChips = (routeIdxs, max = 4) => {
  const names = [...new Map(routeIdxs.map((r) => [net.routes[r].name, net.routes[r]])).values()];
  const shown = names.slice(0, max).map((r) => `<span class="line-chip" style="background:${r.color};color:${r.text}">${esc(r.name)}</span>`);
  if (names.length > max) shown.push(`<span class="line-chip" style="background:var(--soft)">+${names.length - max}</span>`);
  return shown.join('');
};

let lastTap = null; // where the map was last tapped (set on "preclick", before any popup opens)

function nearestStation(lat, lng, only = null) {
  let best = -1, bd = Infinity;
  net.stations.forEach((s, i) => {
    if (only && !only.has(i)) return;
    const d = haversine(lat, lng, ...s.ll);
    if (d < bd) { bd = d; best = i; }
  });
  return [best, bd];
}

function trailPopup(i) {
  const t = trails[i];
  const bits = [`${t.km} km`, t.mins ? `~${fmtDur(t.mins)}` : null, t.grade].filter(Boolean).join(' · ');
  // The trail-side station nearest to where the trail was tapped.
  const linked = new Set(trailStations.get(i) || []);
  const [s] = lastTap && linked.size ? nearestStation(lastTap.lat, lastTap.lng, linked) : [-1];
  const acts = s >= 0
    ? `<button class="btn primary" data-act="start" data-i="${s}">Start biking at ${esc(stName(s))}</button>
       <button class="btn" data-act="finish" data-i="${s}">Finish biking at ${esc(stName(s))}</button>`
    : '';
  return `<div class="pop">
    <h4>${esc(t.name)}</h4>
    <div class="meta">${esc(bits)}</div>
    <div class="acts">${acts}
      <a class="btn" href="${SOURCE_SITE}" target="_blank" rel="noopener">Trail guide ↗</a>
    </div></div>`;
}

function stationPopup(i) {
  const s = net.stations[i];
  const rideable = rideStations.has(i);
  return `<div class="pop">
    <h4>${esc(s.name)}</h4>
    <div class="meta">${lineChips(s.routes, 6)}</div>
    <div class="acts">
      ${rideable ? `<button class="btn primary" data-act="start" data-i="${i}">Start biking here</button>
      <button class="btn" data-act="finish" data-i="${i}">Finish biking here</button>` : ''}
      <button class="btn" data-act="trainFrom" data-i="${i}">Train from here</button>
      <button class="btn" data-act="trainTo" data-i="${i}">Train to here</button>
      ${s.url ? `<a class="btn" href="${esc(s.url)}" target="_blank" rel="noopener">Station info ↗</a>` : ''}
    </div></div>`;
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const i = +b.dataset.i;
  const act = b.dataset.act;
  map.closePopup();
  if (act === 'start' || act === 'finish' || act === 'trainFrom' || act === 'trainTo') setPoint(act, i);
  if (act === 'surprise') surprise();
  if (act === 'gpx') downloadGpx(state.list[state.sel]);
});

/** Sets one of the four plan points and refreshes the ideas. */
function setPoint(which, i) {
  if (which === 'start') {
    state.start = i;
    if (state.finish === i) state.finish = null;
    state.sharedEnd = null;
  } else if (which === 'finish') {
    if (i === state.start) { toast('That’s where the ride starts. Pick a different finish, or leave it on “Suggest”.'); return; }
    state.finish = i;
  } else {
    state[which] = i;
  }
  refresh();
}

function surprise() {
  const list = [...rideStations];
  setPoint('start', list[Math.floor(Math.random() * list.length)]);
}

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------
// A precomputed ride (rides.json) seen from station s.
function fromRide(rideIdx, s) {
  const [a, b, km10, road10, seq] = rides[rideIdx];
  return { s, e: s === a ? b : a, km: km10 / 10, road: road10 / 10, seq: s === a ? seq : seq.slice().reverse() };
}

// Any start → finish pair, worked out on the spot along the trail network.
function rideBetween(s, e) {
  const res = rideResult(s);
  const target = g.stationNode(e);
  if (!isFinite(res.dist[target])) return null;
  const sum = summarisePath(g, pathEdges(res, target));
  return { s, e, km: sum.m / 1000, road: sum.road / 1000, seq: sum.seq };
}

/** The ride ideas for the current plan (empty until a start is chosen). */
function suggest() {
  const S = state.start;
  if (S == null) return [];

  // Finish chosen: one ride, start to finish.
  if (state.finish != null) {
    const c = rideBetween(S, state.finish);
    return c ? addTrains([Object.assign(c, { chosen: true })]) : [];
  }

  // No finish: ideas of the chosen length from the start, ending at different stations.
  const [lo, hi] = RANGES[state.range];
  const mid = (lo + hi) / 2;
  const onward = state.trainTo != null ? trainSearch(tg, state.trainTo) : null;
  const cands = [];
  rides.forEach(([a, b, km10, road10], i) => {
    if (a !== S && b !== S) return;
    const km = km10 / 10;
    if (km < lo || km > hi) return;
    const e = a === S ? b : a;
    // With an onward train, prefer finishes with a shorter trip to it.
    const tOn = onward ? onward.minutes[e] : 0;
    if (!(tOn <= MAX_TRAIN_MIN)) return;
    const score = road10 * 1.5 + Math.abs(km - mid) * 0.5 + tOn * 0.4 + rnd(state.seed, S, e) * 40;
    cands.push([score, i, e]);
  });
  cands.sort((x, y) => x[0] - y[0]);

  // Keep the list varied: different finishes along different trails.
  const picked = [], sets = [];
  for (const [, i] of cands) {
    if (picked.length >= N_SUGGEST) break;
    const set = new Set(rides[i][4].map((q) => q[0]));
    const similar = sets.some((o) => {
      let inter = 0; for (const x of set) if (o.has(x)) inter++;
      return inter / (set.size + o.size - inter) >= 0.5;
    });
    if (similar) continue;
    picked.push(fromRide(i, S));
    sets.push(set);
  }

  // A ride opened from a shared link shows first.
  if (state.sharedEnd != null) {
    const e = state.sharedEnd;
    const already = picked.findIndex((c) => c.e === e);
    if (already >= 0) picked.unshift(...picked.splice(already, 1));
    else {
      const c = rideBetween(S, e);
      if (c) picked.unshift(Object.assign(c, { sharedLink: true }));
    }
    state.sharedEnd = null;
  }
  return addTrains(picked);
}

/** Adds the optional train to the start and train onwards from the finish. */
function addTrains(list) {
  const toStart = state.trainFrom != null ? trainSearch(tg, state.trainFrom) : null;
  for (const c of list) {
    c.out = toStart ? trainJourney(tg, net, toStart, c.s) || [] : null;
    c.back = state.trainTo != null ? trainJourney(tg, net, trainSearch(tg, c.e), state.trainTo) || [] : null;
    c.outStats = c.out ? journeyStats(c.out) : { mins: 0, changes: 0 };
    c.backStats = c.back ? journeyStats(c.back) : { mins: 0, changes: 0 };
    c.rideMins = (c.km / RIDE_KMH) * 60;
    c.total = c.outStats.mins + c.rideMins + c.backStats.mins;
    c.withTrains = !!(c.out || c.back);
  }
  return list;
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------
const stName = (i) => net.stations[i].name;

function trainStep(legs, stats, from, to, isReturn) {
  if (!legs.length) { // the train station is the ride's start / finish
    return `<li class="step"><span class="ico">${ICON.home}</span><div class="step-main">
      <div class="step-title">${isReturn ? `Finish at ${esc(stName(from))}` : `Start at ${esc(stName(to))}`}</div>
      <div class="step-sub">No train needed</div></div></li>`;
  }
  const parts = legs.map((l) => (l.type === 'walk'
    ? `<span>walk to ${esc(stName(l.to))}</span>`
    : lineChips(l.routes, 3)));
  const changes = legs.filter((l) => l.type === 'train').slice(1).map((l) => stName(l.from));
  const changeTxt = changes.length ? ` · change at ${esc(changes.join(', '))}` : '';
  const walking = legs.every((l) => l.type === 'walk');
  return `<li class="step"><span class="ico">${walking ? ICON.walk : ICON.train}</span><div class="step-main">
    <div class="step-title">${walking ? 'Walk' : 'Train'} ${esc(stName(from))} → ${esc(stName(to))}</div>
    <div class="step-sub">${parts.join(' <span class="sep">then</span> ')} <span class="nowrap">${fmtDur(stats.mins)}${changeTxt}</span></div></div></li>`;
}

function rideStep(c) {
  const chain = c.seq.map(([t]) => `<span>${esc(trails[t].name)}</span>`).join('<span class="sep">›</span>');
  const road = c.road >= 0.1 ? ` · ${fmtKm(c.road)} km on streets` : '';
  return `<li class="step ride"><span class="ico">${ICON.bike}</span><div class="step-main">
    <div class="step-title">Ride ${fmtKm(c.km)} km</div>
    <div class="step-sub"><span class="trail-chain">${chain}</span></div>
    <div class="step-sub">about ${fmtDur(c.rideMins)}${road}</div></div></li>`;
}

function renderCards() {
  const list = state.list;
  const [lo, hi] = RANGES[state.range];
  const ideas = state.finish == null;
  $('resultsTitle').textContent = state.start == null ? 'Your ride'
    : !ideas ? 'Your ride'
    : list.length ? `${list.length} ride ideas · ${lo}–${hi} km` : 'Ride ideas';
  $('shuffleBtn').hidden = !ideas || list.length < 2;

  if (state.start == null) {
    $('cards').innerHTML = `<li class="empty intro">
      <strong>Where would you like to start riding?</strong>
      <span>Choose a station above, use your location, pick a spot on the map, or tap any trail or station on the map.</span>
      <button class="btn primary" data-act="surprise" type="button">Surprise me</button>
    </li>`;
    renderPeek();
    return;
  }
  if (!list.length) {
    $('cards').innerHTML = ideas
      ? `<li class="empty">No ${lo}–${hi} km trail rides start at ${esc(stName(state.start))}. Try another distance, or choose where to finish.</li>`
      : `<li class="empty">Couldn’t find a trail route from ${esc(stName(state.start))} to ${esc(stName(state.finish))}. Try another finish.</li>`;
    renderPeek();
    return;
  }
  $('cards').innerHTML = list.map((c, i) => {
    const pill = c.sharedLink ? 'Shared ride' : c.chosen ? '' : i === 0 && !state.shuffled ? "Today's pick" : '';
    return `<li class="card" data-i="${i}" tabindex="0" role="button" aria-current="${i === state.sel}">
      <div class="card-top">
        <span class="km">${fmtKm(c.km)}<small> km</small></span>
        <span class="day">${c.withTrains ? 'day out' : 'riding'} ≈ ${fmtDur(c.total)}</span>
        ${pill ? `<span class="pill">${pill}</span>` : ''}
      </div>
      <h3>${esc(stName(c.s))} → ${esc(stName(c.e))}</h3>
      <ol class="steps">
        ${c.out ? trainStep(c.out, c.outStats, state.trainFrom, c.s, false) : ''}
        ${rideStep(c)}
        ${c.back ? trainStep(c.back, c.backStats, c.e, state.trainTo, true) : ''}
      </ol>
      <div class="card-actions">
        <a class="btn" href="${gmapsUrl(c)}" target="_blank" rel="noopener">Open ride in Google Maps ↗</a>
        <button class="btn" data-act="gpx">Download GPX</button>
      </div>
    </li>`;
  }).join('');
  renderPeek();
}

$('cards').addEventListener('click', (e) => {
  if (e.target.closest('a, button')) return;
  const card = e.target.closest('.card');
  if (!card) return;
  const i = +card.dataset.i;
  select(i === state.sel ? -1 : i, { fromList: true });
});
$('cards').addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('card')) {
    e.preventDefault(); e.target.click();
  }
});

function renderPeek() {
  const c = state.list[state.sel];
  const n = state.list.length;
  $('peekPrev').disabled = $('peekNext').disabled = n < 2;
  $('peekBody').innerHTML = c
    ? `<div class="peek-title"><span class="km">${fmtKm(c.km)}<small> km</small></span> ${esc(stName(c.s))} → ${esc(stName(c.e))}</div>
       <div class="peek-sub">${n > 1 ? `${state.sel + 1} of ${n} · ` : ''}${c.withTrains ? 'day out' : 'riding'} ≈ ${fmtDur(c.total)} · tap for details</div>`
    : state.start == null
      ? '<div class="peek-title">Where would you like to start riding?</div><div class="peek-sub">Tap here to choose</div>'
      : `<div class="peek-title">${n ? `${n} ride ideas` : 'No rides found'}</div><div class="peek-sub">Tap to see them</div>`;
}
$('peekPrev').addEventListener('click', () => step(-1));
$('peekNext').addEventListener('click', () => step(1));
function step(d) {
  const n = state.list.length;
  if (!n) return;
  select(((state.sel < 0 ? 0 : state.sel + d) % n + n) % n);
}

// ---------------------------------------------------------------------------
// Selected trip on the map
// ---------------------------------------------------------------------------
function rideResult(s) {
  if (!rideCache.has(s)) rideCache.set(s, dijkstra(g, g.stationNode(s), 250 * 1000));
  return rideCache.get(s);
}
const ridePieces = (c) => pathPieces(g, rideResult(c.s), g.stationNode(c.e));

function legCoords(leg) {
  if (leg.type === 'walk') return [net.stations[leg.from].ll, net.stations[leg.to].ll];
  const out = [];
  for (const { seg, reverse } of leg.segs) {
    let pts = net.segs[seg].g;
    if (reverse) pts = pts.slice().reverse();
    out.push(...(out.length ? pts.slice(1) : pts));
  }
  return out;
}

function pin(ll, kind, label, icon) {
  const m = L.marker(ll, {
    pane: 'pins', keyboard: false,
    icon: L.divIcon({ className: '', html: `<div class="pin ${kind}">${icon}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] }),
  });
  m.bindTooltip(esc(label), { permanent: true, direction: 'top', offset: [0, -16], className: 'pin-label' });
  return m.addTo(tripLayer);
}

// A train leg drawn as railway track: two rails with sleepers across them, in the line's colour.
function drawRailway(pts, color, halo) {
  const o = { renderer: rTrip, interactive: false, opacity: 1, lineJoin: 'round' };
  L.polyline(pts, { ...o, color: halo, weight: 17, opacity: 0.92 }).addTo(tripLayer);
  L.polyline(pts, { ...o, color, weight: 13, dashArray: '2.5 6', lineCap: 'butt' }).addTo(tripLayer); // sleepers
  L.polyline(pts, { ...o, color, weight: 2.4, offset: -4 }).addTo(tripLayer);                          // rail
  L.polyline(pts, { ...o, color, weight: 2.4, offset: 4 }).addTo(tripLayer);                           // rail
}

// ---------------------------------------------------------------------------
// Moving icons: trains and bikes travel along each leg in the direction of the trip.
// ---------------------------------------------------------------------------
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)');
let movers = [];
let moverFrame = 0;

function prepPath(p) {
  const cum = [0];
  for (let i = 1; i < p.coords.length; i++) cum.push(cum[i - 1] + haversine(...p.coords[i - 1], ...p.coords[i]));
  const km = cum[cum.length - 1] / 1000;
  // Seconds for one pass: longer legs take longer, within limits so short hops stay readable.
  const period = p.kind === 'bike' ? Math.min(16, Math.max(6, km * 0.45)) : Math.min(10, Math.max(3.5, km * 0.4));
  const count = p.kind === 'bike' ? Math.min(4, Math.max(2, Math.round(km / 7))) : km > 14 ? 2 : 1;
  return { ...p, cum, total: cum[cum.length - 1], period, count };
}

function pointAt(p, f) {
  const d = f * p.total;
  let lo = 0, hi = p.cum.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (p.cum[mid] <= d) lo = mid; else hi = mid; }
  const a = p.coords[lo], b = p.coords[hi];
  const t = p.cum[hi] > p.cum[lo] ? (d - p.cum[lo]) / (p.cum[hi] - p.cum[lo]) : 0;
  return { ll: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], west: b[1] < a[1] };
}

function moverIcon(p) {
  const glyph = p.kind === 'bike' ? ICON.bike : ICON.train;
  return L.divIcon({
    className: '',
    html: `<div class="mover ${p.kind}" style="--c:${p.color};--t:${p.text || '#fff'}">${glyph}</div>`,
    iconSize: [26, 26], iconAnchor: [13, 13],
  });
}

function startMovers(paths) {
  movers = paths.filter((p) => p.coords.length > 1).map(prepPath).map((p) => ({
    ...p,
    markers: Array.from({ length: p.count }, () =>
      L.marker(p.coords[0], { pane: 'movers', icon: moverIcon(p), interactive: false, keyboard: false }).addTo(tripLayer)),
  }));
  if (REDUCED_MOTION.matches) {
    // No animation: park the icons along each leg so the direction still reads.
    for (const p of movers) p.markers.forEach((m, j) => moveTo(m, p, (j + 0.6) / (p.count + 0.2)));
    return;
  }
  const t0 = performance.now();
  const frame = (now) => {
    const sec = (now - t0) / 1000;
    for (const p of movers) {
      p.markers.forEach((m, j) => {
        const f = (sec / p.period + j / p.count) % 1;
        moveTo(m, p, f);
        m.setOpacity(Math.min(1, f / 0.06, (1 - f) / 0.06)); // fade in at the start, out at the end
      });
    }
    moverFrame = requestAnimationFrame(frame);
  };
  moverFrame = requestAnimationFrame(frame);
}

function moveTo(m, p, f) {
  const { ll, west } = pointAt(p, f);
  m.setLatLng(ll);
  if (p.kind === 'bike') m.getElement()?.firstElementChild?.classList.toggle('west', west);
}

function stopMovers() {
  cancelAnimationFrame(moverFrame);
  movers = [];
}

let tripBounds = null;
function drawTrip(c, fit = true) {
  stopMovers();
  tripLayer.clearLayers();
  if (!c) {
    dimNetwork(false);
    tripBounds = null;
    // A start with no ride yet still gets its pin, so you can see what you picked.
    if (state.start != null) pin(net.stations[state.start].ll, 'ride', `Start biking at ${stName(state.start)}`, ICON.bike);
    return;
  }
  dimNetwork(true);
  const halo = cssVar('--panel') || '#fff';
  const bounds = L.latLngBounds([]);
  const paths = []; // what the moving icons follow, in travel order
  for (const leg of [...(c.out || []), ...(c.back || [])]) {
    const pts = legCoords(leg);
    pts.forEach((p) => bounds.extend(p));
    if (leg.type === 'walk') {
      const muted = cssVar('--muted');
      L.polyline(pts, { renderer: rTrip, color: halo, weight: 9, interactive: false }).addTo(tripLayer);
      L.polyline(pts, { renderer: rTrip, color: muted, weight: 4, dashArray: '1 7', lineCap: 'round', interactive: false }).addTo(tripLayer);
      continue;
    }
    const { color, text } = net.routes[leg.routes[0]];
    drawRailway(pts, color, halo);
    paths.push({ kind: 'train', coords: pts, color, text });
  }
  const trail = cssVar('--trail');
  const pieces = ridePieces(c);
  for (const p of pieces) {
    L.polyline(p.coords, { renderer: rTrip, color: halo, weight: 11, opacity: 1, interactive: false }).addTo(tripLayer);
    L.polyline(p.coords, {
      renderer: rTrip, color: trail, weight: 6.5, opacity: 1, lineCap: 'round',
      dashArray: p.road ? '1 10' : null, interactive: false,
    }).addTo(tripLayer);
    p.coords.forEach((q) => bounds.extend(q));
  }
  const rideCoords = pieces.flatMap((p, i) => (i ? p.coords.slice(1) : p.coords));
  if (rideCoords.length > 1) paths.push({ kind: 'bike', coords: rideCoords, color: trail });
  startMovers(paths);
  // One pin per station: ride start/finish take priority over the train stations.
  const placed = new Set();
  const place = (s, kind, label, icon) => {
    if (s == null || placed.has(s)) return;
    placed.add(s);
    pin(net.stations[s].ll, kind, label, icon);
  };
  place(c.s, 'ride', `Start biking at ${stName(c.s)}`, ICON.bike);
  place(c.e, 'ride', `Finish biking at ${stName(c.e)}`, ICON.flag);
  if (c.out) place(state.trainFrom, 'home', `Train from ${stName(state.trainFrom)}`, ICON.train);
  if (c.back) place(state.trainTo, 'home', `Train to ${stName(state.trainTo)}`, ICON.train);
  tripBounds = bounds;
  if (fit) fitTrip();
}

function fitTrip() {
  if (!tripBounds || !tripBounds.isValid()) return;
  if (!MOBILE.matches) {
    map.fitBounds(tripBounds, { paddingTopLeft: [60, 50], paddingBottomRight: [60, 40], maxZoom: 15 });
    return;
  }
  // Use where the sheet is heading, not where it is mid-animation.
  const visibleSheet = panel.offsetHeight - sheetY(panel.dataset.state);
  map.fitBounds(tripBounds, { paddingTopLeft: [56, 64], paddingBottomRight: [56, visibleSheet + 30], maxZoom: 15 });
}

function select(i, { fromList = false } = {}) {
  state.sel = i;
  document.querySelectorAll('.card').forEach((el) => el.setAttribute('aria-current', String(+el.dataset.i === i)));
  renderPeek();
  const c = state.list[i];
  if (MOBILE.matches && fromList && c) setSheet('peek');
  drawTrip(c, false);
  if (c) fitTrip();
  if (c && !MOBILE.matches) document.querySelector(`.card[data-i="${i}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  writeHash();
}

// ---------------------------------------------------------------------------
// Exports: Google Maps link, GPX file
// ---------------------------------------------------------------------------
function samplePath(c, fractions) {
  const pts = ridePieces(c).flatMap((p) => p.coords);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + haversine(...pts[i - 1], ...pts[i]));
  const total = cum[cum.length - 1];
  return fractions.map((f) => pts[Math.max(0, cum.findIndex((d) => d >= f * total))]);
}

function gmapsUrl(c) {
  const ll = (p) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`;
  const way = samplePath(c, [0.25, 0.5, 0.75]).map(ll).join('|');
  const q = new URLSearchParams({
    api: '1', travelmode: 'bicycling',
    origin: ll(net.stations[c.s].ll), destination: ll(net.stations[c.e].ll), waypoints: way,
  });
  return `https://www.google.com/maps/dir/?${q}`;
}

function downloadGpx(c) {
  if (!c) return;
  const pts = ridePieces(c).flatMap((p, i) => (i ? p.coords.slice(1) : p.coords));
  const name = `${stName(c.s)} to ${stName(c.e)} (${fmtKm(c.km)} km)`;
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Train and Trail" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>${esc(name)}</name><trkseg>
${pts.map(([la, lo]) => `    <trkpt lat="${la.toFixed(6)}" lon="${lo.toFixed(6)}"/>`).join('\n')}
  </trkseg></trk>
</gpx>
`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([gpx], { type: 'application/gpx+xml' }));
  a.download = `${stName(c.s)}-${stName(c.e)}.gpx`.replace(/\s+/g, '-').toLowerCase();
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
const opts = (list) => list.map(([n, i]) => `<option value="${i}">${esc(n)}</option>`).join('');

function buildControls() {
  const all = net.stations.map((s, i) => [s.name, i]).sort((a, b) => a[0].localeCompare(b[0]));
  const rideable = all.filter(([, i]) => rideStations.has(i));
  $('startSel').innerHTML = '<option value="">Choose a station…</option>' + opts(rideable);
  $('finishSel').innerHTML = '<option value="">Suggest by distance</option>' + opts(rideable);
  $('trainFromSel').innerHTML = opts(all);
  $('trainToSel').innerHTML = opts(all);
  $('rangeChips').innerHTML = RANGES.map(([lo, hi], i) =>
    `<button class="chip" role="radio" data-r="${i}" aria-checked="${i === state.range}">${lo}–${hi}<small> km</small></button>`).join('');

  $('startSel').addEventListener('change', (e) => {
    if (e.target.value === '') { state.start = null; refresh(); } else setPoint('start', +e.target.value);
  });
  $('finishSel').addEventListener('change', (e) => {
    if (e.target.value === '') { state.finish = null; refresh(); } else setPoint('finish', +e.target.value);
  });
  $('trainFromSel').addEventListener('change', (e) => setPoint('trainFrom', +e.target.value));
  $('trainToSel').addEventListener('change', (e) => setPoint('trainTo', +e.target.value));
  $('rangeChips').addEventListener('click', (e) => {
    const b = e.target.closest('.chip'); if (!b) return;
    state.range = +b.dataset.r; refresh();
  });

  // Optional trains: add / remove.
  const remembered = (key) => { const i = stationByName(store.get(key)); return i >= 0 ? i : null; };
  const fallback = Math.max(0, stationByName(DEFAULT_TRAIN_STATION));
  $('addFromBtn').addEventListener('click', () => {
    state.trainFrom = remembered('tt.from') ?? fallback;
    refresh();
    $('trainFromSel').focus();
  });
  $('addToBtn').addEventListener('click', () => {
    state.trainTo = state.trainFrom ?? remembered('tt.to') ?? fallback;
    refresh();
    $('trainToSel').focus();
  });
  $('removeFromBtn').addEventListener('click', () => { state.trainFrom = null; refresh(); });
  $('removeToBtn').addEventListener('click', () => { state.trainTo = null; refresh(); });

  $('shuffleBtn').addEventListener('click', () => { state.seed += 1; state.shuffled = true; refresh(); });
  $('locateStartBtn').addEventListener('click', () => locate('start'));
  $('locateFromBtn').addEventListener('click', () => locate('trainFrom'));
  for (const which of ['start', 'finish', 'trainFrom', 'trainTo']) {
    $(`pick-${which}`).addEventListener('click', () => startPick(which));
  }
  $('pickCancel').addEventListener('click', endPick);
}

/** Puts the state into the form and shows / hides the optional train rows. */
function syncControls() {
  $('startSel').value = state.start == null ? '' : String(state.start);
  $('finishSel').value = state.finish == null ? '' : String(state.finish);
  if (state.trainFrom != null) $('trainFromSel').value = String(state.trainFrom);
  if (state.trainTo != null) $('trainToSel').value = String(state.trainTo);
  document.querySelectorAll('#rangeChips .chip').forEach((b) => b.setAttribute('aria-checked', String(+b.dataset.r === state.range)));
  const hasStart = state.start != null;
  $('rangeField').hidden = state.finish != null;
  $('addFromBtn').hidden = !hasStart || state.trainFrom != null;
  $('fromRow').hidden = !hasStart || state.trainFrom == null;
  $('addToBtn').hidden = !hasStart || state.trainTo != null;
  $('toRow').hidden = !hasStart || state.trainTo == null;
  $('addFromBtn').querySelector('span').textContent = hasStart ? `Get to ${stName(state.start)} by train` : '';
  $('addToBtn').querySelector('span').textContent = state.finish != null
    ? `Continue by train from ${stName(state.finish)}` : 'Continue by train after the ride';
}

// ---------------------------------------------------------------------------
// "Choose on map": tap anywhere, and the nearest station is used.
// Ride start / finish use stations next to a trail; train stops can be any station.
// ---------------------------------------------------------------------------
const PICK_TEXT = {
  start: 'Tap the map where you’d like to start riding.',
  finish: 'Tap the map where you’d like to finish riding.',
  trainFrom: 'Tap the map where you’ll catch the train from.',
  trainTo: 'Tap the map where you want the train to take you.',
};
function startPick(which) {
  state.picking = which;
  document.body.classList.add('picking');
  $('pickText').textContent = `${PICK_TEXT[which]} The nearest station will be used.`;
  $('pickBanner').hidden = false;
  map.closePopup();
  if (MOBILE.matches) setSheet('peek');
}

function endPick() {
  state.picking = null;
  document.body.classList.remove('picking');
  $('pickBanner').hidden = true;
}

// "preclick" always reaches the map, even when the tap lands on a trail or station
// (their popups stop the normal "click"). Popups are held back for that tap.
let noPopupsUntil = 0;
map.on('popupopen', () => { if (state.picking || Date.now() < noPopupsUntil) map.closePopup(); });
const POINT_WORDS = { start: 'Start biking at', finish: 'Finish biking at', trainFrom: 'Train from', trainTo: 'Train to' };
map.on('preclick', (e) => {
  lastTap = e.latlng;
  if (!state.picking) return;
  noPopupsUntil = Date.now() + 500;
  const which = state.picking;
  const [best, bd] = nearestStation(e.latlng.lat, e.latlng.lng, which === 'start' || which === 'finish' ? rideStations : null);
  if (bd > 8000) { toast('That spot is more than 8 km from a suitable station. Try closer to a trail or train line.'); return; }
  endPick();
  if (MOBILE.matches) setSheet('half'); // before refresh, so the new ride is fitted above the sheet
  setPoint(which, best);
  toast(`${POINT_WORDS[which]} ${stName(best)} station${bd > 300 ? ` (${fmtKm(bd / 1000)} km from where you tapped)` : ''}.`);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.picking) endPick(); });

// "Near me": the ride start (nearest trail-side station) or the train-from station.
function locate(which) {
  const btn = $(which === 'start' ? 'locateStartBtn' : 'locateFromBtn');
  const useFix = (la, lo) => {
    const [best, bd] = nearestStation(la, lo, which === 'start' ? rideStations : null);
    if (bd > 60000) { toast('You seem to be outside Melbourne, so nothing was changed.'); return; }
    setPoint(which, best);
    toast(`${POINT_WORDS[which]} ${stName(best)}, the nearest station (${fmtKm(bd / 1000)} km away).`);
  };
  if (me.fix && Date.now() - me.fix.at < 120000) { useFix(...me.fix.ll); return; }
  if (!('geolocation' in navigator)) { toast('This browser can’t share your location.'); return; }
  if (!window.isSecureContext) { toast('Your location only works on a secure (https) page, e.g. the published site on github.io.'); return; }
  btn.disabled = true;
  navigator.geolocation.getCurrentPosition((pos) => {
    btn.disabled = false;
    useFix(pos.coords.latitude, pos.coords.longitude);
    // Keep showing the blue dot from now on, without moving the map off the ride.
    me.centred = true;
    showFix(pos);
    me.wanted = true;
    startWatch();
  }, (err) => {
    btn.disabled = false;
    toast(err.code === 1 ? 'Location is blocked for this site. You can allow it in your browser’s site settings.' : 'Couldn’t get your location.');
  }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
}

function refresh({ keepSelection = false } = {}) {
  syncControls();
  const save = (k, i) => store.set(k, i == null ? '' : stName(i));
  save('tt.start', state.start);
  save('tt.finish', state.finish);
  if (state.trainFrom != null) save('tt.from', state.trainFrom); // remembered even after removing,
  if (state.trainTo != null) save('tt.to', state.trainTo);       // as the next "add train" default
  store.set('tt.trains', `${state.trainFrom != null ? 1 : 0}${state.trainTo != null ? 1 : 0}`);
  store.set('tt.range', String(state.range));
  state.list = suggest();
  state.sel = -1;
  renderCards();
  select(state.list.length ? 0 : -1);
  if (!keepSelection) $('panelScroll').scrollTo?.({ top: 0 });
}

// ---------------------------------------------------------------------------
// URL hash (shareable links):
//   #start=Hughesdale&finish=Alphington&from=Anzac&to=Flinders%20Street
//   #start=Hughesdale&km=20-30&ride=Alphington      (ideas by distance, one selected)
// ---------------------------------------------------------------------------
const stationByName = (n) => net.stations.findIndex((s) => s.name.toLowerCase() === String(n || '').toLowerCase());
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (![...p.keys()].length) return false;
  const st = (k) => { const i = stationByName(p.get(k)); return i >= 0 ? i : null; };
  const ride = (p.get('ride') || '').split('~'); // older links: ride=Start~Finish
  state.start = st('start') ?? (ride.length === 2 ? stationByName(ride[0]) : -1);
  if (!(state.start >= 0 && rideStations.has(state.start))) state.start = null;
  state.finish = st('finish');
  if (state.finish != null && (!rideStations.has(state.finish) || state.finish === state.start)) state.finish = null;
  state.trainFrom = st('from');
  state.trainTo = st('to');
  const r = RANGES.findIndex(([lo, hi]) => `${lo}-${hi}` === p.get('km'));
  if (r >= 0) state.range = r;
  const end = stationByName(ride[ride.length - 1]);
  if (state.finish == null && end >= 0) state.sharedEnd = end;
  return true;
}
function writeHash() {
  const p = new URLSearchParams();
  if (state.start != null) p.set('start', stName(state.start));
  if (state.finish != null) p.set('finish', stName(state.finish));
  else p.set('km', RANGES[state.range].join('-'));
  if (state.trainFrom != null) p.set('from', stName(state.trainFrom));
  if (state.trainTo != null) p.set('to', stName(state.trainTo));
  const c = state.list[state.sel];
  if (c && state.finish == null) p.set('ride', stName(c.e));
  history.replaceState(null, '', '#' + p.toString().replace(/\+/g, '%20'));
}

// ---------------------------------------------------------------------------
// Bottom sheet (phones)
// ---------------------------------------------------------------------------
const panel = $('panel');
const peekH = () => parseFloat(cssVar('--peek-h')) || 92;
function sheetY(name) {
  const H = panel.offsetHeight;
  return name === 'full' ? 0 : name === 'half' ? Math.round(H * 0.45) : H - peekH();
}
function setSheet(name) {
  panel.dataset.state = name;
  if (MOBILE.matches) panel.style.setProperty('--sheet-y', `${sheetY(name)}px`);
}
let drag = null;
function onDown(e) {
  if (!MOBILE.matches || e.target.closest('button, a')) return;
  drag = { y0: e.clientY, base: sheetY(panel.dataset.state), y: sheetY(panel.dataset.state), moved: false, id: e.pointerId, el: e.currentTarget };
  panel.classList.add('dragging');
  e.currentTarget.setPointerCapture?.(e.pointerId);
}
function onMove(e) {
  if (!drag) return;
  const dy = e.clientY - drag.y0;
  if (Math.abs(dy) > 5) drag.moved = true;
  drag.y = Math.max(0, Math.min(panel.offsetHeight - peekH(), drag.base + dy));
  panel.style.setProperty('--sheet-y', `${drag.y}px`);
}
function onUp() {
  if (!drag) return;
  const d = drag; drag = null;
  panel.classList.remove('dragging');
  const cur = panel.dataset.state;
  if (!d.moved) { setSheet(cur === 'peek' ? 'half' : cur === 'half' ? 'full' : 'peek'); return; }
  const best = ['full', 'half', 'peek'].reduce((a, b) => (Math.abs(sheetY(a) - d.y) <= Math.abs(sheetY(b) - d.y) ? a : b));
  setSheet(best);
  if (best === 'peek') fitTrip();
}
for (const el of [$('sheetGrab'), $('peek')]) {
  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onUp);
}
$('sheetGrab').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const c = panel.dataset.state; setSheet(c === 'peek' ? 'half' : c === 'half' ? 'full' : 'peek'); }
});
window.addEventListener('resize', () => setSheet(panel.dataset.state));
// Keep Leaflet in sync with its container whatever changes the layout.
let fitPending = true;
new ResizeObserver(() => {
  map.invalidateSize();
  if (fitPending && tripBounds) { fitPending = false; fitTrip(); }
}).observe($('map'));
MOBILE.addEventListener?.('change', () => {
  if (!MOBILE.matches) panel.style.removeProperty('--sheet-y'); else setSheet(panel.dataset.state);
  setTimeout(() => { map.invalidateSize(); fitTrip(); }, 50);
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  const get = (n) => fetch(`data/${n}.json`).then((r) => { if (!r.ok) throw new Error(`data/${n}.json: ${r.status}`); return r.json(); });
  const [T, N, G, RD] = await Promise.all(['trails', 'network', 'graph', 'rides'].map(get));
  trails = T.trails; net = N; rides = RD.rides;
  g = buildRideGraph(trails, G.extra, G.stationLinks, net.stations.map((s) => s.ll));
  tg = buildTrainGraph(net);
  rideStations = new Set(G.stationLinks.map((l) => l[0]));
  for (const [s, node] of G.stationLinks) {
    const t = g.trailOf[node];
    if (!trailStations.has(t)) trailStations.set(t, []);
    trailStations.get(t).push(s);
  }
  $('builtDate').textContent = `timetable of ${N.built}`;

  drawNetwork();
  buildControls();
  window.trainAndTrail = { map, state, trailLines }; // handy for debugging in the console

  // A shared link wins; otherwise pick up where this device left off.
  if (!readHash()) {
    const st = (k) => { const i = stationByName(store.get(k)); return i >= 0 ? i : null; };
    const start = st('tt.start');
    state.start = start != null && rideStations.has(start) ? start : null;
    const finish = st('tt.finish');
    state.finish = finish != null && rideStations.has(finish) && finish !== state.start ? finish : null;
    const trains = store.get('tt.trains') || '00';
    if (trains[0] === '1') state.trainFrom = st('tt.from');
    if (trains[1] === '1') state.trainTo = st('tt.to');
    const r = parseInt(store.get('tt.range'), 10);
    if (r >= 0 && r < RANGES.length) state.range = r;
  }

  setSheet('half');
  refresh();
  map.invalidateSize();
  fitTrip();
  $('loading').classList.add('done');
  setTimeout(() => $('loading').remove(), 400);
}

// Offline support for the installed app (needs https; localhost works for testing).
// Registered once the app's own data is in, rather than on window "load", which waits for every map tile.
function registerServiceWorker() {
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker:', e.message));
  }
}

boot().then(registerServiceWorker).catch((err) => {
  console.error(err);
  $('loading').innerHTML = `<p>Sorry, the map data could not be loaded.<br><small>${esc(err.message)}</small></p>`;
});
