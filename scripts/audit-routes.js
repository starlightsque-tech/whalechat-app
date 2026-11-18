#!/usr/bin/env node
/* Route audit: boots the assembled bundle in jsdom, signs in as a user or an
   admin, renders every route (user routes + every admin sub-page) and records
   console errors, uncaught exceptions, empty renders and render time.

     node scripts/audit-routes.js --as=user  --net=online
     node scripts/audit-routes.js --as=admin --net=offline
     node scripts/audit-routes.js --all          (runs the four combinations)

   Exit code 1 if any route threw, rendered empty, or took over the slow budget. */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const arg = (n, d) => { const h = args.find((a) => a.startsWith('--' + n + '=')); return h ? h.split('=').slice(1).join('=') : d; };

let JSDOM, indexedDB, IDBKeyRange;
try {
  ({ JSDOM } = require('jsdom'));
  ({ indexedDB, IDBKeyRange } = require('fake-indexeddb'));
} catch (e) {
  console.log('  skip route audit — npm i -D jsdom fake-indexeddb');
  process.exit(0);
}

const PUB = path.resolve(__dirname, '..', 'public');
const HTML = fs.readFileSync(path.join(PUB, 'whalechat.html'), 'utf8');
const SLOW_MS = 4000;

If_all();
function If_all() {
  if (args.includes('--all')) {
    const combos = [['user', 'online'], ['user', 'offline'], ['admin', 'online'], ['admin', 'offline']];
    let bad = 0;
    for (const [who, net] of combos) {
      const out = execFileSync(process.execPath, [__filename, '--as=' + who, '--net=' + net], { encoding: 'utf8' });
      process.stdout.write(out);
      if (/\nFAIL /.test(out) || /FAILED/.test(out)) bad++;
    }
    process.exit(bad ? 1 : 0);
  }
}

const who = arg('as', 'user');
const net = arg('net', 'online');
const offline = net === 'offline';

/* ---------------------------------------------------------------- seed data */
const now = Date.now();
function mkUser(id, username, role, extra) {
  return Object.assign({
    id, username, fullName: username[0].toUpperCase() + username.slice(1), email: username + '@example.com',
    role, balance: 1250, pin: null, cart: [], contacts: [], createdAt: now - 86400000,
    phone: '+1555000' + id.slice(-3), accountId: 'WC' + id.slice(-4).toUpperCase(),
    totalDeposits: 500, totalWithdrawals: 0, referralCode: 'REF' + id.slice(-4).toUpperCase(),
    investAcct: {
      usd: 2500, payout: 120, wcBalance: 300, b2bProfit: 15, stockProfit: 22, autoReinvest: false,
      portfolios: { stock: 2500, wc: 300, b2b: 1200, bot: 100 },
      tools: { autoBuySell: { active: true, since: now - 3600000 } },
      b2b: { AAPL: { units: 1.5, avgPrice: 190 } },
      b2bFav: ['AAPL'], b2bTrades: [
        { id: 'bt_seed1', side: 'buy', ticker: 'AAPL', units: 1.5, price: 190, amount: 285, usd: -285, auto: false, at: now - 7200000 }
      ],
      b2bAlerts: [{ id: 'al_seed', ticker: 'AAPL', buy: 180, sell: 240, buyHit: false, sellHit: false, auto: true, autoAmount: 50, autoState: 'buy', email: true, createdAt: now - 7200000 }],
      ledger: [
        { id: 'il_1', label: 'B2B buy AAPL', usd: -285, coins: 0, scope: 'b2b', meta: { ticker: 'AAPL' }, at: now - 7200000 },
        { id: 'il_2', label: 'Auto Buy/Sell bought AAPL at $190.00', usd: -95, coins: 0, scope: 'b2b', meta: { ticker: 'AAPL', auto: true }, at: now - 3600000 }
      ],
      disputes: [], requests: []
    }
  }, extra || {});
}

const users = [
  mkUser('u_admin', 'admin', 'admin', { pin: '1234' }),
  mkUser('u_alice', 'alice', 'user'),
  mkUser('u_bob', 'bob', 'vendor'),
  mkUser('u_carol', 'carol', 'user')
];
const products = [1, 2, 3].map((i) => ({
  id: 'p' + i, name: 'Product ' + i, priceUsd: 25 * i, stock: 10, active: true,
  vendorId: 'v1', category: 'General', desc: 'A product', image: null, emoji: '📦',
  starUsers: [], stars: 0, createdAt: now - 86400000
}));
const vendors = [{ id: 'v1', userId: 'u_bob', username: 'bob', storeName: 'Bob Store', active: true, plan: 'standard', sales: 3, revenue: 90, createdAt: now - 86400000 }];
const orders = [{
  id: 'ord1', ref: 'WC-ABC12', buyerId: 'u_alice', vendorId: 'v1',
  items: [{ productId: 'p1', name: 'Product 1', qty: 1, priceUsd: 25 }],
  totalUsd: 25, totalCoins: 50, delivery: { fullName: 'Alice', phone: '+1555', email: 'a@e.com', country: 'US', address: '1 Main St' },
  status: 'processing', createdAt: now - 3600000, payment: 'whale_coin',
  timeline: [{ status: 'processing', at: now - 3600000, note: 'placed' }]
}];
const stocks = [
  { ticker: 'AAPL', name: 'Apple', assetClass: 'us', price: 210, prevClose: 208, sector: 'Tech', vol: 1e6 },
  { ticker: 'TSLA', name: 'Tesla', assetClass: 'us', price: 350, prevClose: 345, sector: 'Auto', vol: 2e6 },
  { ticker: '7203_T', displayTicker: '7203.T', finnhubSymbol: '7203.T', name: 'Toyota Motor', assetClass: 'global', price: 2563, prevClose: 2504, sector: 'Automotive', vol: 1e5 },
  { ticker: 'BTCUSDT', name: 'Bitcoin', assetClass: 'crypto', price: 62000, prevClose: 61000, sector: 'Crypto', vol: 5e6 }
];
const trades = [{
  id: 'lt1', userId: 'u_alice', type: 'live', ticker: 'AAPL', name: 'Apple', side: 'long', direction: 'RISE',
  capitalCoins: 100, stakeAmount: 100, entryPrice: 205, initialEntryPrice: 205, leverage: 5,
  status: 'Open', createdAt: now - 600000, expiresAt: now + 3000000, moves: 0, secured: 0
}];

const db = {
  users, products, vendors, orders, stocks, trades,
  messages: [
    { id: 'm1', chatId: 'u_admin__u_alice', from: 'u_alice', to: 'u_admin', type: 'text', text: 'Hello admin', createdAt: now - 100000, status: 'sent', deleted: false, readBy: [] },
    { id: 'm2', chatId: 'u_admin__u_alice', from: 'u_admin', to: 'u_alice', type: 'text', text: 'Hi Alice', createdAt: now - 90000, status: 'sent', deleted: false, readBy: [] }
  ],
  contacts: [{ id: 'ct1', ownerId: 'u_alice', userId: 'u_admin', createdAt: now }, { id: 'ct2', ownerId: 'u_admin', userId: 'u_alice', createdAt: now }],
  txs: [{ id: 'tx1', userId: 'u_alice', type: 'deposit', label: 'Deposit approved', coins: 100, createdAt: now - 7200000 }],
  deposits: [{ id: 'dep1', userId: 'u_alice', usd: 50, coins: 100, coin: 'USDT', method: 'crypto', methodName: 'USDT', detail: 'addr', status: 'pending', createdAt: now - 3600000, note: '' }],
  withdrawals: [{ id: 'wd1', userId: 'u_alice', network: 'TRC20', address: 'TXyz123456789', coins: 20, usd: 10, status: 'pending', createdAt: now - 1800000, note: '' }],
  notifications: [{ id: 'n1', userId: 'u_alice', title: 'Welcome', body: 'Hi', link: '#/home', read: false, channel: 'system', createdAt: now - 50000 }],
  statuses: [], chatsMeta: {}, alerts: [], blocks: [], reports: [], audit: [], disputes: [],
  b2bAutoJournal: [
    { id: 'ab_1', userId: 'u_alice', ticker: 'AAPL', side: 'buy', price: 190, units: 0.5, amount: 95, at: now - 3600000 },
    { id: 'as_1', userId: 'u_alice', ticker: 'AAPL', side: 'sell', price: 240, units: 0.5, proceeds: 120, basis: 95, payout: 25, at: now - 1800000 }
  ],
  settings: {
    crypto: [{ id: 'c1', name: 'USDT TRC20', address: 'TXyz123456789', note: '' }],
    banks: [{ id: 'b1', bankName: 'Test Bank', accountName: 'WhaleChat', accountNumber: '12345678', swift: 'TESTUS33', routing: '021000021', country: 'US' }],
    networks: ['TRC20', 'ERC20'], leverage: 5, feePct: 0.5, depositNote: 'Send only USDT',
    maintenance: { active: false }, push: { enabled: false }
  },
  shares: { plans: [], investments: [] },
  meta: {}
};

const routes = [
  'home', 'chat/u_admin', 'contacts', 'notifications', 'status',
  'market', 'markets', 'product/p1', 'store/v1', 'cart', 'checkout', 'orders', 'track',
  'wallet', 'deposit', 'withdraw', 'transfer', 'account',
  'invest', 'investment', 'investment/b2b', 'investment/b2b/buy', 'investment/b2b/sell', 'investment/b2b/alerts',
  'investment/history', 'investment/history/b2b', 'investment/history/stock', 'investment/history/bot', 'investment/history/wc',
  'investment/tools', 'investment/transfer', 'investment/topup', 'investment/statement', 'investment/disputes', 'investment/more',
  'invest/market', 'invest/stock/7203_T', 'invest/stock/AAPL', 'invest/bots', 'invest/shares', 'invest/watchlist', 'invest/orders',
  'profile', 'settings', 'referrals', 'bonuses', 'trade', 'vendor', 'vendor/products', 'vendor/orders', 'vendor/history',
  'admin'
];
const ADMIN_PAGES = ['users','user-360','deposits','withdrawals','orders','products','vendors','vendor-requests','stocks','market-data',
  'market-controls','servers','connections','server-details','email','notifications','release','audit','trade-guide','settings',
  'b2b-inventory','shares','bots','tools','bonuses','refunds','requests','sales','help-desk','livechat','chat','invest-disputes',
  'service-settings','demo-activity','demo-sellers'];

/* plan gold: admin has extra routes */
const allRoutes = who === 'admin'
  ? ['home', 'admin'].concat(ADMIN_PAGES.map((p) => 'admin/' + p))
  : routes;

/* ---------------------------------------------------------------- harness */
const nodeRejections = [];
process.on('unhandledRejection', (r) => { nodeRejections.push(String((r && r.message) || r)); });

(async () => {
  const dom = new JSDOM(HTML, {
    url: 'https://app.test/whalechat.html#/home',
    pretendToBeVisual: true,
    runScripts: 'dangerously',
    beforeParse(w) {
      const session = { userId: who === 'admin' ? 'u_admin' : 'u_alice', at: Date.now() };
      w.localStorage.setItem('whalechat.db.v1', JSON.stringify(db));
      w.localStorage.setItem('whalechat.session.v1', JSON.stringify(session));
      w.indexedDB = indexedDB;
      w.IDBKeyRange = IDBKeyRange;
      w.Notification = function () {};
      w.Notification.permission = 'granted';
      w.Notification.requestPermission = () => Promise.resolve('granted');
      const okJson = JSON.stringify({ ok: true, prices: {}, quotes: {}, symbols: [], results: [], alerts: [] });
      w.fetch = () => offline ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve(
        new Response(okJson, { status: 200, headers: { 'content-type': 'application/json' } })
      );
      w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
      w.HTMLCanvasElement.prototype.getContext = () => null;
      w.navigator.serviceWorker = { controller: null, ready: new Promise(() => {}), register: () => Promise.resolve({}), getRegistration: () => Promise.resolve(null), addEventListener() {} };
      w.scrollTo = () => {};
      w.confirm = () => true;
      w.alert = () => {};
    }
  });
  const w = dom.window;
  const doc = w.document;

  const errors = [];
  w.addEventListener('error', (e) => errors.push('error: ' + (e.message || e.error)));
  w.addEventListener('unhandledrejection', (e) => errors.push('rejection: ' + ((e.reason && e.reason.message) || e.reason)));
  const origError = w.console.error;
  w.console.error = function () {
    const msg = Array.prototype.map.call(arguments, (a) => (a && a.message) || String(a)).join(' ');
    if (!/offline|Failed to fetch|fetch is not defined|Not implemented|Could not parse CSS|sw\.js|service worker/i.test(msg)) errors.push('console: ' + msg.slice(0, 160));
    try { origError.apply(w.console, arguments); } catch (e) {}
  };

  if (offline) Object.defineProperty(w.navigator, 'onLine', { value: false, configurable: true });

  await new Promise((r) => setTimeout(r, 3000));
  const page = (e) => w.eval(e);
  const signedIn = page('!!(SESSION && SESSION.userId)');
  const rows = [];

  for (const route of allRoutes) {
    errors.length = 0;
    if (process.env.DEBUG_ROUTES) process.stderr.write('→ ' + route + '\n');
    const t0 = Date.now();
    try {
      w.location.hash = '#/' + route;
      w.dispatchEvent(new w.Event('hashchange'));
      await new Promise((r) => setTimeout(r, 120));
    } catch (e) {
      errors.push('navigate: ' + e.message);
    }
    const ms = Date.now() - t0;
    const content = doc.getElementById('content');
    const text = content ? content.textContent.trim() : '';
    const notFound = /Page not found/i.test(text);
    const empty = !text || text.length < 2;
    rows.push({ route, ms, len: text.length, notFound, empty, errors: errors.slice(0, 3) });
  }

  const failed = rows.filter((r) => r.notFound || r.empty || r.errors.length || r.ms > SLOW_MS);
  console.log('\n' + (who === 'admin' ? 'ADMIN' : 'USER') + ' · ' + net.toUpperCase() + ' · signed in: ' + signedIn + ' · routes: ' + rows.length);
  for (const r of rows) {
    if (failed.includes(r)) {
      console.log('  FAIL ' + r.route.padEnd(32) + ' ' + String(r.ms).padStart(4) + 'ms len=' + r.len +
        (r.notFound ? ' NOT-FOUND' : '') + (r.empty ? ' EMPTY' : '') + (r.ms > SLOW_MS ? ' SLOW' : '') +
        (r.errors.length ? '\n         ' + r.errors.join('\n         ') : ''));
    }
  }
  const slowest = rows.slice().sort((a, b) => b.ms - a.ms).slice(0, 3).map((r) => r.route + ' ' + r.ms + 'ms').join(', ');
  console.log('  ' + (rows.length - failed.length) + '/' + rows.length + ' routes clean · slowest: ' + slowest);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('audit crashed:', e && e.stack || e); process.exit(1); });
