/* FRONTLINES — service worker (çevrimdışı açılış + sağlam otomatik güncelleme)
   Sürüm: 20261123-1130
   • Kurulum hafif: hiçbir büyük dosya indirmez, anında biter (eskiden 36 MB'lık sayfa kurulumda iniyordu;
     telefonda yarım kalınca yeni sürüm hiç devreye giremiyordu).
   • index.html → önce önbellek (anında açılır). Arkada önce küçük bir HEAD isteğiyle "değişti mi?" bakılır;
     yalnızca değiştiyse tam indirilir. İndirme event.waitUntil ile korunur (tarayıcı yarıda öldürmez);
     yarım inen dosya önbelleğe yazılmaz, eskisi kalır ve bir sonraki açılışta yeniden denenir.
   • Sayfa istek üzerine ("check") güncelleme denetler; yenisi inince sayfaya "fl-updated" haberi gider.
   • data.json / auto.json (siteyle gelen kopya) → önce ağ (6 sn), olmazsa son önbellek
     (asıl güncel veri GitHub veri deposundan sayfa tarafından okunur — bkz. FL_DATA_BASE)
   • Leaflet / yazı tipleri → önbellekte kalır. Harita karoları, Telegram, Catbox vb. dış istekler → karışılmaz */
const VER = '20261123-1130';
const APP = 'fl-app';
const DATA = 'fl-data';
const LIBS = 'fl-libs-1';
const SMALL = ['./manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];
const LIB_HOSTS = ['cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];
const SIGKEY = './__index-sig';

self.addEventListener('install', e => {
  self.skipWaiting();                                   /* büyük iş yok → kurulum anında biter */
  e.waitUntil((async () => {
    try {
      const c = await caches.open(APP);
      await Promise.all(SMALL.map(u => c.add(new Request(u, { cache: 'no-cache' })).catch(() => {})));
    } catch (err) {}
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keep = [APP, DATA, LIBS];
    for (const k of await caches.keys()) if (!keep.includes(k)) await caches.delete(k);   /* eski fl-shell-* önbellekleri */
    await self.clients.claim();
  })());
});

async function notify(msg) {
  for (const c of await self.clients.matchAll({ includeUncontrolled: true })) c.postMessage(msg);
}

/* "değişti mi" imzası: etag → last-modified → content-length */
function sigOf(r) {
  if (!r) return '';
  return r.headers.get('etag') || r.headers.get('last-modified') || ('len:' + (r.headers.get('content-length') || ''));
}
async function headSig() {
  try {
    const r = await fetch(new Request('./', { method: 'HEAD', cache: 'no-cache' }));
    if (r && r.ok) return sigOf(r);
  } catch (err) {}
  return null;                                          /* çevrimdışı ya da HEAD desteklenmiyor */
}
async function storedSig(c) {
  try { const r = await c.match(SIGKEY); return r ? await r.text() : ''; } catch (err) { return ''; }
}

/* index'i tazele: 'same' | 'new' | 'fail' — aynı anda yalnızca bir tane */
let inflight = null;
function refreshIndex() {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const c = await caches.open(APP);
      const hit = await c.match('./', { ignoreSearch: true });
      const old = await storedSig(c);
      const now = await headSig();
      if (hit && now && old && now === old) return 'same';
      const r = await fetch(new Request('./', { cache: 'no-cache' }));
      if (!r || !r.ok) return 'fail';
      const sig = now || sigOf(r);
      await c.put('./', r.clone());                     /* gövde yarım kalırsa burada hata verir; eski kopya yerinde kalır */
      await c.put(SIGKEY, new Response(sig));
      if (hit && old && sig !== old) await notify({ type: 'fl-updated', what: 'app' });
      return (hit && old && sig === old) ? 'same' : 'new';
    } catch (err) { return 'fail'; }
    finally { inflight = null; }
  })();
  return inflight;
}

/* index: önbellek önce, arkada (korumalı) tazele */
async function shell(req) {
  try {
    const c = await caches.open(APP);
    const hit = await c.match('./', { ignoreSearch: true });
    if (hit) return { resp: hit, bg: refreshIndex() };
    /* önbellek boş (ilk kurulum / sıfırlama): doğrudan ağdan ver, kopyasını arkada sakla */
    const hp = headSig();
    const r = await fetch(new Request('./', { cache: 'no-cache' }));
    let bg = null;
    if (r && r.ok) {
      const copy = r.clone();
      bg = (async () => {
        try { await c.put('./', copy); await c.put(SIGKEY, new Response((await hp) || sigOf(r))); } catch (err) {}
      })();
    }
    return { resp: r, bg };
  } catch (err) {
    return { resp: new Response('Offline — open the app once while online first.', { status: 503, headers: { 'content-type': 'text/plain' } }), bg: null };
  }
}

/* data.json / auto.json: ağ önce */
async function data(req) {
  const c = await caches.open(DATA);
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 6000);
    const r = await fetch(new Request(req, { cache: 'no-store' }), { signal: ctl.signal });
    clearTimeout(t);
    if (r && r.ok) { c.put(req, r.clone()); return r; }
    throw new Error('http ' + (r && r.status));
  } catch (err) {
    const hit = (await c.match(req, { ignoreSearch: true })) || (await (await caches.open(APP)).match('./' + (new URL(req.url).pathname.split('/').pop() || 'data.json')));
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
  const c = await caches.open(APP);
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
    if (req.mode === 'navigate' && (u.pathname.endsWith('/') || u.pathname.endsWith('/index.html'))) {
      const p = shell(req);
      e.respondWith(p.then(x => x.resp));
      e.waitUntil(p.then(x => x.bg).catch(() => {}));       /* arka plan indirmesi bitene kadar işçiyi canlı tut */
      return;
    }
    if (/\/(data|auto)\.json$/.test(u.pathname)) { e.respondWith(data(req)); return; }
    if (/\/(sw\.js)$/.test(u.pathname)) return;                  /* SW'nin kendisine dokunma */
    if (/\.(png|svg|webmanifest|ico)$/.test(u.pathname)) { e.respondWith(same(req)); return; }
    return;
  }
  if (LIB_HOSTS.includes(u.hostname)) e.respondWith(lib(req));
});

/* sayfadan gelen istekler: 'ver' (sürüm sor) · 'check' (güncelleme denetle) */
self.addEventListener('message', e => {
  const d = e.data || {};
  const reply = m => { try { if (e.source) e.source.postMessage(m); } catch (err) {} };
  if (d.type === 'ver') {
    e.waitUntil((async () => {
      let cached = false, sig = '';
      try { const c = await caches.open(APP); cached = !!(await c.match('./', { ignoreSearch: true })); sig = await storedSig(c); } catch (err) {}
      reply({ type: 'fl-ver', ver: VER, cached, sig });
    })());
  } else if (d.type === 'check') {
    e.waitUntil((async () => { const res = await refreshIndex(); reply({ type: 'fl-check', result: res, ver: VER }); })());
  }
});
