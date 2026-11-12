#!/usr/bin/env node
/* Build step for Render / Docker / local `npm run build`.
   1. decode the base64-committed images (assets, legacy products/bots, demo media)
   2. assemble public/whalechat.html from its <120 KB committed parts
   3. inject the repo-owned app modules (tawk control + live trades & demo fleet)
   4. stamp the release version committed in public/release.json
   Fail-safe: any problem leaves the previous build serving. */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const APP = path.join(PUB, 'whalechat.html');

/* 1. committed base64 image assets ------------------------------------------- */
const assetDirs = [
  path.join(PUB, 'assets'),
  path.join(PUB, 'products'),
  path.join(PUB, 'bots'),
  path.join(PUB, 'demo', 'products'),
  path.join(PUB, 'demo', 'sellers'),
  path.join(PUB, 'demo', 'banners'),
  path.join(PUB, 'company', 'products')
].filter((d) => fs.existsSync(d));

let made = 0;
for (const dir of assetDirs) {
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.b64')) continue;
    const target = path.join(dir, name.slice(0, -4));
    try {
      if (fs.existsSync(target) && fs.statSync(target).size > 0) continue;
      fs.writeFileSync(target, Buffer.from(fs.readFileSync(path.join(dir, name), 'utf8').trim(), 'base64'));
      made++;
    } catch (e) { console.error('[assets] failed', name, e.message); }
  }
}
console.log('[assets] decoded', made, 'file(s)');

/* 2. assemble the app bundle from the committed parts ------------------------- */
const parts = fs.readdirSync(PUB)
  .filter((f) => /^whalechat\.html\.part\d+$/.test(f))
  .sort((a, b) => parseInt(a.match(/(\d+)$/)[1], 10) - parseInt(b.match(/(\d+)$/)[1], 10));

if (!parts.length) {
  console.error('[app] no committed parts found — keeping whatever is already there');
} else {
  const html = parts.map((f) => fs.readFileSync(path.join(PUB, f), 'utf8')).join('');
  if (!html.trimEnd().endsWith('</html>')) {
    console.error('[app] parts look incomplete (' + html.length + ' bytes) — not writing a broken bundle');
  } else {
    fs.writeFileSync(APP, html);
    console.log('[app] assembled whalechat.html from ' + parts.length + ' part(s) (' + html.length + ' bytes)');
  }
}

/* 3. app modules owned by the repo ------------------------------------------- */
const MODULES = [
  { file: 'tawk-control.js', marker: 'wc-tawk-control' },
  { file: 'live-trade.js', marker: 'wc-live-trade' },
  { file: 'assets-multi.js', marker: 'wc-assets-multi' },
  { file: 'spot-orders.js', marker: 'wc-spot-orders' },
  { file: 'market-live.js', marker: 'wc-market-live' },
  { file: 'demo-sellers.js', marker: 'wc-demo-sellers' },
  { file: 'support.js', marker: 'wc-support' }
];
try {
  let page = fs.readFileSync(APP, 'utf8');
  const before = page;
  page = page.replace(/<!--Start of Tawk\.to Script-->[\s\S]*?<!--End of Tawk\.to Script-->\s*/g, '');
  /* the sync server injects this marker per request; keep the file free of it */
  page = page.replace(/<script>window\.__WC_SERVER__[^\n]*<\/script>\s*/g, '');

  for (const mod of MODULES) {
    const src = path.join(PUB, mod.file);
    if (!fs.existsSync(src)) { console.error('[app] missing module ' + mod.file); continue; }
    const js = fs.readFileSync(src, 'utf8');
    const block = '<script>\n/* ' + mod.marker + ' */\n' + js + '\n</script>';
    const re = new RegExp('<script>\\s*\\/\\* ' + mod.marker + ' \\*\\/[\\s\\S]*?<\\/script>');
    if (re.test(page)) { page = page.replace(re, function () { return block; }); console.log('[app] ' + mod.file + ' refreshed'); }
    else { page = page.replace('</body>', function () { return block + '\n</body>'; }); console.log('[app] ' + mod.file + ' injected'); }
  }
  if (page !== before) {
    const closings = (page.match(/<\/html>/g) || []).length;
    if (closings !== 1 || !page.trimEnd().endsWith('</html>')) {
      console.error('[app] REFUSING to write bundle: ' + closings + ' </html> markers');
    } else {
      fs.writeFileSync(APP, page);
      console.log('[app] bundle finalised (' + before.length + ' -> ' + page.length + ' bytes)');
    }
  }
} catch (e) { console.error('[app] module injection failed:', e.message); }

/* 4. single release lever ---------------------------------------------------- */
try {
  const metaFile = path.join(PUB, 'release.json');
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  const version = meta.version;
  const build = meta.build;
  let page = fs.readFileSync(APP, 'utf8');
  if (!/const APP_VERSION = '[^']*';/.test(page) || !/const APP_BUILD = '[^']*';/.test(page)) {
    throw new Error('version markers not found in bundle');
  }
  page = page.replace(/const APP_VERSION = '[^']*';/, "const APP_VERSION = '" + version + "';")
             .replace(/const APP_BUILD = '[^']*';/, "const APP_BUILD = '" + build + "';");
  fs.writeFileSync(APP, page);
  const next = Object.assign({}, meta, {
    file: 'whalechat.html',
    releasedAt: build,
    minimum: meta.minimum || '3.0.0'
  });
  fs.writeFileSync(path.join(PUB, 'version.json'), JSON.stringify(next, null, 2) + '\n');
  fs.writeFileSync(metaFile, JSON.stringify(next, null, 2) + '\n');
  console.log('[app] stamped ' + version + ' @ ' + build);
} catch (e) { console.error('[app] release stamp skipped:', e.message); }
