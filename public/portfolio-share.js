/* =========================================================================
   WhaleChat shared stock portfolio
   Owners share a username-only link. A trusted trader can then use ONLY the
   Invest / WhaleChat investment / Trading Bots pages with the owner's balance
   (trades, plans, bot subscriptions) but cannot deposit, withdraw, or open
   wallet/chat/marketplace pages.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  const P = window.WC_PORTFOLIO = window.WC_PORTFOLIO || {};
  const SESSION_KEY = 'whalechat.session.v1';
  const PREV_KEY = 'wc.prevSession';
  const LINK_TOKEN_KEY = 'wc.pfToken';

  const av = (n) => {
    try {
      const a = new Uint8Array(n);
      (window.crypto || window.msCrypto).getRandomValues(a);
      return Array.prototype.map.call(a, (x) => ('0' + (x % 36).toString(36)).slice(-1)).join('');
    } catch (e) {
      return Math.random().toString(36).slice(2) + Date.now().toString(36);
    }
  };
  const restricted = () => !!(typeof SESSION !== 'undefined' && SESSION && SESSION.portfolio);
  const clean = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function notify(msg, type) { try { if (typeof toast === 'function') toast(msg, type || 'ok'); } catch (e) {} }

  /* ------------------------------- tokens -------------------------------- */
  P.tokenFor = function (u, rotate) {
    if (!u) return '';
    if (rotate || !u.portfolioToken) {
      u.portfolioToken = 'pt_' + av(22);
      u.portfolioUpdatedAt = Date.now();
      try { persist(); } catch (e) {}
      try { sync(); } catch (e) {}
    }
    return u.portfolioToken;
  };

  P.linkFor = function (u) {
    const token = P.tokenFor(u);
    const base = location.pathname.replace(/[^/]*$/, '') || '/';
    return location.origin + base + '#/portfolio/' + token;
  };

  P.storedToken = function () {
    try {
      const m = (location.hash || '').match(/^#\/portfolio\/([A-Za-z0-9_-]+)/i);
      if (m) { sessionStorage.setItem(LINK_TOKEN_KEY, m[1]); return m[1]; }
      const t = new URLSearchParams(location.search).get('portfolio');
      if (t) { sessionStorage.setItem(LINK_TOKEN_KEY, t); return t; }
      return sessionStorage.getItem(LINK_TOKEN_KEY) || '';
    } catch (e) { return ''; }
  };
  P.clearStoredToken = function () { try { sessionStorage.removeItem(LINK_TOKEN_KEY); } catch (e) {} };

  /* --------------------------- session switch ---------------------------- */
  P.enter = function (user, token) {
    if (!user) return false;
    try {
      if (!restricted()) localStorage.setItem(PREV_KEY, localStorage.getItem(SESSION_KEY) || '');
    } catch (e) {}
    SESSION = { userId: user.id, at: Date.now(), portfolio: true, portfolioToken: token };
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(SESSION)); } catch (e) {}
    P.clearStoredToken();
    document.body.classList.add('wc-portfolio-mode');
    ensureBanner();
    location.hash = '#/invest';
    try { render(); } catch (e) {}
    return true;
  };

  P.exit = function () {
    let prev = '';
    try { prev = localStorage.getItem(PREV_KEY) || ''; localStorage.removeItem(PREV_KEY); } catch (e) {}
    SESSION = null;
    try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
    if (prev) {
      try { SESSION = JSON.parse(prev); } catch (e) { SESSION = null; }
      if (SESSION) { try { localStorage.setItem(SESSION_KEY, prev); } catch (e) {} }
    }
    document.body.classList.remove('wc-portfolio-mode');
    const banner = document.getElementById('pfBanner'); if (banner) banner.remove();
    const hash = SESSION ? '#/home' : '#/login';
    if (location.hash === hash) render(); else location.hash = hash;
    notify('Exited portfolio manager mode', 'ok');
  };

  /* ------------------------------ login UI ------------------------------- */
  function ownersForToken(token) {
    try { return (DB.users || []).filter((u) => u && String(u.portfolioToken || '') === token); }
    catch (e) { return []; }
  }

  P.showLogin = function (token) {
    if (restricted()) return;
    if (typeof DB_READY === 'undefined' || !DB_READY) return;
    const app = document.getElementById('app');
    if (!app) return;
    if (P.loginToken === token && document.getElementById('pfLoginCard')) return;
    P.loginToken = token;
    const owners = ownersForToken(token);
    if (!owners.length) {
      app.innerHTML = `<div class="auth"><div class="auth-form-wrap"><div class="auth-card card" id="pfLoginCard">
        <h2>Portfolio link not valid</h2>
        <p class="sub">This stock portfolio link is invalid or was reset by its owner.</p>
        <a class="btn btn-primary" id="pfCancel" href="#/welcome" style="width:100%">Back to WhaleChat</a>
      </div></div></div>`;
      const cancel = document.getElementById('pfCancel');
      if (cancel) cancel.onclick = () => { P.clearStoredToken(); };
      return;
    }
    const owner = owners[0];
    app.innerHTML = `<div class="auth"><div class="auth-form-wrap"><div class="auth-card card" id="pfLoginCard">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">${typeof LOGO === 'string' ? `<img src="${LOGO}" style="width:44px;height:44px;border-radius:50%"/>` : ''}
        <div><h2 style="font-size:22px;margin:0">Shared stock portfolio</h2>
        <div class="tiny muted">Managing for @${clean(owner.username)}</div></div></div>
      <p class="sub">Enter the portfolio owner's WhaleChat <b>username</b> to continue. No password is needed for a portfolio link.</p>
      <div class="field"><label class="label">Owner username</label>
        <input class="input" id="pfUsername" autocomplete="off" autocapitalize="none" placeholder="@username"/></div>
      <div class="tiny" id="pfLoginError" style="color:var(--danger);min-height:18px"></div>
      <button class="btn btn-primary btn-block" id="pfLoginBtn" style="margin-top:6px">Open shared portfolio</button>
      <div class="tiny muted" style="margin-top:12px;line-height:1.6">
        You can manage trades, WhaleChat investment plans and trading bots using the owner's balance.
        <b>Deposits, withdrawals and wallet transfers are disabled</b> in portfolio mode.
      </div>
      <a class="btn btn-ghost btn-block" href="#/welcome" style="margin-top:12px" id="pfCancel">Back to WhaleChat</a>
    </div></div></div>`;
    const input = document.getElementById('pfUsername');
    const err = document.getElementById('pfLoginError');
    const submit = () => {
      const name = String((input && input.value) || '').trim().replace(/^@/, '').toLowerCase();
      if (!name) { err.textContent = 'Enter the owner username.'; return; }
      const match = ownersForToken(token).find((u) => String(u.username || '').toLowerCase() === name);
      if (!match) { err.textContent = 'That username does not match this portfolio link.'; return; }
      err.textContent = '';
      P.enter(match, token);
    };
    const btn = document.getElementById('pfLoginBtn');
    if (btn) btn.onclick = submit;
    if (input) {
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
      setTimeout(() => { try { input.focus(); } catch (e) {} }, 120);
    }
    const cancel = document.getElementById('pfCancel');
    if (cancel) cancel.onclick = () => { P.clearStoredToken(); };
  };

  /* --------------------------- mode chrome ------------------------------- */
  function ensureBanner() {
    if (!restricted()) return;
    if (document.getElementById('pfBanner')) return;
    const main = document.querySelector('.main');
    if (!main) return;
    const bar = document.createElement('div');
    bar.id = 'pfBanner';
    bar.className = 'pf-banner';
    bar.innerHTML = `<span>${typeof ic === 'function' ? ic('shield', 14) : ''} <b>Portfolio manager mode</b> — trades, investments and bots are allowed · deposits and withdrawals are disabled</span>
      <button class="btn btn-xs btn-ghost" data-act="portfolio-exit">Exit portfolio</button>`;
    const topbar = main.querySelector('.topbar');
    if (topbar && topbar.parentNode) topbar.parentNode.insertBefore(bar, topbar.nextSibling);
    else main.insertBefore(bar, main.firstChild);
  }

  function ensureTopbarExit() {
    if (!restricted()) return;
    const row = document.querySelector('.topbar .row');
    if (!row || document.getElementById('pfTopExit')) return;
    const b = document.createElement('button');
    b.id = 'pfTopExit';
    b.className = 'btn btn-xs btn-ghost';
    b.setAttribute('data-act', 'portfolio-exit');
    b.textContent = 'Exit portfolio';
    row.insertBefore(b, row.firstChild);
  }

  /* ---------------------------- route guard ------------------------------ */
  function allowedRoute(parts) {
    const top = parts[0] || 'invest';
    if (top === 'invest') return true;
    if (top === 'portfolio') return true;
    return false;
  }

  function installGuard() {
    if (window.__wcPortfolioGuard) return;
    window.__wcPortfolioGuard = true;
    const base = window.render;
    if (typeof base === 'function') {
      window.render = function () {
        const parts = (typeof parseHash === 'function' ? parseHash().parts : []);
        const token = P.storedToken();
        if (!restricted() && token) {
          if (typeof DB_READY !== 'undefined' && DB_READY) { P.showLogin(token); return; }
          return base.apply(this, arguments);
        }
        if (restricted()) {
          document.body.classList.add('wc-portfolio-mode');
          if (!parts[0] || parts[0] === 'portfolio') { location.hash = '#/invest'; return; }
          if (!allowedRoute(parts)) { location.hash = '#/invest'; return; }
        } else {
          document.body.classList.remove('wc-portfolio-mode');
        }
        const out = base.apply(this, arguments);
        setTimeout(() => { ensureBanner(); ensureTopbarExit(); }, 60);
        return out;
      };
    }
    /* routeGuard is called by the app when a logged-out visitor hits a page */
    window.addEventListener('hashchange', function () {
      try {
        if (restricted()) {
          const parts = (typeof parseHash === 'function' ? parseHash().parts : []);
          if (parts[0] === 'portfolio' || !allowedRoute(parts)) { location.hash = '#/invest'; return; }
          ensureBanner(); ensureTopbarExit();
        } else {
          const t = P.storedToken();
          if (t) P.showLogin(t);
        }
      } catch (e) {}
    });
    const baseGuard = window.routeGuard;
    if (typeof baseGuard === 'function') {
      window.routeGuard = function () {
        const t = P.storedToken();
        if (t) { P.showLogin(t); return; }
        return baseGuard.apply(this, arguments);
      };
    }
  }

  /* Block money movement actions while in portfolio mode */
  function blockMoneyActions() {
    if (typeof App === 'undefined') return;
    ['submitDeposit', 'submitWithdraw', 'depQuick', 'wdMax'].forEach((name) => {
      const orig = App[name];
      if (typeof orig !== 'function' || orig.__wcPfBlocked) return;
      const wrapped = function () {
        if (restricted()) return notify('Deposits and withdrawals are disabled in portfolio manager mode', 'err');
        return orig.apply(this, arguments);
      };
      wrapped.__wcPfBlocked = true;
      App[name] = wrapped;
    });
  }

  /* ------------------------- owner share controls ------------------------- */
  function shareCard() {
    const u = typeof me === 'function' ? me() : null;
    if (!u) return '';
    return `<div class="card" id="portfolioShareCard">
      <div class="between" style="align-items:flex-start;gap:10px">
        <div><div class="card-title" style="margin:0">Share stock portfolio</div>
          <div class="tiny muted" style="margin-top:4px;line-height:1.6">Invite a professional trader or friend to manage your stock trades, WhaleChat investment and trading bots. They use your balance but can never deposit or withdraw.</div></div>
        <button class="btn btn-sm btn-primary" data-act="portfolio-share">${typeof ic === 'function' ? ic('link', 14) : ''} Share link</button>
      </div>
    </div>`;
  }

  function mountShareCard() {
    if (restricted()) return;
    const h = location.hash || '';
    if (!(h === '#/invest' || h === '' || h.startsWith('#/invest?'))) return;
    if (!document.querySelector('.inv-hero') || document.getElementById('portfolioShareCard')) return;
    const host = document.createElement('div');
    host.innerHTML = shareCard();
    const anchor = document.querySelector('.inv-hero');
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(host.firstChild, anchor.nextSibling);
  }

  if (typeof App !== 'undefined') {
    App.portfolioExit = function () { P.exit(); };
    App.portfolioShare = function () {
      const u = me(); if (!u) return;
      const link = P.linkFor(u);
      const body = `<div class="tiny muted" style="margin-bottom:10px;line-height:1.6">Send this link to someone you trust. They sign in with only <b>your username</b> and get access to the stock portfolio, investment plans and bots — never deposits or withdrawals.</div>
        <div class="field"><label class="label">Portfolio link</label>
          <textarea class="input" id="pfLinkText" rows="3" readonly>${clean(link)}</textarea></div>
        <div class="tiny muted">Anyone with this link who knows your username can manage trades on your behalf. Reset the link to revoke all access.</div>`;
      openModal(modalShell('Share stock portfolio', body,
        `<button class="btn btn-ghost" data-close style="flex:1">Close</button>
         <button class="btn btn-ghost" data-act="portfolio-rotate" style="flex:1">Reset link</button>
         <button class="btn btn-primary" id="pfCopy" style="flex:1">Copy link</button>`), { locked: false });
      const copy = async () => {
        try {
          if (navigator.share) { await navigator.share({ title: 'WhaleChat stock portfolio', text: 'Manage my WhaleChat stock portfolio', url: link }); }
          else if (navigator.clipboard) { await navigator.clipboard.writeText(link); notify('Portfolio link copied', 'ok'); }
          else { const t = document.getElementById('pfLinkText'); if (t) { t.select(); document.execCommand('copy'); notify('Portfolio link copied', 'ok'); } }
        } catch (e) { notify('Could not share the link', 'err'); }
      };
      const btn = document.getElementById('pfCopy');
      if (btn) btn.onclick = copy;
    };
    App.portfolioRotate = function () {
      const u = me(); if (!u) return;
      if (typeof confirmDialog === 'function') {
        confirmDialog({ title: 'Reset portfolio link?', body: 'The old link stops working immediately. Anyone using it will lose access.', ok: 'Reset link', danger: true }).then((ok) => {
          if (!ok) return;
          P.tokenFor(u, true);
          try { sync(); } catch (e) {}
          notify('New portfolio link created — share it again', 'ok');
          closeModal();
          render();
        });
      } else {
        P.tokenFor(u, true); notify('New portfolio link created', 'ok'); closeModal(); render();
      }
    };
  }

  /* inject styles */
  (function styles() {
    if (document.getElementById('wc-pf-style')) return;
    const st = document.createElement('style');
    st.id = 'wc-pf-style';
    st.textContent = `
    .pf-banner{display:flex;align-items:center;gap:10px;padding:8px 14px;font-size:12px;line-height:1.5;
      background:linear-gradient(90deg,rgba(46,230,201,.12),rgba(58,160,255,.08));border-bottom:1px solid var(--border);
      color:var(--text)}
    .pf-banner span{flex:1;min-width:0}
    body.wc-portfolio-mode .sidebar a.nav-item:not([href="#/invest"]){display:none!important}
    body.wc-portfolio-mode .bottomnav a.bnav:not([href="#/invest"]){display:none!important}
    body.wc-portfolio-mode .side-user,
    body.wc-portfolio-mode .topbar [data-nav="#/profile"],
    body.wc-portfolio-mode .topbar [data-nav="#/notifications"],
    body.wc-portfolio-mode .topbar-search,
    body.wc-portfolio-mode .topbar [data-act="mobile-search"]{display:none!important}
    body.wc-portfolio-mode a[href="#/deposit"],
    body.wc-portfolio-mode a[href="#/withdraw"],
    body.wc-portfolio-mode [data-act="deposit"],
    body.wc-portfolio-mode [data-act="withdraw"]{display:none!important}
    body.wc-portfolio-mode #portfolioShareCard{display:none!important}`;
    document.head.appendChild(st);
  })();

  /* --------------------------- boot + watches ---------------------------- */
  function installGallery() {
    installGuard();
    blockMoneyActions();
    /* add the share card to the Invest dashboard after every render */
    if (typeof AFTER === 'object') {
      const prev = AFTER.invest;
      AFTER.invest = function (parts, params) {
        try { if (prev) prev(parts, params); } catch (e) {}
        setTimeout(mountShareCard, 120);
      };
    }
  }

  installGuard();
  blockMoneyActions();

  const boot = setInterval(() => {
    try {
      if (typeof DB_READY === 'undefined' || !DB_READY) return;
      installGallery();
      blockMoneyActions();
      if (restricted()) {
        document.body.classList.add('wc-portfolio-mode');
        ensureBanner(); ensureTopbarExit();
      } else {
        const t = P.storedToken();
        if (t) P.showLogin(t);
      }
      clearInterval(boot);
    } catch (e) {}
  }, 350);

  /* keep the login/guard alive if the app re-renders */
  setInterval(() => {
    try {
      if (typeof DB_READY === 'undefined' || !DB_READY) return;
      blockMoneyActions();
      if (restricted()) {
        const owner = typeof me === 'function' ? me() : null;
        if (!owner || String(owner.portfolioToken || '') !== String((SESSION && SESSION.portfolioToken) || '')) { P.exit(); return; }
        document.body.classList.add('wc-portfolio-mode');
        ensureBanner(); ensureTopbarExit();
      } else {
        const t = P.storedToken();
        if (t && !document.getElementById('pfLoginCard')) P.showLogin(t);
      }
      mountShareCard();
    } catch (e) {}
  }, 1200);
})();
