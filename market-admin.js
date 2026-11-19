'use strict';
/* =========================================================================
   WhaleChat market admin + provider-only price cache
   Tables (db/migrations/001_market_admin.sql):
     market_provider_config · tradable_symbols · trading_controls ·
     admin_logs · market_price_cache
   Rules
   - /api/market/quote ALWAYS answers from market_price_cache
   - market_price_cache is ONLY written by refresh(), which ONLY calls
     Binance / Twelve Data / Finnhub. There is no function, route or admin
     field that accepts a price. The DB also rejects any other `source`.
   - provider failure -> last cached price with is_delayed: true
     ("Delayed Data"); no cache yet -> 503 no_price (never a made-up price)
   - API keys are stored AES-256-GCM encrypted (WC_ENCRYPTION_KEY)
   - every admin change is written to admin_logs with old_value / new_value
   Without DATABASE_URL the same logic runs on an in-memory store.
   ========================================================================= */
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const MIGRATION = path.join(__dirname, 'db', 'migrations', '001_market_admin.sql');
const PROVIDERS = ['binance', 'twelvedata', 'finnhub'];
const ASSET_TYPES = ['crypto', 'stock', 'forex'];
/* how long a cached price counts as fresh, per provider (free-tier friendly) */
const REFRESH_MS = { binance: 5000, finnhub: 15000, twelvedata: 60000 };
const delayAfter = (p) => Math.max(120000, (REFRESH_MS[p] || 15000) * 3);
const CONTROL_FIELDS = ['trading_paused', 'pause_reason', 'new_trades_only_paused', 'maintenance_mode'];
const SYMBOL_FIELDS = ['display_name', 'asset_type', 'provider_name', 'provider_symbol', 'is_tradable', 'is_visible', 'min_trade_amount', 'max_trade_amount', 'max_leverage', 'price_decimals'];

/* ------------------------------ helpers ---------------------------------- */
function getJSON(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: Object.assign({ 'user-agent': 'whalechat/1.0' }, headers || {}), timeout: 10000 }, (res) => {
      let b = ''; res.setEncoding('utf8');
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        let d = null; try { d = JSON.parse(b); } catch (e) { /* keep null */ }
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error('HTTP ' + res.statusCode + (d && (d.msg || d.message) ? ' ' + (d.msg || d.message) : '')));
        if (d == null) return reject(new Error('bad json'));
        resolve(d);
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}
const alnum = (s) => String(s || '').toUpperCase().replace(/^[A-Z0-9_]+:/, '').replace(/[^A-Z0-9.]/g, '');
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
/* WhaleChat user ids are not UUIDs; derive a stable UUID for admin_id/updated_by */
function uuidFrom(id) {
  const h = crypto.createHash('sha256').update('whalechat-user::' + String(id)).digest('hex');
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-5' + h.slice(13, 16) + '-' + ((parseInt(h[16], 16) & 3) | 8).toString(16) + h.slice(17, 20) + '-' + h.slice(20, 32);
}
function httpErr(status, msg) { const e = new Error(msg); e.status = status; return e; }

/* ----------------------------- encryption -------------------------------- */
function encKey() {
  const raw = process.env.WC_ENCRYPTION_KEY || '';
  return raw ? crypto.createHash('sha256').update(raw).digest() : null;
}
function encrypt(plain) {
  const key = encKey();
  if (!key) throw httpErr(400, 'Set the WC_ENCRYPTION_KEY environment variable on the server before saving API keys');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function decrypt(blob) {
  if (!blob) return '';
  const key = encKey();
  if (!key || !String(blob).startsWith('v1:')) return '';
  try {
    const b = Buffer.from(String(blob).slice(3), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch (e) { return ''; }
}

/* default symbol list for the in-memory store (mirrors the SQL seed) */
function seedSymbols() {
  const out = [];
  [['BTCUSDT', 'Bitcoin', 2], ['ETHUSDT', 'Ethereum', 2], ['BNBUSDT', 'BNB', 2], ['SOLUSDT', 'Solana', 2], ['XRPUSDT', 'XRP', 4], ['DOGEUSDT', 'Dogecoin', 5], ['ADAUSDT', 'Cardano', 4], ['AVAXUSDT', 'Avalanche', 2], ['LINKUSDT', 'Chainlink', 3], ['TRXUSDT', 'TRON', 5], ['DOTUSDT', 'Polkadot', 3], ['LTCUSDT', 'Litecoin', 2]]
    .forEach(([s, n, d]) => out.push({ symbol: 'BINANCE:' + s, display_name: n, asset_type: 'crypto', provider_name: 'binance', provider_symbol: s, price_decimals: d }));
  [['AAPL', 'Apple'], ['MSFT', 'Microsoft'], ['NVDA', 'NVIDIA'], ['TSLA', 'Tesla'], ['AMZN', 'Amazon'], ['GOOGL', 'Alphabet'], ['META', 'Meta Platforms'], ['NFLX', 'Netflix'], ['AMD', 'AMD'], ['JPM', 'JPMorgan Chase'], ['V', 'Visa'], ['DIS', 'Disney']]
    .forEach(([s, n]) => out.push({ symbol: s, display_name: n, asset_type: 'stock', provider_name: 'twelvedata', provider_symbol: s, price_decimals: 2 }));
  [['EUR/USD', 5], ['GBP/USD', 5], ['USD/JPY', 3], ['AUD/USD', 5], ['USD/CAD', 5], ['USD/CHF', 5], ['NZD/USD', 5], ['EUR/GBP', 5]]
    .forEach(([s, d]) => out.push({ symbol: s, display_name: s, asset_type: 'forex', provider_name: 'twelvedata', provider_symbol: s, price_decimals: d }));
  return out.map((s) => Object.assign({ id: crypto.randomUUID(), is_tradable: true, is_visible: true, min_trade_amount: 10, max_trade_amount: 10000, max_leverage: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }, s));
}

function createMarketAdmin(opts) {
  const log = opts.log || ((m) => console.log(m));
  const legacyKeys = opts.legacyKeys || (() => ({}));   // keys saved before 3.46 (connections store)
  let pool = null;
  const mem = {
    providers: PROVIDERS.map((p) => ({ id: crypto.randomUUID(), provider_name: p, is_enabled: p !== 'finnhub', api_key_encrypted: null, api_secret_encrypted: null, is_testnet: false, last_test_status: 'not_tested', last_test_error: null, last_test_at: null })),
    symbols: seedSymbols(),
    controls: { id: 1, trading_paused: false, pause_reason: null, new_trades_only_paused: false, maintenance_mode: false, updated_by: null, updated_at: new Date().toISOString() },
    logs: [],
    cache: new Map()
  };
  /* in-process snapshots so trade gates can run synchronously */
  const snap = { providers: new Map(), symbols: [], index: new Map(), controls: Object.assign({}, mem.controls), at: 0 };
  const failUntil = new Map();      // symbol -> retry time after a provider failure
  const lastErr = new Map();        // symbol -> last provider error
  const inflight = new Map();

  /* ------------------------------ storage -------------------------------- */
  async function init(pgPool) {
    pool = pgPool || null;
    if (pool) {
      try {
        await pool.query(fs.readFileSync(MIGRATION, 'utf8'));
        log('[market-admin] schema ready (market_provider_config, tradable_symbols, trading_controls, admin_logs, market_price_cache)');
      } catch (e) {
        console.error('[market-admin] migration failed, using in-memory store:', e.message);
        pool = null;
      }
    } else {
      log('[market-admin] no DATABASE_URL: provider config, controls, logs and price cache are in memory only');
    }
    if (!encKey()) console.warn('[market-admin] WC_ENCRYPTION_KEY not set: API keys cannot be saved from the admin panel');
    await reload();
    const t = setInterval(() => { reload().catch(() => {}); }, 15000);
    if (t.unref) t.unref();
  }

  async function reload() {
    let providers, symbols, controls;
    if (pool) {
      providers = (await pool.query('select * from market_provider_config')).rows;
      symbols = (await pool.query('select * from tradable_symbols order by asset_type, symbol')).rows;
      controls = (await pool.query('select * from trading_controls where id = 1')).rows[0] || mem.controls;
    } else {
      providers = mem.providers; symbols = mem.symbols; controls = mem.controls;
    }
    snap.providers = new Map(providers.map((p) => [p.provider_name, p]));
    snap.symbols = symbols.map(normSymbol);
    snap.index = new Map();
    snap.symbols.forEach((s) => {
      [s.symbol.toUpperCase(), s.provider_symbol.toUpperCase(), alnum(s.symbol), alnum(s.provider_symbol)].forEach((k) => { if (k && !snap.index.has(k)) snap.index.set(k, s); });
    });
    snap.controls = Object.assign({}, controls);
    snap.at = Date.now();
  }
  function normSymbol(r) {
    return Object.assign({}, r, {
      min_trade_amount: num(r.min_trade_amount), max_trade_amount: num(r.max_trade_amount),
      max_leverage: Number(r.max_leverage) || 1, price_decimals: Number(r.price_decimals) || 2
    });
  }
  function resolve(input) {
    const raw = String(input || '').trim().toUpperCase();
    if (!raw) return null;
    return snap.index.get(raw) || snap.index.get(alnum(raw)) || null;
  }

  /* ------------------------------ audit log ------------------------------ */
  async function audit(admin, reqCtx, action, entityType, entityId, oldValue, newValue) {
    const row = {
      admin_id: uuidFrom(admin.id), admin_user_ref: String(admin.id), admin_email: String(admin.email || admin.username || admin.id).slice(0, 255),
      action, entity_type: entityType || null, entity_id: entityId == null ? null : String(entityId).slice(0, 100),
      old_value: oldValue == null ? null : oldValue, new_value: newValue == null ? null : newValue,
      ip_address: (reqCtx && reqCtx.ip) || null, user_agent: (reqCtx && reqCtx.userAgent) || null
    };
    if (pool) {
      let ip = row.ip_address; if (ip && !/^[0-9a-f:.]+$/i.test(ip)) ip = null;
      await pool.query('insert into admin_logs (admin_id, admin_user_ref, admin_email, action, entity_type, entity_id, old_value, new_value, ip_address, user_agent) values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::inet,$10)',
        [row.admin_id, row.admin_user_ref, row.admin_email, row.action, row.entity_type, row.entity_id, JSON.stringify(row.old_value), JSON.stringify(row.new_value), ip || null, row.user_agent]);
    } else {
      mem.logs.unshift(Object.assign({ id: crypto.randomUUID(), created_at: new Date().toISOString() }, row));
      if (mem.logs.length > 5000) mem.logs.length = 5000;
    }
  }
  async function logs(q) {
    const limit = Math.max(1, Math.min(500, Number(q && q.limit) || 100));
    const action = q && q.action ? String(q.action) : '';
    const entity = q && q.entity_type ? String(q.entity_type) : '';
    if (pool) {
      const w = [], a = [];
      if (action) { a.push(action); w.push('action = $' + a.length); }
      if (entity) { a.push(entity); w.push('entity_type = $' + a.length); }
      a.push(limit);
      return (await pool.query('select * from admin_logs ' + (w.length ? 'where ' + w.join(' and ') : '') + ' order by created_at desc limit $' + a.length, a)).rows;
    }
    return mem.logs.filter((l) => (!action || l.action === action) && (!entity || l.entity_type === entity)).slice(0, limit);
  }

  /* ------------------------------ providers ------------------------------ */
  function providerKeys(name) {
    const p = snap.providers.get(name) || {};
    const legacy = legacyKeys() || {};
    const lk = legacy[name] || {};
    return {
      enabled: p.is_enabled !== false,
      testnet: !!p.is_testnet,
      apiKey: decrypt(p.api_key_encrypted) || lk.apiKey || '',
      secret: decrypt(p.api_secret_encrypted) || lk.secret || '',
      keySource: decrypt(p.api_key_encrypted) ? 'encrypted' : (lk.apiKey ? 'legacy' : 'none')
    };
  }
  function providerView(p) {
    const k = providerKeys(p.provider_name);
    return {
      provider_name: p.provider_name, is_enabled: p.is_enabled !== false, is_testnet: !!p.is_testnet,
      has_key: !!k.apiKey, has_secret: !!k.secret, key_source: k.keySource,
      last_test_status: p.last_test_status || 'not_tested', last_test_error: p.last_test_error || null, last_test_at: p.last_test_at || null,
      updated_at: p.updated_at || null
    };
  }
  function providersView() { return PROVIDERS.map((n) => providerView(snap.providers.get(n) || { provider_name: n })); }

  async function updateProvider(admin, reqCtx, body) {
    const name = String(body.provider || body.provider_name || '');
    if (!PROVIDERS.includes(name)) throw httpErr(400, 'Unknown provider');
    const cur = snap.providers.get(name) || {};
    const before = providerView(cur);
    const set = {};
    if (typeof body.is_enabled === 'boolean') set.is_enabled = body.is_enabled;
    if (typeof body.is_testnet === 'boolean' && name === 'binance') set.is_testnet = body.is_testnet;
    const key = body.api_key == null ? '' : String(body.api_key).trim();
    const sec = body.api_secret == null ? '' : String(body.api_secret).trim();
    if (key) set.api_key_encrypted = encrypt(key);
    if (sec && name === 'binance') set.api_secret_encrypted = encrypt(sec);
    if (body.clear_key === true) { set.api_key_encrypted = null; set.api_secret_encrypted = null; }
    if (key || sec || body.clear_key === true) { set.last_test_status = 'not_tested'; set.last_test_error = null; set.last_test_at = null; }
    if (!Object.keys(set).length) return before;
    if (pool) {
      const cols = Object.keys(set);
      await pool.query('update market_provider_config set ' + cols.map((c, i) => c + ' = $' + (i + 2)).join(', ') + ' where provider_name = $1', [name].concat(cols.map((c) => set[c])));
    } else {
      Object.assign(mem.providers.find((p) => p.provider_name === name), set);
    }
    await reload();
    const after = providerView(snap.providers.get(name));
    /* never log key material, only whether a key is present */
    if ('is_enabled' in set && set.is_enabled !== before.is_enabled) {
      await audit(admin, reqCtx, set.is_enabled ? 'provider_enabled' : 'provider_disabled', 'provider', name, { is_enabled: before.is_enabled }, { is_enabled: after.is_enabled });
    }
    if ('is_testnet' in set && set.is_testnet !== before.is_testnet) {
      await audit(admin, reqCtx, 'provider_testnet_changed', 'provider', name, { is_testnet: before.is_testnet }, { is_testnet: after.is_testnet });
    }
    if (key || sec || body.clear_key === true) {
      await audit(admin, reqCtx, body.clear_key === true ? 'api_key_removed' : 'api_key_updated', 'provider', name,
        { has_key: before.has_key, has_secret: before.has_secret, key_source: before.key_source },
        { has_key: after.has_key, has_secret: after.has_secret, key_source: after.key_source, key_changed: !!key, secret_changed: !!sec });
    }
    failUntil.clear();
    return after;
  }

  async function testProvider(admin, reqCtx, name) {
    if (!PROVIDERS.includes(name)) throw httpErr(400, 'Unknown provider');
    const k = providerKeys(name);
    let status = 'success', error = null;
    try {
      if (name === 'binance') {
        const base = k.testnet ? 'https://testnet.binance.vision' : 'https://api.binance.com';
        await getJSON(base + '/api/v3/ping');
        if (k.apiKey && k.secret) {
          const qs = 'timestamp=' + Date.now(), sig = crypto.createHmac('sha256', k.secret).update(qs).digest('hex');
          await getJSON(base + '/api/v3/account?' + qs + '&signature=' + sig, { 'X-MBX-APIKEY': k.apiKey });
        } else {
          await getJSON(base + '/api/v3/ticker/price?symbol=BTCUSDT');
        }
      } else if (name === 'twelvedata') {
        if (!k.apiKey) throw new Error('no API key saved');
        const d = await getJSON('https://api.twelvedata.com/price?symbol=AAPL&apikey=' + encodeURIComponent(k.apiKey));
        if (d.status === 'error' || !d.price) throw new Error(d.message || 'key rejected');
      } else {
        if (!k.apiKey) throw new Error('no API key saved');
        const d = await getJSON('https://finnhub.io/api/v1/quote?symbol=AAPL&token=' + encodeURIComponent(k.apiKey));
        if (!d || !d.c) throw new Error('key rejected or no data');
      }
    } catch (e) { status = 'failed'; error = String(e.message || e).slice(0, 500); }
    const before = providerView(snap.providers.get(name) || { provider_name: name });
    if (pool) {
      await pool.query('update market_provider_config set last_test_status = $2, last_test_error = $3, last_test_at = now() where provider_name = $1', [name, status, error]);
    } else {
      Object.assign(mem.providers.find((p) => p.provider_name === name), { last_test_status: status, last_test_error: error, last_test_at: new Date().toISOString() });
    }
    await reload();
    await audit(admin, reqCtx, 'provider_tested', 'provider', name, { last_test_status: before.last_test_status }, { last_test_status: status, last_test_error: error });
    return providerView(snap.providers.get(name));
  }

  /* --------------------------- trading controls -------------------------- */
  function controls() {
    const c = snap.controls || {};
    return { trading_paused: !!c.trading_paused, pause_reason: c.pause_reason || null, new_trades_only_paused: !!c.new_trades_only_paused, maintenance_mode: !!c.maintenance_mode, updated_at: c.updated_at || null };
  }
  async function updateControls(admin, reqCtx, body) {
    const before = controls();
    const next = Object.assign({}, before);
    ['trading_paused', 'new_trades_only_paused', 'maintenance_mode'].forEach((f) => { if (typeof body[f] === 'boolean') next[f] = body[f]; });
    if ('pause_reason' in body) next.pause_reason = body.pause_reason == null ? null : String(body.pause_reason).slice(0, 500) || null;
    const changed = CONTROL_FIELDS.filter((f) => next[f] !== before[f]);
    if (!changed.length) return before;
    if (pool) {
      await pool.query('update trading_controls set trading_paused = $1, pause_reason = $2, new_trades_only_paused = $3, maintenance_mode = $4, updated_by = $5 where id = 1',
        [next.trading_paused, next.pause_reason, next.new_trades_only_paused, next.maintenance_mode, uuidFrom(admin.id)]);
    } else {
      Object.assign(mem.controls, next, { updated_by: uuidFrom(admin.id), updated_at: new Date().toISOString() });
    }
    await reload();
    const after = controls();
    const pick = (o) => { const r = {}; changed.forEach((f) => { r[f] = o[f]; }); return r; };
    let action = 'trading_controls_updated';
    if (changed.includes('trading_paused')) action = after.trading_paused ? 'trading_paused' : 'trading_resumed';
    else if (changed.includes('maintenance_mode')) action = after.maintenance_mode ? 'maintenance_enabled' : 'maintenance_disabled';
    else if (changed.includes('new_trades_only_paused')) action = after.new_trades_only_paused ? 'new_trades_paused' : 'new_trades_resumed';
    await audit(admin, reqCtx, action, 'trading_controls', '1', pick(before), pick(after));
    return after;
  }

  /* trade gate. action: 'open' | 'close'. Returns null when allowed or a
     user-facing reason string. Tickers not managed in tradable_symbols are
     only subject to the global controls. */
  function gate(action, o) {
    const c = controls();
    if (c.maintenance_mode) return 'Trading is unavailable during maintenance' + (c.pause_reason ? ': ' + c.pause_reason : '');
    if (c.trading_paused) return 'Trading is paused by an administrator' + (c.pause_reason ? ': ' + c.pause_reason : '');
    if (action === 'open' && c.new_trades_only_paused) return 'New trades are paused by an administrator' + (c.pause_reason ? ': ' + c.pause_reason : '');
    if (action === 'open' && o && o.ticker) {
      const s = resolve(o.ticker);
      if (s) {
        if (!s.is_tradable) return s.display_name + ' is not tradable right now';
        const amt = num(o.amountUsd);
        if (amt != null && s.min_trade_amount != null && amt < s.min_trade_amount) return 'Minimum trade for ' + s.display_name + ' is $' + s.min_trade_amount.toFixed(2);
        if (amt != null && s.max_trade_amount != null && amt > s.max_trade_amount) return 'Maximum trade for ' + s.display_name + ' is $' + s.max_trade_amount.toFixed(2);
        const lev = num(o.leverage);
        if (lev != null && lev > s.max_leverage) return 'Maximum leverage for ' + s.display_name + ' is ' + s.max_leverage + 'x';
      }
    }
    return null;
  }

  /* ------------------------------ symbols -------------------------------- */
  function symbolsAll() { return snap.symbols.slice(); }
  function frontType(t) { return t === 'stock' ? 'stocks' : t; }
  function symbolsPublic(type) {
    const t = String(type || '').toLowerCase();
    const want = t === 'stocks' || t === 'us' || t === 'stock' ? 'stock' : t === 'forex' ? 'forex' : t === 'crypto' ? 'crypto' : '';
    return snap.symbols.filter((s) => s.is_visible && (!want || s.asset_type === want)).map((s) => ({
      symbol: alnum(s.provider_symbol), listing: s.symbol, name: s.display_name, type: frontType(s.asset_type),
      tradable: !!s.is_tradable, min: s.min_trade_amount, max: s.max_trade_amount, maxLeverage: s.max_leverage, decimals: s.price_decimals
    }));
  }
  async function upsertSymbol(admin, reqCtx, body) {
    if ('price' in body || 'manual_price' in body) throw httpErr(400, 'Prices cannot be set manually. Prices come only from the market data providers.');
    const key = String(body.symbol || '').trim();
    if (!key || key.length > 50) throw httpErr(400, 'symbol is required (max 50 characters)');
    const existing = snap.symbols.find((s) => s.symbol === key) || null;
    const v = {};
    SYMBOL_FIELDS.forEach((f) => { if (f in body) v[f] = body[f]; });
    if ('display_name' in v) { v.display_name = String(v.display_name || '').trim().slice(0, 100); if (!v.display_name) throw httpErr(400, 'display_name is required'); }
    if ('asset_type' in v && !ASSET_TYPES.includes(v.asset_type)) throw httpErr(400, 'asset_type must be crypto, stock or forex');
    if ('provider_name' in v && !PROVIDERS.includes(v.provider_name)) throw httpErr(400, 'provider_name must be binance, twelvedata or finnhub');
    if ('provider_symbol' in v) { v.provider_symbol = String(v.provider_symbol || '').trim().slice(0, 50); if (!v.provider_symbol) throw httpErr(400, 'provider_symbol is required'); }
    ['is_tradable', 'is_visible'].forEach((f) => { if (f in v) v[f] = v[f] === true || v[f] === 'true'; });
    ['min_trade_amount', 'max_trade_amount'].forEach((f) => { if (f in v) { const n = num(v[f]); if (n == null || n < 0 || n > 1e15) throw httpErr(400, f + ' must be a positive number'); v[f] = Math.round(n * 100) / 100; } });
    if ('max_leverage' in v) { const n = Math.round(Number(v.max_leverage)); if (!(n >= 1 && n <= 100)) throw httpErr(400, 'max_leverage must be 1-100'); v.max_leverage = n; }
    if ('price_decimals' in v) { const n = Math.round(Number(v.price_decimals)); if (!(n >= 0 && n <= 8)) throw httpErr(400, 'price_decimals must be 0-8'); v.price_decimals = n; }
    const merged = Object.assign({}, existing || {}, v);
    if (merged.min_trade_amount != null && merged.max_trade_amount != null && merged.max_trade_amount < merged.min_trade_amount) throw httpErr(400, 'max_trade_amount must be at least min_trade_amount');
    if (!existing) {
      ['display_name', 'asset_type', 'provider_name', 'provider_symbol'].forEach((f) => { if (!merged[f]) throw httpErr(400, f + ' is required for a new symbol'); });
    }
    const cols = Object.keys(v);
    if (existing && !cols.length) return existing;
    if (pool) {
      if (existing) {
        await pool.query('update tradable_symbols set ' + cols.map((c, i) => c + ' = $' + (i + 2)).join(', ') + ' where symbol = $1', [key].concat(cols.map((c) => v[c])));
      } else {
        const all = ['symbol'].concat(cols);
        await pool.query('insert into tradable_symbols (' + all.join(', ') + ') values (' + all.map((c, i) => '$' + (i + 1)).join(', ') + ')', [key].concat(cols.map((c) => v[c])));
      }
    } else if (existing) {
      Object.assign(mem.symbols.find((s) => s.symbol === key), v, { updated_at: new Date().toISOString() });
    } else {
      mem.symbols.push(Object.assign({ id: crypto.randomUUID(), symbol: key, is_tradable: true, is_visible: true, min_trade_amount: 10, max_trade_amount: 10000, max_leverage: 1, price_decimals: 2, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }, v));
    }
    await reload();
    const after = snap.symbols.find((s) => s.symbol === key);
    const pick = (o) => { const r = {}; (existing ? cols : SYMBOL_FIELDS).forEach((f) => { r[f] = o ? o[f] : null; }); return r; };
    let action = existing ? 'symbol_updated' : 'symbol_created';
    if (existing && 'is_tradable' in v && v.is_tradable !== existing.is_tradable) action = v.is_tradable ? 'symbol_enabled' : 'symbol_disabled';
    else if (existing && 'is_visible' in v && v.is_visible !== existing.is_visible) action = v.is_visible ? 'symbol_shown' : 'symbol_hidden';
    await audit(admin, reqCtx, action, 'symbol', key, existing ? pick(existing) : null, pick(after));
    if (existing && ('provider_symbol' in v || 'provider_name' in v)) failUntil.delete(key);
    return after;
  }

  /* ---------------------- provider fetch -> price cache ------------------- */
  async function fetchFromProvider(s) {
    const k = providerKeys(s.provider_name);
    if (!k.enabled) throw new Error(s.provider_name + ' is disabled by an administrator');
    if (s.provider_name === 'binance') {
      const base = k.testnet ? 'https://testnet.binance.vision' : 'https://api.binance.com';
      const d = await getJSON(base + '/api/v3/ticker/24hr?symbol=' + encodeURIComponent(alnum(s.provider_symbol)));
      if (!(Number(d.lastPrice) > 0)) throw new Error('no price from Binance');
      return { price: +d.lastPrice, change_percent: num(d.priceChangePercent), high_24h: num(d.highPrice), low_24h: num(d.lowPrice), source: 'binance' };
    }
    if (s.provider_name === 'twelvedata') {
      if (!k.apiKey) throw new Error('Twelve Data API key missing');
      const d = await getJSON('https://api.twelvedata.com/quote?symbol=' + encodeURIComponent(s.provider_symbol) + '&apikey=' + encodeURIComponent(k.apiKey));
      if (d.status === 'error' || !(Number(d.close) > 0)) throw new Error(d.message || 'no price from Twelve Data');
      return { price: +d.close, change_percent: num(d.percent_change), high_24h: num(d.high), low_24h: num(d.low), source: 'twelvedata' };
    }
    if (s.provider_name === 'finnhub') {
      if (!k.apiKey) throw new Error('Finnhub API key missing');
      const d = await getJSON('https://finnhub.io/api/v1/quote?symbol=' + encodeURIComponent(s.provider_symbol) + '&token=' + encodeURIComponent(k.apiKey));
      if (!d || !(Number(d.c) > 0)) throw new Error('no price from Finnhub');
      return { price: +d.c, change_percent: num(d.dp), high_24h: num(d.h), low_24h: num(d.l), source: 'finnhub' };
    }
    throw new Error('unknown provider');
  }
  /* the ONLY writer of market_price_cache */
  async function refresh(s) {
    if (inflight.has(s.symbol)) return inflight.get(s.symbol);
    const p = (async () => {
      const q = await fetchFromProvider(s);
      if (pool) {
        await pool.query('insert into market_price_cache (symbol, price, change_percent, high_24h, low_24h, source, fetched_at) values ($1,$2,$3,$4,$5,$6,now()) on conflict (symbol) do update set price = excluded.price, change_percent = excluded.change_percent, high_24h = excluded.high_24h, low_24h = excluded.low_24h, source = excluded.source, fetched_at = excluded.fetched_at',
          [s.symbol, q.price, q.change_percent, q.high_24h, q.low_24h, q.source]);
      } else {
        mem.cache.set(s.symbol, Object.assign({ symbol: s.symbol, fetched_at: new Date() }, q));
      }
      failUntil.delete(s.symbol); lastErr.delete(s.symbol);
    })();
    inflight.set(s.symbol, p);
    try { await p; } finally { inflight.delete(s.symbol); }
  }
  async function readCache(symbol) {
    if (pool) return (await pool.query('select * from market_price_cache where symbol = $1', [symbol])).rows[0] || null;
    return mem.cache.get(symbol) || null;
  }

  /* GET /api/market/quote : always answered from market_price_cache */
  async function quote(input, o) {
    const s = resolve(input);
    if (!s || (!s.is_visible && !(o && o.admin))) throw httpErr(404, 'symbol_not_available');
    let row = await readCache(s.symbol);
    const now = Date.now();
    const age = row ? now - new Date(row.fetched_at).getTime() : Infinity;
    const due = age > (REFRESH_MS[s.provider_name] || 15000) && !(failUntil.get(s.symbol) > now);
    if (due) {
      try { await refresh(s); }
      catch (e) {
        lastErr.set(s.symbol, String(e.message || e));
        failUntil.set(s.symbol, now + (REFRESH_MS[s.provider_name] || 15000));
      }
      row = await readCache(s.symbol);
    }
    if (!row) throw httpErr(503, 'no_price');
    const fetchedMs = new Date(row.fetched_at).getTime();
    const failing = failUntil.get(s.symbol) > Date.now() && lastErr.has(s.symbol);
    const isDelayed = failing || Date.now() - fetchedMs > delayAfter(s.provider_name);
    const price = Number(row.price), pct = num(row.change_percent);
    return {
      symbol: alnum(s.provider_symbol), listing: s.symbol, name: s.display_name, type: frontType(s.asset_type),
      price, changePct: pct, change: pct == null ? null : +(price - price / (1 + pct / 100)).toFixed(8),
      high: num(row.high_24h), low: num(row.low_24h), source: row.source,
      ts: fetchedMs, fetched_at: new Date(fetchedMs).toISOString(),
      is_delayed: isDelayed, delayed: isDelayed, label: isDelayed ? 'Delayed Data' : 'Live',
      tradable: !!s.is_tradable, decimals: s.price_decimals
    };
  }

  function overview() {
    return { ok: true, providers: providersView(), controls: controls(), symbols: symbolsAll(), storage: pool ? 'postgres' : 'memory', encryptionReady: !!encKey() };
  }

  /* decrypted provider credentials for the server-side live feeds (never sent
     to a browser). Twelve Data is polled by twelvedata.js. */
  function keyFor(name) { try { return providerKeys(String(name || '')); } catch (e) { return { apiKey: '', secret: '', enabled: false }; } }
  return { init, reload, resolve, quote, symbolsPublic, symbolsAll, controls, gate, updateControls, updateProvider, testProvider, upsertSymbol, audit, logs, overview, providersView, keyFor, uuidFrom };
}

module.exports = { createMarketAdmin, encrypt, decrypt, uuidFrom };
