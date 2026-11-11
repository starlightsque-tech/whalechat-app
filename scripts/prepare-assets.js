#!/usr/bin/env node
/* Build step: decode committed assets, install the current app bundle, and make
   sure the sync server accepts the investing collections.
   Runs automatically on Render/Docker before the server starts.
   Fail-safe: any problem here leaves the previous build serving. */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const APP = path.join(PUB, 'whalechat.html');
const RELEASE = { version: '3.9.3', build: '2026-11-11T17:05:00Z' };
const MARKER = 'WhaleChat Invest';
/* 1. committed base64 image assets ------------------------------------------------ */
const assetDir = path.join(PUB, 'assets');
let made = 0;
for (const name of fs.readdirSync(assetDir)) {
  if (!name.endsWith('.b64')) continue;
  const target = path.join(assetDir, name.slice(0, -4));
  try {
    if (fs.existsSync(target) && fs.statSync(target).size > 0) continue;
    fs.writeFileSync(target, Buffer.from(fs.readFileSync(path.join(assetDir, name), 'utf8').trim(), 'base64'));
    made++;
  } catch (e) { console.error('[assets] failed', name, e.message); }
}
console.log('[assets] decoded', made, 'file(s)');

/* 2. app bundle ------------------------------------------------------------------- */
function current() {
  try { return fs.readFileSync(APP, 'utf8'); } catch (e) { return ''; }
}
function isCurrent(html) {
  return html.includes(MARKER) && html.includes("APP_VERSION = '" + VERSION + "'");
}

(async () => {
  /* Assemble the app from the committed parts — builds are hermetic, no network. */
  const parts = fs.readdirSync(PUB)
    .filter((f) => /^whalechat\.html\.part\d+$/.test(f))
    .sort((x, y) => parseInt(x.match(/(\d+)$/)[1], 10) - parseInt(y.match(/(\d+)$/)[1], 10));

  if (!parts.length) {
    console.error('[app] no committed parts found — keeping whatever is already there');
  } else {
    const html = parts.map((f) => fs.readFileSync(path.join(PUB, f), 'utf8')).join('');
    if (!html.trimEnd().endsWith('</html>')) {
      console.error('[app] parts look incomplete (' + html.length + ' bytes) — not writing a broken bundle');
    } else {
      fs.writeFileSync(APP, html);
      console.log('[app] assembled whalechat.html from ' + parts.length + ' committed part(s) (' + html.length + ' bytes)');
    }
  }

  /* 2b. app modules injected from the repo (live chat + live trades) ---------- */
  const MODULES = [
    { file: 'tawk-control.js', marker: 'wc-tawk-control' },
    { file: 'live-trade.js', marker: 'wc-live-trade' }
  ];
  try {
    let page = fs.readFileSync(APP, 'utf8');
    const before = page;
    page = page.replace(/<!--Start of Tawk\.to Script-->[\s\S]*?<!--End of Tawk\.to Script-->\s*/g, '');
    // their server injects this marker per request; keep the file free of it so copies never stack up
    page = page.replace(/<script>window\.__WC_SERVER__[^\n]*<\/script>\s*/g, '');

    for (const mod of MODULES) {
      const src = path.join(PUB, mod.file);
      if (!fs.existsSync(src)) { console.error('[app] missing module ' + mod.file); continue; }
      const js = fs.readFileSync(src, 'utf8');
      const block = '<script>\n/* ' + mod.marker + ' */\n' + js + '\n</script>';
      const re = new RegExp('<script>\\s*\\/\\* ' + mod.marker + ' \\*\\/[\\s\\S]*?<\\/script>');
      if (re.test(page)) { page = page.replace(re, function () { return block; }); console.log('[app] ' + mod.file + ' refreshed'); }
      else { page = page.replace('</body>', block + '\n</body>'); console.log('[app] ' + mod.file + ' injected'); }
    }
    if (page !== before) {
      fs.writeFileSync(APP, page);
      console.log('[app] bundle finalised (' + before.length + ' -> ' + page.length + ' bytes)');
    }
  } catch (e) { console.error('[app] module injection failed:', e.message); }

  /* 2d. stamp the release version (single lever for shipping a new build) ------ */
  try {
    let page = fs.readFileSync(APP, 'utf8');
    const before = page;
    page = page.replace(/const APP_VERSION = '[^']*';/, "const APP_VERSION = '" + RELEASE.version + "';")
               .replace(/const APP_BUILD = '[^']*';/, "const APP_BUILD = '" + RELEASE.build + "';");
    if (page !== before) { fs.writeFileSync(APP, page); console.log('[app] stamped ' + RELEASE.version + ' @ ' + RELEASE.build); }
  } catch (e) { console.error('[app] stamp failed:', e.message); }

  /* 3. sync server must persist the investing collections --------------------------- */
  const need = ['stocks', 'holdings', 'trades', 'watchlist', 'alerts'];
  const serverFile = path.join(ROOT, 'server.js');
  try {
    let src = fs.readFileSync(serverFile, 'utf8');
    const m = src.match(/const COLLECTIONS = \[([^\]]*)\];/);
    if (!m) throw new Error('COLLECTIONS not found');
    const have = m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    const missing = need.filter((c) => !have.includes(c));
    if (missing.length) {
      const next = have.concat(missing).map((c) => "'" + c + "'").join(', ');
      src = src.replace(m[0], 'const COLLECTIONS = [' + next + '];');
      fs.writeFileSync(serverFile, src);
      console.log('[sync] added collections:', missing.join(', '));
    } else {
      console.log('[sync] collections already complete');
    }
  } catch (e) {
    console.error('[sync] could not patch server.js:', e.message);
  }

  /* 4. mail sender must be a sender Brevo has actually verified -------------------- */
  try {
    const emailFile = path.join(ROOT, 'email.js');
    let src = fs.readFileSync(emailFile, 'utf8');
    const VERIFIED = (process.env.MAIL_FROM_VERIFIED || 'whalechat1@gmail.com').toLowerCase();
    const line = "  from: process.env.MAIL_FROM || process.env.SMTP_USER || process.env.OUTLOOK_EMAIL || 'onboarding@resend.dev',";
    const marker = '/* wc-verified-sender */';
    if (src.includes(line) && !src.includes(marker)) {
      const replace = "  /* wc-verified-sender */ from: (function () {\n"
        + "    var want = String(process.env.MAIL_FROM || '').trim().toLowerCase();\n"
        + "    var verified = '" + VERIFIED + "';\n"
        + "    if (want && want === verified) return process.env.MAIL_FROM;\n"
        + "    if (want) console.warn('[mail] MAIL_FROM ' + want + ' is not a verified Brevo sender - using ' + verified);\n"
        + "    return verified;\n"
        + "  })(),";
      src = src.replace(line, replace);
      fs.writeFileSync(emailFile, src);
      console.log('[mail] sender pinned to verified address ' + VERIFIED);
    } else {
      console.log('[mail] sender guard already applied');
    }
  } catch (e) { console.error('[mail] could not patch email.js:', e.message); }

  /* 5. release metadata — mirror the build stamp baked into the bundle ------- */
  try {
    const app = fs.readFileSync(APP, 'utf8');
    const ver = RELEASE.version || (app.match(/APP_VERSION = '([^']+)'/) || [])[1];
    const build = RELEASE.build || (app.match(/APP_BUILD = '([^']+)'/) || [])[1];
    const meta = { version: ver, build, file: 'whalechat.html',
      notes: 'WhaleChat ' + ver + ' — live trades with real-time P/L, take-profit and stop-loss, timed auto-close, charts on every holding.',
      releasedAt: build, minimum: '3.0.0' };
    fs.writeFileSync(path.join(PUB, 'version.json'), JSON.stringify(meta, null, 2));
    fs.writeFileSync(path.join(PUB, 'release.json'), JSON.stringify(meta, null, 2));
    console.log('[app] release metadata -> ' + ver + ' @ ' + build);
  } catch (e) { console.error('[app] version.json skip:', e.message); }
})();
