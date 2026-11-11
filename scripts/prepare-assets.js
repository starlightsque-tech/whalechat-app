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
const VERSION = '3.9.0';
const MARKER = 'WhaleChat Invest';
/* Where to get the current bundle. Own service first (a failed deploy keeps the
   previous container serving, so this is safe), then the known-good mirror. */
const SOURCES = [
  process.env.APP_SOURCE_URL,
  process.env.APP_URL ? new URL('/whalechat.html', process.env.APP_URL).toString() : null,
  'https://whalechat-qkgd.onrender.com/whalechat.html',
  'https://whalechat-mldp.onrender.com/whalechat.html'
].filter(Boolean);

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
  let html = current();
  if (isCurrent(html)) {
    console.log('[app] whalechat.html ' + VERSION + ' already in place');
  } else {
    let fetched = '';
    for (const src of SOURCES) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 30000);
        const res = await fetch(src, { signal: ctrl.signal, cache: 'no-store' });
        clearTimeout(t);
        if (!res.ok) { console.error('[app] ' + src + ' -> HTTP ' + res.status); continue; }
        const body = await res.text();
        if (body.length > 600000 && body.includes(MARKER) && body.trimEnd().endsWith('</html>')) {
          fetched = body;
          console.log('[app] fetched bundle from ' + src);
          break;
        }
        console.error('[app] ' + src + ' did not look like a bundle');
      } catch (e) { console.error('[app] ' + src + ' failed: ' + e.message); }
    }

    if (fetched.length > 600000 && fetched.includes(MARKER) && fetched.trimEnd().endsWith('</html>')) {
      fs.writeFileSync(APP, fetched);
      console.log('[app] installed whalechat.html ' + VERSION + ' (' + fetched.length + ' bytes)');
      html = fetched;
    } else {
      // last resort: the repo's committed parts (previous release)
      const parts = fs.readdirSync(PUB).filter((f) => /^whalechat\.html\.part\d+$/.test(f)).sort();
      if (parts.length && !html) {
        html = parts.map((f) => fs.readFileSync(path.join(PUB, f), 'utf8')).join('');
        fs.writeFileSync(APP, html);
        console.log('[app] fell back to', parts.length, 'committed part(s)');
      } else {
        console.error('[app] keeping existing bundle — deploy will still start');
      }
    }
  }

  /* 2b. live chat: remove the hardcoded Tawk embed, inject the controlled loader -- */
  try {
    const before = fs.readFileSync(APP, 'utf8');
    let page = before;
    page = page.replace(/<!--Start of Tawk\.to Script-->[\s\S]*?<!--End of Tawk\.to Script-->\s*/g, '');
    // their server injects this marker per request; keep the file free of it so copies never stack up
    page = page.replace(/<script>window\.__WC_SERVER__[^\n]*<\/script>\s*/g, '');
    const ctrl = path.join(PUB, 'tawk-control.js');
    if (fs.existsSync(ctrl)) {
      const js = fs.readFileSync(ctrl, 'utf8');
      const block = '<script>\n/* wc-tawk-control */\n' + js + '\n</script>';
      if (/<script>\s*\/\* wc-tawk-control \*\/[\s\S]*?<\/script>/.test(page)) {
        page = page.replace(/<script>\s*\/\* wc-tawk-control \*\/[\s\S]*?<\/script>/, function () { return block; });
        console.log('[chat] live chat loader refreshed');
      } else {
        page = page.replace('</body>', block + '\n</body>');
        console.log('[chat] live chat loader injected');
      }
    }
    if (page !== before) {
      fs.writeFileSync(APP, page);
      console.log('[chat] removed hardcoded Tawk embed (' + before.length + ' -> ' + page.length + ' bytes)');
    }
  } catch (e) { console.error('[chat] patch failed:', e.message); }

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

  /* 5. release metadata ------------------------------------------------------------- */
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(PUB, 'version.json'), 'utf8'));
    if (meta.version !== VERSION) {
      meta.version = VERSION;
      meta.build = new Date().toISOString();
      meta.releasedAt = meta.build;
      meta.notes = 'WhaleChat ' + VERSION + ' — stock investing dashboard, buy/sell with PIN, watchlist and alerts, admin stock panel. Fixed Add to cart, added save-contact-to-phone.';
      fs.writeFileSync(path.join(PUB, 'version.json'), JSON.stringify(meta, null, 2));
      fs.writeFileSync(path.join(PUB, 'release.json'), JSON.stringify(meta, null, 2));
      console.log('[app] version.json bumped to ' + VERSION);
    }
  } catch (e) { console.error('[app] version.json skip:', e.message); }
})();
