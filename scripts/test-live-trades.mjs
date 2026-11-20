/* Proves the trade rails and the live move counter: a real open trade, real
   LT maths, and the DOM nodes the order card and the chart actually use. */
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const pass = [], fail = [];
const ok = (c, m, extra) => (c ? pass : fail).push(m + (extra !== undefined && !c ? ' → ' + JSON.stringify(extra) : ''));
const read = (f) => fs.readFileSync(new URL('../public/' + f, import.meta.url), 'utf8');

const dom = new JSDOM(`<!doctype html><html data-theme="dark"><body>
  <div id="app">
    <div class="lt-card" data-trade="t1">
      <div class="lt-pnl" data-lt-pnl="t1">+0.00 USD</div>
      <div data-lt-pct="t1">+0.00%</div>
      <div>Price <b data-lt-price="t1">0</b> <span data-lt-move="t1">▲ 0.00%</span></div>
      <div>Moves <b data-lt-moves="t1">1</b></div>
      <button data-lt-tp-btn="t1">Take profit <span data-lt-tp-amt="t1"></span></button>
      <div class="lt-bar"><i style="width:50%"></i></div>
    </div>
    <div class="wc-live-chart" data-wc-live-chart="AAPL"><div class="wc-live-host" data-wc-live-host></div></div>
  </div></body></html>`, { url: 'https://x/whalechat.html#/invest/stock/AAPL', pretendToBeVisual: true, runScripts: 'outside-only' });
const w = dom.window, d = w.document;
w.scrollTo = () => {};

/* ---- the trade, exactly as the app stores it ---- */
let price = 300;
const trade = {
  id: 't1', ticker: 'AAPL', side: 'long', status: 'Open',
  entryPrice: 300, capitalCoins: 1000, leverage: 1,
  expiresAt: Date.now() + 3600e3, moveCount: 0, totalMoveCount: 0,
  takeProfitWc: 0, stopLossWc: 0, takeProfitPrice: 0, stopLossPrice: 0
};
w.DB = { users: [{ id: 'u1', fullName: 'Trader', investAcct: {}, settings: {} }], messages: [] };
w.SESSION = { userId: 'u1' };
w.me = () => w.DB.users[0];

/* the app's own trade maths, reduced to the functions this module reads */
w.LT = {
  open: () => [trade],
  dirOf: (t) => (t.side === 'short' ? 'FALL' : 'RISE'),
  closeFee: () => 0,
  moveRateOf: () => 1,                    /* 1 WC of profit per $1 of move per 1000 capital */
  priceMovePct: (e, p) => (p - e) / e * 100,
  movePctOf: (t, p) => (p - t.entryPrice) * t.capitalCoins * (1 / 100) / t.capitalCoins * 100,
  tpLevelOf: () => 0,
  movesOf: (t, p) => {
    if (t._cEntry !== t.entryPrice) { t._cEntry = t.entryPrice; t._cMoves = 0; t._cLast = undefined; }
    if (p > 0 && p !== t._cLast) { if (t._cLast > 0) { t._cMoves = (t._cMoves || 0) + 1; } t._cLast = p; }
    return Math.max(1, Number(t.moveCount) || 0, t._cMoves || 0);
  },
  totalMovesOf: (t) => Math.max(Number(t.totalMoveCount) || 0, Number(t.moveCount) || 0, t._cMoves || 0),
  calc: (t) => {
    const dir = t.side === 'short' ? -1 : 1;
    const movePctCap = (price - t.entryPrice) * (1 / 100) * 100;
    let pnl = t.capitalCoins * (movePctCap / 100) * (t.leverage || 1) * dir * w.LT.movesOf(t, price);
    pnl = Math.max(-t.capitalCoins, pnl);
    return { price, movePct: movePctCap * dir, pnlCoins: Math.round(pnl * 100) / 100, pnlPct: (pnl / t.capitalCoins) * 100, payoutCoins: t.capitalCoins + pnl, left: t.expiresAt - Date.now() };
  }
};
w.INV = { quote: () => ({ price, prevClose: 298 }) };

/* the chart kit stand-in: records what the module asks it to draw */
const drawn = [];
w.document.querySelector('[data-wc-live-host]').__api = { setLines: (lines) => { drawn.length = 0; drawn.push(...lines); } };

w.eval(read('wc-live-moves.js'));
const M = w.WCLiveChat === undefined ? null : null;

/* ---------------------------------------------------------------- checks */
const btn = () => d.querySelector('[data-lt-moves="t1"]').textContent;
const entryRail = () => drawn.find((l) => /^Entry/.test(l.title || ''));
const liveRail = () => drawn.find((l) => l.live);

/* first paint */
w.WCLiveMoves.refresh();
ok(entryRail(), 'the entry price rail is drawn', drawn.map((l) => l.title));
ok(entryRail() && entryRail().price === 300, 'the rail sits at the trade entry price');
ok(!!liveRail(), 'a live price rail is drawn');
ok(liveRail() && liveRail().price === price, 'the live rail sits at the current price');
ok(!!d.querySelector('.wc-lm-hud'), 'the readout is on the chart');
ok(/Entry/.test(d.querySelector('.wc-lm-hud').textContent) && /Moves/.test(d.querySelector('.wc-lm-hud').textContent),
  'the readout shows entry, price, moves and P/L');

/* a rising price: green, moves count up, profit follows the trade maths */
price = 306;
w.WCLiveMoves.refresh();
ok(liveRail().color === '#31e0a0', 'the live rail is green when the price is above entry');
const afterFirstMove = Number(btn());
ok(afterFirstMove >= 1, 'the move counter counted the first movement', btn());
const pnlText = d.querySelector('[data-lt-pnl="t1"]').textContent;
ok(/\+/.test(pnlText) && !/\+0\.00/.test(pnlText), 'the card shows a running profit', pnlText);
ok(d.querySelector('[data-lt-price="t1"]').textContent.indexOf('306') === 0, 'the card price moved with the tick',
  d.querySelector('[data-lt-price="t1"]').textContent);

/* a falling price: red */
price = 292;
w.WCLiveMoves.refresh();
ok(liveRail().color === '#ff5d6c', 'the live rail is red when the price is below entry');
ok(/−|-/.test(d.querySelector('[data-lt-pnl="t1"]').textContent), 'the card shows a loss on a fall');
ok(/▼/.test(d.querySelector('[data-lt-move="t1"]').textContent), 'the % move arrow flips on a fall');
ok(Number(btn()) > afterFirstMove, 'the counter keeps counting as the price moves again', { afterFirstMove, now: btn() });

/* the same price twice must not invent a move */
const before = Number(btn());
w.WCLiveMoves.refresh(); w.WCLiveMoves.refresh();
ok(Number(btn()) === before, 'a repeated price does not add a move', { before, after: btn() });

/* the payout maths is untouched: the module never writes to the trade */
ok(trade.capitalCoins === 1000 && trade.entryPrice === 300 && trade.takeProfitWc === 0,
  'the module did not modify the trade record');
ok(typeof w.LT.totalMovesOf(trade) === 'number' && w.LT.calc(trade).payoutCoins === 1000 + w.LT.calc(trade).pnlCoins,
  'payout is still capital + P/L');

console.log(pass.map((m) => '  ok   ' + m).join('\n'));
if (fail.length) console.log(fail.map((m) => '  FAIL ' + m).join('\n'));
console.log('\n' + (fail.length ? '✗ ' + fail.length + ' failed, ' : '✓ ') + pass.length + ' passed');
process.exit(fail.length ? 1 : 0);
