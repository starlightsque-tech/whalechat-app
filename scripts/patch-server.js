/* Build-time patch: wires the market data proxy (market-data.js) into server.js.
   Idempotent. Run from scripts/prepare-assets.js. */
'use strict';
const fs = require('fs');
const path = require('path');

const ROUTES = `  /* --- market data proxy (keys stay server side) ------------------------- */
  if (marketData && pathname === '/api/market/symbols' && req.method === 'GET') {
    return json(res, 200, { ok: true, symbols: marketData.symbols(query.get('type') || 'crypto') });
  }
  if (marketData && pathname === '/api/market/quote' && req.method === 'GET') {
    try { return json(res, 200, { ok: true, quote: await marketData.quote(query.get('symbol')) }); }
    catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  if (marketData && pathname === '/api/market/candles' && req.method === 'GET') {
    try { return json(res, 200, Object.assign({ ok: true }, await marketData.candles(query.get('symbol'), query.get('tf') || '1H'))); }
    catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  if (marketData && pathname === '/api/market/symbol-search' && req.method === 'GET') {
    return json(res, 200, { ok: true, results: await marketData.search(query.get('q')) });
  }
  if (marketData && pathname === '/api/market/providers' && req.method === 'GET') {
    if (!isAdmin(store.db, query.get('adminId') || '')) return json(res, 403, { ok: false, error: 'admin_only' });
    return json(res, 200, { ok: true, providers: marketData.status() });
  }
  if (marketData && pathname === '/api/market/providers' && req.method === 'POST') {
    const body = await readBody(req);
    if (!isAdmin(store.db, body.adminId)) return json(res, 403, { ok: false, error: 'admin_only' });
    return json(res, 200, { ok: true, providers: marketData.save(body) });
  }
  if (marketData && pathname === '/api/market/providers/test' && req.method === 'POST') {
    const body = await readBody(req);
    if (!isAdmin(store.db, body.adminId)) return json(res, 403, { ok: false, error: 'admin_only' });
    return json(res, 200, { ok: true, result: await marketData.test(String(body.which || '')) });
  }
`;

function patchServer(file) {
  let s = fs.readFileSync(file, 'utf8');
  if (s.includes('createMarketData')) return false;
  const must = [
    "const connections = createConnections ?",
    "}) : null;\n\n/* B2B price alerts",
    "  /* --- durable connection settings (admin only)",
    "server.keepAliveTimeout = 65000;"
  ];
  for (const m of must) if (!s.includes(m)) { console.warn('[patch-server] anchor missing, skipped: ' + m.slice(0, 40)); return false; }
  s = s.replace("const connections = createConnections ?", "let createMarketData = null;\ntry { createMarketData = require('./market-data').createMarketData; } catch (e) { console.error('[market-data] module unavailable:', e.message); }\nconst connections = createConnections ?");
  s = s.replace("}) : null;\n\n/* B2B price alerts", "}) : null;\nconst marketData = (createMarketData && connections) ? createMarketData({ connections, log: (m) => console.log(m) }) : null;\n\n/* B2B price alerts");
  s = s.replace("  /* --- durable connection settings (admin only)", () => ROUTES + "  /* --- durable connection settings (admin only)");
  s = s.replace("server.keepAliveTimeout = 65000;", "if (marketData) { try { marketData.attachWs(server); } catch (e) { console.error('[market-data] ws:', e.message); } }\nserver.keepAliveTimeout = 65000;");
  fs.writeFileSync(file, s);
  return true;
}
function patchConnections(file) {
  let s = fs.readFileSync(file, 'utf8');
  if (s.includes('saveExtra')) return false;
  const anchor = "  return { boot, apply, status, saveFrom, stored, file };";
  if (!s.includes(anchor)) { console.warn('[patch-server] connections anchor missing'); return false; }
  s = s.replace(anchor, "  function saveExtra(key, val) { const o = {}; o[key] = val; save(o); }\n\n  return { boot, apply, status, saveFrom, saveExtra, stored, file };");
  fs.writeFileSync(file, s);
  return true;
}
module.exports = { patchServer, patchConnections };
if (require.main === module) { patchConnections(path.join(__dirname, '..', 'connections.js')); console.log('[patch-server]', patchServer(path.join(__dirname, '..', 'server.js')) ? 'server.js patched' : 'no change'); }
