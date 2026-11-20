import { JSDOM } from 'jsdom';
import fs from 'node:fs';

const dom = new JSDOM(`<!doctype html><html data-theme="dark"><head><meta name="theme-color" content="#04101a"></head><body>
<div class="shell"><aside class="sidebar"><div class="side-brand">B</div><a class="nav-item">x</a>
<div class="side-foot"><button data-theme-toggle><span>i</span><span>Dark mode</span></button></div></aside>
<div class="main"><header class="topbar"><div class="row">
<button data-theme-toggle class="btn-icon hide-desktop" title="Theme">moon</button>
<button class="btn-icon">profile</button></div></header>
<div id="app"><div class="content"><div class="wck inv-chart-kit"></div></div></div></div></div>
</body></html>`, { url: 'https://x.test/#/invest', pretendToBeVisual: true, runScripts: 'outside-only' });

const w = dom.window;
w.scrollTo = () => {};
w.HTMLCanvasElement.prototype.getContext = function () {
  return { setTransform(){}, clearRect(){}, beginPath(){}, moveTo(){}, lineTo(){}, stroke(){}, closePath(){}, fill(){}, createLinearGradient(){return{addColorStop(){}}} };
};
// stubs
const prices = { AAPL: 110, TSLA: 90 };
w.me = () => ({ id: 'usr_1', fullName: 'A' });
w.INV = { quote: (t) => ({ price: prices[t] || 100 }), series: (t) => [100, 102, 101, 105, 108] };
w.LT = { positions: () => [
  { kind:'trade', ticker:'AAPL', side:'long', entry:100, price:110, pnlCoins:12.5, pnlPct:10, capital: 100, valueCoins:112.5 },
  { kind:'trade', ticker:'TSLA', side:'long', entry:100, price:90, pnlCoins:-7.25, pnlPct:-7.25, capital: 100, valueCoins:92.75 }
], summary: () => ({ pos:[1,2], botActive:false, valueUsd: 205.25 }) };
w.eval(fs.readFileSync('public/wc-live-portfolio.js','utf8'));
w.eval(fs.readFileSync('public/wc-theme.js','utf8'));
await new Promise(r=>setTimeout(r,1300));
const card = w.document.getElementById('wcLiveSide');
console.log('sidebar card:', !!card, 'rows:', card && card.querySelectorAll('[data-wc-ls-row]').length);
console.log('total:', card && card.querySelector('.wc-ls-total').textContent);
const pls = [...w.document.querySelectorAll('[data-wc-ls-pl]')].map(x=>x.textContent);
console.log('pl:', pls);
const tb = w.document.getElementById('wcThemeBtn');
console.log('theme btn in topbar:', !!(tb && tb.closest('header.topbar')), 'fixed:', tb && tb.style.position, 'class:', tb && tb.className);
console.log('no body floating button:', ![...w.document.body.children].some(el=>el.id==='wcThemeBtn'));
// toggle works
tb.click();
await new Promise(r=>setTimeout(r,100));
console.log('theme after click:', w.document.documentElement.getAttribute('data-theme'));
