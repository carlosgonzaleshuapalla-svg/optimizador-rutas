/* Service worker generado por herramientas/construir_web.py — no editar a mano. */
const VERSION = 'rutas-79373fe2abb3';
const ARCHIVOS = ["./README.md", "./app.js", "./estilos.css", "./icons/icon-180.png", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/icon-maskable-512.png", "./", "./lib/contornos.svg", "./lib/fonts/EBGaramond-400.woff2", "./lib/fonts/OFL-eb-garamond.txt", "./lib/fonts/OFL-inter.txt", "./lib/fonts/inter-latin-400-normal.woff2", "./lib/fonts/inter-latin-500-normal.woff2", "./lib/leaflet.css", "./lib/leaflet.js", "./manifest.webmanifest", "./motor.js", "./registro-sw.js"];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
/* Red primero para lo propio (así las actualizaciones llegan de inmediato) y caché si no hay internet.
   Nominatim, OSRM y las teselas de OpenStreetMap NO se interceptan ni se guardan. */
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (u.origin !== self.location.origin) return;
  e.respondWith(fetch(r).then(resp => {
    if (resp && resp.ok) { const copia = resp.clone(); caches.open(VERSION).then(c => c.put(r, copia)); }
    return resp;
  }).catch(() => caches.match(r, { ignoreSearch: true }).then(x => x || (r.mode === 'navigate' ? caches.match('./') : Response.error()))));
});
