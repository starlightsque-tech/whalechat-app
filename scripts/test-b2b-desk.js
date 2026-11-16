/* Headless smoke test for the B2B desk + shared subscription registry.
   Runs the real client modules in a vm sandbox with a minimal DOM stub. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PUB = path.join(__dirname, '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');

const els = {};
function el(id, value) { els[id] = { id, value, checked: false, textContent: '', getAttribute: () => null, querySelector: () => null }; return els[id]; }
function setVal(id, v) { if (!els[id]) el(id, ''); els[id].value = String(v); return els[id]; }

const stocks = [
  { ticker: 'BTCUSD', name: 'Bitcoin', sector: 'Crypto', crypto: true, price: 50000, prevClose: 50000 },
  { ticker: 'AAPL', name: 'Apple Inc', sector: 'Technology', price: 200, prevClose: 200 },
  { ticker: 'SPX', name: 'S&P 500', sector: 'Indices', price: 5000, prevClose: 5000 }
];
const prices = { BTCUSD: 50000, AAPL: 200, SPX: 5000 };
const user = { id: 'u1', username: 'tester', email: 't@example.com', balance: 500, investAcct: null, role: 'user', settings: {} };
const DB = {
  users: [user], settings: {}, stocks: [], trades: [], holdings: [], deposits: [], withdrawals: [],
  alerts: [], watchlist: [], notifications: [], orders: []
};

const sandbox = {
  console,
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
  Date, Math, JSON, Number, String, Object, Array, Promise, RegExp, Error,
  document: {
    getElementById: (id) => els[id] || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    createElement: () => ({ id: '', textContent: '', appendChild: () => {} }),
    head: { appendChild: () => {} },
    documentElement: { getAttribute: () => 'dark' }
  },
  location: { hash: '#/investment/b2b' },
  navigator: {},
  DB, stocks,
  me: () => user,
  persist: () => {},
  sync: () => {},
  render: () => {},
  toast: (m, t) => { toastLog.push({ m, t }); },
  uid: (p) => p + Math.random().toString(36).slice(2, 8),
  ic: () => '',
  notify: () => {},
  tx: () => {},
  App: {},
  VIEWS: { invest() { return ''; }, profile() { return ''; }, admin() { return ''; } },
  ADMIN_NAV: [], BOTTOM_NAV: [], USER_NAV: [], VENDOR_NAV: [],
  INV: {
    stocks: () => stocks,
    visibleStocks: () => stocks,
    stock: (t) => stocks.find((s) => s.ticker === String(t).toUpperCase()) || null,
    quote: (t) => { const p = prices[String(t).toUpperCase()]; return p ? { price: p, changePct: 1.23 } : null; },
    series: () => [1, 2, 3, 4, 5],
    viewDash: () => '<div>dash</div>'
  },
  Remote: { enabled: false, url: (p) => p }
};
const toastLog = [];
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

vm.runInContext(read('subscriptions.js'), sandbox, { filename: 'subscriptions.js' });
vm.runInContext(read('investment-hub.js'), sandbox, { filename: 'investment-hub.js' });

(async () => {
const A = sandbox.App;
const S = sandbox.WC_SUBS;
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')); }
}
function lastToast() { return toastLog[toastLog.length - 1] || {}; }
function acct() { return user.investAcct; }

console.log('\n— capital / top-up —');
acct().usd = 1000;
A.ihB2bTopup();                          // no amount → must refuse
check('top-up refuses an empty amount', /Enter an amount/.test(lastToast().m), lastToast().m);
setVal('ihB2bTopAmount', 400);
setVal('ihB2bTopFrom', 'usd');
A.ihB2bTopup();
check('top-up moves USD into B2B capital', acct().portfolios.b2b === 400 && acct().usd === 600, JSON.stringify({ cap: acct().portfolios.b2b, usd: acct().usd }));

console.log('\n— buy —');
setVal('ihB2bBuyAmount', 100);
A.ihB2bBuy(null, { t: 'BTCUSD' });
const h = acct().b2b.BTCUSD;
check('buy debits capital', acct().portfolios.b2b === 300, String(acct().portfolios.b2b));
check('buy credits units at the live price', h && Math.abs(h.units - 100 / 50000) < 1e-12, JSON.stringify(h));
check('buy sets entry price', h && h.avgPrice === 50000);
check('buy draws down company inventory', Math.abs(Number(DB.settings.b2bInventory.BTCUSD) - (100000 - 100 / 50000)) < 1e-8, String(DB.settings.b2bInventory.BTCUSD));
setVal('ihB2bBuyAmount', 999999);
A.ihB2bBuy(null, { t: 'AAPL' });
check('buy refuses more than the capital balance', /Not enough capital/.test(lastToast().m), lastToast().m);
check('refused buy does not change capital', acct().portfolios.b2b === 300, String(acct().portfolios.b2b));

console.log('\n— sell —');
prices.BTCUSD = 60000;                   // +20%
const beforeCapital = acct().portfolios.b2b;
A.ihB2bSell(null, { t: 'BTCUSD', all: '1' });
const expectedBasis = 100;               // principal returns to capital
const expectedPayout = 20;               // 100 → 120 at +20%
check('sell returns the principal to capital', Math.abs(acct().portfolios.b2b - (beforeCapital + expectedBasis)) < 0.011, String(acct().portfolios.b2b));
check('sell credits the payout to the profit balance', Math.abs(acct().b2bProfit - expectedPayout) < 0.011, String(acct().b2bProfit));
check('sell removes the holding', !acct().b2b.BTCUSD);
check('sell returns units to company inventory', Math.abs(Number(DB.settings.b2bInventory.BTCUSD) - 100000) < 1e-8, String(DB.settings.b2bInventory.BTCUSD));

console.log('\n— transfer —');
setVal('ihB2bTrAmount', 5);
setVal('ihB2bTrMode', 'profit2invest');
A.ihB2bTransfer();
check('profit → investment profit balance', Math.abs(acct().payout - 5) < 1e-9 && Math.abs(acct().b2bProfit - (expectedPayout - 5)) < 0.011, JSON.stringify({ payout: acct().payout, profit: acct().b2bProfit }));
setVal('ihB2bTrAmount', 1000);
A.ihB2bTransfer();
check('transfer refuses more than the profit balance', /Not enough B2B profit/.test(lastToast().m), lastToast().m);
setVal('ihB2bTrAmount', 3);
setVal('ihB2bTrMode', 'profit2capital');
const capBefore = acct().portfolios.b2b;
A.ihB2bTransfer();
check('profit → capital balance', Math.abs(acct().portfolios.b2b - (capBefore + 3)) < 1e-9, String(acct().portfolios.b2b));

console.log('\n— shared subscriptions —');
acct().usd = 100;
const r1 = await S.subscribe('autosecure', { source: 'tools', skipPin: true });
check('tools page subscribes Auto Secure', r1.ok === true, JSON.stringify(r1));
check('charges the catalogue price once', Math.abs(acct().usd - 90.01) < 0.001, String(acct().usd));
check('registry marks it active everywhere', S.is('autosecure') === true);
const r2 = await S.subscribe('autosecure', { source: 'stock', skipPin: true });
check('second subscribe is refused (no double charge)', r2.already === true && Math.abs(acct().usd - 90.01) < 0.001, JSON.stringify({ r2, usd: acct().usd }));
S.set('autosecure', { active: true, expiresAt: Date.now() + 864e5, paused: false, source: 'bots' }, { silent: true });
check('bots page sees the same record', S.record('autosecure').source === 'bots' && S.is('autosecure'));
check('shared badge renders subscribed', /Subscribed/.test(S.badge('autosecure')));

console.log('\n— bot tier mirroring —');
sandbox.WC_BOTS = { state: { tiers: [{ id: 'tier_1', name: 'Alpha Bot', owned: true, priceUsd: 15 }], autoSecure: { active: true, enabled: true, expiresAt: Date.now() + 864e5, priceCoins: 30, priceUsd: 15 } } };
S.reconcile({ silent: true });
check('owned bot tier appears in the shared registry', !!S.record('tier_1'), JSON.stringify(S.record('tier_1')));

console.log('\n— page renderers —');
const pages = {
  dash: '<div class="b2b-pair"',
  buy: 'ihB2bBuyAmount',
  sell: 'Sell assets',
  assets: 'ihB2bMultiAmount',
  topup: 'ihB2bTopAmount',
  transfer: 'ihB2bTrMode'
};
['dash', 'buy', 'sell', 'assets', 'topup', 'transfer'].forEach((k) => {
  try {
    const out = sandbox.VIEWS.investment(['investment', 'b2b', k === 'dash' ? undefined : k].filter(Boolean), {});
    check('b2b ' + k + ' page renders', typeof out === 'string' && out.indexOf(pages[k]) >= 0, out && out.slice(0, 80));
  } catch (e) { check('b2b ' + k + ' page renders', false, e.message); }
});
try {
  const tools = sandbox.VIEWS.investment(['investment', 'tools'], {});
  check('tools page shows the subscribed state', /Subscribed/.test(tools) && /Bot traders/.test(tools));
  check('tools page hides the Subscribe button for an owned tool', tools.indexOf('data-act="ih-tool-sub" data-tool="autosecure"') === -1);
} catch (e) { check('tools page renders', false, e.message); }

if (process.env.DBG) {
  console.log('me():', JSON.stringify(sandbox.me() && sandbox.me().id));
  console.log('VIEWS keys:', Object.keys(sandbox.VIEWS));
  console.log('invest src:', String(sandbox.VIEWS.invest).slice(0,240));
  console.log('me in sandbox:', sandbox.me() ? 'ok' : 'null');
  ['investment','investment/tools','investment/b2b','investment/b2b/buy'].forEach((k)=>{ const parts=k.split('/'); const oo=sandbox.VIEWS.investment(parts,{}); console.log(k, '->', typeof oo, oo&&oo.length); });
  const o = sandbox.VIEWS.investment(['investment', 'b2b'], {});
  console.log('type:', typeof o, 'len:', o && o.length);
  console.log('head sample:', String(o).slice(0, 300));
}
console.log('\n' + (fail ? 'FAILED ' + fail + ' / ' + (pass + fail) : 'ALL PASS') + ' (' + pass + ' checks)');
process.exitCode = fail ? 1 : 0;

})().catch((e) => { console.error('harness error:', e); process.exit(2); });
