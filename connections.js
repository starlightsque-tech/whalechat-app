/* =========================================================================
   WhaleChat connection registry  (server side)

   One durable home for every third-party connection so a new version can
   never wipe them:

     Finnhub   — stock/chart price source (REST + websocket)
     Binance   — crypto/meme price source (REST + websocket)
     Twelve Data — US stock/forex price source (REST, runs alongside Finnhub)
     Brevo     — transactional email
     SMTP      — fallback mail transport

   Everything is stored in the app database (Postgres when configured, the
   mounted disk otherwise) under settings.connections, mirrored to
   DATA_DIR/connections.json. Boot applies the stored values on top of the
   environment, so a deploy that has no env vars still comes up connected.
   ========================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');

const SECRET = '••••••••';

function mask(has) { return has ? SECRET : ''; }

function createConnections(opts) {
  const getDb = opts.getDb || (() => null);
  const persist = opts.persist || (() => {});
  const dataDir = opts.dataDir;
  const file = path.join(dataDir, 'connections.json');
  const market = opts.market;
  const email = opts.email;
  const binance = opts.binance;
  const twelvedata = opts.twelvedata || null;
  const log = opts.log || (() => {});

  function readFile() {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (e) { return {}; }
  }
  function writeFile(v) {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(v, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (e) { log('[connections] file write failed: ' + e.message); }
  }

  function stored() {
    const fromFile = readFile();
    let fromDb = {};
    try {
      const db = getDb();
      fromDb = (db && db.settings && db.settings.connections) || {};
    } catch (e) {}
    /* the database wins; the file is the safety net when the DB is empty */
    return Object.assign({}, fromFile, fromDb);
  }

  function save(next) {
    const merged = Object.assign({}, stored(), next, { updatedAt: Date.now() });
    try {
      const db = getDb();
      if (db) {
        if (!db.settings) db.settings = {};
        db.settings.connections = merged;
        persist();
      }
    } catch (e) { log('[connections] db write failed: ' + e.message); }
    writeFile(merged);
    return merged;
  }

  /* apply the stored configuration to the live services */
  function apply() {
    const c = stored();
    let applied = [];

    if (market && c.finnhub && (c.finnhub.apiKey || c.finnhub.mode)) {
      try {
        const next = {};
        if (c.finnhub.apiKey) next.apiKey = c.finnhub.apiKey;
        if (c.finnhub.mode) next.mode = c.finnhub.mode;
        if (Object.keys(next).length && typeof market.saveConfig === 'function') {
          market.saveConfig(next);
          applied.push('finnhub');
        }
      } catch (e) { log('[connections] finnhub apply failed: ' + e.message); }
    }

    if (c.binance) {
      try {
        const db = getDb();
        if (db) {
          if (!db.settings) db.settings = {};
          db.settings.binance = Object.assign({}, db.settings.binance || {}, {
            enabled: c.binance.enabled !== false,
            apiKey: c.binance.apiKey || (db.settings.binance || {}).apiKey || ''
          });
        }
        applied.push('binance');
      } catch (e) { log('[connections] binance apply failed: ' + e.message); }
    }

    if (c.twelvedata && c.twelvedata.apiKey) {
      try {
        const db = getDb();
        if (db) {
          if (!db.settings) db.settings = {};
          db.settings.marketData = Object.assign({}, db.settings.marketData || {});
          db.settings.marketData.twelvedata = { apiKey: c.twelvedata.apiKey };
        }
        applied.push('twelvedata');
        if (twelvedata) twelvedata.poll().catch(() => {});
      } catch (e) { log('[connections] twelvedata apply failed: ' + e.message); }
    }

    if (c.brevo && c.brevo.apiKey && email) {
      try {
        const mail = {
          brevoKey: c.brevo.apiKey,
          from: c.brevo.from || 'whalechat1@gmail.com',
          fromName: c.brevo.fromName || 'WhaleChat'
        };
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(path.join(dataDir, 'mail.json'), JSON.stringify(mail, null, 2), { mode: 0o600 });
        applied.push('brevo');
      } catch (e) { log('[connections] brevo apply failed: ' + e.message); }
    }
    log('[connections] applied: ' + (applied.join(', ') || 'environment only'));
    return applied;
  }

  function status() {
    const c = stored();
    const fin = (c.finnhub || {});
    const bin = (c.binance || {});
    const bre = (c.brevo || {});
    let marketStatus = {};
    try { marketStatus = market ? market.status() : {}; } catch (e) {}
    let binStatus = {};
    try { binStatus = binance ? binance.status() : {}; } catch (e) {}
    let mailStatus = {};
    try { mailStatus = email ? email.status() : {}; } catch (e) {}
    return {
      ok: true,
      finnhub: {
        mode: marketStatus.mode || fin.mode || 'simulated',
        configured: !!(marketStatus.hasKey || fin.apiKey),
        key: mask(!!fin.apiKey),
        source: marketStatus.source || null,
        websocket: marketStatus.ws || fin.websocket || null
      },
      binance: {
        configured: !!(binStatus.hasKey || bin.apiKey),
        key: mask(!!bin.apiKey),
        enabled: binStatus.enabled !== false,
        symbols: (binStatus.symbols || []).length,
        source: binStatus.source || null,
        host: binStatus.host || null,
        websocket: binStatus.ws || null
      },
      twelvedata: {
        configured: !!(c.twelvedata && c.twelvedata.apiKey),
        key: mask(!!(c.twelvedata && c.twelvedata.apiKey)),
        enabled: !(c.twelvedata && c.twelvedata.enabled === false),
        live: twelvedata ? twelvedata.status() : null
      },
      brevo: {
        configured: !!bre.apiKey || !!(mailStatus.provider === 'brevo'),
        key: mask(!!bre.apiKey),
        from: bre.from || mailStatus.from || '',
        provider: mailStatus.provider || 'none'
      },
      smtp: {
        configured: !!(mailStatus.configured && mailStatus.provider === 'smtp'),
        host: mailStatus.host || '',
        from: mailStatus.from || ''
      },
      storage: {
        database: opts.storageBackend ? opts.storageBackend() : 'file',
        file: file,
        updatedAt: c.updatedAt || 0
      }
    };
  }

  /* ---- save from the admin panel ---------------------------------------- */
  function saveFrom(body) {
    const next = {};
    if (body.finnhub) {
      next.finnhub = {
        apiKey: body.finnhub.apiKey ? String(body.finnhub.apiKey).trim() : (stored().finnhub || {}).apiKey || '',
        mode: body.finnhub.mode === 'simulated' ? 'simulated' : 'hybrid'
      };
    }
    if (body.binance) {
      next.binance = {
        enabled: body.binance.enabled !== false,
        apiKey: body.binance.apiKey ? String(body.binance.apiKey).trim() : (stored().binance || {}).apiKey || ''
      };
    }
    if (body.twelvedata) {
      const cur = stored().twelvedata || {};
      next.twelvedata = {
        enabled: body.twelvedata.enabled !== false,
        apiKey: body.twelvedata.apiKey ? String(body.twelvedata.apiKey).trim() : cur.apiKey || ''
      };
    }
    if (body.brevo) {
      next.brevo = {
        apiKey: body.brevo.apiKey ? String(body.brevo.apiKey).trim() : (stored().brevo || {}).apiKey || '',
        from: body.brevo.from ? String(body.brevo.from).trim() : (stored().brevo || {}).from || 'whalechat1@gmail.com',
        fromName: body.brevo.fromName ? String(body.brevo.fromName).trim() : (stored().brevo || {}).fromName || 'WhaleChat'
      };
    }
    save(next);
    const applied = apply();
    if (body.twelvedataPoll && twelvedata) twelvedata.poll().catch(() => {});
    return { ok: true, applied, status: status() };
  }

  /* ---- boot: never lose a configuration -------------------------------- */
  function boot() {
    apply();
    try { if (twelvedata) twelvedata.start(); } catch (e) {}
    try {
      const c = stored();
      if (c && Object.keys(c).length) {
        const snap = path.join(dataDir, 'connections-backup-' + new Date().toISOString().slice(0, 10) + '.json');
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(snap, JSON.stringify(c, null, 2), { mode: 0o600 });
      }
    } catch (e) {}
  }

  function saveExtra(key, val) { const o = {}; o[key] = val; save(o); }

  return { boot, apply, status, saveFrom, saveExtra, stored, file };
}

module.exports = { createConnections };
