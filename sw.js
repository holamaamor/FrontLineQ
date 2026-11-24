/* FRONTLINES — service worker (çevrimdışı açılış + sağlam otomatik güncelleme)
   Sürüm: 20261124-1840
   • Kurulum hafif: hiçbir büyük dosya indirmez, anında biter (eskiden 36 MB'lık sayfa kurulumda iniyordu;
     telefonda yarım kalınca yeni sürüm hiç devreye giremiyordu).
   • index.html → önce önbellek (anında açılır). Arkada önce küçük bir HEAD isteğiyle "değişti mi?" bakılır;
     yalnızca değiştiyse tam indirilir. İndirme event.waitUntil ile korunur (tarayıcı yarıda öldürmez);
     yarım inen dosya önbelleğe yazılmaz, eskisi kalır ve bir sonraki açılışta yeniden denenir.
   • PARÇALI İNDİRME (CHUNK-v1): yeni sayfa tek bir 14 MB'lık istek yerine 1 MB'lık Range parçalarıyla iner; her parça ayrı denenir
     (5 deneme), kesilen parça baştan değil kaldığı yerden tekrarlanır. Sunucu Range desteklemezse eski tek istek kullanılır.
     Bütün parçalar gelmeden, boyut ve </html> kuyruğu doğrulanmadan önbelleğe yazılmaz. Başarısızlıkta gerçek neden sayfaya iletilir.
   • Sayfa istek üzerine ("check") güncelleme denetler; yenisi inince sayfaya "fl-updated" haberi gider.
   • data.json / auto.json (siteyle gelen kopya) → önce ağ (6 sn), olmazsa son önbellek
     (asıl güncel veri GitHub veri deposundan sayfa tarafından okunur — bkz. FL_DATA_BASE)
   • Leaflet / yazı tipleri → önbellekte kalır. Harita karoları, Telegram, Catbox vb. dış istekler → karışılmaz */
const VER = '20261124-1840';
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

/* CHUNK-v1 --------------------------------------------------------------------------------------------------- */
const CHUNK = 1024 * 1024;
let lastInfo = '';                                      /* son denetimin kısa açıklaması (sayfada gösterilir) */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const errText = e => String((e && e.message) || e || 'error').slice(0, 90);

/* bir bayt aralığını getir; geçici hatada (ağ, 5xx, 429) tekrar dener. 206 → {buf,total,etag}; 200 → {resp} (Range yok sayıldı ya da dosya değişti) */
async function getRange(url, from, to, etag, tries, label) {
  let last = '';
  for (let a = 1; a <= tries; a++) {
    try {
      const h = { Range: 'bytes=' + from + '-' + to };
      if (etag && !/^W\//.test(etag)) h['If-Range'] = etag;
      const r = await fetch(new Request(url, { cache: 'no-store', headers: h }));
      if (r.status === 206) {
        const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(r.headers.get('content-range') || '');
        if (!m || +m[1] !== from) throw new Error('bad Content-Range');
        const buf = new Uint8Array(await r.arrayBuffer());
        if (buf.length !== (+m[2] - +m[1] + 1)) throw new Error('short part');
        return { status: 206, buf, total: m[3] === '*' ? 0 : +m[3], etag: r.headers.get('etag') || '' };
      }
      if (r.status === 200) return { status: 200, resp: r };
      last = 'HTTP ' + r.status;
      if (r.status < 500 && r.status !== 429 && r.status !== 408) { const e = new Error(label + ': ' + last); e.fatal = true; throw e; }
    } catch (e) { if (e && e.fatal) throw e; last = errText(e); }
    lastInfo = label + ' failed (' + last + '), try ' + a + '/' + tries;
    if (a < tries) await sleep(500 * a);
  }
  throw new Error(label + ': ' + last);
}

/* yeni index'i indir: { resp, how } — parça parça; Range yoksa tek istek */
async function downloadIndex() {
  const url = './';
  for (let round = 0; round < 2; round++) {
    const first = await getRange(url, 0, CHUNK - 1, '', 5, 'part 1');
    if (first.status === 200) {                         /* sunucu Range desteklemiyor: tek istek (eski davranış) */
      return { resp: first.resp, how: 'single request (no Range support)' };
    }
    const total = first.total, etag = first.etag, n = total ? Math.ceil(total / CHUNK) : 0;
    if (!total) return { resp: await fetch(new Request(url, { cache: 'no-cache' })), how: 'single request (size unknown)' };
    const parts = [first.buf];
    let changed = false;
    for (let i = 1; i < n; i++) {
      const from = i * CHUNK, to = Math.min(total, from + CHUNK) - 1;
      const p = await getRange(url, from, to, etag, 5, 'part ' + (i + 1) + '/' + n);
      if (p.status === 200) { changed = true; break; }  /* If-Range uyuşmadı: site güncellendi, baştan */
      parts.push(p.buf);
      if (i % 2 === 0) notify({ type: 'fl-progress', done: i + 1, total: n });
    }
    if (changed) continue;
    const blob = new Blob(parts, { type: 'text/html; charset=utf-8' });
    if (blob.size !== total) throw new Error('size mismatch (' + blob.size + ' of ' + total + ')');
    const tail = await blob.slice(Math.max(0, blob.size - 400)).text();
    if (!/<\/html>\s*$/i.test(tail)) throw new Error('page incomplete (no </html> at the end)');
    return { resp: new Response(blob, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'etag': etag } }), how: n + ' parts of 1 MB' };
  }
  throw new Error('the site was updated again during the download — try again');
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
      lastInfo = '';
      let d;
      try { d = await downloadIndex(); } catch (err) { lastInfo = errText(err); return 'fail'; }
      const r = d.resp;
      if (!r || !r.ok) { lastInfo = 'HTTP ' + (r && r.status); return 'fail'; }
      const sig = now || sigOf(r);
      try {
        await c.put('./', r.clone());                   /* gövde yarım kalırsa burada hata verir; eski kopya yerinde kalır */
        await c.put(SIGKEY, new Response(sig));
      } catch (err) { lastInfo = 'could not store the app copy (' + errText(err) + ')'; return 'fail'; }
      lastInfo = d.how;
      if (hit && old && sig !== old) await notify({ type: 'fl-updated', what: 'app' });
      return (hit && old && sig === old) ? 'same' : 'new';
    } catch (err) { lastInfo = errText(err); return 'fail'; }
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
    e.waitUntil((async () => { const res = await refreshIndex(); reply({ type: 'fl-check', result: res, ver: VER, info: lastInfo }); })());
  }
});
