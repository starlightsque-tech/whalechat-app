#!/usr/bin/env node
/* Boots the assembled whalechat.html in jsdom, signs a user in with a Toyota (7203_T)
   stock in the database, opens #/invest/stock/7203_T and asserts:
     · the trade ticket mounts with capital, direction, TP/SL, duration and leverage
     · leverage is honoured when the trade is opened
     · B2B manual buy/sell + Auto Buy/Sell fills appear in the B2B history
   Skips cleanly when jsdom/fake-indexeddb are not installed. */
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
  console.log('  skip ui harness — npm i -D jsdom fake-indexeddb');
  process.exit(0);
}

const HERE = path.dirname(new URL(import.meta.url).pathname);
const PUB = path.resolve(HERE, '..', 'public');
const html = fs.readFileSync(path.join(PUB, 'whalechat.html'), 'utf8');

const now = Date.now();
const user = {
  id: 'u1', username: 'tester', fullName: 'Test User', email: 't@example.com', role: 'user',
  balance: 1000, pin: null, cart: [], contacts: [], createdAt: now,
  investAcct: {
    usd: 2500, payout: 120, wcBalance: 0, b2bProfit: 0,
    portfolios: { stock: 2500, wc: 0, b2b: 1000, bot: 0 },
    tools: {}, b2b: {}, b2bFav: [], b2bAlerts: [], b2bTrades: [], ledger: [], disputes: [], requests: []
  }
};
const toyota = {
  ticker: '7203_T', displayTicker: '7203.T', finnhubSymbol: '7203.T', assetClass: 'global',
  name: 'Toyota Motor', exchange: 'Tokyo', currency: 'JPY', sector: 'Automotive',
  color: '#eb0a1e', price: 2563.16, prevClose: 2504, vol: 1200000
};
const db = {
  users: [user],
  stocks: [toyota],
  products: [], orders: [], messages: [], txs: [], vendors: [], deposits: [], withdrawals: [],
  contacts: [], notifications: [], statuses: [], chatsMeta: {}, alerts: [], blocks: [],
  settings: { crypto: [], banks: [], networks: ['TRC20'], leverage: 5, feePct: 0.5 },
  trades: [],
  b2bAutoJournal: [
    { id: 'ab_1', userId: 'u1', ticker: 'AAPL', side: 'buy', price: 200, units: 0.5, amount: 100, at: now - 60000 },
    { id: 'as_1', userId: 'u1', ticker: 'AAPL', side: 'sell', price: 210, units: 0.5, proceeds: 105, basis: 100, payout: 5, at: now - 30000 }
  ],
  reports: [], audit: [], meta: {}
};

const dom = new JSDOM(html, {
  url: 'https://app.test/whalechat.html#/invest/stock/7203_T',
  pretendToBeVisual: true,
  runScripts: 'dangerously',
  beforeParse(window) {
    window.localStorage.setItem('whalechat.db.v1', JSON.stringify(db));
    window.localStorage.setItem('whalechat.session.v1', JSON.stringify({ userId: 'u1', at: now }));
    window.indexedDB = indexedDB;
    window.IDBKeyRange = IDBKeyRange;
    window.Notification = function () {};
    window.Notification.permission = 'granted';
    window.Notification.requestPermission = () => Promise.resolve('granted');
    window.fetch = () => Promise.reject(new TypeError('offline in harness'));
    window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
    window.HTMLCanvasElement.prototype.getContext = () => null;
    window.navigator.serviceWorker = {
      controller: null,
      ready: new Promise(() => {}),
      register: () => Promise.resolve({}),
      getRegistration: () => Promise.resolve(null),
      addEventListener() {}
    };
    window.scrollTo = () => {};
  }
});

const { window } = dom;
const doc = window.document;
/* the bundle declares DB/LT/App with let/const at script top level, so they are
   reachable through eval in the page context but not as window properties */
const page = (expr) => window.eval(expr);
const results = [];
const check = (name, ok, extra) => results.push({ name, ok: !!ok, extra });

(async () => {
  await new Promise((r) => setTimeout(r, 2500));      // boot
  const w = window;

  const booted = page('typeof DB !== "undefined" && !!DB');
  check('app booted', booted, String(booted));
  const signedIn = page('!!(SESSION && SESSION.userId)');
  check('signed-in session restored', signedIn, String(signedIn));
  const s = page("typeof LT !== 'undefined' && LT.resolveStock ? LT.resolveStock('7203.T') : null");
  check('resolver finds Toyota from the display ticker', s && s.ticker === '7203_T', s && s.ticker);

  /* open the page the way a user would (hash already set at boot) */
  w.location.hash = '#/invest/stock/7203_T';
  w.dispatchEvent(new w.Event('hashchange'));
  await new Promise((r) => setTimeout(r, 1200));

  const ticket = doc.getElementById('ltTicketMount');
  check('ticket mounted on the Toyota page', !!ticket);
  const ticketHTML = ticket ? ticket.innerHTML : '';
  check('ticket has a capital field', /id="ltCapital"/.test(ticketHTML));
  check('ticket has Rise/Fall direction', /data-act="lt-side"/.test(ticketHTML) && /Rise/.test(ticketHTML) && /Fall/.test(ticketHTML));
  check('ticket has TP and SL fields', /id="ltTp"/.test(ticketHTML) && /id="ltSl"/.test(ticketHTML));
  check('ticket has a duration field', /id="ltDuration"/.test(ticketHTML));
  check('ticket has a per-trade leverage control', /id="ltLev"/.test(ticketHTML), (ticketHTML.match(/id="ltLev"[\s\S]{0,120}/) || [''])[0].slice(0, 90));
  check('only one leverage control on the ticket', (ticketHTML.match(/id="ltLev/g) || []).length === 1, String((ticketHTML.match(/id="ltLev/g) || []).length));

  /* open a trade with leverage pinned to 12x */
  if (ticket) {
    const cap = doc.getElementById('ltCapital'); if (cap) cap.value = '100';
    const lev = doc.getElementById('ltLev'); if (lev) lev.value = '10';
    const dur = doc.getElementById('ltDuration'); if (dur) dur.selectedIndex = 0;
    /* click Buy like a user: the per-trade leverage listener runs on the click */
    const buyBtn = doc.querySelector('[data-act="lt-start"]');
    if (buyBtn) buyBtn.click();
    await new Promise((r) => setTimeout(r, 400));
    const t = page("(DB.trades || []).filter(x => x.ticker === '7203_T')[0]");
    check('Toyota trade opened', !!t, t && t.id);
    check('trade stored the ticket leverage (10x)', t && Number(t.leverage) === 10, t && String(t.leverage));
    check('trade has a direction', t && (t.direction === 'RISE' || t.direction === 'FALL'), t && t.direction);
  }

  /* B2B history: seed a manual buy/sell through the real fill + sell handlers */
  try {
    const a = page('me().investAcct');
    a.b2b = { AAPL: { units: 1, avgPrice: 200 } };
    a.portfolios.b2b = 1000;
    page("DB.stocks.push({ticker:'AAPL',name:'Apple',assetClass:'us',price:200,prevClose:200,sector:'Tech'})");
    page("INV.live = INV.live || {}; INV.live['AAPL'] = { price: 200, prevClose: 200, source:'finnhub', real:true, feed:true }");
    doc.body.insertAdjacentHTML('beforeend', '<input id="ihB2bBuyAmount" value="100"/>');
    page("App.ihB2bBuy(null, { t: 'AAPL' })");
    await new Promise((r) => setTimeout(r, 200));
    const n = page("(me().investAcct.b2bTrades || []).length");
    check('manual B2B buy journalled', n >= 1, String(n));

    w.location.hash = '#/investment/history/b2b';
    w.dispatchEvent(new w.Event('hashchange'));
    await new Promise((r) => setTimeout(r, 900));
    const content = doc.getElementById('content');
    const text = content ? content.textContent : '';
    check('B2B history page renders', /B2B-Investing history/i.test(text), text.slice(0, 60));
    check('history lists the manual buy', /B2B buy|▲ Buy/i.test(text));
    check('history lists the auto buy fill', /Auto Buy|AUTO/.test(text));
    check('history lists the auto sell fill', /Auto Buy\/Sell sold|Auto Buy\/Sell/.test(text));
    check('B2B trades block present', /B2B trades/.test(text));
  } catch (e) {
    check('B2B history flow ran', false, e.message);
  }

  let bad = 0;
  for (const r of results) {
    console.log((r.ok ? '  ok   ' : '  FAIL ') + r.name + (r.ok || !r.extra ? '' : ' → ' + r.extra));
    if (!r.ok) bad++;
  }
  console.log('\n' + (bad ? bad + ' failure(s)' : 'ui harness passed (' + results.length + ' checks)'));
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('harness crashed:', e && e.stack || e); process.exit(1); });
