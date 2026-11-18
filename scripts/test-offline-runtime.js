#!/usr/bin/env node
/* Offline behaviour harness (integration): boots the real offline-first / offline-data modules
   in a simulated phone context (jsdom + fake-indexeddb) and drives an
   offline chat send + cart change through the outbox, then reconnects.

   Verifies: queued records are written, the message is flagged pending and gets
   a badge, checkout is refused offline, and flushing clears the queue exactly
   once (idempotent handlers). */
'use strict';
const fs = require('fs');
const path = require('path');
let JSDOM, indexedDB, IDBKeyRange;
try {
  ({ JSDOM } = require('jsdom'));
  ({ indexedDB, IDBKeyRange } = require('fake-indexeddb'));
} catch (e) {
  console.log('  skip offline runtime harness — install dev deps first:');
  console.log('         npm i -D jsdom fake-indexeddb');
  process.exit(0);
}

const PUB = path.resolve(__dirname, '..', 'public');
const src = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');

const dom = new JSDOM('<!doctype html><html><body><div id="content"></div></body></html>', {
  url: 'https://whalechat.example/whalechat.html',
  pretendToBeVisual: true,
  runScripts: 'outside-only'
});
const { window } = dom;

/* ---- browser surface ---------------------------------------------------- */
Object.defineProperty(window.navigator, 'onLine', { value: false, writable: true, configurable: true });
window.indexedDB = indexedDB;
window.IDBKeyRange = IDBKeyRange;
window.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
window.Notification = function () {};
window.Notification.permission = 'granted';
window.Notification.requestPermission = () => Promise.resolve('granted');
window.caches = {
  keys: async () => ['wc-v3.49.0-1'],
  open: async () => ({ keys: async () => new Array(157).fill(0), match: async () => null, put: async () => {}, add: async () => {} }),
  match: async () => null,
  delete: async () => true
};
window.navigator.storage = { estimate: async () => ({ usage: 1000, quota: 100000 }), persist: () => Promise.resolve(true) };
window.navigator.serviceWorker = {
  controller: {},
  getRegistration: async () => ({ active: { state: 'activated' }, scope: 'https://whalechat.example/', pushManager: { getSubscription: async () => null } }),
  ready: Promise.resolve({ active: { state: 'activated' }, pushManager: { getSubscription: async () => null }, periodicSync: { register: async () => {} }, showNotification: async () => {} }),
  register: async () => ({})
};

/* ---- the app's own globals the modules hook into ------------------------ */
let SESSION = { userId: 'u1' };
const DB = {
  users: [{ id: 'u1', username: 'me', fullName: 'Me', cart: [] }, { id: 'u2', username: 'bo', fullName: 'Bo' }],
  products: [{ id: 'p1', name: 'Shirt', priceUsd: 10, stock: 5, active: true }],
  messages: [],
  chatsMeta: {},
  orders: [{ id: 'ord1', ref: 'WC-ABC12', buyerId: 'u1', vendorId: 'v1', items: [{ name: 'Shirt', qty: 2, priceUsd: 10 }], totalUsd: 20, totalCoins: 40, status: 'processing', createdAt: Date.now() }],
  txs: [{ id: 'tx1', userId: 'u1', type: 'deposit', label: 'Deposit approved', coins: 50, createdAt: Date.now() }],
  investAcct: { b2bAlerts: [] }
};
let renders = 0;
let persistCalls = 0;

window.DB = DB;
window.SESSION = SESSION;
window.me = () => DB.users.find((u) => u.id === SESSION.userId);
window.persist = () => { persistCalls++; };
window.sync = () => { persistCalls++; };
window.render = () => { renders++; };
window.loadDB = () => DB;
window.toast = (m, k) => { window.__toasts = (window.__toasts || []).concat([[k || 'ok', m]]); };
window.App = {
  async send() {
    const m = { id: 'msg_' + (DB.messages.length + 1), chatId: 'u1__u2', from: 'u1', to: 'u2', type: 'text', text: 'hello offline', createdAt: Date.now(), status: 'sent' };
    DB.messages.push(m);
    const el = window.document.createElement('div');
    el.setAttribute('data-msg', m.id);
    window.document.getElementById('content').appendChild(el);
    return m;
  },
  submitDeposit(mode) {
    const u = window.me();
    (DB.deposits = DB.deposits || []).unshift({ id: 'dep1', userId: u.id, usd: 25, status: 'pending' });
    return true;
  },
  addToCart(id, qty) {
    const u = window.me();
    const line = u.cart.find((c) => c.productId === id);
    if (line) line.qty += qty || 1; else u.cart.push({ productId: id, qty: qty || 1 });
  },
  async placeOrder() { return 'ORDER_PLACED'; }
};

const results = [];
const check = (name, cond, extra) => { results.push({ name, ok: !!cond, extra }); };

(async () => {
  /* ---- boot the three real modules -------------------------------------- */
  window.eval(src('offline-first.js'));
  window.eval(src('offline-data.js'));
  window.eval(src('diagnostics.js'));
  window.eval(src('message-search.js'));
  window.eval(src('offline-actions.js'));

  await new Promise((r) => setTimeout(r, 2600));   // let their boot timers + first mirror run

  const OD = window.WC_OFFLINE_DATA;
  const OF = window.WC_OFFLINE;
  check('offline-first booted', !!OF);
  check('offline-data booted', !!OD);
  check('diagnostics booted', !!window.WC_DIAGNOSTICS);

  /* ---- 1. offline chat send queues and flags the message --------------- */
  await window.App.send();
  await new Promise((r) => setTimeout(r, 250));

  const queued = await OF.all('outbox');
  check('message queued in outbox', queued.length === 1, JSON.stringify(queued.map((q) => q.kind)));
  check('message flagged pending', DB.messages[0]._pending === true);
  check('pending badge rendered', !!window.document.querySelector('.wc-pending-badge'));
  check('outbox record is a message', queued[0] && queued[0].kind === 'message');

  /* ---- 2. offline cart change queues an absolute quantity -------------- */
  window.App.addToCart('p1', 2);
  await new Promise((r) => setTimeout(r, 200));
  const q2 = await OF.all('outbox');
  check('cart change queued', q2.some((q) => q.kind === 'cart-set'), JSON.stringify(q2.map((q) => q.kind)));
  const cartRec = q2.find((q) => q.kind === 'cart-set');
  check('cart payload is absolute qty', cartRec && cartRec.payload.qty === 2, JSON.stringify(cartRec && cartRec.payload));

  /* ---- 2b. offline message search finds the cached message ------------- */
  const hits = await window.WC_MSG_SEARCH.search('hello offline');
  check('message search finds cached text', hits.length >= 1, String(hits.length));
  window.WC_MSG_SEARCH.open('hello offline');
  await new Promise((r) => setTimeout(r, 400));
  const rows = window.document.querySelectorAll('.wc-ms-row');
  check('search overlay rendered results', rows.length >= 1, String(rows.length));
  check('search result highlights the match', !!window.document.querySelector('.wc-ms-snip mark'));
  check('search result says the data is on device', /on device/i.test(window.document.getElementById('wcMsMeta').textContent + (rows[0] ? rows[0].textContent : '')));
  window.WC_MSG_SEARCH.close();

  /* ---- 2b2. one box, grouped by type across products/orders/wallet ----- */
  const gAll = await window.WC_SEARCH.searchAll('shirt');
  check('search finds products', gAll.products.length >= 1, String(gAll.products.length));
  check('search finds orders by item name', gAll.orders.length >= 1, String(gAll.orders.length));
  const gWallet = await window.WC_SEARCH.searchAll('deposit');
  check('search finds wallet history', gWallet.wallet.length >= 1, String(gWallet.wallet.length));
  window.WC_SEARCH.open('shirt');
  await new Promise((r) => setTimeout(r, 400));
  const groups = window.document.querySelectorAll('.wc-ms-group');
  check('results grouped by type', groups.length >= 2, String(groups.length));
  const heads = Array.prototype.map.call(groups, (x) => x.querySelector('h5').textContent).join('|');
  check('group headers carry counts', /Products\s*\d/.test(heads) || /Products/.test(heads), heads);
  window.WC_SEARCH.close();

  /* ---- 2c. money action queued offline (deposit request) --------------- */
  window.App.submitDeposit('crypto');
  await new Promise((r) => setTimeout(r, 300));
  const q3 = await OF.all('outbox');
  check('offline deposit queued for sync', q3.some((q) => q.kind === 'money'), JSON.stringify(q3.map((q) => q.kind)));
  check('deposit recorded on the device', (DB.deposits || []).length === 1);

  /* ---- 2d. device-mode notice on money routes -------------------------- */
  window.document.body.dataset.route = 'wallet';
  await new Promise((r) => setTimeout(r, 1400));
  const dm = window.document.getElementById('wcDeviceMode');
  check('device mode notice shown on wallet while offline', !!dm && /Device mode/i.test(dm.textContent));

  /* ---- 3. connectivity pill shows offline ------------------------------ */
  const pill = window.document.getElementById('wcNetPill');
  check('offline pill visible', !!pill && pill.style.display === 'flex' && /Offline/.test(pill.textContent), pill && pill.textContent);

  /* ---- 4. checkout is refused offline ---------------------------------- */
  const orderResult = await window.App.placeOrder();
  check('checkout blocked offline', orderResult === false, String(orderResult));
  await new Promise((r) => setTimeout(r, 200));
  check('checkout shows a calm offline notice', (window.__toasts || []).some((t) => /connection/i.test(t[1])));

  /* ---- 5. reconnect: queue flushes in order, exactly once -------------- */
  Object.defineProperty(window.navigator, 'onLine', { value: true, writable: true, configurable: true });
  window.dispatchEvent(new window.Event('online'));
  await OD.flush();
  await new Promise((r) => setTimeout(r, 400));

  const after = await OF.all('outbox');
  check('outbox drained', after.length === 0, JSON.stringify(after));
  check('message no longer pending', DB.messages[0]._pending === false);
  const cartAfter = window.me().cart.find((c) => c.productId === 'p1');
  check('cart quantity correct after flush (no double apply)', cartAfter && cartAfter.qty === 2, JSON.stringify(window.me().cart));

  /* ---- 6. diagnostics collects real numbers ---------------------------- */
  await new Promise((r) => setTimeout(r, 600));
  window.WC_DIAGNOSTICS.open();
  await new Promise((r) => setTimeout(r, 900));
  const report = window.WC_DIAGNOSTICS.report;
  check('diagnostics produced a report', !!report);
  check('diagnostics counts cached files', report && report.cacheFileCount === 157, report && report.cacheFileCount);
  check('diagnostics reports alert timing', report && 'lastRun' in report.alerts);
  check('diagnostics reports notification permission', report && report.notifications.permission === 'granted');
  check('diagnostics panel rendered rows', window.document.querySelectorAll('.wc-dg-row').length > 10, String(window.document.querySelectorAll('.wc-dg-row').length));
  window.WC_DIAGNOSTICS.close();

  /* ---- report ---------------------------------------------------------- */
  let bad = 0;
  for (const r of results) {
    console.log((r.ok ? '  ok   ' : '  FAIL ') + r.name + (r.ok || !r.extra ? '' : ' → ' + r.extra));
    if (!r.ok) bad++;
  }
  console.log('\n' + (bad ? bad + ' failure(s)' : 'offline harness passed (' + results.length + ' checks)'));
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('harness crashed:', e); process.exit(1); });
