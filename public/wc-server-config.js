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
    release: '3.64.0',
    appwrite: {
      endpoint: 'https://nyc.cloud.appwrite.io/v1',
      projectId: '6aff3eda000983f5a975',
      databaseId: 'whalechat',
      bucketId: 'whalechat',
      collections: { orders: 'orders', offlineOrders: 'offline_orders', portfolios: 'portfolios' }
    },
    binanceWs: 'wss://stream.binance.com:9443/stream',
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

  window.WC_SERVERS = S;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { S.refresh(); });
  else S.refresh();
})();
