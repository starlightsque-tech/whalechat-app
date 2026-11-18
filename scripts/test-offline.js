#!/usr/bin/env node
/* Offline-readiness check — fails if the installed app would be missing
   anything it needs with the network switched off.

   Run: npm run test:offline   (after npm run build) */
'use strict';
const fs = require('fs');
const path = require('path');

const PUB = path.resolve(__dirname, '..', 'public');
const fail = [];
const warn = [];
const ok = [];

function read(p) { return fs.readFileSync(p, 'utf8'); }

/* 1. manifest exists and is complete -------------------------------------- */
const manifestFile = path.join(PUB, 'offline-manifest.json');
if (!fs.existsSync(manifestFile)) {
  fail.push('public/offline-manifest.json missing — run `node scripts/prepare-assets.js`');
} else {
  const m = JSON.parse(read(manifestFile));
  const assets = new Set(m.assets || []);
  ok.push('manifest lists ' + assets.size + ' assets');

  const must = ['whalechat.html', 'sw.js', 'offline-first.js', 'manifest.webmanifest', 'index.html'];
  must.forEach((f) => { if (!assets.has('./' + f)) fail.push('manifest missing ./' + f); });

  /* every client module on disk must be precached */
  fs.readdirSync(PUB)
    .filter((f) => f.endsWith('.js'))
    .forEach((f) => { if (!assets.has('./' + f)) fail.push('module not precached: ' + f); });

  /* only files that really exist */
  assets.forEach((a) => {
    if (/^https?:/i.test(a)) return;
    const p = path.join(PUB, a.replace(/^\.\//, ''));
    if (!fs.existsSync(p)) fail.push('manifest points at a missing file: ' + a);
  });
}

/* 2. service worker wiring ------------------------------------------------- */
const sw = path.join(PUB, 'sw.js');
if (!fs.existsSync(sw)) fail.push('public/sw.js missing');
else {
  const s = read(sw);
  if (!/PRECACHE_ALL/.test(s)) fail.push('sw.js has no PRECACHE_ALL handler');
  if (!/offline-manifest\.json/.test(s)) fail.push('sw.js does not read offline-manifest.json');
  if (!/periodicsync/.test(s)) warn.push('sw.js has no periodic background sync (Chrome/Android only)');
  if (!/alertCheck/.test(s)) fail.push('sw.js has no device-side alert check');
  if (!/pathname\.startsWith\('\/api\/'\)/.test(s)) fail.push('sw.js does not cache /api/ responses');
  if (!/IMAGE_CACHE/.test(s)) fail.push('sw.js has no image cache (cache-first media)');
  if (!/offline-placeholder\.svg/.test(s)) fail.push('sw.js has no offline image placeholder');
  if (!/SWR_PATHS/.test(s)) fail.push('sw.js has no stale-while-revalidate list of endpoints');
  ok.push('service worker: precache + api cache + media cache + swr + background alerts');
}

/* 2b. local-first database schema ---------------------------------------- */
const ofs = path.join(PUB, 'offline-first.js');
if (!fs.existsSync(ofs)) fail.push('public/offline-first.js missing');
else {
  const s = read(ofs);
  if (!/var DB_VER = 2/.test(s)) fail.push('IndexedDB schema is not at version 2');
  ['messages', 'chats', 'profiles', 'products', 'cart', 'orders', 'outbox'].forEach((st) => {
    if (!new RegExp("'" + st + "'").test(s)) fail.push('IndexedDB store missing: ' + st);
  });
  ok.push('IndexedDB v2: chat, messages, profiles, products, cart, orders, outbox');
}

/* 2c. offline data + diagnostics modules --------------------------------- */
const odFile = path.join(PUB, 'offline-data.js');
if (!fs.existsSync(odFile)) fail.push('public/offline-data.js missing');
else {
  const s = read(odFile);
  if (!/flushOutbox/.test(s)) fail.push('offline-data.js has no outbox flush');
  if (!/PENDING_MSGS/.test(s)) fail.push('offline-data.js has no pending message badge');
  if (!/placeOrder/.test(s)) fail.push('offline-data.js does not guard checkout offline');
  if (!/wc-net-pill/.test(s)) fail.push('offline-data.js has no connectivity pill');
  ok.push('offline data: outbox flush, pending badges, checkout guard, connectivity pill');
}
const msFile = path.join(PUB, 'message-search.js');
if (!fs.existsSync(msFile)) fail.push('public/message-search.js missing');
else {
  const s = read(msFile);
  if (!/WC_MSG_SEARCH/.test(s)) fail.push('message-search.js does not expose WC_MSG_SEARCH');
  if (!/searchMessages/.test(s)) fail.push('message-search.js does not use the offline mirror');
  if (!/wc-ms-row/.test(s)) fail.push('message-search.js has no result rows');
  ok.push('message search: memory + IndexedDB mirror, highlighted results');
}
const oaFile = path.join(PUB, 'offline-actions.js');
if (!fs.existsSync(oaFile)) fail.push('public/offline-actions.js missing');
else {
  const s = read(oaFile);
  ['submitDeposit', 'submitWithdraw', 'spotBuy', 'wcDeviceMode', 'registerHandler'].forEach((n) => {
    if (!s.includes(n)) fail.push('offline-actions.js missing: ' + n);
  });
  ok.push('device mode: deposit/withdraw/transfer queueing + spot guard');
}
const dgFile = path.join(PUB, 'diagnostics.js');
if (!fs.existsSync(dgFile)) fail.push('public/diagnostics.js missing');
else {
  const s = read(dgFile);
  ['caches.keys', "OF.all('api')", 'lastAlertRun', 'Notification.permission', 'outbox'].forEach((needle) => {
    if (!s.includes(needle)) fail.push('diagnostics.js does not report: ' + needle);
  });
  ok.push('diagnostics: sw caches, file count, idb api cache, alert time, notification permission');
}

/* 2d. installable manifest ----------------------------------------------- */
const mf = path.join(PUB, 'manifest.webmanifest');
if (!fs.existsSync(mf)) fail.push('manifest.webmanifest missing');
else {
  const m = JSON.parse(read(mf));
  if (!m.name) fail.push('manifest has no name');
  if (!m.start_url) fail.push('manifest has no start_url');
  if (!m.display || !/standalone|fullscreen|minimal-ui/.test(m.display)) fail.push('manifest is not installable (display)');
  const sizes = new Set((m.icons || []).map((i) => i.sizes));
  if (!sizes.has('192x192')) fail.push('manifest has no 192x192 icon');
  if (!sizes.has('512x512')) fail.push('manifest has no 512x512 icon');
  (m.icons || []).forEach((i) => {
    const p = path.join(PUB, i.src.replace(/^\.\//, ''));
    if (!fs.existsSync(p)) fail.push('manifest icon missing on disk: ' + i.src);
  });
  if (!fs.existsSync(path.join(PUB, 'assets', 'apple-touch-icon.png'))) warn.push('no apple-touch-icon for iOS install');
  ok.push('manifest installable (name, start_url, standalone, 192/512 icons on disk)');
}

/* 3. the bundle actually shipped the offline runtime ---------------------- */
const app = path.join(PUB, 'whalechat.html');
if (!fs.existsSync(app)) fail.push('public/whalechat.html not assembled');
else {
  const html = read(app);
  if (!/wc-offline-first/.test(html)) fail.push('bundle does not include the offline-first module');
  if (!/wc-offline-data/.test(html)) fail.push('bundle does not include the offline data module');
  if (!/wc-diagnostics/.test(html)) fail.push('bundle does not include the diagnostics module');
  if (!/wc-live-trade/.test(html)) fail.push('bundle lost a core module');

  /* local script/link references must all be cached files */
  const m = fs.existsSync(manifestFile) ? JSON.parse(read(manifestFile)) : { assets: [] };
  const assets = new Set(m.assets || []);
  const refs = new Set();
  const re = /(?:src|href)="(\.\/[^"]+|\/[^"?#]+|[A-Za-z0-9_-]+\.(?:js|css|png|jpg|webmanifest))"/g;
  let hit;
  while ((hit = re.exec(html))) refs.add(hit[1]);
  refs.forEach((r) => {
    if (/^(https?:)?\/\//.test(r)) return;
    const rel = './' + r.replace(/^\.\//, '').replace(/^\//, '');
    if (!/\.(js|css|png|jpg|jpeg|webmanifest|ico|svg|webp)$/i.test(rel)) return;
    if (!assets.has(rel)) warn.push('page references an uncached file: ' + rel);
  });
  ok.push('bundle includes offline runtime (' + Math.round(html.length / 1024) + ' KB)');
}

/* 4. release gate ---------------------------------------------------------- */
const rel = JSON.parse(read(path.join(PUB, 'release.json')));
const stamped = read(app).match(/const APP_VERSION = '([^']+)'/);
if (!stamped || stamped[1] !== rel.version) fail.push('bundle version ' + (stamped && stamped[1]) + ' != release.json ' + rel.version);
else ok.push('release stamped ' + rel.version);
const swv = read(sw).match(/const VERSION = 'wc-v([\d.]+)/);
if (!swv || !rel.version.startsWith(swv[1])) warn.push('sw cache version ' + (swv && swv[1]) + ' vs release ' + rel.version);

/* report ------------------------------------------------------------------ */
ok.forEach((l) => console.log('  ok   ' + l));
warn.forEach((l) => console.log('  warn ' + l));
fail.forEach((l) => console.log('  FAIL ' + l));
if (fail.length) {
  console.error('\noffline check failed (' + fail.length + ' problem(s))');
  process.exit(1);
}
console.log('\noffline check passed — the installed app can boot with no network');
