/* FRONTLINES — service worker (çevrimdışı açılış + otomatik güncelleme)
   Sürüm: 20261122-1814
   • index.html  → önce önbellek (anında açılır), arkada yenisini indirir; yenisi gelirse sayfaya haber verir
   • data.json   → önce ağ (6 sn), olmazsa son önbellek: içerik her açılışta tazelenir
   • Leaflet / yazı tipleri → önbellekte kalır (çevrimdışı harita kütüphanesi)
   • Harita karoları, Telegram, Catbox vb. dış istekler → hiç karışılmaz */
const VER = '20261122-1814';
const SHELL = 'fl-shell-' + VER;
const DATA = 'fl-data';
const LIBS = 'fl-libs-1';
const PRE = ['./', './data.json', './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];
const LIB_HOSTS = ['cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    /* tek tek: biri (ör. data.json yoksa) olmasa da kurulum bozulmasın */
    await Promise.all(PRE.map(u => c.add(new Request(u, { cache: 'no-cache' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keep = [SHELL, DATA, LIBS];
    for (const k of await caches.keys()) if (!keep.includes(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

async function notify(msg) {
  for (const c of await self.clients.matchAll({ includeUncontrolled: true })) c.postMessage(msg);
}

function changed(a, b) {
  if (!a || !b) return true;
  const ea = a.headers.get('etag'), eb = b.headers.get('etag');
  if (ea && eb) return ea !== eb;
  const la = a.headers.get('last-modified'), lb = b.headers.get('last-modified');
  if (la && lb) return la !== lb;
  const na = a.headers.get('content-length'), nb = b.headers.get('content-length');
  return !!(na && nb && na !== nb);
}

/* index: önbellek önce, arkada tazele */
async function shell(req) {
  const c = await caches.open(SHELL);
  const hit = await c.match('./', { ignoreSearch: true });
  const refresh = (async () => {
    try {
      const r = await fetch(new Request('./', { cache: 'no-cache' }));
      if (r && r.ok) {
        const diff = changed(hit, r);
        await c.put('./', r.clone());
        if (hit && diff) notify({ type: 'fl-updated', what: 'app' });
      }
      return r;
    } catch (err) { return null; }
  })();
  if (hit) return hit;                      /* anında aç; güncelleme arkada sürer */
  const r = await refresh;                  /* ilk kurulum / önbellek boş */
  return r || new Response('Offline — open the app once while online first.', { status: 503, headers: { 'content-type': 'text/plain' } });
}

/* data.json: ağ önce */
async function data(req) {
  const c = await caches.open(DATA);
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 6000);
    const r = await fetch(new Request(req, { cache: 'no-store' }), { signal: ctl.signal });
    clearTimeout(t);
    if (r && r.ok) { c.put(req, r.clone()); return r; }
    throw new Error('http ' + (r && r.status));
  } catch (err) {
    const hit = (await c.match(req, { ignoreSearch: true })) || (await (await caches.open(SHELL)).match('./data.json'));
    if (hit) return hit;
    throw err;
  }
}

/* kütüphane / yazı tipi: önbellek önce */
async function lib(req) {
  const c = await caches.open(LIBS);
  const hit = await c.match(req);
  if (hit) return hit;
  const r = await fetch(req);
  if (r && (r.ok || r.type === 'opaque')) c.put(req, r.clone());
  return r;
}

/* diğer aynı-köken dosyalar (ikonlar, manifest): önbellek önce, yoksa ağ */
async function same(req) {
  const c = await caches.open(SHELL);
  const hit = await c.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const r = await fetch(req);
  if (r && r.ok) c.put(req, r.clone());
  return r;
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (u.origin === self.location.origin) {
    if (req.mode === 'navigate' && (u.pathname.endsWith('/') || u.pathname.endsWith('/index.html'))) { e.respondWith(shell(req)); return; }
    if (/\/data\.json$/.test(u.pathname)) { e.respondWith(data(req)); return; }
    if (/\/(sw\.js)$/.test(u.pathname)) return;                  /* SW'nin kendisine dokunma */
    if (/\.(png|svg|webmanifest|ico)$/.test(u.pathname)) { e.respondWith(same(req)); return; }
    return;
  }
  if (LIB_HOSTS.includes(u.hostname)) e.respondWith(lib(req));
});
