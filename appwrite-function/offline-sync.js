/* =========================================================================
   WhaleChat sync function · offline trade reconciliation (Appwrite backend)
   -------------------------------------------------------------------------
   The static site (Appwrite Sites) has no Node server, so this function is the
   reconciliation authority when the app is deployed to Appwrite hosting. It
   implements exactly the same rules as offline-orders.js:

     FIFO · clientOrderId idempotency · 2% tolerance (honour offline price) ·
     live fill + quantity re-derivation when outside tolerance · LIMIT/STOP
     conversion to OPEN · insufficient-funds protection · Brevo receipt.

   Quotes: Binance (crypto, no key) → Finnhub (stocks) → Twelve Data (fallback).
   ========================================================================= */
'use strict';

const STATUS = {
  PENDING: 'PENDING', SYNCING: 'SYNCING', RECONCILED: 'RECONCILED', ADJUSTED: 'ADJUSTED',
  OPEN: 'OPEN', FAILED_INSUFFICIENT_FUNDS: 'FAILED_INSUFFICIENT_FUNDS', FAILED: 'FAILED'
};
const TOLERANCE = Number(process.env.WC_OFFLINE_TOLERANCE_PCT || 2);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const round = (v, n) => Math.round((Number(v) || 0) * Math.pow(10, n)) / Math.pow(10, n);

async function getJSON(url, headers) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(url, { headers: headers || {}, signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

async function quote(symbol) {
  const sym = String(symbol || '').toUpperCase();
  const crypto = /USDT$/.test(sym);
  if (crypto) {
    /* api.binance.com is geo-blocked (HTTP 451) from many cloud regions —
       data-api.binance.vision serves the same public market data there. */
    for (const host of ['https://data-api.binance.vision', 'https://api.binance.com', 'https://api1.binance.com']) {
      const j = await getJSON(host + '/api/v3/ticker/price?symbol=' + encodeURIComponent(sym));
      const p = Number(j && j.price);
      if (p > 0) return p;
    }
  }
  const fk = process.env.FINNHUB_API_KEY || '';
  if (fk) {
    const j = await getJSON('https://finnhub.io/api/v1/quote?symbol=' + encodeURIComponent(sym) + '&token=' + fk);
    const p = Number(j && j.c);
    if (p > 0) return p;
  }
  const tk = process.env.TWELVEDATA_API_KEY || '';
  if (tk) {
    const j = await getJSON('https://api.twelvedata.com/price?symbol=' + encodeURIComponent(sym) + '&apikey=' + tk);
    const p = Number(j && j.price);
    if (p > 0) return p;
  }
  return 0;
}

function acct(u) {
  if (!u.investAcct) u.investAcct = { usd: 0, payout: 0, wcBalance: 0, portfolios: { stock: 0, wc: 0, b2b: 0, bot: 0 }, stockProfit: 0 };
  if (!u.investAcct.portfolios) u.investAcct.portfolios = { stock: 0, wc: 0, b2b: 0, bot: 0 };
  return u.investAcct;
}
const cash = (u) => round(acct(u).portfolios.stock, 2);
const setCash = (u, v) => { acct(u).portfolios.stock = round(v, 2); };
function holding(db, userId, ticker) {
  return (db.holdings || []).find((h) => h && h.userId === userId && String(h.ticker).toUpperCase() === ticker && h.status !== 'closed') || null;
}

function fill(db, u, order, exec, qty) {
  const ticker = order.assetSymbol;
  const notional = round(qty * exec, 2);
  if (order.side === 'BUY') {
    const available = round(cash(u) - (Number(acct(u).stockReserved) || 0), 2);
    if (available + 1e-6 < notional) return { ok: false, reason: 'insufficient_funds', available };
    setCash(u, cash(u) - notional);
    let h = holding(db, order.userId, ticker);
    if (h) {
      const prev = Number(h.shares) || 0, next = round(prev + qty, 8);
      h.avgPrice = round(((prev * (Number(h.avgPrice) || 0)) + qty * exec) / next, 8);
      h.shares = next; h.investedUsd = round((Number(h.investedUsd) || 0) + notional, 2);
      h.investedCoins = round(h.investedUsd * 2, 2); h.marketPriceUsd = exec; h.updatedAt = Date.now();
    } else {
      h = { id: 'hd_' + Math.random().toString(36).slice(2, 10), userId: order.userId, ticker, name: ticker, shares: qty, avgPrice: exec, investedUsd: notional, investedCoins: round(notional * 2, 2), takeProfitPrice: 0, stopLossPrice: 0, adminProfitPct: 0, profitPct: 0, marketPriceUsd: exec, kind: 'spot', status: 'open', source: 'offline-sync', createdAt: order.offlineTimestamp, updatedAt: Date.now() };
      db.holdings.push(h);
    }
    return { ok: true, notional };
  }
  const h = holding(db, order.userId, ticker);
  if (!h) return { ok: false, reason: 'no_position', available: 0 };
  const held = Number(h.shares) || 0;
  if (qty > held + 1e-9) return { ok: false, reason: 'insufficient_units', available: held };
  h.shares = round(held - qty, 8);
  h.investedUsd = round(Math.max(0, (Number(h.investedUsd) || 0) * (1 - qty / held)), 2);
  h.investedCoins = round(h.investedUsd * 2, 2);
  if (h.shares <= 1e-9) h.status = 'closed';
  h.updatedAt = Date.now();
  setCash(u, cash(u) + notional);
  return { ok: true, notional };
}

async function reconcile(st, body, deps) {
  const db = st.db;
  if (!db) return { ok: false, error: 'not_initialised', results: [] };
  if (!Array.isArray(db.offlineOrders)) db.offlineOrders = [];
  if (!Array.isArray(db.holdings)) db.holdings = [];
  if (!Array.isArray(db.trades)) db.trades = [];
  const userId = String(body.userId || '');
  const u = (db.users || []).find((x) => x && x.id === userId);
  if (!u) return { ok: false, error: 'unknown_user', results: [] };

  const incoming = (Array.isArray(body.orders) ? body.orders : []).slice(0, 25)
    .sort((a, b) => (Number(a.offlineTimestamp) || 0) - (Number(b.offlineTimestamp) || 0));
  const results = [];
  const settled = [];

  for (const raw of incoming) {
    const id = String(raw.clientOrderId || '');
    if (!UUID.test(id)) { results.push({ clientOrderId: id, status: STATUS.FAILED, reason: 'invalid_client_order_id' }); continue; }
    const seen = db.offlineOrders.find((r) => r && r.clientOrderId === id);
    if (seen && seen.syncStatus && seen.syncStatus !== 'PENDING' && seen.syncStatus !== 'FAILED') {
      results.push({ clientOrderId: id, status: seen.syncStatus, duplicate: true });
      continue;
    }
    for (const c of (deps.collections || [])) {
      const hit = await deps.findOrder(c, id);
      if (hit) { results.push({ clientOrderId: id, status: STATUS.RECONCILED, duplicate: true, source: 'appwrite' }); }
    }
    if (results.length && results[results.length - 1].clientOrderId === id && results[results.length - 1].duplicate) continue;

    const o = seen || {
      clientOrderId: id, userId,
      assetSymbol: String(raw.assetSymbol || '').toUpperCase(),
      assetName: String(raw.assetName || raw.assetSymbol || '').toUpperCase(),
      assetType: String(raw.assetType || 'stock').toLowerCase(),
      side: String(raw.side || 'BUY').toUpperCase(),
      orderType: String(raw.orderType || 'MARKET').toUpperCase(),
      quantity: Number(raw.quantity) || 0,
      notionalAmount: Number(raw.notionalAmount) || 0,
      offlineSimulatedPrice: Number(raw.offlineSimulatedPrice) || 0,
      offlineTimestamp: Number(raw.offlineTimestamp) || Date.now(),
      triggerPrice: Number(raw.triggerPrice) || 0,
      direction: String(raw.direction || ''),
      syncStatus: STATUS.SYNCING, receivedAt: Date.now(),
      tradeId: 'tr_' + Math.random().toString(36).slice(2, 10)
    };
    if (!seen) db.offlineOrders.push(o);
    if (!o.assetSymbol && o.orderType !== 'TRANSFER') { o.syncStatus = STATUS.FAILED; o.lastError = 'invalid_order'; results.push({ clientOrderId: id, status: STATUS.FAILED, reason: 'invalid_order' }); continue; }

    const offlinePrice = Number(o.offlineSimulatedPrice) || 0;
    const qty = Number(o.quantity) || 0;
    const notional = Number(o.notionalAmount) || round(qty * offlinePrice, 2);
    const type = String(o.orderType).toUpperCase();

    if (type === 'TRANSFER') {
      const dir = o.direction || 'to_wallet';
      const amount = round(notional, 2);
      const a = acct(u);
      if (dir === 'to_wallet') {
        if (cash(u) + 1e-6 < amount) { o.syncStatus = STATUS.FAILED_INSUFFICIENT_FUNDS; o.lastError = 'insufficient_funds'; results.push({ clientOrderId: id, status: o.syncStatus, reason: o.lastError }); continue; }
        setCash(u, cash(u) - amount); a.wcBalance = round((Number(a.wcBalance) || 0) + amount, 2);
      } else {
        if ((Number(a.wcBalance) || 0) + 1e-6 < amount) { o.syncStatus = STATUS.FAILED_INSUFFICIENT_FUNDS; o.lastError = 'insufficient_wallet'; results.push({ clientOrderId: id, status: o.syncStatus, reason: o.lastError }); continue; }
        a.wcBalance = round((Number(a.wcBalance) || 0) - amount, 2); setCash(u, cash(u) + amount);
      }
      o.syncStatus = STATUS.RECONCILED; o.finalUsd = amount; o.note = 'Transfer ' + dir;
      results.push({ clientOrderId: id, status: o.syncStatus });
      continue;
    }

    const live = await quote(o.assetSymbol);
    if (!(live > 0)) { o.syncStatus = STATUS.PENDING; o.lastError = 'waiting_for_live_price'; results.push({ clientOrderId: id, status: STATUS.PENDING, reason: 'waiting_for_live_price' }); continue; }
    o.livePrice = round(live, 6);

    if (type === 'LIMIT' || type === 'STOP_LOSS') {
      const trigger = Number(o.triggerPrice) || offlinePrice;
      const isBuy = o.side === 'BUY';
      const hit = type === 'LIMIT' ? (isBuy ? live <= trigger : live >= trigger) : (isBuy ? live >= trigger : live <= trigger);
      if (!hit) {
        o.syncStatus = STATUS.OPEN; o.triggerPrice = trigger;
        o.reservedUsd = isBuy ? round(notional, 2) : 0;
        if (isBuy) acct(u).stockReserved = round((Number(acct(u).stockReserved) || 0) + notional, 2);
        o.note = type + ' converted to a live open order at ' + trigger;
        results.push({ clientOrderId: id, status: STATUS.OPEN, trigger, livePrice: live });
        continue;
      }
      const exec = type === 'LIMIT' ? (isBuy ? Math.min(live, trigger) : Math.max(live, trigger)) : live;
      const fq = isBuy ? round(notional / exec, 8) : qty;
      const out = fill(db, u, o, exec, fq);
      if (isBuy) acct(u).stockReserved = Math.max(0, round((Number(acct(u).stockReserved) || 0) - (Number(o.reservedUsd) || notional), 2));
      if (!out.ok) { o.syncStatus = STATUS.FAILED_INSUFFICIENT_FUNDS; o.lastError = out.reason; results.push({ clientOrderId: id, status: o.syncStatus, reason: out.reason }); continue; }
      o.executedLivePrice = round(exec, 6); o.executedQuantity = fq; o.finalUsd = out.notional;
      o.syncStatus = STATUS.RECONCILED; o.note = type + ' triggered';
      db.trades.unshift({ id: o.tradeId, userId, ticker: o.assetSymbol, name: o.assetSymbol, side: o.side.toLowerCase(), type: 'spot', status: 'Completed', shares: fq, priceUsd: exec, marketPriceUsd: live, coins: round(out.notional * 2, 2), source: 'offline-sync', clientOrderId: id, offlineSimulatedPrice: offlinePrice, offlineTimestamp: o.offlineTimestamp, syncStatus: o.syncStatus, createdAt: Date.now() });
      settled.push(o);
      results.push({ clientOrderId: id, status: o.syncStatus, executedPrice: exec, quantity: fq, ticker: o.assetSymbol, side: o.side });
      continue;
    }

    const diff = offlinePrice > 0 ? Math.abs(offlinePrice - live) / live * 100 : 0;
    const within = diff <= TOLERANCE + 1e-9;
    const exec = within ? offlinePrice : live;
    const fq = within ? qty : (o.side === 'BUY' ? round(notional / exec, 8) : qty);
    if (!(fq > 0)) { o.syncStatus = STATUS.FAILED; o.lastError = 'invalid_quantity'; results.push({ clientOrderId: id, status: STATUS.FAILED, reason: 'invalid_quantity' }); continue; }
    const out = fill(db, u, o, exec, fq);
    if (!out.ok) { o.syncStatus = STATUS.FAILED_INSUFFICIENT_FUNDS; o.lastError = out.reason; o.note = 'Balance changed online before this offline trade synced'; results.push({ clientOrderId: id, status: o.syncStatus, reason: out.reason }); continue; }
    o.executedLivePrice = round(exec, 6); o.executedQuantity = fq; o.finalUsd = out.notional;
    o.priceDiffPct = round(diff, 4);
    o.syncStatus = within ? STATUS.RECONCILED : STATUS.ADJUSTED;
    o.note = within ? 'Offline price honoured' : 'Filled at live price; quantity adjusted to the committed amount';
    db.trades.unshift({ id: o.tradeId, userId, ticker: o.assetSymbol, name: o.assetSymbol, side: o.side.toLowerCase(), type: 'spot', status: 'Completed', shares: fq, priceUsd: exec, marketPriceUsd: live, coins: round(out.notional * 2, 2), source: 'offline-sync', clientOrderId: id, offlineSimulatedPrice: offlinePrice, executedLivePrice: exec, offlineTimestamp: o.offlineTimestamp, syncStatus: o.syncStatus, createdAt: Date.now() });
    settled.push(o);
    results.push({ clientOrderId: id, status: o.syncStatus, executedPrice: exec, quantity: fq, priceDiffPct: o.priceDiffPct, ticker: o.assetSymbol, side: o.side });
  }

  if (db.trades.length > 3000) db.trades.length = 3000;
  return {
    ok: true, serverTime: Date.now(), tolerance: TOLERANCE,
    balanceUsd: round(cash(u), 2), reservedUsd: round(Number(acct(u).stockReserved) || 0, 2),
    results, settled
  };
}

function receiptHtml(user, settled, balance) {
  const rows = settled.map((o) => (
    '<tr><td style="padding:6px 4px;color:#e9f4f9;font-weight:700">' + o.side + ' ' + o.assetSymbol + '</td>' +
    '<td style="padding:6px 4px">' + o.orderType + '</td>' +
    '<td style="padding:6px 4px">$' + Number(o.executedLivePrice || 0).toFixed(4) + '</td>' +
    '<td style="padding:6px 4px;color:' + (o.syncStatus === 'ADJUSTED' ? '#b7791f' : '#0f766e') + '">' + o.syncStatus + '</td></tr>'
  )).join('');
  return '<div style="font-family:Segoe UI,Roboto,sans-serif;max-width:560px">' +
    '<h2 style="color:#0b2230">Your offline trades are synced</h2>' +
    '<p style="color:#334;font-size:14px">Hi ' + String(user.fullName || user.username || 'there').split(' ')[0] + ', your device reconnected and WhaleChat settled the trades you placed offline against the live market (tolerance ' + TOLERANCE + '%).</p>' +
    '<table cellpadding="0" cellspacing="0" style="font-size:13px;width:100%">' + rows + '</table>' +
    '<p style="font-size:13px"><b>Portfolio cash balance:</b> $' + Number(balance || 0).toFixed(2) + '</p>' +
    '<p style="font-size:12px;color:#667">Trades filled away from your offline price are flagged ADJUSTED; the committed amount is always preserved.</p></div>';
}

module.exports = { reconcile, receiptHtml, quote, STATUS, TOLERANCE };
