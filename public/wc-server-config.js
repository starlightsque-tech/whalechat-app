/* =========================================================================
   WhaleChat · server configuration (client, wc-server-config)
   -------------------------------------------------------------------------
   Injected before every other module. Holds the PUBLIC ids only — the
   Appwrite endpoint + project, the Binance stream, and the reconciliation
   tolerance. Every secret (Appwrite API key, Telesign, Brevo, Finnhub,
   Twelve Data) stays on the server.

   `/api/config/servers` is fetched once at boot and refines these values;
   when it is unreachable the constants below still let the installed app
   boot and reconcile later.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  if (window.WC_SERVERS) return;

  var S = {
    release: '3.68.0',
    appwrite: {
      endpoint: 'https://nyc.cloud.appwrite.io/v1',
      projectId: '6aff3eda000983f5a975',
      databaseId: '6aff488e0006a3fe39e0',
      bucketId: '6aff48620020a44c714f',
      collections: { orders: 'orders', offlineOrders: 'offline_orders', portfolios: 'portfolios' }
    },
    binanceWs: 'wss://data-stream.binance.vision/stream',
    tolerancePct: 2,
    features: { telesign: false, brevo: false, appwriteEmail: true },
    fetchedAt: 0
  };

  function base() {
    try { if (typeof Remote !== 'undefined' && Remote && Remote.enabled && Remote.base) return String(Remote.base).replace(/\/+$/, ''); } catch (e) {}
    try { if (typeof DEFAULT_SYNC_SERVER !== 'undefined' && DEFAULT_SYNC_SERVER) return String(DEFAULT_SYNC_SERVER).replace(/\/+$/, ''); } catch (e) {}
    return '';
  }

  S.apiBase = base;
  S.api = function (path) {
    var p = String(path || '');
    if (/^https?:/i.test(p)) return p;
    return (S.apiBase() || '') + (p.charAt(0) === '/' ? p : '/' + p);
  };

  S.refresh = function () {
    return fetch(S.api('/api/config/servers'), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !j.ok) return S;
        if (j.appwrite) {
          if (j.appwrite.endpoint) S.appwrite.endpoint = j.appwrite.endpoint;
          if (j.appwrite.projectId) S.appwrite.projectId = j.appwrite.projectId;
          if (j.appwrite.databaseId) S.appwrite.databaseId = j.appwrite.databaseId;
          if (j.appwrite.bucketId) S.appwrite.bucketId = j.appwrite.bucketId;
          if (j.appwrite.collections) S.appwrite.collections = j.appwrite.collections;
        }
        if (j.market && j.market.binanceWs) S.binanceWs = j.market.binanceWs;
        if (j.reconciliation && Number(j.reconciliation.tolerancePct) > 0) S.tolerancePct = Number(j.reconciliation.tolerancePct);
        if (j.features) S.features = Object.assign({}, S.features, j.features);
        S.fetchedAt = Date.now();
        try { localStorage.setItem('wc.servers.v1', JSON.stringify(S)); } catch (e) {}
        return S;
      })
      .catch(function () { return S; });
  };

  try {
    var cached = JSON.parse(localStorage.getItem('wc.servers.v1') || 'null');
    if (cached && cached.appwrite && cached.appwrite.projectId) {
      S.appwrite = cached.appwrite || S.appwrite;
      if (cached.binanceWs) S.binanceWs = cached.binanceWs;
      if (cached.tolerancePct) S.tolerancePct = cached.tolerancePct;
      if (cached.features) S.features = Object.assign({}, S.features, cached.features);
    }
  } catch (e) {}

  /* ------------------------------------------------------------------
     Appwrite Functions transport. Appwrite only exposes one endpoint,
     /v1/functions/<id>/executions, and it always delivers path "/". Every
     /api/* call is therefore wrapped in a JSON envelope that the function
     unwraps, so the whole existing app keeps working unchanged.
     ------------------------------------------------------------------ */
  var EXEC_BASE = 'https://nyc.cloud.appwrite.io/v1/functions/whalechat-sync';
  var EXEC_URL = EXEC_BASE + '/executions';
  S.execBase = EXEC_BASE;
  S.execUrl = EXEC_URL;

  var nativeFetch = (typeof window.fetch === 'function') ? window.fetch.bind(window) : null;
  if (nativeFetch && !window.__wcExecFetch) {
    window.__wcExecFetch = true;
    window.fetch = function (input, init) {
      try {
        var raw = typeof input === 'string' ? input : (input && input.url) || '';
        var abs = new URL(raw, location.href).href;
        if (abs.indexOf(EXEC_BASE) === 0 && abs.indexOf('/executions') !== 0) {
          var u = new URL(abs);
          var sub = u.href.slice(EXEC_BASE.length).split('?')[0];
          if (sub.indexOf('/api/') === 0) {
            /* Appwrite /executions takes execution parameters:
               { path, method, headers, body } — not the payload itself. */
            var params = {
              path: sub,
              method: String((init && init.method) || 'GET').toUpperCase(),
              headers: { accept: 'application/json' }
            };
            var qs = u.searchParams.toString();
            if (qs) params.path += '?' + qs;
            if (init && init.body) params.body = String(init.body);
            return nativeFetch(EXEC_URL, {
              method: 'POST',
              headers: { 'x-appwrite-project': S.appwrite.projectId, 'content-type': 'application/json' },
              body: JSON.stringify(params),
              cache: 'no-store'
            }).then(function (r) {
              return r.text().then(function (text) {
                var j = null;
                try { j = text ? JSON.parse(text) : null; } catch (e) {}
                if (j && j.responseBody !== undefined) {
                  if (j.responseStatusCode && j.responseStatusCode >= 500 && !j.responseBody) {
                    return new Response(JSON.stringify({ ok: false, error: 'function_failed' }), { status: j.responseStatusCode, headers: { 'content-type': 'application/json' } });
                  }
                  return new Response(j.responseBody, {
                    status: j.responseStatusCode || 200,
                    headers: { 'content-type': 'application/json', 'x-wc-exec': '1' }
                  });
                }
                return new Response(text, { status: r.status, headers: { 'content-type': 'application/json' } });
              });
            });
          }
        }
      } catch (e) {}
      return nativeFetch(input, init);
    };
  }

  window.WC_SERVERS = S;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { S.refresh(); });
  else S.refresh();
})();
