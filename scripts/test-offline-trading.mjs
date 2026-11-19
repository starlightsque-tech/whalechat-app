#!/usr/bin/env node
/* =========================================================================
   WhaleChat 3.64.0 · offline trading test suite
   -------------------------------------------------------------------------
   Runs with no network and no browser:

     1. the server reconciliation engine (offline-orders.js) — FIFO,
        clientOrderId idempotency, 2% tolerance, ADJUSTED fills, LIMIT/STOP
        conversion, insufficient funds, transfers
     2. the device database + simulator + reconciliation client inside jsdom
        with fake-indexeddb (queue → flush → adopt server balance)
     3. the built bundle actually contains every new module

   Usage: npm run test:offline-trading
   ========================================================================= */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

let pass = 0, fail = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(() => { pass++; console.log('  ✓ ' + name); })
    .catch((e) => { fail++; console.error('  ✗ ' + name + '\n    ' + (e && e.message)); });
}

/* ---------------------------------------------------------------- server */
const { createReconciler } = require(path.join(ROOT, 'offline-orders.js'));
const uuid = (n) => '11111111-1111-4111-8111-' + String(n).padStart(12, '0');

function freshServer() {
  const db = {
    users: [{ id: 'u1', email: 'trader@example.com', fullName: 'Test Trader', investAcct: { portfolios: { stock: 1000 }, wcBalance: 50 } }],
    holdings: [], trades: [], offlineOrders: [], notifications: []
  };
  const quotes = { AAPL: { price: 100 }, BTCUSDT: { price: 50000 } };
  const mails = [];
  const r = createReconciler({
    getDb: () => db, persist: () => {}, quoteFor: (t) => quotes[t] || null,
    mail: { enqueue: (m) => mails.push(m) }, notify: () => {},
    tolerancePct: 2
  });
  return { db, quotes, r, mails };
}

console.log('\nserver · reconciliation engine');

await test('market buy inside tolerance honours the offline price', async () => {
  const { db, r, quotes } = freshServer();
  quotes.AAPL.price = 101;
  const out = await r.push({ userId: 'u1', orders: [{ clientOrderId: uuid(1), assetSymbol: 'AAPL', side: 'BUY', orderType: 'MARKET', quantity: 2, notionalAmount: 200, offlineSimulatedPrice: 100, offlineTimestamp: 1 }] });
  assert.equal(out.results[0].status, 'RECONCILED');
  assert.equal(out.results[0].executedPrice, 100);
  assert.equal(out.balanceUsd, 800);
  assert.equal(db.holdings[0].shares, 2);
});

await test('market buy outside tolerance fills live and re-derives quantity', async () => {
  const { db, r, quotes } = freshServer();
  quotes.AAPL.price = 130;
  const out = await r.push({ userId: 'u1', orders: [{ clientOrderId: uuid(2), assetSymbol: 'AAPL', side: 'BUY', orderType: 'MARKET', quantity: 1, notionalAmount: 100, offlineSimulatedPrice: 100, offlineTimestamp: 1 }] });
  assert.equal(out.results[0].status, 'ADJUSTED');
  assert.equal(out.results[0].executedPrice, 130);
  assert.ok(Math.abs(out.balanceUsd - 900) < 0.01, 'committed $100 spent, never more');
  assert.ok(db.holdings[0].shares < 1);
});

await test('duplicate clientOrderId never creates a second trade', async () => {
  const { db, r } = freshServer();
  const order = { clientOrderId: uuid(3), assetSymbol: 'AAPL', side: 'BUY', orderType: 'MARKET', quantity: 1, notionalAmount: 100, offlineSimulatedPrice: 100, offlineTimestamp: 1 };
  await r.push({ userId: 'u1', orders: [order] });
  const again = await r.push({ userId: 'u1', orders: [order] });
  assert.equal(again.results[0].duplicate, true);
  assert.equal(db.holdings.length, 1);
  assert.equal(db.trades.length, 1);
});

await test('limit order the market has not reached becomes OPEN and reserves funds', async () => {
  const { db, r, quotes } = freshServer();
  quotes.AAPL.price = 120;
  const out = await r.push({ userId: 'u1', orders: [{ clientOrderId: uuid(4), assetSymbol: 'AAPL', side: 'BUY', orderType: 'LIMIT', quantity: 2, notionalAmount: 200, offlineSimulatedPrice: 100, triggerPrice: 100, offlineTimestamp: 1 }] });
  assert.equal(out.results[0].status, 'OPEN');
  assert.equal(out.reservedUsd, 200);
  assert.equal(db.offlineOrders[0].syncStatus, 'OPEN');
});

await test('stop-loss sell fills once the price crosses the stop', async () => {
  const { db, r, quotes } = freshServer();
  db.holdings.push({ id: 'h1', userId: 'u1', ticker: 'AAPL', shares: 3, avgPrice: 90, status: 'open' });
  quotes.AAPL.price = 85;
  const out = await r.push({ userId: 'u1', orders: [{ clientOrderId: uuid(5), assetSymbol: 'AAPL', side: 'SELL', orderType: 'STOP_LOSS', quantity: 1, notionalAmount: 95, offlineSimulatedPrice: 95, triggerPrice: 95, offlineTimestamp: 1 }] });
  assert.equal(out.results[0].status, 'RECONCILED');
  assert.equal(out.results[0].executedPrice, 85);
});

await test('insufficient funds fails without touching the balance', async () => {
  const { db, r } = freshServer();
  const before = db.users[0].investAcct.portfolios.stock;
  const out = await r.push({ userId: 'u1', orders: [{ clientOrderId: uuid(6), assetSymbol: 'AAPL', side: 'BUY', orderType: 'MARKET', quantity: 100, notionalAmount: 10000, offlineSimulatedPrice: 100, offlineTimestamp: 1 }] });
  assert.equal(out.results[0].status, 'FAILED_INSUFFICIENT_FUNDS');
  assert.equal(db.users[0].investAcct.portfolios.stock, before);
});

await test('selling more than held is rejected', async () => {
  const { r } = freshServer();
  const out = await r.push({ userId: 'u1', orders: [{ clientOrderId: uuid(7), assetSymbol: 'AAPL', side: 'SELL', orderType: 'MARKET', quantity: 2, notionalAmount: 200, offlineSimulatedPrice: 100, offlineTimestamp: 1 }] });
  assert.equal(out.results[0].status, 'FAILED_INSUFFICIENT_FUNDS');
});

await test('FIFO: a sell queued after a buy sees the bought shares', async () => {
  const { r } = freshServer();
  const out = await r.push({
    userId: 'u1',
    orders: [
      { clientOrderId: uuid(9), assetSymbol: 'AAPL', side: 'SELL', orderType: 'MARKET', quantity: 1, notionalAmount: 100, offlineSimulatedPrice: 100, offlineTimestamp: 200 },
      { clientOrderId: uuid(8), assetSymbol: 'AAPL', side: 'BUY', orderType: 'MARKET', quantity: 1, notionalAmount: 100, offlineSimulatedPrice: 100, offlineTimestamp: 100 }
    ]
  });
  assert.equal(out.results[0].clientOrderId, uuid(8), 'buy settled first');
  assert.equal(out.results[0].status, 'RECONCILED');
  assert.equal(out.results[1].status, 'RECONCILED');
});

await test('transfer moves cash into the wallet', async () => {
  const { db, r } = freshServer();
  const out = await r.push({ userId: 'u1', orders: [{ clientOrderId: uuid(10), orderType: 'TRANSFER', symbol: 'USD', notionalAmount: 100, direction: 'to_wallet', offlineTimestamp: 1 }] });
  assert.equal(out.results[0].status, 'RECONCILED');
  assert.equal(db.users[0].investAcct.portfolios.stock, 900);
  assert.equal(db.users[0].investAcct.wcBalance, 150);
});

await test('a settled batch sends exactly one Brevo receipt', async () => {
  const { r, mails } = freshServer();
  await r.push({ userId: 'u1', orders: [{ clientOrderId: uuid(11), assetSymbol: 'AAPL', side: 'BUY', orderType: 'MARKET', quantity: 1, notionalAmount: 100, offlineSimulatedPrice: 100, offlineTimestamp: 1 }] });
  assert.equal(mails.length, 1);
  assert.equal(mails[0].template, 'offlineReceipt');
});

/* ------------------------------------------------------------- browser */
console.log('\nbrowser · device DB, simulator, client reconciliation');

const { JSDOM } = require('jsdom');
const fakeIDB = require('fake-indexeddb');

async function browser() {
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
    url: 'https://whalechat.test/whalechat.html',
    pretendToBeVisual: true,
    runScripts: 'outside-only'
  });
  const w = dom.window;
  w.indexedDB = fakeIDB.indexedDB;
  w.IDBKeyRange = fakeIDB.IDBKeyRange;
  w.matchMedia = w.matchMedia || function () { return { matches: false, addEventListener() {}, removeEventListener() {} }; };
  w.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('/api/orders/offline/push')) {
      const body = JSON.parse((opts && opts.body) || '{}');
      const results = body.orders.map((o) => ({ clientOrderId: o.clientOrderId, ticker: o.assetSymbol, status: 'RECONCILED', executedPrice: o.offlineSimulatedPrice, quantity: o.quantity }));
      return { ok: true, json: async () => ({ ok: true, balanceUsd: 900, reservedUsd: 0, results }) };
    }
    if (u.includes('/api/state')) {
      return { ok: true, json: async () => ({ db: { users: [{ id: 'u1', investAcct: { portfolios: { stock: 900 } } }], holdings: [{ userId: 'u1', ticker: 'AAPL', shares: 1, avgPrice: 100 }] } }) };
    }
    if (u.includes('/api/config/servers')) return { ok: true, json: async () => ({ ok: true, appwrite: { projectId: '6aff3eda000983f5a975' }, features: {} }) };
    return { ok: false, json: async () => ({}) };
  };
  w.eval(fs.readFileSync(path.join(ROOT, 'public/wc-server-config.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(ROOT, 'public/wc-device-store.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(ROOT, 'public/wc-install-mode.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(ROOT, 'public/wc-sim-engine.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(ROOT, 'public/wc-recon.js'), 'utf8'));
  await new Promise((r) => setTimeout(r, 60));
  return w;
}

const w = await browser();

await test('device store persists portfolio, holdings, watchlist and the pending queue', async () => {
  const D = w.WC_DEVICE;
  await D.savePortfolio({ cashUsd: 500, reservedUsd: 0, userId: 'u1' });
  await D.saveHolding('AAPL', { qty: 2, avgPrice: 100 });
  await D.watch('BTCUSDT');
  await D.queue({ clientOrderId: D.uuid(), assetSymbol: 'AAPL', side: 'BUY', orderType: 'MARKET', quantity: 1, notionalAmount: 100, offlineSimulatedPrice: 100, offlineTimestamp: Date.now(), syncStatus: 'PENDING' });
  const pf = await D.portfolio();
  assert.equal(pf.cashUsd, 500);
  assert.equal((await D.pending()).length, 1);
  assert.deepEqual(await D.watched(), ['BTCUSDT']);
});

await test('simulator seeds from the last real price and produces candles', async () => {
  w.localStorage.setItem('wc.market.quotes.v1', JSON.stringify({ AAPL: { price: 100 } }));
  const q = w.WC_SIM.start('AAPL', { assetType: 'stock', candles: [] });
  assert.ok(q && q.price > 0, 'seeded');
  assert.equal(q.simulated, true);
  const p0 = w.WC_SIM.price('AAPL');
  await new Promise((r) => setTimeout(r, 1200));
  const p1 = w.WC_SIM.price('AAPL');
  assert.ok(p1 > 0 && Math.abs(p1 / p0 - 1) < 0.2, 'ticks stay near the seed');
  assert.ok(w.WC_SIM.candles().length >= 1);
  w.WC_SIM.stop();
});

await test('simulator refuses to invent a price with no cached close', async () => {
  const q = w.WC_SIM.start('ZZZZUNKNOWN', { assetType: 'stock' });
  assert.equal(q, null);
  assert.equal(w.WC_SIM.status().seedSource, 'none');
});

await test('client reconciliation flushes FIFO queue and adopts the server balance', async () => {
  const D = w.WC_DEVICE;
  const id = D.uuid();
  await D.saveOrder({ clientOrderId: id, assetSymbol: 'AAPL', side: 'BUY', orderType: 'MARKET', quantity: 1, notionalAmount: 100, offlineSimulatedPrice: 100, offlineTimestamp: Date.now() });
  await D.queue({ clientOrderId: id, assetSymbol: 'AAPL', side: 'BUY', orderType: 'MARKET', quantity: 1, notionalAmount: 100, offlineSimulatedPrice: 100, offlineTimestamp: Date.now(), syncStatus: 'PENDING' });
  w.SESSION = { userId: 'u1' };
  w.eval('SESSION = { userId: "u1" };');
  const out = await w.WC_RECON.flush({ silent: true });
  assert.equal(out.ok, true);
  assert.equal(out.results[0].status, 'RECONCILED');
  const pf = await D.portfolio();
  assert.equal(pf.cashUsd, 900);
});

await test('browser tab offline is locked out and installed mode unlocks it', async () => {
  const M = w.WC_MODE;
  assert.equal(M.installed, false);
  w.eval('navigator.onLine = false;');
  M.refresh();
  assert.equal(M.requireOffline(), false, 'browser tab must be gated');
  w.eval('navigator.onLine = true;');
  w.eval('Object.defineProperty(navigator, "standalone", { value: true, configurable: true });');
  M.refresh();
  assert.equal(M.installed, true, 'iOS standalone detected');
  assert.equal(M.requireOffline(), true);
});

/* -------------------------------------------------------------- bundle */
console.log('\nbundle · build output');

await test('the built bundle carries every 3.64 module', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/whalechat.html'), 'utf8');
  ['wc-server-config', 'wc-device-store', 'wc-install-mode', 'wc-sim-engine', 'wc-native-chart', 'wc-recon', 'wc-offline-desk']
    .forEach((m) => assert.ok(html.includes('/* ' + m + ' */'), 'missing ' + m));
  assert.ok(html.includes('OFFLINE SIMULATED'));
  assert.ok(html.includes('nyc.cloud.appwrite.io'));
});

await test('release metadata and service worker cache are rotated', () => {
  const rel = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/release.json'), 'utf8'));
  assert.equal(rel.version, '3.64.0');
  const sw = fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8');
  assert.ok(sw.includes('wc-v3.64.0'));
  assert.ok(sw.includes("'sync'"));
  assert.ok(sw.includes('wc-device-store.js'));
});

console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
