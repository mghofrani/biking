// Service worker: lets the installed app open without a connection (e.g. out on a trail).
// - Site files and data: network first, falling back to the last saved copy when offline.
// - Leaflet from the CDN: saved once (the URLs are versioned, so they never change).
// - Map tiles are left to the browser's normal cache (OpenStreetMap's tile policy).

const CACHE = 'train-trail-v1';
const SHELL = [
  './',
  'index.html',
  'css/style.css',
  'js/app.js',
  'js/ridegraph.js',
  'js/trains.js',
  'data/trails.json',
  'data/network.json',
  'data/graph.json',
  'data/rides.json',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
];
const CDN = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/leaflet-polylineoffset@1.1.1/leaflet.polylineoffset.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    // Save files one by one: if one can't be saved, the app still installs and works online.
    try {
      const cache = await caches.open(CACHE);
      await Promise.all([
        ...SHELL.map((u) => fetch(u, { cache: 'reload' }).then((r) => r.ok && cache.put(u, r))),
        ...CDN.map((u) => fetch(u, { mode: 'no-cors' }).then((r) => cache.put(u, r))),
      ].map((p) => p.catch(() => {})));
    } catch { /* storage unavailable (e.g. private mode): still install */ }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(req));
  } else if (url.hostname === 'unpkg.com') {
    event.respondWith(cacheFirst(req));
  }
  // Everything else (map tiles, outside links) goes straight to the network.
});

const save = (req, res) => caches.open(CACHE).then((c) => c.put(req, res)).catch(() => {});
const find = (req, opts) => caches.match(req, opts).catch(() => undefined);

async function networkFirst(req) {
  try {
    const res = await fetch(req);
    if (res.ok) save(req, res.clone());
    return res;
  } catch (err) {
    const hit = (await find(req, { ignoreSearch: true })) || (req.mode === 'navigate' && (await find('index.html')));
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(req) {
  const hit = await find(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') save(req, res.clone());
  return res;
}
