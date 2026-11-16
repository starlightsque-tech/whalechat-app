#!/usr/bin/env node
/* Verify that the B2B buy-now / sell-now alert links resolve on a deployment.
 *
 *   node scripts/verify-b2b-links.mjs                     # localhost:8090
 *   node scripts/verify-b2b-links.mjs https://host.example
 *
 * It checks four things:
 *   1. /api/health answers and reports the running version
 *   2. /whalechat.html is served and contains the B2B buy / sell routes,
 *      the asset-lists route and the shared subscription module
 *   3. /api/b2b/alerts/status returns the exact buy / sell links the email
 *      template uses (and the page URL those links point at)
 *   4. the page URL behind each link answers 200
 */
import http from 'node:http';
import https from 'node:https';

const base = (process.argv[2] || 'http://localhost:8090').replace(/\/+$/, '');

function get(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { 'user-agent': 'wc-verify' }, timeout: 20000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

const checks = [];
function check(name, ok, detail) { checks.push({ name, ok, detail }); console.log((ok ? '  ok   ' : '  FAIL ') + name + (detail ? '  → ' + detail : '')); }

(async () => {
  console.log('\nWhaleChat B2B alert link verification · ' + base + '\n');

  /* 1 — health */
  let health = null;
  try { health = JSON.parse((await get(base + '/api/health')).body); } catch (e) {}
  check('health endpoint answers', !!health && health.ok === true, health ? 'version ' + health.version : 'no answer');

  /* 2 — app bundle */
  let page = '';
  try { const r = await get(base + '/whalechat.html'); page = r.body; check('/whalechat.html served', r.status === 200, 'HTTP ' + r.status); }
  catch (e) { check('/whalechat.html served', false, e.message); }

  const routes = [
    ['buy route', '#/investment/b2b/buy'],
    ['sell route', '#/investment/b2b/sell'],
    ['asset lists route', '#/investment/b2b/assets'],
    ['top-up route', '#/investment/b2b/topup'],
    ['transfer route', '#/investment/b2b/transfer'],
    ['buy page id', 'ihB2bBuyAmount'],
    ['sell page id', 'ihB2bSellUnits_'],
    ['multi-buy handler', 'ihB2bBuyMulti'],
    ['shared subscription module', '/* wc-subs */'],
    ['back navigation stack', 'NAV_STACK'],
    ['WC-Investing plan engine', '/* wc-invest-plans */'],
    ['WC-Investing pages', '/* wc-invest-ui */'],
    ['shares invest route', '#/invest/shares/invest'],
    ['shares active route', '#/invest/shares/active'],
    ['shares ROI route', '#/invest/shares/roi'],
    ['shares transfer route', '#/invest/shares/transfer'],
    ['B2B marketplace module', '/* wc-b2b-market */'],
    ['marketplace route', '#/investment/b2b/market'],
    ['asset data route', '#/investment/b2b/asset'],
    ['multi-asset alerts route', '#/investment/b2b/alerts'],
    ['Binance feed', '/api/market/binance'],
    ['connections admin page', 'wc-connections-admin'],
    ['connections API', '/api/connections']
  ];
  for (const [name, needle] of routes) check(name + ' present in the bundle', page.includes(needle));

  /* 3 — alert links from the running server */
  let status = null;
  try { status = JSON.parse((await get(base + '/api/b2b/alerts/status')).body); } catch (e) {}
  check('alert watcher reachable', !!status && status.ok === true);
  const buyUrl = status && status.links && status.links.buy;
  const sellUrl = status && status.links && status.links.sell;
  check('buy-now link returned', !!buyUrl && buyUrl.includes('#/investment/b2b/buy?asset='), buyUrl || 'none');
  check('sell-now link returned', !!sellUrl && sellUrl.includes('#/investment/b2b/sell?asset='), sellUrl || 'none');
  check('email delivery configured on this deployment', !!(status && status.email && status.email.configured), status && status.email ? (status.email.configured ? 'yes · ' + status.email.provider : 'NO — set SMTP_USER / SMTP_PASS or a Resend/Brevo key') : 'unknown');

  /* 4 — the page each link points at */
  if (buyUrl) {
    const target = buyUrl.split('#')[0];
    try { const r = await get(target); check('buy-now link target answers 200', r.status === 200, 'HTTP ' + r.status); }
    catch (e) { check('buy-now link target answers 200', false, e.message); }
  }
  if (sellUrl) {
    const target = sellUrl.split('#')[0];
    try { const r = await get(target); check('sell-now link target answers 200', r.status === 200, 'HTTP ' + r.status); }
    catch (e) { check('sell-now link target answers 200', false, e.message); }
  }

  const failed = checks.filter((c) => !c.ok);
  console.log('\n' + (failed.length ? 'FAILED ' + failed.length + ' of ' + checks.length : 'ALL PASS') + ' (' + checks.length + ' checks)');
  process.exitCode = failed.length ? 1 : 0;
})();
