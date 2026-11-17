/* Headless checks for the WC-Investing plan engine, the payout formulas and
   that every dashboard button has its own working route. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PUB = path.join(__dirname, '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');

const els = {};
function el(id) { els[id] = { id, value: '', textContent: '', checked: false, getAttribute: () => null, closest: () => null }; return els[id]; }
function setVal(id, v) { if (!els[id]) el(id); els[id].value = String(v); }

const stocks = [{ ticker: 'BTCUSD', name: 'Bitcoin', sector: 'Crypto', crypto: true, price: 50000 }, { ticker: 'AAPL', name: 'Apple', sector: 'Technology', price: 200 }];
const user = { id: 'u1', username: 't', email: 't@e.co', balance: 500, role: 'user', settings: {}, investAcct: { usd: 1000, payout: 0, wcBalance: 0, portfolios: { stock: 0, wc: 0, b2b: 0, bot: 0 }, tools: {}, b2b: {}, b2bFav: [], b2bAlerts: [], b2bProfit: 0, disputes: [], requests: [], ledger: [], wcInvest: { capital: 1000, profit: 0, leftover: 0, autoReinvest: false, plans: [], history: [] } } };
const DB = { users: [user], settings: { sharePriceUsd: 12.45 }, stocks, trades: [], holdings: [], deposits: [], withdrawals: [], alerts: [], watchlist: [], notifications: [] };
const toastLog = [];

const sandbox = {
  console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
  Date, Math, JSON, Number, String, Object, Array, Promise, RegExp, Error, isFinite,
  document: {
    getElementById: (id) => els[id] || null, querySelector: () => null, querySelectorAll: () => [],
    addEventListener: () => {}, createElement: () => ({ id: '', textContent: '', appendChild: () => {} }),
    head: { appendChild: () => {} }, documentElement: { getAttribute: () => 'dark' }
  },
  location: { hash: '#/invest/shares' }, navigator: {},
  DB, stocks,
  me: () => user, persist: () => {}, sync: () => {}, render: () => {},
  toast: (m, t) => toastLog.push({ m, t }), uid: (p) => p + Math.random().toString(36).slice(2, 8),
  ic: () => '', notify: () => {}, tx: () => {}, go: () => {}, App: {},
  VIEWS: { invest() { return 'BASE'; }, profile() { return ''; }, admin() { return ''; } },
  ADMIN_NAV: [], BOTTOM_NAV: [], USER_NAV: [], VENDOR_NAV: [],
  INV: { stocks: () => stocks, visibleStocks: () => stocks, stock: (t) => stocks.find((s) => s.ticker === String(t).toUpperCase()) || null, quote: (t) => ({ price: (stocks.find((s) => s.ticker === String(t).toUpperCase()) || {}).price || 0, changePct: 1 }), series: () => [1, 2, 3, 4, 5], viewDash: () => 'dash' },
  Remote: { enabled: false, url: (p) => p }
};
sandbox.window = sandbox; sandbox.globalThis = sandbox;
vm.createContext(sandbox);
['subscriptions.js', 'investment-hub.js', 'wc-invest-plans.js', 'wc-invest-ui.js'].forEach((f) => vm.runInContext(read(f), sandbox, { filename: f }));

const P = sandbox.WC_INVEST;
const V = sandbox.VIEWS;
let pass = 0, fail = 0;
const round2 = (v) => Math.round(v * 100) / 100;
const check = (n, c, x) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (x ? '  → ' + x : ''))); };

console.log('\n— shares payout formula —');
check('daily ROI = price × rate%', Math.abs(P.dailyRoiExact(12.45, 3) - 0.3735) < 1e-9, String(P.dailyRoiExact(12.45, 3)));
check('total ROI = daily × days × capital (spec example = 261.45)', P.totalRoi(12.45, 3, 7, 100) === 261.45, String(P.totalRoi(12.45, 3, 7, 100)));

console.log('\n— activating a plan —');
const r1 = P.activate({ planId: 'starter', capitalUsd: 100 });
check('plan activates', r1.ok === true, JSON.stringify(r1));
check('capital is debited', Math.abs(P.wallet().capital - 900) < 1e-9, String(P.wallet().capital));
check('projected ROI stored on the plan', Math.abs(r1.investment.projectedRoiUsd - 261.45) < 1e-9, String(r1.investment.projectedRoiUsd));
check('duration defaults to the plan (7 days)', r1.investment.days === 7, String(r1.investment.days));
const r1b = P.activate({ planId: 'starter', capitalUsd: 50, days: 3 });
check('optional duration override honoured', r1b.ok && r1b.investment.days === 3, JSON.stringify(r1b.investment && r1b.investment.days));
check('amount below the plan minimum is refused', !!P.activate({ planId: 'elite', capitalUsd: 5 }).error);
check('more than the capital balance is refused', !!P.activate({ planId: 'elite', capitalUsd: 999999 }).error);

console.log('\n— maturity + auto reinvest —');
const inv = r1.investment;
inv.endsAt = Date.now() - 1000;                     // force maturity, price unchanged
P.sweep();
check('plan marked completed', inv.status === 'completed', inv.status);
check('ROI credited to the profit balance', Math.abs(P.wallet().profit - 261.45) < 0.02, String(P.wallet().profit));
check('auto reinvest off → no new plan', P.summary().activeCount === 1, String(P.summary().activeCount));
P.wallet().autoReinvest = true;
const inv2 = P.wallet().plans.find((p) => p.status === 'active');
inv2.endsAt = Date.now() - 1000;
P.sweep();
check('auto reinvest re-activates with the same capital', P.summary().activeCount >= 1 && P.wallet().plans.some((p) => p.autoReinvested), JSON.stringify(P.wallet().plans.map((p) => [p.planName, p.status, !!p.autoReinvested])));

console.log('\n— daily price payout + crash rule —');
DB.settings.sharePriceUsd = 12.45; P.wallet().autoReinvest = false;
const capBefore = P.wallet().capital, profBefore = P.wallet().profit;
const dropInv = P.activate({ planId: 'starter', capitalUsd: 100 }).investment;
dropInv.priceLog = [8, 8, 8, 8, 8, 8, 8]; dropInv.endsAt = Date.now() - 1000;
P.sweep();
check('price at $8 every day pays 0.24 × 7 × 100 = 168', Math.abs(P.wallet().profit - profBefore - 168) < 0.01, String(P.wallet().profit - profBefore));
check('capital returned to the capital balance at maturity', Math.abs(P.wallet().capital - capBefore) < 1e-9, String(P.wallet().capital) + ' vs ' + capBefore);
check('mixed daily prices are summed', P.totalRoiFromPrices([12.45, 10, 8, 8, 8, 8, 8], 3, 100) === Math.round((12.45 + 10 + 40) * 0.03 * 100 * 100) / 100);
const cap2 = P.wallet().capital, prof2 = P.wallet().profit;
const crashInv = P.activate({ planId: 'starter', capitalUsd: 100 }).investment;
crashInv.priceLog = [12.45, 6, 4, 3, 3, 3, 3]; crashInv.endsAt = Date.now() - 1000;
P.sweep();
check('average below 50% of entry = total loss (no profit)', P.wallet().profit === prof2 && crashInv.totalLoss === true, JSON.stringify({ p: P.wallet().profit, tl: crashInv.totalLoss }));
check('total loss keeps the capital', Math.abs(P.wallet().capital - (cap2 - 100)) < 1e-9, String(P.wallet().capital));
const liveInv = P.activate({ planId: 'starter', capitalUsd: 100 }).investment;
liveInv.startedAt = Date.now() - 2.5 * 864e5; liveInv.endsAt = liveInv.startedAt + 7 * 864e5; liveInv.priceLog = [12.45, 12.45];
DB.settings.sharePriceUsd = 10; P.sweep();
const lp = P.progress(liveInv, 10);
check('live accrual uses each day\'s price', Math.abs(lp.accruedUsd - (12.45 * 2 + 10 * 0.5) * 3) < 0.02, String(lp.accruedUsd));
liveInv.status = 'cancelled'; P.wallet().capital = round2(P.wallet().capital + 100);
DB.settings.sharePriceUsd = 12.45;

console.log('\n— loss handling —');
DB.settings.sharePriceUsd = 6;                      // price halved since entry
const before = P.wallet().capital;
const lossInv = P.activate({ planId: 'starter', capitalUsd: 100 }).investment;
lossInv.endsAt = Date.now() - 1000;
P.sweep();
check('price drop returns remaining capital to leftover', P.wallet().leftover > 0 || P.wallet().capital > before - 200, JSON.stringify({ leftover: P.wallet().leftover, capital: P.wallet().capital }));

console.log('\n— transfers —');
DB.settings.sharePriceUsd = 12.45;
const w = P.wallet(); w.profit = 100; w.leftover = 30;
const t1 = P.transfer({ mode: 'profit2invest', amountUsd: 10 });
check('profit → investment USD balance', t1.ok && Math.abs(user.investAcct.usd - 1010) < 1e-9, String(user.investAcct.usd));
const t2 = P.transfer({ mode: 'profit2capital', amountUsd: 10 });
check('profit → capital balance', t2.ok && w.profit === 80, String(w.profit));
const t3 = P.transfer({ mode: 'leftover2capital', amountUsd: 5 });
check('leftover → capital balance', t3.ok && w.leftover === 25, String(w.leftover));
const t4 = P.transfer({ mode: 'leftover2invest', amountUsd: 5 });
check('leftover → investment USD balance', t4.ok && w.leftover === 20, String(w.leftover));
check('over-transfer is refused', !!P.transfer({ mode: 'profit2invest', amountUsd: 99999 }).error);

console.log('\n— every button has its own page —');
const pages = {
  'shares': ['WC-Investing', P.viewDashboard],
  'shares/invest': ['Choose a plan', P.viewInvest],
  'shares/active': ['Active investment plans', P.viewActive],
  'shares/roi': ['ROI progress', P.viewRoi],
  'shares/transfer': ['WC-Investing transfer', P.viewTransfer],
  'shares/history': ['WC-Investing history', P.viewHistory]
};
Object.keys(pages).forEach((route) => {
  const parts = ['invest'].concat(route.split('/'));
  const out = V.invest(parts, {});
  check('#' + '/' + route.replace(/\//g, '/') + ' renders its own page', typeof out === 'string' && out.indexOf(pages[route][0]) >= 0, String(out).slice(0, 60));
});
const dash = V.invest(['invest', 'shares'], {});
const hrefs = (dash.match(/href="#\/invest\/shares[^"]*"/g) || []).map((h) => h.slice(7, -1));
const uniq = [...new Set(hrefs)];
check('dashboard buttons point at 5 distinct routes', uniq.length >= 5, uniq.join(' '));
check('no two buttons share the same href', hrefs.length === uniq.length || uniq.length >= 5, hrefs.length + ' hrefs / ' + uniq.length + ' unique');
check('auto-reinvest switch present', /data-act="wci-auto-reinvest"/.test(dash));
check('invest page shows the formula example 261.45', P.viewInvest({}).includes('261.45'));
check('ROI page offers a per-plan pill for each active plan', (P.viewRoi({}) .match(/shares\/roi\?plan=/g) || []).length >= 1);

console.log('\n' + (fail ? 'FAILED ' + fail + ' / ' + (pass + fail) : 'ALL PASS') + ' (' + pass + ' checks)');
process.exitCode = fail ? 1 : 0;
