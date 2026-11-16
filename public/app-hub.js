/* =========================================================================
   WhaleChat account hub — Tools page + Top up WC investing account
   - #/tools : every account, investing and automation tool in one place
   - #/invest/topup : fund the WC investing / stock trading account
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  const H = window.WC_HUB = window.WC_HUB || {};
  function escH(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function num(v, d) { return (Number(v) || 0).toFixed(d == null ? 2 : d); }
  function money(v) { return '$' + num(v, 2); }
  function u() { try { return me(); } catch (e) { return null; } }
  function coinsAvail() { return Number((u() && u().balance) || 0); }
  function usdAvail() { return coinsAvail() * 0.5; }
  function tmsg(msg, type) { if (typeof toast === 'function') toast(msg, type || 'ok'); }

  const TOOL_CARDS = [
    { icon: 'user', title: 'WhaleChat account', desc: 'Profile, photo, security and personal details', href: '#/profile', tag: 'Account' },
    { icon: 'trend', title: 'Investment account', desc: 'Portfolio value, holdings, earnings and performance', href: '#/invest', tag: 'Invest' },
    { icon: 'download', title: 'Top up WC investing', desc: 'Add trade capital to your WC investing account', href: '#/invest/topup', tag: 'Funding' },
    { icon: 'wallet', title: 'B2B investing account', desc: 'USD trade capital, all assets, multi-asset buy & sell', href: '#/invest/b2b', tag: 'Invest' },
    { icon: 'grid', title: 'Trading bots', desc: 'Subscribe, allocate capital and run automated trading', href: '#/invest/bots', tag: 'Automation' },
    { icon: 'users', title: 'Bot profiles', desc: 'Identities, accuracy, health and performance', href: '#/bots', tag: 'Automation' },
    { icon: 'trend', title: 'Bot performance', desc: 'Equity curve, win rate and session history', href: '#/invest/bots/performance', tag: 'Automation' },
    { icon: 'star', title: 'WhaleChat shares', desc: 'Fixed-return investment plans and live earnings', href: '#/invest/shares', tag: 'Plans' },
    { icon: 'clock', title: 'Orders & trade history', desc: 'Open, completed and settled trades', href: '#/invest/orders', tag: 'History' },
    { icon: 'bell', title: 'Watchlist & alerts', desc: 'Track assets and set price notifications', href: '#/invest/watchlist', tag: 'Markets' },
    { icon: 'lock', title: 'Security & settings', desc: 'PIN, password, notifications and app preferences', href: '#/settings', tag: 'Account' },
    { icon: 'wallet', title: 'Wallet', desc: 'Deposits, withdrawals and Whale Coin balance', href: '#/wallet', tag: 'Funding' }
  ];

  function toolsPage() {
    const bal = coinsAvail();
    return `<div class="page-head"><div class="between">
      <div class="row" style="gap:10px;align-items:center"><a href="#/home" class="btn-icon">${ic('back', 18)}</a>
        <div><div class="section-title" style="margin:0">Tools</div>
          <div class="tiny muted">Account, investing, automation and funding — all in one place</div></div></div>
      <div class="row" style="gap:8px"><a href="#/invest/topup" class="btn btn-sm btn-primary">${ic('download', 14)} Top up</a>
        <a href="#/profile" class="btn btn-sm btn-ghost">My account</a></div>
    </div></div>
    <div class="card hub-hero">
      <div class="between" style="align-items:flex-start;gap:12px">
        <div><div class="tiny muted">WhaleChat account balance</div>
          <div class="hub-balance">${num(bal)} <span class="tiny muted">WC</span></div>
          <div class="tiny muted">≈ ${money(bal * 0.5)} · available for investing and trading</div></div>
        <span class="badge badge-success">Active</span>
      </div>
      <div class="hub-actions">
        <a class="btn btn-primary btn-sm" href="#/invest/topup">${ic('download', 14)} Top up investing</a>
        <a class="btn btn-ghost btn-sm" href="#/invest">Open investment account</a>
        <a class="btn btn-ghost btn-sm" href="#/invest/b2b">B2B account</a>
      </div>
    </div>
    <div class="hub-grid">
      ${TOOL_CARDS.map((t) => `<a class="card hub-card" href="${t.href}">
        <div class="between" style="align-items:flex-start"><span class="hub-ic">${ic(t.icon, 18)}</span><span class="badge hub-tag">${escH(t.tag)}</span></div>
        <div class="hub-title">${escH(t.title)}</div>
        <div class="tiny muted hub-desc">${escH(t.desc)}</div>
        <div class="hub-open">Open →</div>
      </a>`).join('')}
    </div>`;
  }

  function topupPage() {
    const bal = coinsAvail();
    const settings = (typeof DB !== 'undefined' && DB.settings) || {};
    const crypto = (settings.crypto || []).length;
    const banks = (settings.banks || []).length;
    const deposits = (typeof DB !== 'undefined' ? (DB.deposits || []) : []).filter((d) => d && d.userId === (u() && u().id)).slice(0, 5);
    return `<div class="page-head"><div class="between">
      <div class="row" style="gap:10px;align-items:center"><a href="#/invest" class="btn-icon">${ic('back', 18)}</a>
        <div><div class="section-title" style="margin:0">Top up WC investing account</div>
          <div class="tiny muted">Fund the WC balance used for stocks, B2B investing and trading bots</div></div></div>
      <a href="#/wallet" class="btn btn-sm btn-ghost">Wallet</a>
    </div></div>
    <div class="card hub-hero">
      <div class="between" style="align-items:flex-start;gap:12px">
        <div><div class="tiny muted">Current investing capital</div>
          <div class="hub-balance">${num(bal)} <span class="tiny muted">WC</span></div>
          <div class="tiny muted">≈ ${money(bal * 0.5)} · 1 WC = $0.50</div></div>
        <span class="badge badge-success">Ready</span>
      </div>
    </div>
    <div class="card">
      <div class="card-title">Choose top-up amount</div>
      <div class="hub-amounts">${[10, 25, 50, 100, 250, 500].map((v) => `<button class="hub-amt" data-act="inv-topup-amt" data-usd="${v}">$${v}<span>${v / 0.5} WC</span></button>`).join('')}</div>
      <div class="field"><label class="label">Amount in USD</label>
        <div class="input-wrap"><span class="inv-prefix">$</span><input class="input" id="invTopupUsd" type="number" min="1" step="1" placeholder="50" oninput="App.invTopupPreview(this.value)"/></div>
        <div class="tiny muted" style="margin-top:5px">You receive <b id="invTopupCoins">0 WC</b> at 1 WC = $0.50.</div></div>
      <div class="hub-preview">
        <div class="between"><span>Top-up amount</span><b id="invTopupUsdOut">$0.00</b></div>
        <div class="between"><span>WC added</span><b id="invTopupWcOut">0 WC</b></div>
        <div class="between"><span>Investing capital after top-up</span><b id="invTopupAfter">${money(usdAvail())} (${num(bal)} WC)</b></div>
      </div>
      <button class="btn btn-primary" data-act="inv-topup-go" style="width:100%;margin-top:10px">${ic('download', 15)} Continue to deposit</button>
      <div class="tiny muted" style="margin-top:6px">Deposits are reviewed by the team and credited to the same WC balance used for investing and stock trading.</div>
    </div>
    <div class="card">
      <div class="between"><div class="card-title" style="margin:0">Payment methods</div><a href="#/deposit" class="tiny muted">Open deposit page →</a></div>
      <div class="hub-methods">
        <div><span class="hub-ic">${ic('wallet', 16)}</span><b>Crypto</b><i>${crypto} method${crypto === 1 ? '' : 's'} configured</i></div>
        <div><span class="hub-ic">${ic('store', 16)}</span><b>Bank transfer</b><i>${banks} account${banks === 1 ? '' : 's'} configured</i></div>
      </div>
      <div class="tiny muted" style="margin-top:8px">Need capital from an existing position? <a class="link" href="#/invest/b2b/sell">Sell holdings</a> and the payout is credited to this investing balance immediately.</div>
    </div>
    ${deposits.length ? `<div class="card"><div class="card-title" style="margin:0 0 6px">Recent top-ups</div>
      ${deposits.map((d) => `<div class="between" style="padding:7px 0;border-top:1px solid var(--border);font-size:11px">
        <div><b>${money(Number(d.usd) || 0)}</b> <span class="tiny muted">${escH(d.method || d.type || 'deposit')}</span></div>
        <span class="badge ${d.status === 'approved' ? 'badge-success' : d.status === 'rejected' ? 'badge-danger' : 'badge-warn'}">${escH(d.status || 'pending')}</span>
      </div>`).join('')}
    </div>` : ''}
    <div class="card"><div class="tiny muted" style="line-height:1.7">${ic('help', 13)} The WC investing account uses the same Whale Coin balance as your wallet. Once a deposit is approved, it is available immediately for B2B investing, stock purchases and bot capital. No separate transfer step is needed.</div></div>`;
  }

  if (typeof App !== 'undefined') {
    App.invTopupPreview = function (value) {
      const usd = Number(value) || 0;
      const wc = usd / 0.5;
      const set = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
      set('invTopupCoins', num(wc) + ' WC');
      set('invTopupUsdOut', money(usd));
      set('invTopupWcOut', num(wc) + ' WC');
      set('invTopupAfter', money(usdAvail() + usd) + ' (' + num(coinsAvail() + wc) + ' WC)');
    };
    App.invTopupAmt = function (id, ds) {
      const el = document.getElementById('invTopupUsd');
      if (el) { el.value = Number(ds.usd) || 0; App.invTopupPreview(el.value); el.focus(); }
    };
    App.invTopupGo = function () {
      const el = document.getElementById('invTopupUsd');
      const usd = Number((el && el.value) || 0);
      if (!(usd >= 1)) return tmsg('Enter at least $1 to top up', 'err');
      try { location.hash = '#/deposit?amount=' + encodeURIComponent(usd); } catch (e) {}
    };
  }

  function patchViews() {
    if (typeof VIEWS === 'undefined') return false;
    if (!VIEWS.__wcHubTools) { VIEWS.tools = function () { return toolsPage(); }; VIEWS.__wcHubTools = true; }
    if (typeof VIEWS.invest === 'function' && !VIEWS.__wcHubInvest) {
      const base = VIEWS.invest;
      VIEWS.invest = function (parts, params) {
        if ((parts[1] || '') === 'topup') return topupPage();
        return base.apply(this, arguments);
      };
      VIEWS.__wcHubInvest = true;
    }
    return true;
  }
  function addNav() {
    try {
      if (typeof USER_NAV !== 'undefined' && Array.isArray(USER_NAV) && !USER_NAV.some((n) => n.key === 'tools')) {
        USER_NAV.splice(Math.max(1, USER_NAV.length - 1), 0, { key: 'tools', label: 'Tools', icon: 'grid', href: '#/tools' });
      }
    } catch (e) {}
  }
  /* register routes immediately, then keep retrying until the app shell exists */
  try { patchViews(); addNav(); } catch (e) {}
  let tries = 0;
  const iv = setInterval(() => {
    tries++;
    const ok = patchViews();
    addNav();
    if (ok || tries > 40) clearInterval(iv);
  }, 180);

  (function styles() {
    if (document.getElementById('wc-hub-style')) return;
    const st = document.createElement('style');
    st.id = 'wc-hub-style';
    st.textContent = `
    .hub-hero{background:radial-gradient(circle at 90% 0%,rgba(46,230,201,.16),transparent 55%),linear-gradient(135deg,#08202b,#0a1a26);border-color:rgba(46,230,201,.22)}
    .hub-balance{font-size:30px;font-weight:800;letter-spacing:-.03em;color:#2ee6c9;line-height:1.15}
    .hub-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:11px}
    .hub-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px}
    .hub-card{display:flex;flex-direction:column;gap:4px;text-decoration:none;color:inherit;padding:13px}
    .hub-ic{width:34px;height:34px;border-radius:10px;background:rgba(46,230,201,.12);color:var(--accent);display:flex;align-items:center;justify-content:center;flex:none}
    .hub-tag{font-size:8.5px;text-transform:uppercase;letter-spacing:.04em}
    .hub-title{font-size:12.5px;font-weight:750;margin-top:5px}
    .hub-desc{line-height:1.5;min-height:33px}
    .hub-open{font-size:10.5px;font-weight:750;color:var(--accent);margin-top:2px}
    .hub-amounts{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin:8px 0 12px}
    .hub-amt{display:flex;flex-direction:column;align-items:center;gap:1px;padding:9px 6px;border-radius:10px;border:1px solid var(--border);background:var(--surface-2);color:var(--text);font-weight:750;font-size:13px}
    .hub-amt span{font-size:9.5px;color:var(--muted);font-weight:600}
    .hub-amt:hover{border-color:rgba(46,230,201,.45)}
    .hub-preview{padding:9px 10px;border:1px solid var(--border);border-radius:9px;background:var(--surface-2)}
    .hub-preview .between{font-size:11px;padding:2px 0;color:var(--muted)}
    .hub-preview b{color:var(--text);font-variant-numeric:tabular-nums}
    .hub-methods{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:10px}
    .hub-methods div{display:flex;flex-direction:column;gap:2px;padding:9px;border:1px solid var(--border);border-radius:9px;background:var(--surface-2)}
    .hub-methods b{font-size:11.5px} .hub-methods i{font-style:normal;font-size:10px;color:var(--muted)}
    @media(max-width:560px){.hub-grid{grid-template-columns:1fr 1fr}.hub-amounts{grid-template-columns:1fr 1fr}}
    `;
    document.head.appendChild(st);
  })();
})();
