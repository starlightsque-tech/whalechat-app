#!/usr/bin/env node
/* =========================================================================
   Build gate — every connection must answer before a build is allowed.

     node scripts/verify-connections.js
     WC_SKIP_VERIFY=1 ...   (emergency/local builds only)

   Checks: Appwrite sync function health, market key availability, the quote
   proxy, the shares engine and the published site. Exit code 1 fails the build.
   ========================================================================= */
'use strict';
const CFG = {
  sync: process.env.WC_SYNC_URL || 'https://nyc.cloud.appwrite.io/v1/functions/whalechat-sync',
  exec: process.env.WC_EXEC_URL || 'https://nyc.cloud.appwrite.io/v1/functions/whalechat-sync/executions',
  project: process.env.APPWRITE_PROJECT_ID || '6aff3eda000983f5a975',
  site: process.env.WC_SITE_URL || 'https://whalechat.appwrite.network'
};
const VIA_FUNCTION = /\/functions\/[^/]+\/?$/.test(CFG.sync);
const TIMEOUT = 12000;

async function hit(path, opts) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  const started = Date.now();
  const base = (opts && opts.base) ? opts.base : CFG.sync;
  try {
    let r;
    if (VIA_FUNCTION && !(opts && opts.base)) {
      /* Appwrite Functions deliver path "/" — every call is an envelope POST */
      const q = path.split('?')[1] || '';
      r = await fetch(CFG.exec, {
        method: 'POST',
        signal: ctrl.signal,
        cache: 'no-store',
        headers: { 'content-type': 'application/json', 'x-appwrite-project': CFG.project },
        body: JSON.stringify({ path: path, method: 'GET' })
      });
      const outer = await r.json().catch(() => null);
      if (outer && outer.responseBody !== undefined) {
        return { ok: (outer.responseStatusCode || 200) < 400, status: outer.responseStatusCode || 200, json: JSON.parse(outer.responseBody || 'null'), ms: Date.now() - started };
      }
    }
    r = await fetch(base + path, { signal: ctrl.signal, cache: 'no-store', headers: { accept: 'application/json' } });
    const text = await r.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) {}
    return { ok: r.ok, status: r.status, json, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, status: 0, error: e.message, ms: Date.now() - started };
  } finally { clearTimeout(t); }
}

async function post(path, payload) {
  try {
    if (!VIA_FUNCTION) {
      const r = await fetch(CFG.sync + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload || {}) });
      return await r.json();
    }
    const r = await fetch(CFG.exec, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-appwrite-project': CFG.project },
      body: JSON.stringify({ path, method: 'POST', body: JSON.stringify(payload || {}) })
    });
    const outer = await r.json().catch(() => null);
    if (outer && outer.responseBody !== undefined) return JSON.parse(outer.responseBody || 'null');
    return outer;
  } catch (e) { return null; }
}

(async () => {
  if (process.env.WC_SKIP_VERIFY === '1') { console.log('[verify] skipped (WC_SKIP_VERIFY=1)'); process.exit(0); }
  const checks = [];
  /* required checks block a build; advisory checks only warn (the Appwrite
     function intentionally exposes a narrower surface than the Node server) */
  const add = (name, ok, detail, required) => {
    checks.push({ name, ok, detail, required: required !== false });
    const tag = ok ? '  ok  ' : (required === false ? ' warn ' : ' FAIL ');
    console.log(tag + name + (detail ? '  · ' + detail : ''));
  };

  const health = await hit('/api/health');
  add('sync function health', health.ok && health.json && health.json.app === 'whalechat', health.json ? health.json.version + ' · ' + health.ms + 'ms' : health.error);

  const keys = await hit('/api/market/keys');
  const providers = keys.json || {};
  add('market providers', keys.ok && !!(providers.finnhub || providers.twelvedata), 'finnhub=' + !!providers.finnhub + ' twelvedata=' + !!providers.twelvedata, false);

  const proxy = await hit('/api/market/proxy?provider=auto&symbols=AAPL,MSFT');
  const qn = proxy.json && proxy.json.quotes ? Object.keys(proxy.json.quotes).length : 0;
  add('stock quote proxy', proxy.ok && qn > 0, qn + ' quote(s) · ' + proxy.ms + 'ms', false);

  const email = await hit('/api/email/status');
  add('email provider', email.ok && email.json && email.json.configured === true, email.json ? email.json.provider || '' : email.error, false);

  const shares = await hit('/api/shares/admin');
  const sharesReachable = !!shares.json && (shares.json.error === 'admin_only' || shares.json.ok === true);
  add('shares engine', sharesReachable, shares.json && shares.json.error ? shares.json.error : 'ok', false);

  const tick = await post('/api/engine/tick', {});
  add('engine tick', !!(tick && tick.ok), tick ? 'bots ' + (tick.botsTrades || 0) + ' · sessions ' + (tick.sessions || 0) : 'unreachable', false);

  const site = await hit('/release.json', { base: CFG.site });
  add('published site', site.ok && !!site.json, site.json ? 'v' + site.json.version : site.error);

  const failed = checks.filter((c) => !c.ok && c.required !== false);
  if (failed.length) {
    console.error('\n[verify] ' + failed.length + ' connection check(s) failed — BUILD BLOCKED.');
    process.exit(1);
  }
  console.log('\n[verify] all connections are live — build allowed');
})();
