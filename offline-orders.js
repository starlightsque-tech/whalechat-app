'use strict';
/* =========================================================================
   WhaleChat · deterministic offline → online trade reconciliation
   -------------------------------------------------------------------------
   Rules implemented here (server = single source of truth):

     1. FIFO          queued orders are settled oldest `offlineTimestamp` first,
                      so a sell queued after a buy sees the bought shares.
     2. Idempotency   `clientOrderId` (UUID v4 from the device) is the primary
                      key. If Appwrite (or the local ledger) already holds it,
                      the order is marked RECONCILED and never written twice.
     3. MARKET        |offlineSimulatedPrice − live| / live ≤ tolerancePct (2%)
                        → honour the offline price               → RECONCILED
                      > tolerance
                        → fill at live, quantity re-derived from the
                          committed notional (never overspend)   → ADJUSTED
                      both prices are stored on the order.
     4. LIMIT         buy fills when live ≤ limit, sell when live ≥ limit,
                      executed at the live price               → RECONCILED
                      otherwise the simulated fill is converted into a live
                      OPEN order and the reserved balance is released.
     5. STOP_LOSS     sell fills when live ≤ stop, buy when live ≥ stop,
                      same OPEN conversion as LIMIT.
     6. FUNDS         the live server balance is re-checked before every fill.
                      A concurrent online session that spent the money wins:
                      the order becomes FAILED_INSUFFICIENT_FUNDS and the
                      client is told to roll its optimistic balance back.
     7. EMAIL         one consolidated Brevo receipt per batch that produced
                      at least one RECONCILED / ADJUSTED trade.
   ========================================================================= */

const crypto = require('crypto');
const cfg = require('./server-config');

const STATUS = {
  PENDING: 'PENDING',
  SYNCING: 'SYNCING',
  RECONCILED: 'RECONCILED',
  ADJUSTED: 'ADJUSTED',
  OPEN: 'OPEN',
  FAILED_INSUFFICIENT_FUNDS: 'FAILED_INSUFFICIENT_FUNDS',
  FAILED: 'FAILED'
};

const round = (v, n) => Math.round((Number(v) || 0) * Math.pow(10, n)) / Math.pow(10, n);
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(v) { return uuidRe.test(String(v || '')); }

function ensure(db) {
  if (!Array.isArray(db.offlineOrders)) db.offlineOrders = [];
  if (!Array.isArray(db.trades)) db.trades = [];
  if (!Array.isArray(db.holdings)) db.holdings = [];
  return db;
}

function txAcct(u) {
  if (!u.investAcct) u.investAcct = { usd: 0, payout: 0, wcBalance: 0, portfolios: { stock: 0, wc: 0, b2b: 0, bot: 0 }, stockProfit: 0 };
  const a = u.investAcct;
  if (!a.portfolios) a.portfolios = { stock: 0, wc: 0, b2b: 0, bot: 0 };
  return a;
}
function cash(u) { return round(txAcct(u).portfolios.stock, 2); }
function setCash(u, v) { txAcct(u).portfolios.stock = round(v, 2); return txAcct(u).portfolios.stock; }

function holdingFor(db, userId, ticker) {
  return db.holdings.find((h) => h && h.userId === userId && String(h.ticker).toUpperCase() === ticker && h.status !== 'closed') || null;
}

function pushTrade(db, rec) {
  const order = {
    id: rec.tradeId,
    userId: rec.userId,
    ticker: rec.ticker,
    name: rec.name || rec.ticker,
    side: String(rec.side).toLowerCase(),
    type: 'spot',
    status: 'Completed',
    shares: rec.quantity,
    priceUsd: rec.executedPrice,
    marketPriceUsd: rec.livePrice,
    coins: round(rec.notionalUsd * 2, 2),
    feeCoins: 0,
    plUsd: 0,
    plCoins: 0,
    source: 'offline-sync',
    clientOrderId: rec.clientOrderId,
    offlineSimulatedPrice: rec.offlineSimulatedPrice,
    offlineTimestamp: rec.offlineTimestamp,
    syncStatus: rec.syncStatus,
    note: rec.note || '',
    createdAt: Date.now()
  };
  db.trades.unshift(order);
  if (db.trades.length > 3000) db.trades.length = 3000;
  return order;
}

/* ---------------------------------------------------------------- engine */
function createReconciler(opts) {
  const getDb = opts.getDb || (() => null);
  const persist = opts.persist || (() => {});
  const quoteFor = opts.quoteFor || (() => null);
  const appwrite = opts.appwrite || null;       // { findOrder(id), createOrder(doc) }
  const mail = opts.mail || null;               // { enqueue(...) }
  const notify = opts.notify || (() => {});
  const appUrl = opts.appUrl || 'https://whalechat.appwrite.network';
  const tolerance = Number(opts.tolerancePct || cfg.DEFAULTS.reconciliation.tolerancePct);
  const BATCH = Number(opts.batchSize || cfg.DEFAULTS.reconciliation.batchSize);

  function live(ticker) {
    const q = quoteFor(ticker);
    const p = Number(q && (q.price ?? q.last ?? q.usdPrice));
    return p > 0 ? p : 0;
  }
  function user(db, userId) { return (db.users || []).find((u) => u && u.id === userId) || null; }

  function existing(db, clientOrderId) {
    return db.offlineOrders.find((r) => r && r.clientOrderId === clientOrderId) || null;
  }

  /* reserve / release helpers keep LIMIT/STOP money in one place */
  function reserve(db, u, amount) {
    const a = txAcct(u);
    a.stockReserved = round((Number(a.stockReserved) || 0) + amount, 2);
    return a.stockReserved;
  }
  function release(db, u, amount) {
    const a = txAcct(u);
    a.stockReserved = Math.max(0, round((Number(a.stockReserved) || 0) - amount, 2));
    return a.stockReserved;
  }

  function applyMarketFill(db, u, order, execPrice, qty, kind) {
    const ticker = order.assetSymbol;
    const side = order.side;
    const notional = round(qty * execPrice, 2);
    const available = round(cash(u) - (Number(txAcct(u).stockReserved) || 0) + (kind === 'release' ? Number(order.reservedUsd) || 0 : 0), 2);

    if (side === 'BUY') {
      if (!(available + 1e-6 >= notional)) return { ok: false, reason: 'insufficient_funds', needed: notional, available };
      setCash(u, cash(u) - notional);
      let h = holdingFor(db, order.userId, ticker);
      if (h) {
        const prevShares = Number(h.shares) || 0;
        const nextShares = round(prevShares + qty, 8);
        const prevInvested = Number(h.investedCoins) || round(prevShares * (Number(h.avgPrice) || 0) * 2, 2);
        h.avgPrice = round(((prevShares * (Number(h.avgPrice) || 0)) + (qty * execPrice)) / nextShares, 8);
        h.shares = nextShares;
        h.investedCoins = round(prevInvested + notional * 2, 2);
        h.investedUsd = round(h.investedCoins * 0.5, 2);
        h.marketPriceUsd = execPrice;
        h.updatedAt = Date.now();
        h.source = h.source || 'offline-sync';
      } else {
        h = {
          id: 'hd_' + crypto.randomBytes(6).toString('hex'),
          userId: order.userId, ticker, name: order.assetName || ticker,
          shares: round(qty, 8), avgPrice: execPrice,
          investedCoins: round(notional * 2, 2), investedUsd: notional,
          takeProfitPrice: 0, stopLossPrice: 0,
          adminProfitPct: 0, profitPct: 0, marketPriceUsd: execPrice,
          kind: 'spot', status: 'open', source: 'offline-sync',
          createdAt: Number(order.offlineTimestamp) || Date.now(), updatedAt: Date.now()
        };
        db.holdings.push(h);
      }
      return { ok: true, notional, execPrice, qty };
    }

    /* SELL */
    const h = holdingFor(db, order.userId, ticker);
    if (!h) return { ok: false, reason: 'no_position', available: 0 };
    const held = Number(h.shares) || 0;
    if (qty > held + 1e-9) return { ok: false, reason: 'insufficient_units', available: held };
    const proceeds = round(qty * execPrice, 2);
    h.shares = round(held - qty, 8);
    const basis = round((Number(h.investedUsd) || 0) * (qty / held), 2);
    h.investedUsd = round(Math.max(0, (Number(h.investedUsd) || 0) - basis), 2);
    h.investedCoins = round(h.investedUsd * 2, 2);
    if (h.shares <= 1e-9) h.status = 'closed';
    h.updatedAt = Date.now();
    setCash(u, cash(u) + proceeds);
    return { ok: true, notional: proceeds, execPrice, qty };
  }

  function settleOne(db, u, order) {
    const ticker = order.assetSymbol;
    const offlinePrice = Number(order.offlineSimulatedPrice) || 0;
    const qty = Number(order.quantity) || 0;
    const notional = Number(order.notionalAmount) || round(qty * offlinePrice, 2);
    const type = String(order.orderType || 'MARKET').toUpperCase();

    /* ------------------------------- TRANSFER (cash ⇄ wallet) ----------- */
    if (type === 'TRANSFER') {
      const dir = String(order.direction || 'to_wallet');
      const amount = round(notional, 2);
      if (!(amount > 0)) { order.syncStatus = STATUS.FAILED; order.lastError = 'invalid_amount'; return { status: STATUS.FAILED, reason: 'invalid_amount' }; }
      const acct = txAcct(u);
      const wallet = Number(acct.wcBalance) || 0;
      if (dir === 'to_wallet') {
        if (cash(u) + 1e-6 < amount) { order.syncStatus = STATUS.FAILED_INSUFFICIENT_FUNDS; order.lastError = 'insufficient_funds'; order.availableUsd = cash(u); return { status: order.syncStatus, reason: 'insufficient_funds' }; }
        setCash(u, cash(u) - amount);
        acct.wcBalance = round(wallet + amount, 2);
      } else {
        if (wallet + 1e-6 < amount) { order.syncStatus = STATUS.FAILED_INSUFFICIENT_FUNDS; order.lastError = 'insufficient_wallet'; order.availableUsd = round(wallet, 2); return { status: order.syncStatus, reason: 'insufficient_wallet' }; }
        acct.wcBalance = round(wallet - amount, 2);
        setCash(u, cash(u) + amount);
      }
      order.syncStatus = STATUS.RECONCILED;
      order.executedLivePrice = 1;
      order.executedQuantity = amount;
      order.finalUsd = amount;
      order.note = dir === 'to_wallet' ? 'Transferred $' + amount.toFixed(2) + ' to the wallet' : 'Transferred $' + amount.toFixed(2) + ' to stock cash';
      return { status: order.syncStatus, executedPrice: 1, quantity: amount };
    }

    /* price-traded orders need a live quote (a transfer does not) */
    const price = live(ticker);
    if (!(price > 0)) {
      order.syncStatus = STATUS.PENDING;
      order.lastError = 'waiting_for_live_price';
      return { status: STATUS.PENDING, reason: 'waiting_for_live_price' };
    }
    order.livePrice = round(price, 6);

    /* ------------------------------- LIMIT / STOP_LOSS ------------------ */
    if (type === 'LIMIT' || type === 'STOP_LOSS') {
      const trigger = Number(order.triggerPrice) || offlinePrice;
      const isBuy = order.side === 'BUY';
      const hit = type === 'LIMIT'
        ? (isBuy ? price <= trigger : price >= trigger)
        : (isBuy ? price >= trigger : price <= trigger);

      if (!hit) {
        order.syncStatus = STATUS.OPEN;
        order.triggerPrice = trigger;
        order.reservedUsd = isBuy ? round(notional, 2) : 0;
        order.note = type === 'LIMIT'
          ? 'Converted to a live open limit order — market has not reached ' + trigger
          : 'Converted to a live open stop order — market has not reached ' + trigger;
        /* the simulated fill never touched server money, so nothing is charged;
           the reservation is tracked so a later fill can be funded. */
        if (isBuy) reserve(db, u, round(notional, 2));
        return { status: STATUS.OPEN, trigger, livePrice: price };
      }

      const exec = type === 'LIMIT'
        ? (isBuy ? Math.min(price, trigger) : Math.max(price, trigger))
        : price;
      const fillQty = isBuy ? round(notional / exec, 8) : qty;
      const out = applyMarketFill(db, u, order, exec, fillQty, 'release');
      if (!out.ok) {
        order.syncStatus = STATUS.FAILED_INSUFFICIENT_FUNDS;
        order.lastError = out.reason;
        order.availableUsd = out.available;
        if (isBuy) release(db, u, round(order.reservedUsd || notional, 2));
        return { status: order.syncStatus, reason: out.reason, available: out.available };
      }
      if (isBuy) release(db, u, round(order.reservedUsd || notional, 2));
      order.executedLivePrice = round(exec, 6);
      order.executedQuantity = fillQty;
      order.finalUsd = out.notional;
      order.syncStatus = STATUS.RECONCILED;
      order.note = type + ' triggered at ' + trigger;
      pushTrade(db, order);
      return { status: order.syncStatus, executedPrice: order.executedLivePrice, quantity: fillQty };
    }

    /* ------------------------------------ MARKET ------------------------ */
    const diffPct = offlinePrice > 0 ? Math.abs(offlinePrice - price) / price * 100 : 0;
    const within = diffPct <= tolerance + 1e-9;
    const exec = within ? offlinePrice : price;
    let fillQty = qty;

    if (!within) {
      /* keep the user's committed dollars: never overspend on slippage */
      fillQty = order.side === 'BUY' ? round(notional / exec, 8) : qty;
    }
    if (!(fillQty > 0)) {
      order.syncStatus = STATUS.FAILED;
      order.lastError = 'invalid_quantity';
      return { status: STATUS.FAILED, reason: 'invalid_quantity' };
    }

    const out = applyMarketFill(db, u, order, exec, fillQty, 'plain');
    if (!out.ok) {
      order.syncStatus = STATUS.FAILED_INSUFFICIENT_FUNDS;
      order.lastError = out.reason;
      order.availableUsd = out.available;
      order.note = out.reason === 'insufficient_units'
        ? 'Position no longer holds the units sold offline'
        : 'Balance was spent by an online session before this offline trade synced';
      return { status: order.syncStatus, reason: out.reason };
    }

    order.executedLivePrice = round(exec, 6);
    order.executedQuantity = fillQty;
    order.finalUsd = out.notional;
    order.priceDiffPct = round(diffPct, 4);
    order.syncStatus = within ? STATUS.RECONCILED : STATUS.ADJUSTED;
    order.note = within
      ? 'Offline price honoured (within ' + tolerance + '% of live)'
      : 'Filled at live price — quantity adjusted to keep the committed amount';
    pushTrade(db, order);
    return { status: order.syncStatus, executedPrice: order.executedLivePrice, quantity: fillQty, priceDiffPct: order.priceDiffPct };
  }

  /* settle an OPEN limit/stop that the market has now reached */
  function settleOpen(db) {
    let changed = 0;
    for (const order of db.offlineOrders) {
      if (!order || order.syncStatus !== STATUS.OPEN) continue;
      const before = order.syncStatus;
      const out = settleOne(db, user(db, order.userId), order);
      if (order.syncStatus !== before) changed++;
      void out;
    }
    return changed;
  }

  async function push(payload) {
    const db = ensure(getDb());
    if (!db) return { ok: false, error: 'db_not_ready', results: [] };
    const userId = String(payload.userId || '');
    const u = user(db, userId);
    if (!u) return { ok: false, error: 'unknown_user', results: [] };

    let incoming = Array.isArray(payload.orders) ? payload.orders.slice(0, BATCH) : [];
    /* FIFO — oldest offline execution first, ties broken by arrival */
    incoming.sort((a, b) => (Number(a.offlineTimestamp) || 0) - (Number(b.offlineTimestamp) || 0));

    const results = [];
    for (const raw of incoming) {
      const clientOrderId = String(raw.clientOrderId || '');
      if (!isUuid(clientOrderId)) {
        results.push({ clientOrderId, status: STATUS.FAILED, reason: 'invalid_client_order_id' });
        continue;
      }
      /* idempotency guard #1 — local ledger */
      const seen = existing(db, clientOrderId);
      if (seen && seen.syncStatus !== STATUS.FAILED && seen.syncStatus !== STATUS.PENDING) {
        results.push({ clientOrderId, status: seen.syncStatus, duplicate: true });
        continue;
      }
      /* idempotency guard #2 — Appwrite orders collection */
      if (appwrite && appwrite.findOrder) {
        try {
          const found = await appwrite.findOrder(clientOrderId);
          if (found) {
            if (seen) { seen.syncStatus = STATUS.RECONCILED; seen.note = 'Already present in Appwrite'; }
            results.push({ clientOrderId, status: STATUS.RECONCILED, duplicate: true, source: 'appwrite' });
            continue;
          }
        } catch (e) { /* a lookup failure must not lose the order */ }
      }

      const order = seen || {
        clientOrderId,
        userId,
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
        syncStatus: STATUS.SYNCING,
        receivedAt: Date.now(),
        tradeId: 'tr_' + crypto.randomBytes(6).toString('hex')
      };
      const isTransfer = String(order.orderType).toUpperCase() === 'TRANSFER';
      if ((!isTransfer && !order.assetSymbol) || !(order.quantity > 0 || order.notionalAmount > 0)) {
        order.syncStatus = STATUS.FAILED;
        order.lastError = 'invalid_order';
        results.push({ clientOrderId, status: STATUS.FAILED, reason: 'invalid_order' });
        continue;
      }
      if (!seen) db.offlineOrders.push(order);
      order.syncStatus = STATUS.SYNCING;

      const out = settleOne(db, u, order);
      results.push(Object.assign({ clientOrderId, ticker: order.assetSymbol, side: order.side, orderType: order.orderType }, out));

      if (order.syncStatus === STATUS.RECONCILED || order.syncStatus === STATUS.ADJUSTED) {
        if (appwrite && appwrite.createOrder) {
          try {
            await appwrite.createOrder({
              clientOrderId,
              userId,
              ticker: order.assetSymbol,
              assetType: order.assetType,
              side: order.side,
              orderType: order.orderType,
              quantity: order.executedQuantity,
              notionalUsd: order.finalUsd,
              offlineSimulatedPrice: order.offlineSimulatedPrice,
              executedLivePrice: order.executedLivePrice,
              offlineTimestamp: order.offlineTimestamp,
              syncedAt: Date.now(),
              syncStatus: order.syncStatus
            });
          } catch (e) {
            order.note = (order.note || '') + ' · Appwrite write retry pending';
          }
        }
      }
    }

    persist();

    const settled = results.filter((r) => r.status === STATUS.RECONCILED || r.status === STATUS.ADJUSTED);
    if (settled.length && mail) {
      const acct = txAcct(u);
      try {
        mail.enqueue({
          key: 'offline-sync-' + userId + '-' + settled.map((s) => s.clientOrderId).sort().join(',') .slice(0, 180),
          to: String(payload.email || u.email || ''),
          template: 'offlineReceipt',
          data: {
            user: u,
            orders: results,
            balanceUsd: round(acct.portfolios.stock, 2),
            tolerance,
            syncedAt: Date.now()
          },
          appUrl
        });
      } catch (e) {}
    }
    if (settled.length) {
      try { notify(u.id, 'Offline trades synced', settled.length + ' offline trade' + (settled.length === 1 ? '' : 's') + ' reconciled with the live market.', 'trend'); } catch (e) {}
    }

    return {
      ok: true,
      serverTime: Date.now(),
      tolerance,
      balanceUsd: round(txAcct(u).portfolios.stock, 2),
      reservedUsd: round(txAcct(u).stockReserved || 0, 2),
      results
    };
  }

  function state(userId) {
    const db = ensure(getDb());
    const rows = (db.offlineOrders || []).filter((r) => !userId || r.userId === userId);
    return {
      ok: true,
      counts: rows.reduce((acc, r) => { acc[r.syncStatus] = (acc[r.syncStatus] || 0) + 1; return acc; }, {}),
      orders: rows.slice(-200),
      tolerance
    };
  }

  return { push, state, settleOpen, STATUS, tolerance };
}

module.exports = { createReconciler, STATUS };
