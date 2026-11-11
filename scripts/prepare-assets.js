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
const RELEASE = { version: '3.9.6', build: '2026-11-11T18:15:00Z' };
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
      else { page = page.replace('</body>', function () { return block + '\n</body>'; }); console.log('[app] ' + mod.file + ' injected'); }
    }
    if (page !== before) {
      const closings = (page.match(/<\/html>/g) || []).length;
      if (closings !== 1 || !page.trimEnd().endsWith('</html>')) {
        console.error('[app] REFUSING to write bundle: ' + closings + ' </html> markers (temp token leak)');
      } else {
        fs.writeFileSync(APP, page);
        console.log('[app] bundle finalised (' + before.length + ' -> ' + page.length + ' bytes)');
      }
    }
  } catch (e) { console.error('[app] module injection failed:', e.message); }

  /* 2d. stamp the release version (single lever for shipping a new build) ------ */
  try {
    let page = fs.readFileSync(APP, 'utf8');
    const before = page;
    page = page.replace(/const APP_VERSION = '[^']*';/, function () { return "const APP_VERSION = '" + RELEASE.version + "';"; })
               .replace(/const APP_BUILD = '[^']*';/, function () { return "const APP_BUILD = '" + RELEASE.build + "';"; });
    if (page !== before) { fs.writeFileSync(APP, page); console.log('[app] stamped ' + RELEASE.version + ' @ ' + RELEASE.build); }
  } catch (e) { console.error('[app] stamp failed:', e.message); }

  /* 2e. vendor + admin users get the Invest tab -------------------------------- */
  try {
    let page = fs.readFileSync(APP, 'utf8');
    const before = page;
    page = page.replace("['home', 'vendor', 'company', 'market', 'wallet', 'profile']",
                        "['home', 'vendor', 'company', 'market', 'invest', 'wallet', 'profile']");
    page = page.replace("['admin', 'admin-users', 'admin-orders', 'admin-withdrawals', 'admin-chat']",
                        "['admin', 'admin-users', 'admin-orders', 'admin-withdrawals', 'invest', 'admin-chat']");
    if (page !== before) { fs.writeFileSync(APP, page); console.log('[app] Invest tab enabled for vendor and admin accounts'); }
  } catch (e) { console.error('[app] nav patch failed:', e.message); }

  /* 2f. admin can configure the mail server from the panel --------------------- */
  try {
    const emailFile = path.join(ROOT, 'email.js');
    let src = fs.readFileSync(emailFile, 'utf8');
    if (!src.includes('applyRuntimeMail')) {
      src = src.replace("const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');",
        "const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');\nconst MAIL_CFG_FILE = path.join(DATA_DIR, 'mail.json');\n"
        + "function applyRuntimeMail() {\n  try {\n    const c = JSON.parse(fs.readFileSync(MAIL_CFG_FILE, 'utf8'));\n"
        + "    if (c.brevoKey) cfg.brevoKey = c.brevoKey;\n    if (c.resendKey) cfg.resendKey = c.resendKey;\n"
        + "    if (c.from) cfg.from = c.from;\n    if (c.fromName) cfg.fromName = c.fromName;\n"
        + "    if (c.host) cfg.host = c.host;\n    if (c.port) cfg.port = Number(c.port);\n  } catch (e) {}\n}\n", 1);
      src = src.replace("function provider() {", "function provider() {\n  applyRuntimeMail();", 1);
      src = src.replace("function configured() {", "function configured() {\n  applyRuntimeMail();", 1);
      fs.writeFileSync(emailFile, src);
      console.log('[mail] runtime config hook installed (admin panel)');
    }
  } catch (e) { console.error('[mail] runtime hook failed:', e.message); }

  try {
    const serverFile = path.join(ROOT, 'server.js');
    let src = fs.readFileSync(serverFile, 'utf8');
    if (!src.includes('/api/admin/mail')) {
      const route = `  if (pathname === '/api/admin/mail' && req.method === 'POST') {
    const body = await readBody(req);
    const db = (store && store.db) || {};
    const admin = (db.users || []).find(u => u.id === body.adminId && u.role === 'admin');
    if (!admin) return json(res, 403, { ok: false, error: 'admin only' });
    try {
      const file = path.join(DATA_DIR, 'mail.json');
      let cur = {};
      try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
      if (body.brevoKey) cur.brevoKey = String(body.brevoKey).trim();
      if (body.from) cur.from = String(body.from).trim();
      if (body.fromName) cur.fromName = String(body.fromName).trim();
      if (body.resendKey) cur.resendKey = String(body.resendKey).trim();
      cur.updatedAt = new Date().toISOString();
      writeJSONAtomic(file, cur);
      if (cur.brevoKey) process.env.BREVO_API_KEY = cur.brevoKey;
      if (cur.from) process.env.MAIL_FROM = cur.from;
      return json(res, 200, { ok: true, configured: email.configured(), from: cur.from || null });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }
`;
      const anchorRoute = "  if (pathname === '/api/reload' && req.method === 'POST') {";
      if (src.includes(anchorRoute)) {
        src = src.replace(anchorRoute, route + anchorRoute);
        fs.writeFileSync(serverFile, src);
        console.log('[server] /api/admin/mail route added');
      } else {
        console.error('[server] route anchor missing — skipped');
      }
    }
  } catch (e) { console.error('[server] route patch failed:', e.message); }

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
      notes: 'WhaleChat ' + ver + ' — 1D charts fixed, 2s live market ticker, vendors can invest, admin can publish releases and connect email + push for every user.',
      releasedAt: build, minimum: '3.0.0' };
    fs.writeFileSync(path.join(PUB, 'version.json'), JSON.stringify(meta, null, 2));
    fs.writeFileSync(path.join(PUB, 'release.json'), JSON.stringify(meta, null, 2));
    console.log('[app] release metadata -> ' + ver + ' @ ' + build);
  } catch (e) { console.error('[app] version.json skip:', e.message); }
})();
