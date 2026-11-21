/* =========================================================================
   WhaleChat — Binance live crypto feed (browser)

   · keeps its own WebSocket to Binance's public combined mini-ticker stream
   · tracks the top 100 USDT spot pairs by real 24h quote volume (refreshed
     every 30 minutes) so the stock pages show real coins, real prices and
     real movements — no simulator, no API key, no proxy, no Render
   · reconnects on its own (network change, sleep/wake, Binance 24h rotation)
     and never needs a button
   · feeds WC_MARKET.applyQuotes(), the same pipeline the stock pages already
     use, so charts, watchlists, holdings and portfolio values all update

   Public API:  window.WC_BINANCE.{status, symbols, lastAt, receonect()}
   ========================================================================= */
'use strict';

(function () {
  if (typeof window === 'undefined') return;
  if (window.__WCB_LOADED__) return;
  window.__WCB_LOADED__ = true;

  const B = window.WC_BINANCE = window.WC_BINANCE || {};
  B.status = 'starting';
  B.symbols = [];
  B.lastAt = 0;
  B.ticks = 0;
  B.source = 'binance-ws';
  B.host = '';

  const MAX = 100;
  /* market-data hosts first: they are the ones that stay reachable where the
     main api host is geoblocked or rate limited. */
  const REST_HOSTS = ['https://data-api.binance.vision', 'https://api.binance.com', 'https://api1.binance.com'];
  const WS_HOSTS = [
    'wss://data-stream.binance.vision',
    'wss://stream.binance.com:9443',
    'wss://stream.binance.com:443'
  ];

  /* Fallback universe — only used when the REST ranking cannot be read. */
  const FALLBACK = ['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'DOGE', 'ADA', 'TRX', 'AVAX', 'LINK', 'DOT', 'LTC', 'BCH',
    'SHIB', 'UNI', 'ATOM', 'XLM', 'ETC', 'FIL', 'APT', 'ARB', 'OP', 'SUI', 'NEAR', 'INJ', 'GRT', 'AAVE', 'ALGO',
    'VET', 'ICP', 'HBAR', 'SAND', 'MANA', 'AXS', 'THETA', 'EOS', 'RUNE', 'LDO', 'IMX', 'SEI', 'TIA', 'PEPE', 'WIF',
    'BONK', 'FLOKI', 'JUP', 'FET', 'MKR', 'SNX', 'CRV', 'COMP', 'ZEC', 'DASH', 'XTZ', 'NEO', 'IOTA', 'EGLD', 'FLOW',
    'CHZ', 'ENJ', 'BAT', 'ZIL', 'ONE', 'QTUM', 'ONT', 'KSM', 'ZEN', 'DGB', 'RVN', 'SC', 'STORJ', 'ANKR', 'KAVA',
    'ROSE', 'JASMY', 'GALA', 'APE', 'GMT', 'LUNC', 'CAKE', '1000SATS', 'ORDI', 'STX', 'WLD', 'PYTH', 'JTO', 'ENS',
    'BLUR', 'DYDX', 'GMX', 'RNDR', 'AKT', 'OSMO', 'KAS', 'TON', 'NOT', 'TAO', 'AR', 'MINA', 'CFX', 'FTT'];

  const NAMES = {
    BTC: 'Bitcoin', ETH: 'Ethereum', BNB: 'BNB', SOL: 'Solana', XRP: 'XRP', DOGE: 'Dogecoin', ADA: 'Cardano',
    TRX: 'TRON', AVAX: 'Avalanche', LINK: 'Chainlink', DOT: 'Polkadot', LTC: 'Litecoin', BCH: 'Bitcoin Cash',
    SHIB: 'Shiba Inu', UNI: 'Uniswap', ATOM: 'Cosmos', XLM: 'Stellar', ETC: 'Ethereum Classic', FIL: 'Filecoin',
    APT: 'Aptos', ARB: 'Arbitrum', OP: 'Optimism', SUI: 'Sui', NEAR: 'NEAR Protocol', INJ: 'Injective',
    GRT: 'The Graph', AAVE: 'Aave', ALGO: 'Algorand', VET: 'VeChain', ICP: 'Internet Computer', HBAR: 'Hedera',
    SAND: 'The Sandbox', MANA: 'Decentraland', AXS: 'Axie Infinity', THETA: 'Theta Network', EOS: 'EOS',
    RUNE: 'THORChain', LDO: 'Lido DAO', IMX: 'Immutable', SEI: 'Sei', TIA: 'Celestia', PEPE: 'Pepe', WIF: 'dogwifhat',
    BONK: 'Bonk', FLOKI: 'Floki', JUP: 'Jupiter', FET: 'Artificial Superintelligence', MKR: 'Maker', SNX: 'Synthetix',
    CRV: 'Curve DAO', COMP: 'Compound', ZEC: 'Zcash', DASH: 'Dash', XTZ: 'Tezos', NEO: 'Neo', IOTA: 'IOTA',
    EGLD: 'MultiversX', FLOW: 'Flow', CHZ: 'Chiliz', ENJ: 'Enjin Coin', BAT: 'Basic Attention', ZIL: 'Zilliqa',
    ONE: 'Harmony', QTUM: 'Qtum', ONT: 'Ontology', KSM: 'Kusama', ZEN: 'Horizen', DGB: 'DigiByte', RVN: 'Ravencoin',
    SC: 'Siacoin', STORJ: 'Storj', ANKR: 'Ankr', KAVA: 'Kava', ROSE: 'Oasis', JASMY: 'JasmyCoin', GALA: 'Gala',
    APE: 'ApeCoin', GMT: 'GMT', LUNC: 'Terra Classic', CAKE: 'PancakeSwap', ORDI: 'ORDI', STX: 'Stacks',
    WLD: 'Worldcoin', PYTH: 'Pyth Network', JTO: 'Jito', ENS: 'Ethereum Name Service', BLUR: 'Blur',
    DYDX: 'dYdX', GMX: 'GMX', RNDR: 'Render', TON: 'Toncoin', NOT: 'Notcoin', TAO: 'Bittensor', AR: 'Arweave',
    MINA: 'Mina Protocol', CFX: 'Conflux', FTT: 'FTX Token', KAS: 'Kaspa', POL: 'Polygon Ecosystem Token'
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------------------------------------------------------------- *
   *  Which coins: top 100 USDT pairs by real 24h turnover            *
   * ---------------------------------------------------------------- */
  function cleanBase(sym) {
    const s = String(sym || '').toUpperCase();
    if (!s.endsWith('USDT')) return '';
    const base = s.slice(0, -4);
    if (/^(USD\d*|USDC|FDUSD|TUSD|BUSD|DAI|EUR|GBP|TRY|BRL|ARS|AEUR|USDP|USDE|USDS|BFUSD|XUSD)$/.test(base)) return '';
    if (/(UP|DOWN|BULL|BEAR)$/.test(base) && base.length > 4) return '';   // leveraged tokens
    return base;
  }

  async function topSymbols() {
    for (const host of REST_HOSTS) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 9000);
        const res = await fetch(host + '/api/v3/ticker/24hr', { signal: ctrl.signal });
        clearTimeout(t);
        if (!res.ok) continue;
        const rows = await res.json();
        if (!Array.isArray(rows)) continue;
        const seen = new Set();
        const picked = rows
          .map((r) => ({ base: cleanBase(r.symbol), quote: Number(r.quoteVolume) || 0, price: Number(r.lastPrice) || 0, open: Number(r.openPrice) || 0 }))
          .filter((r) => r.base && r.price > 0)
          .sort((a, b) => b.quote - a.quote)
          .filter((r) => (seen.has(r.base) ? false : (seen.add(r.base), true)))
          .slice(0, MAX);
        if (picked.length >= 20) return picked.map((r) => r.base);
      } catch (e) { /* next host */ }
    }
    return FALLBACK.slice(0, MAX);
  }

  /* ---------------------------------------------------------------- *
   *  Catalogue: make the coins visible on every stock page            *
   * ---------------------------------------------------------------- */
  const CAT = new Map();          // ticker -> virtual stock record (never synced)

  function ensureStocks(bases) {
    try {
      if (typeof DB === 'undefined' || !DB || typeof INV === 'undefined') return;
      bases.forEach((base) => {
        if (CAT.has(base)) return;
        CAT.set(base, {
          id: 'st_cx_' + base.toLowerCase(),
          ticker: base,
          name: (NAMES[base] || base) + ' · Binance',
          sector: 'Crypto',
          price: 0,
          prevClose: 0,
          pe: 0,
          mcap: 0,
          div: 0,
          vol: 0,
          ceo: '',
          website: 'binance.com',
          color: '#f0b90b',
          about: (NAMES[base] || base) + ' — live spot market on Binance, streamed to WhaleChat in real time.',
          crypto: true,
          binance: base + 'USDT',
          paused: false,
          custom: false,
          createdAt: Date.now()
        });
      });
      installCatalogue();
      try { if (typeof render === 'function') render(); } catch (e) {}
    } catch (e) { console.warn('[binance] catalogue', e && e.message); }
  }

  /* The crypto universe lives in memory only: writing 100 rows into DB.stocks
     would push them through the cross-device state sync on every boot (and the
     state loop that follows). Virtual records render, chart and trade exactly
     like saved stocks. */
  function installCatalogue() {
    if (installCatalogue.__done || typeof INV === 'undefined') return;
    installCatalogue.__done = true;
    const origStock = INV.stock.bind(INV);
    const origStocks = INV.stocks.bind(INV);
    INV.stock = function (t) {
      let hit = null;
      try { hit = origStock(t); } catch (e) {}
      return hit || CAT.get(String(t || '').toUpperCase()) || null;
    };
    INV.stocks = function () {
      let list = [];
      try { list = origStocks(); } catch (e) {}
      const seen = new Set(list.map((s) => s && String(s.ticker).toUpperCase()));
      const extra = [];
      CAT.forEach((v, k) => { if (!seen.has(k)) extra.push(v); });
      return list.concat(extra).sort((a, b) => (Number(b.vol) || 0) - (Number(a.vol) || 0));
    };
  }

  /* ---------------------------------------------------------------- *
   *  WebSocket                                                        *
   * ---------------------------------------------------------------- */
  let ws = null;
  let retry = 0;
  let hostIdx = 0;
  let stopped = false;
  let pending = {};
  let snap = {};          // base -> { open, high, low, quoteVol }
  let lastMsgAt = 0;

  function streamUrl(host, bases) {
    const streams = bases.map((b) => b.toLowerCase() + 'usdt@miniTicker').join('/');
    return host + '/stream?streams=' + streams;
  }

  function connect() {
    if (stopped) return;
    if (!B.symbols.length) return;
    const host = WS_HOSTS[hostIdx % WS_HOSTS.length];
    B.host = host;
    B.status = 'connecting';
    try { if (ws) { ws.onclose = null; ws.close(); } } catch (e) {}
    let sock;
    try { sock = new WebSocket(streamUrl(host, B.symbols)); } catch (e) { scheduleReconnect(); return; }
    ws = sock;

    sock.onopen = () => {
      if (ws !== sock) return;
      retry = 0;
      B.status = 'live';
      B.connectedAt = Date.now();
      lastMsgAt = Date.now();
      paintPill();
    };
    sock.onmessage = (ev) => {
      if (ws !== sock) return;
      let payload;
      try { payload = JSON.parse(ev.data); } catch (e) { return; }
      const d = payload && (payload.data || payload);
      if (!d || !d.s) return;
      const sym = String(d.s).toUpperCase();
      if (!sym.endsWith('USDT')) return;
      const base = sym.slice(0, -4);
      if (!B.symbols.includes(base)) return;
      const price = Number(d.c);
      if (!(price > 0)) return;
      const open = Number(d.o) || price;
      const s = snap[base] || (snap[base] = {});
      s.open = open;
      s.high = Number(d.h) || price;
      s.low = Number(d.l) || price;
      s.quote = Number(d.q) || 0;
      lastMsgAt = Date.now();
      B.lastAt = lastMsgAt;
      B.ticks++;
      pending[base] = {
        price,
        prevClose: open,
        open,
        dayHigh: s.high,
        dayLow: s.low,
        vol: s.quote,
        updatedAt: lastMsgAt,
        source: 'binance-ws'
      };
      schedulePaint();
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      if (B.status === 'live') { B.status = 'reconnecting'; paintPill(); }
      scheduleReconnect();
    };
    sock.onerror = () => {
      try { sock.close(); } catch (e) {}
      if (ws === sock) { ws = null; B.status = 'error'; scheduleReconnect(); }
    };
  }

  function scheduleReconnect() {
    if (stopped) return;
    retry = Math.min(retry + 1, 6);
    hostIdx++;                                        // rotate hosts
    setTimeout(connect, Math.min(15000, 500 * Math.pow(2, retry)));
  }

  /* ---------------------------------------------------------------- *
   *  Paint: throttled, feeds the shared quote pipeline                *
   * ---------------------------------------------------------------- */
  let paintTimer = null;
  function schedulePaint() {
    if (paintTimer) return;
    paintTimer = setTimeout(paint, 220);
  }

  function paint() {
    paintTimer = null;
    const batch = pending;
    pending = {};
    if (!Object.keys(batch).length) return;
    const MK = window.WC_MARKET;
    if (MK && typeof MK.applyQuotes === 'function') {
      const prev = (MK.feed && MK.feed.quotes) || {};
      MK.applyQuotes({
        ok: true,
        at: Date.now(),
        source: 'binance-ws',
        notice: 'Live crypto prices from Binance',
        quotes: Object.assign({}, prev, batch)
      });
    } else {
      /* market module not loaded yet: keep the raw cache warm */
      Object.keys(batch).forEach((t) => {
        try {
          if (typeof INV !== 'undefined') {
            INV.live[t] = Object.assign({}, batch[t], { changePct: batch[t].prevClose ? ((batch[t].price - batch[t].prevClose) / batch[t].prevClose) * 100 : 0 });
          }
        } catch (e) {}
      });
    }
    paintPill();
  }

  /* ---------------------------------------------------------------- *
   *  Status pill shown on every market / invest / trade page          *
   * ---------------------------------------------------------------- */
  const STOCK_ROUTES = /^(market|invest|stock|stocks|trade|spot|portfolio|watchlist|wallet|home)$/;
  let pill = null;
  function ensurePill() {
    if (pill && document.body.contains(pill)) return pill;
    pill = document.createElement('div');
    pill.id = 'wcBinancePill';
    pill.style.cssText = [
      'position:fixed', 'right:12px', 'bottom:86px', 'z-index:60',
      'display:none', 'align-items:center', 'gap:7px',
      'padding:7px 11px', 'border-radius:999px',
      'background:rgba(6,20,30,.86)', 'border:1px solid rgba(240,185,11,.35)',
      'backdrop-filter:blur(10px)', 'color:#e9f4f9',
      'font:600 11px/1 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif',
      'box-shadow:0 8px 24px rgba(0,0,0,.35)', 'pointer-events:none'
    ].join(';');
    document.body.appendChild(pill);
    return pill;
  }

  function routeShown() {
    let t = '';
    try { t = (location.hash || '').replace(/^#\/?/, '').split('?')[0].split('/')[0] || 'home'; } catch (e) {}
    return STOCK_ROUTES.test(t);
  }

  function paintPill() {
    try {
      const el = ensurePill();
      const live = B.status === 'live' && (Date.now() - lastMsgAt < 20000);
      /* The Binance connection pill is disabled: prices still stream, but the
         app no longer shows "Connecting to Binance…" status pop-ups. */
      const show = false;
      el.style.display = 'none';
      if (!show) return;
      const dotColor = live ? '#22c55e' : B.status === 'connecting' ? '#f0b90b' : '#ef4444';
      const label = live
        ? 'LIVE · ' + B.symbols.length + ' coins · Binance'
        : B.status === 'connecting' ? 'Connecting to Binance…'
        : B.status === 'reconnecting' ? 'Reconnecting to Binance…'
        : 'Binance offline';
      el.innerHTML = '<span style="width:7px;height:7px;border-radius:50%;background:' + dotColor +
        ';box-shadow:0 0 0 3px ' + dotColor + '22;display:inline-block"></span>' +
        '<span>' + label + '</span>';
    } catch (e) {}
  }

  /* ---------------------------------------------------------------- *
   *  Boot / resilience                                               *
   * ---------------------------------------------------------------- */
  let started = false;
  async function start() {
    if (started) return;
    if (typeof DB === 'undefined' || !DB || typeof INV === 'undefined') { setTimeout(start, 400); return; }
    if (typeof DB_READY !== 'undefined' && !DB_READY) { setTimeout(start, 400); return; }
    started = true;
    B.status = 'loading-symbols';
    const bases = await topSymbols();
    B.symbols = bases;
    ensureStocks(bases);
    connect();

    /* refresh the ranking every 30 minutes (new listings, volume shifts) */
    setInterval(async () => {
      const next = await topSymbols();
      if (!next.length) return;
      const changed = next.join(',') !== B.symbols.join(',');
      B.symbols = next;
      ensureStocks(next);
      if (changed) connect();
    }, 30 * 60 * 1000);

    /* watchdog: a silent socket is a dead socket */
    setInterval(() => {
      if (stopped) return;
      if (!navigator.onLine) { B.status = 'offline'; paintPill(); return; }
      if (!ws) { connect(); return; }
      if (lastMsgAt && Date.now() - lastMsgAt > 45000) {
        B.status = 'reconnecting';
        try { ws.close(); } catch (e) {}
        ws = null; connect();
      }
    }, 15000);

    window.addEventListener('online', () => { B.status = 'reconnecting'; lastMsgAt = Date.now(); connect(); });
    window.addEventListener('offline', () => { B.status = 'offline'; paintPill(); });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      paintPill();
      if (!ws || Date.now() - lastMsgAt > 30000) { lastMsgAt = Date.now(); connect(); }
    });
    window.addEventListener('hashchange', paintPill);
    setInterval(paintPill, 3000);
  }

  B.reconnect = () => { retry = 0; connect(); };
  B.restart = () => { stopped = false; started = false; start(); };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else setTimeout(start, 300);
})();
