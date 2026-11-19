#!/usr/bin/env node
/* 3.57 acceptance harness: dashboard card, default My account, offline banner,
   transaction PIN settings, reset view and WC-Investing chart. */
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let JSDOM, indexedDB, IDBKeyRange;
try {
  ({ JSDOM } = require('jsdom'));
  ({ indexedDB, IDBKeyRange } = require('fake-indexeddb'));
} catch (e) {
  console.log('  skip 3.57 harness — npm i -D jsdom fake-indexeddb');
  process.exit(0);
}
const PUB = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'public');
const html = fs.readFileSync(path.join(PUB, 'whalechat.html'), 'utf8');
const now = Date.now();
const user = {
  id: 'u1', username: 'tester', fullName: 'Test User', email: 't@example.com', role: 'user',
  pass: 'x', balance: 1000, pin: null, cart: [], contacts: [], createdAt: now, verified: true,
  investAcct: { usd: 2500, payout: 120, portfolios: { stock: 0, wc: 500, b2b: 0, bot: 0 }, wcInvest: { profit: 0, leftover: 0, plans: [], history: [] }, tools: {}, b2b: {}, b2bAlerts: [], ledger: [] }
};
const db = { users: [user], stocks: [{ ticker: 'AAPL', name: 'Apple', assetClass: 'us', price: 230, prevClose: 228, sector: 'Technology' }], products: [], orders: [], messages: [], txs: [], vendors: [], deposits: [], withdrawals: [], contacts: [], notifications: [], statuses: [], chatsMeta: {}, alerts: [], blocks: [], settings: { crypto: [], banks: [], networks: ['TRC20'], leverage: 5 }, trades: [], reports: [], audit: [], meta: {} };
const dom = new JSDOM(html, {
  url: 'https://app.test/whalechat.html#/profile', pretendToBeVisual: true, runScripts: 'dangerously',
  beforeParse(window) {
    window.localStorage.setItem('whalechat.db.v1', JSON.stringify(db));
    window.localStorage.setItem('whalechat.session.v1', JSON.stringify({ userId: 'u1', at: now }));
    window.indexedDB = indexedDB; window.IDBKeyRange = IDBKeyRange;
    window.Notification = function () {}; window.Notification.permission = 'granted';
    window.Notification.requestPermission = () => Promise.resolve('granted');
    window.fetch = () => Promise.reject(new TypeError('offline in harness'));
    window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
    window.HTMLCanvasElement.prototype.getContext = () => null;
    window.navigator.serviceWorker = { controller: null, ready: new Promise(() => {}), register: () => Promise.resolve({}), getRegistration: () => Promise.resolve(null), addEventListener() {} };
    window.scrollTo = () => {};
  }
});
const { window } = dom;
const doc = window.document;
const page = (e) => window.eval(e);
const results = [];
const check = (n, ok, extra) => results.push({ n, ok: !!ok, extra });

(async () => {
  await new Promise((r) => setTimeout(r, 2800));
  check('app booted', page('typeof DB !== "undefined" && !!DB'));
  check('3.57 module booted', page('!!window.WC_BUILD_357'));

  /* dashboard card */
  const card = doc.querySelector('#app .wallet-card');
  check('dashboard card enlarged', card && card.classList.contains('wc-dash-lg'));
  const acts = card ? card.querySelector('.wallet-actions') : null;
  const labels = acts ? Array.from(acts.querySelectorAll('a,button')).map((b) => (b.textContent || '').trim()) : [];
  check('stocks-trade button renamed', labels.includes('stocks-trade'), labels.join(' | '));
  check('WC-invest button added', labels.includes('WC-invest'));
  check('vendor button added', labels.includes('vendor'));

  /* offline banner hidden */
  doc.body.insertAdjacentHTML('beforeend', '<div id="wcOfflineChip" class="wc-offline-chip">Offline — your work is saved</div>');
  await new Promise((r) => setTimeout(r, 300));
  check('offline banner removed', !doc.getElementById('wcOfflineChip'));

  /* settings: transaction PIN card */
  window.location.hash = '#/settings';
  window.dispatchEvent(new window.Event('hashchange'));
  await new Promise((r) => setTimeout(r, 600));
  check('transaction PIN card in Settings', !!doc.getElementById('wc357PinCard'));
  check('PIN can be set from Settings', /Set transaction PIN|Change transaction PIN/.test((doc.getElementById('wc357PinCard') || {}).textContent || ''));

  /* WC-Investing plan chart renders a green/red ROI chart */
  check('WC-Investing chart override', page("!!(window.WC_INVEST && window.WC_INVEST.__wc357chart)"));
  const chart = page("window.WC_INVEST.chart([0,1,0.6,1.4,1.1,2.2], {height:90})");
  check('chart has green and red segments', /#22c55e/.test(chart) && /#ef4444/.test(chart));
  check('chart shows ROI progress ticks', /20%/.test(chart) && /100%/.test(chart));

  /* password reset view is the emailed-code flow */
  const reset = page('viewForgot()');
  check('reset page asks for username/email', /id="wcRUser"/.test(reset));
  check('reset page asks for verification code', /id="wcRCode"/.test(reset));
  check('reset page asks for new password', /id="wcRPass"/.test(reset));

  /* signup offline still creates + signs in and opens My account */
  page("SESSION = null; localStorage.removeItem('whalechat.session.v1'); sessionStorage.clear(); go('signup')");
  await new Promise((r) => setTimeout(r, 500));
  ['suName', 'suUser', 'suEmail', 'suPhone', 'suPass', 'suPass2'].forEach((id) => {
    const el = doc.getElementById(id); if (el) el.value = id === 'suName' ? 'New Person' : id === 'suUser' ? 'newperson' : id === 'suEmail' ? 'new@example.com' : id === 'suPhone' ? '+15550001111' : 'secret123';
  });
  const terms = doc.getElementById('suTerms'); if (terms) terms.checked = true;
  page('App.signup()');
  await new Promise((r) => setTimeout(r, 1400));
  check('offline signup stored the account', page("(DB.users || []).some(u => u.username === 'newperson')"));
  check('offline signup signs the user in', page("!!(SESSION && DB.users.find(u=>u.id===SESSION.userId).username==='newperson')"));
  check('signup lands on My account', /profile/.test(window.location.hash), window.location.hash);
  check('no PIN popup after signup', !doc.querySelector('#pinErr') && !doc.getElementById('setPinBtn'));

  let failed = 0;
  results.forEach((r) => { if (!r.ok) failed++; console.log((r.ok ? '  ok   ' : '  FAIL ') + r.n + (r.extra ? '  [' + r.extra + ']' : '')); });
  console.log(failed ? '\n' + failed + ' check(s) failed' : '\n3.57 harness passed (' + results.length + ' checks)');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
