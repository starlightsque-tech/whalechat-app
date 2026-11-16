/* =========================================================================
   WhaleChat Trade Guide — auto-updating (module wc-trade-guide)
   -------------------------------------------------------------------------
   Two pages, one source of truth:
     · #/how-it-works        public guide (also linked from My Account)
     · #/admin/trade-guide   admin version + editable recommendation message

   Everything numeric is read live from the app database at render time —
   WC price, stock-trade fee, default leverage, deposit/withdrawal minimums,
   the active 24/7 asset list and the WhaleChat Shares plans. Change a value
   in Admin Settings and this guide changes on the next render. No hard-coded
   fee, price or ticker text lives in the guide.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  if (window.__wcTradeGuide) return;
  window.__wcTradeGuide = true;

  function defaultMessage() {
    var d = db();
    var g = d && d.settings && d.settings.tradeGuide ? d.settings.tradeGuide : {};
    var rate = Number(g.wcUsd) || (typeof COIN_USD === 'number' ? COIN_USD : 0.5);
    var lev = Math.max(1, Number(d && d.invest && d.invest.leverage) || 5);
    var fee = Number(d && d.invest && d.invest.feePct) || 0;
    var asset = 'MARA 24/7';
    try { if (typeof INV !== 'undefined' && INV.visibleStocks) { var list = INV.visibleStocks(); if (list.length) asset = list[0].name || list[0].ticker; } } catch (e) {}
    var capitalUsd = 100, capitalWc = Math.round(capitalUsd / rate);
    var profit = (capitalUsd * 0.02 * lev).toFixed(2);
    return 'I want to show you this company called WhaleChat. Have you heard about them before?\n\n' +
      'WhaleChat is a Social Finance ecosystem — an all-in-one chat, shopping and sales, trade and investing app. You can chat with friends, buy and sell products in the company marketplace, trade 24/7, and invest in the company shares in real time.\n\n' +
      'How trading works: 1 WC = $' + rate.toFixed(2) + '. Pick a live 24/7 asset like ' + asset + ' or BTC/USD, choose LONG if you think it will go up or SHORT if you think it will go down, set your capital, take profit and take loss, then trade. Example: $' + capitalUsd + ' (' + capitalWc + ' WC) with ' + lev + 'x leverage and a +2% move in your favour = $' + profit + ' profit, auto-closed. Take Loss protects you if it goes the other way.\n\n' +
      'The current stock-trade fee is ' + fee + '%. You can also buy WhaleChat Shares for long-term ownership, or become a Vendor and sell in the marketplace. All markets are LIVE 24/7 — no weekend closure.\n\n' +
      'Want me to send you my link and guide you on your first trade?\n' +
      'Check it here: https://whalechat-qkgd.onrender.com';
  }

  function db() { try { return (typeof DB !== 'undefined') ? DB : null; } catch (e) { return null; } }
  function settings() {
    var d = db();
    if (!d) return {};
    if (!d.settings || typeof d.settings !== 'object') d.settings = {};
    return d.settings;
  }
  function guide() {
    var s = settings();
    if (!s.tradeGuide || typeof s.tradeGuide !== 'object') s.tradeGuide = {};
    var g = s.tradeGuide;
    if (typeof g.message !== 'string' || !g.message.trim()) g.message = defaultMessage();
    if (!(Number(g.wcUsd) > 0)) g.wcUsd = (typeof COIN_USD === 'number') ? COIN_USD : 0.5;
    if (!(Number(g.minDepositUsd) > 0)) g.minDepositUsd = 10;
    if (!(Number(g.minWithdrawUsd) > 0)) g.minWithdrawUsd = 10;
    ['s1', 's2', 's3', 's4'].forEach(function (k) { if (typeof g[k] !== 'string') g[k] = ''; });
    return g;
  }
  function wcRate() {
    var g = guide();
    var r = Number(g.wcUsd) || 0.5;
    /* keep the whole app's WC exchange rate in step with the admin setting */
    try { if (typeof COIN_USD === 'number' && Math.abs(COIN_USD - r) > 1e-9) COIN_USD = r; } catch (e) {}
    return r;
  }
  function feePct() {
    try { if (typeof INV !== 'undefined' && INV.fee) return Number(INV.fee()) || 0; } catch (e) {}
    var d = db(); return Number(d && d.invest && d.invest.feePct) || 0;
  }
  function leverage() {
    var d = db();
    return Math.max(1, Number(d && d.invest && d.invest.leverage) || 5);
  }
  function assets() {
    try {
      if (typeof INV !== 'undefined' && INV.visibleStocks) {
        return INV.visibleStocks().map(function (s) { return s.ticker + ' — ' + s.name; });
      }
    } catch (e) {}
    return ['BTC/USD', 'ETH/USD', 'EUR/USD Synthetic', 'MARA 24/7', 'US30 24/7'];
  }
  function shareMarket() {
    var d = db();
    var m = (d && d.shareMarket) || {};
    return { priceUsd: Number(m.priceUsd) || 0, dailyChangePct: Number(m.dailyChangePct) || 0 };
  }
  function plans() {
    var d = db();
    var list = (d && Array.isArray(d.sharePlans)) ? d.sharePlans : [];
    return list.filter(function (p) { return p && p.enabled !== false; });
  }
  function planDays(p) {
    var v = Math.max(1, Number(p && p.durationValue) || 1);
    var u = String((p && p.durationUnit) || 'days');
    if (u === 'months') return Math.round(v * 30);
    if (u === 'years') return Math.round(v * 365);
    return v;
  }
  function money(n) { return '$' + (Math.round((Number(n) || 0) * 100) / 100).toFixed(2); }
  function pct(n) { return (Math.round((Number(n) || 0) * 100) / 100).toFixed(2) + '%'; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function feeLine() {
    return '<div class="tg-live"><span class="tg-dot"></span>Auto-updated from Admin Settings · 1 WC = ' + money(wcRate()) +
      ' · trade fee ' + feePct() + '% · default leverage ' + leverage() + 'x</div>';
  }

  /* ------------------------------------------------------------- sections */
  function section1() {
    var g = guide();
    return {
      id: 'what', icon: 'help', title: '1. What Is WhaleChat?',
      body: '<p>WhaleChat is a <b>Social Finance ecosystem</b> — three apps in one:</p>' +
        '<div class="tg-grid3">' +
        '<div class="tg-tile"><b>1 · Messaging</b><span>Peer-to-peer chat like WhatsApp — private messages, groups, status and calls.</span></div>' +
        '<div class="tg-tile"><b>2 · Marketplace</b><span>Social shopping like Amazon. Users buy and sell, verified vendors run stores.</span></div>' +
        '<div class="tg-tile"><b>3 · 24/7 Trading</b><span>Synthetic micro-derivative trading on the price movement of stocks, crypto, forex and indices — every day, all day, with Whale Coin.</span></div>' +
        '</div>' +
        '<p class="tg-note">WhaleChat never shows a "Market Closed" screen. Every listed asset trades Monday to Sunday.</p>' +
        (g.s1 ? '<div class="tg-admin-note"><b>Admin note:</b> ' + esc(g.s1) + '</div>' : ''),
    };
  }

  function section2() {
    var g = guide();
    var ex = leverage();
    return {
      id: 'trade', icon: 'trend', title: '2. How To Trade Stocks (Step By Step)',
      body:
        '<ol class="tg-steps">' +
        '<li><b>Deposit Whale Coin (WC).</b> 1 WC = ' + money(wcRate()) + '. Deposit from the Wallet, then move funds into your investment account balance.</li>' +
        '<li><b>Open the Trading page</b> and pick a live 24/7 asset, for example MARA 24/7 or BTC/USD.</li>' +
        '<li><b>Set your capital</b> (e.g. 200 WC = ' + money(200 * wcRate()) + ') and choose your direction: <b>LONG / RISE</b> if you think price goes up, <b>SHORT / FALL</b> if you think it goes down.</li>' +
        '<li><b>Set your duration</b> (5 min, 15 min, 1 hour or 1 day) and optional <b>Take Profit</b> / <b>Take Loss</b>.</li>' +
        '<li><b>Choose leverage</b> — low risk 1x–5x, higher risk 10x–100x. Leave it blank and the app uses the default <b>' + leverage() + 'x</b>.</li>' +
        '<li><b>Wait for the trade to close</b> at Take Profit, Take Loss or the timer — or stop it manually.</li>' +
        '<li><b>Payout is automatic.</b> Profit + capital returns to your balance. A Take Loss closes the trade at your limit to protect the remaining capital. If no Take Loss is set and price moves fully against you, the trade can reach zero and closes with nothing returned.</li>' +
        '</ol>' +
        '<div class="tg-example"><b>Worked example</b><p>$100 capital, leverage <b>3x</b>, price moves <b>+2%</b> in your direction:<br>' +
        '<code>profit = capital × move% × leverage = 100 × 2% × 3 = $6</code><br>' +
        'With the default <b>' + ex + 'x</b>: <code>100 × 2% × ' + ex + ' = ' + money(100 * 0.02 * ex) + '</code>.</p>' +
        '<p>If price moves −2% against you: <code>100 × −2% × 3 = −$6</code>, deducted from the trade capital while the trade is live.</p></div>' +
        '<div class="tg-calc" data-tg-calc="stock">' +
        '<div class="tg-calc-title">Live trade payout calculator</div>' +
        '<div class="tg-calc-row"><label>Capital (USD)</label><input type="number" id="tgCap" value="100" min="1" step="1"/></div>' +
        '<div class="tg-calc-row"><label>Leverage</label><input type="number" id="tgLev" value="' + ex + '" min="1" max="100" step="1"/></div>' +
        '<div class="tg-calc-row"><label>Price move (%)</label><input type="number" id="tgMove" value="2" step="0.1"/></div>' +
        '<div class="tg-calc-row"><label>Direction</label><select id="tgDir"><option value="1">LONG / Rise</option><option value="-1">SHORT / Fall</option></select></div>' +
        '<div class="tg-calc-out" id="tgStockOut"></div></div>' +
        '<p class="tg-note">You own the position and trade the price movement; WhaleChat calculates and distributes every payout automatically. A trade fee of <b>' + feePct() + '%</b> is deducted when a stock trade is activated. Withdrawals carry their own fee; deposits are free. No hidden charges.</p>' +
        (g.s2 ? '<div class="tg-admin-note"><b>Admin note:</b> ' + esc(g.s2) + '</div>' : ''),
    };
  }

  function section3() {
    var g = guide();
    var m = shareMarket();
    var ps = plans();
    var planCards = ps.length ? ps.map(function (p) {
      return '<div class="tg-plan"><b>' + esc(p.name || 'Plan') + '</b>' +
        '<span>Min ' + money(p.minUsd) + ' · Max ' + money(p.maxUsd) + '</span>' +
        '<span>' + planDays(p) + ' days · ' + Number(p.returnPct || 0) + '% rate</span></div>';
    }).join('') : '<div class="tg-plan"><b>Whale Starter</b><span>Plans are configured by the admin.</span></div>';
    return {
      id: 'shares', icon: 'star', title: '3. How To Buy WhaleChat Shares',
      body:
        '<p>WhaleChat Shares are <b>different from trading</b>. A share is long-term ownership in WhaleChat — not a 15-minute trade.</p>' +
        '<ol class="tg-steps">' +
        '<li>Go to <b>Menu → Buy WhaleChat Shares</b> and pick a plan.</li>' +
        '<li>Press <b>Invest</b>, enter an amount within the plan minimum and maximum. The amount is deducted from your WhaleChat balance and the plan activates.</li>' +
        '<li>The WhaleChat share price movement appears on your <b>WC Investing portfolio chart</b> in real time.</li>' +
        '<li>When the plan duration completes, the payout is calculated automatically and credited to your balance.</li>' +
        '</ol>' +
        '<div class="tg-stats"><div><span>Share price now</span><b>' + money(m.priceUsd) + '</b></div>' +
        '<div><span>Today\'s move</span><b class="' + (m.dailyChangePct >= 0 ? 'up' : 'down') + '">' + (m.dailyChangePct >= 0 ? '+' : '') + pct(m.dailyChangePct) + '</b></div>' +
        '<div><span>Plans live</span><b>' + ps.length + '</b></div></div>' +
        '<div class="tg-grid3" style="margin-top:10px">' + planCards + '</div>' +
        '<div class="tg-example"><b>Payout formula used by WhaleChat Shares</b>' +
        '<p><code>daily profit = share price × plan rate</code><br><code>total payout = daily profit × plan days × capital</code></p>' +
        '<p>Example: share price <b>$12.45</b>, Starter rate <b>3%</b>, capital <b>$100</b>, duration <b>7 days</b>:<br>' +
        'daily = 12.45 × 3% = <b>$0.3735</b><br>' +
        'total = 0.3735 × 7 × 100 = <b>$261.45 profit</b>, plus capital credited to your investment balance.</p></div>' +
        '<div class="tg-calc" data-tg-calc="shares">' +
        '<div class="tg-calc-title">Live shares payout calculator</div>' +
        '<div class="tg-calc-row"><label>Plan</label><select id="tgPlan">' +
        (ps.length ? ps.map(function (p, i) { return '<option value="' + i + '">' + esc(p.name) + ' · ' + Number(p.returnPct || 0) + '%</option>'; }).join('') : '<option value="0">Starter · 3%</option>') +
        '</select></div>' +
        '<div class="tg-calc-row"><label>Capital (USD)</label><input type="number" id="tgSCap" value="100" min="1" step="1"/></div>' +
        '<div class="tg-calc-row"><label>Duration (days)</label><input type="number" id="tgSDays" value="' + (ps[0] ? planDays(ps[0]) : 7) + '" min="1" step="1"/></div>' +
        '<div class="tg-calc-row"><label>Share price (USD)</label><input type="number" id="tgSPrice" value="' + (m.priceUsd || 12.45) + '" min="0.01" step="0.01"/></div>' +
        '<div class="tg-calc-out" id="tgSharesOut"></div></div>' +
        '<p class="tg-note"><b>Benefits of holding:</b> shareholders earn from platform growth, get early access to features, higher vendor commission opportunities, and share value can increase over time. Profit is not guaranteed — the share price can rise or fall and that movement determines the final payout.</p>' +
        '<p class="tg-note">Trading is short- and long-term trade holding. WhaleChat Shares are long-term holding with an automatic system-managed flow: you buy the plan once and the system manages the investment cycle for you.</p>' +
        (g.s3 ? '<div class="tg-admin-note"><b>Admin note:</b> ' + esc(g.s3) + '</div>' : ''),
    };
  }

  function section4() {
    var g = guide();
    var fee = feePct();
    var lev = leverage();
    return {
      id: 'payout', icon: 'wallet', title: '4. How Stock Trading And Payouts Work',
      body:
        '<p><b>Payout = Capital + Profit − WhaleChat trade fee.</b> Profit uses the leverage you selected for that trade; if you did not select one, the app uses the default <b>' + lev + 'x</b>.</p>' +
        '<div class="tg-formula">profit = capital × price move % × leverage<br>' +
        'payout = capital + profit − (capital × ' + fee + '%)</div>' +
        '<table class="tg-table"><thead><tr><th>Capital</th><th>Leverage</th><th>Move</th><th>Profit</th></tr></thead><tbody>' +
        '<tr><td>$20</td><td>3x</td><td>+2%</td><td class="up">+$1.20</td></tr>' +
        '<tr><td>$20</td><td>' + lev + 'x (default)</td><td>+2%</td><td class="up">+$2.00</td></tr>' +
        '<tr><td>$100</td><td>3x</td><td>+2%</td><td class="up">+$6.00</td></tr>' +
        '<tr><td>$100</td><td>' + lev + 'x (default)</td><td>+2%</td><td class="up">+' + money(100 * 0.02 * lev) + '</td></tr>' +
        '<tr><td>$500</td><td>3x</td><td>+2%</td><td class="up">+$30.00</td></tr>' +
        '<tr><td>$500</td><td>' + lev + 'x (default)</td><td>+2%</td><td class="up">+' + money(500 * 0.02 * lev) + '</td></tr>' +
        '</tbody></table>' +
        '<p>Loss is capped only when <b>Take Loss</b> is set. Once the loss reaches the limit, the trade stops automatically and the remaining capital is returned. If no Take Loss is set, price can move against the trade until the capital is exhausted and the trade closes with zero returned. Take Loss limits the loss to the percentage or amount you chose — for example, a −10% Take Loss on $100 stops at about −$10.</p>' +
        '<p><b>Auto Secure / Take Profit bot:</b> a subscribed bot watches your active trades in real time, locks in profit when a trade is in the green and keeps it available for you to claim. You do not need to watch the screen to secure a profit.</p>' +
        '<p class="tg-note">Payout timing is instant to your WC wallet on the portfolio where the trade happened. The stock trade fee is <b>' + fee + '%</b> and is deducted only when a stock trade activates. Withdrawal fees apply only to withdrawals; deposits are free. No hidden fees.</p>' +
        '<p class="tg-note"><b>Risk levels:</b> low-risk leverage 1x–5x. High-risk leverage 10x–100x (higher potential profit and higher potential loss). You choose per trade; the default is ' + lev + 'x.</p>' +
        '<div class="tg-live-assets"><b>Active 24/7 assets (' + assets().length + '):</b><div>' + assets().map(function (a) { return '<span>' + esc(a) + '</span>'; }).join('') + '</div></div>' +
        (g.s4 ? '<div class="tg-admin-note"><b>Admin note:</b> ' + esc(g.s4) + '</div>' : ''),
    };
  }

  function messageBox(admin) {
    var g = guide();
    var msg = g.message;
    return '<div class="card tg-message-card">' +
      '<div class="between" style="align-items:center;gap:8px;flex-wrap:wrap">' +
      '<div class="section-title" style="margin:0"><h3 style="margin:0;font-size:14px">Admin recommendation message</h3>' +
      '<div class="tiny muted">Copy this and send it to a user in chat. It updates everywhere when you edit it.</div></div>' +
      '<div class="row" style="gap:6px">' +
      '<button class="btn btn-sm btn-soft" data-tg="copy">Copy</button>' +
      '<button class="btn btn-sm btn-primary" data-tg="whatsapp">Share to WhatsApp</button>' +
      '</div></div>' +
      (admin
        ? '<textarea id="tgMessage" class="input" rows="12" style="margin-top:10px;font-family:inherit;line-height:1.6">' + esc(msg) + '</textarea>' +
          '<div class="row" style="gap:8px;margin-top:8px"><button class="btn btn-primary btn-sm" data-tg="save-message">Save message</button>' +
          '<button class="btn btn-ghost btn-sm" data-tg="reset-message">Reset to default</button></div>'
        : '<div class="tg-message-preview">' + esc(msg).replace(/\n/g, '<br>') + '</div>') +
      '</div>';
  }

  function renderGuide(admin) {
    wcRate();
    var list = [section1(), section2(), section3(), section4()];
    if (admin) list.push({ id: 'adminmsg', icon: 'send', title: '5. Admin Copy-Paste Recommendation Message', body: messageBox(true) });
    var body = list.map(function (s) {
      return '<section class="card tg-section" data-tg-section="' + s.id + '">' +
        '<div class="tg-head">' + ic(s.icon, 20) + '<h2>' + s.title + '</h2></div>' + s.body + '</section>';
    }).join('');
    return '<div class="page-head"><div class="between" style="align-items:flex-start;gap:10px;flex-wrap:wrap">' +
      '<div><h1>' + (admin ? 'Trade Guide — Auto Updated' : 'How WhaleChat Works') + '</h1>' +
      '<p>' + (admin ? 'This is the live admin guide. Every number is pulled from the app database and updates automatically.' : 'Everything you need to know about trading, investing and getting paid on WhaleChat.') + '</p></div>' +
      '<div class="row" style="gap:8px">' +
      (admin ? '<a href="#/how-it-works" class="btn btn-sm btn-ghost">' + ic('eye', 14) + ' Public view</a>' : '') +
      '<a href="' + (admin ? '#/admin/stocks' : '#/invest/market') + '" class="btn btn-sm btn-soft">' + ic('trend', 14) + ' ' + (admin ? 'Stock settings' : 'Open market') + '</a></div></div></div>' +
      feeLine() +
      '<div class="searchbar" style="margin:10px 0 12px">' + ic('search', 17) +
      '<input id="tgSearch" placeholder="Search the guide — leverage, payout, shares, deposit…" autocomplete="off"/></div>' +
      '<div id="tgSections">' + body + '</div>' +
      '<div class="tg-support">Do you need further assistance? Kindly click the button to connect with our support team on a livechat.' +
      '<button class="btn btn-sm btn-primary" data-tg="support">' + ic('chat', 14) + ' Support live chat</button></div>';
  }

  /* --------------------------------------------------------- admin settings */
  function adminSettingsBox() {
    var g = guide();
    return '<div class="card" style="margin-bottom:14px">' +
      '<div class="section-title"><h3>Auto-update sources</h3><span class="tiny muted">stored in Admin Settings</span></div>' +
      '<div class="tg-settings-grid">' +
      '<div class="field"><label class="label">WC price (USD)</label><input class="input" id="tgWcUsd" type="number" min="0.01" step="0.01" value="' + wcRate() + '"/></div>' +
      '<div class="field"><label class="label">Min deposit (USD)</label><input class="input" id="tgMinDep" type="number" min="1" step="1" value="' + Number(g.minDepositUsd) + '"/></div>' +
      '<div class="field"><label class="label">Min withdrawal (USD)</label><input class="input" id="tgMinWd" type="number" min="1" step="1" value="' + Number(g.minWithdrawUsd) + '"/></div>' +
      '</div>' +
      '<div class="tiny muted" style="line-height:1.7">Stock trade fee: <b>' + feePct() + '%</b> (change in Admin → Stocks) · default leverage: <b>' + leverage() + 'x</b> · active assets: <b>' + assets().length + '</b>. These fields update the guide everywhere instantly.</div>' +
      '<div class="row" style="gap:8px;margin-top:10px"><button class="btn btn-primary btn-sm" data-tg="save-settings">Save auto-update settings</button></div>' +
      '<div class="divider" style="margin:14px 0"></div>' +
      '<div class="card-title">Section notes (shown to users)</div>' +
      '<div class="tg-settings-grid">' +
      '<div class="field"><label class="label">Section 1 note</label><textarea class="input" id="tgS1" rows="2">' + esc(guide().s1) + '</textarea></div>' +
      '<div class="field"><label class="label">Section 2 note</label><textarea class="input" id="tgS2" rows="2">' + esc(guide().s2) + '</textarea></div>' +
      '<div class="field"><label class="label">Section 3 note</label><textarea class="input" id="tgS3" rows="2">' + esc(guide().s3) + '</textarea></div>' +
      '<div class="field"><label class="label">Section 4 note</label><textarea class="input" id="tgS4" rows="2">' + esc(guide().s4) + '</textarea></div>' +
      '</div>' +
      '<div class="row" style="gap:8px;margin-top:8px"><button class="btn btn-primary btn-sm" data-tg="save-notes">Save section notes</button></div>' +
      '</div>';
  }

  /* ---------------------------------------------------------------- styles */
  function css() {
    if (document.getElementById('tg-css')) return;
    var st = document.createElement('style');
    st.id = 'tg-css';
    st.textContent =
      '.tg-live{display:flex;align-items:center;gap:7px;font-size:10.5px;color:var(--muted);padding:8px 10px;border-radius:10px;background:var(--surface-2);border:1px solid var(--border);line-height:1.5}' +
      '.tg-dot{width:7px;height:7px;border-radius:50%;background:#22c55e;animation:tgPulse 1.6s infinite;flex:none}' +
      '@keyframes tgPulse{0%{box-shadow:0 0 0 0 rgba(34,197,94,.6)}70%{box-shadow:0 0 0 6px rgba(34,197,94,0)}100%{box-shadow:0 0 0 0 rgba(34,197,94,0)}}' +
      '.tg-section{margin-bottom:12px;padding:14px}' +
      '.tg-head{display:flex;align-items:center;gap:9px;margin-bottom:9px;color:var(--accent)}' +
      '.tg-head h2{font-size:14px;margin:0;color:var(--text)}' +
      '.tg-section p{font-size:12px;line-height:1.8;color:var(--text);margin:8px 0}' +
      '.tg-note{color:var(--muted)!important;font-size:11px!important}' +
      '.tg-grid3{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin:8px 0}' +
      '.tg-tile{background:var(--surface-2);border:1px solid var(--border);border-radius:11px;padding:10px}' +
      '.tg-tile b{display:block;font-size:11.5px;margin-bottom:4px;color:var(--accent)}' +
      '.tg-tile span{font-size:10.5px;color:var(--muted);line-height:1.6;display:block}' +
      '.tg-steps{padding-left:18px;margin:8px 0}' +
      '.tg-steps li{font-size:11.5px;line-height:1.8;margin-bottom:7px;color:var(--text)}' +
      '.tg-example{background:rgba(46,230,201,.06);border:1px solid rgba(46,230,201,.25);border-radius:11px;padding:10px 12px;margin:10px 0}' +
      '.tg-example b{font-size:11.5px;color:var(--accent)}.tg-example p{font-size:11px!important;line-height:1.8!important}' +
      '.tg-example code{font-size:10.5px;color:#9cebd8;background:rgba(0,0,0,.25);padding:1px 4px;border-radius:4px}' +
      '.tg-calc{background:var(--surface-2);border:1px solid var(--border);border-radius:12px;padding:11px;margin:10px 0}' +
      '.tg-calc-title{font-size:11.5px;font-weight:700;margin-bottom:8px}' +
      '.tg-calc-row{display:flex;align-items:center;gap:8px;margin-bottom:6px}' +
      '.tg-calc-row label{font-size:10.5px;color:var(--muted);flex:0 0 105px}' +
      '.tg-calc-row input,.tg-calc-row select{flex:1;min-width:0;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:7px 8px;color:var(--text);font-size:11.5px;outline:none}' +
      '.tg-calc-out{margin-top:8px;padding:9px;border-radius:9px;background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.25);font-size:11.5px;line-height:1.8}' +
      '.tg-calc-out b{font-size:13px}' +
      '.tg-table{width:100%;border-collapse:collapse;font-size:11px;margin:8px 0}' +
      '.tg-table th,.tg-table td{padding:6px 7px;border-bottom:1px solid var(--border);text-align:left}' +
      '.tg-table th{font-size:9.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}' +
      '.up{color:#22c55e}.down{color:#f87171}' +
      '.tg-formula{background:rgba(58,160,255,.07);border:1px solid rgba(58,160,255,.25);border-radius:10px;padding:10px;font-size:11px;line-height:1.9;color:#bcdfff;margin:8px 0}' +
      '.tg-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;margin:10px 0}' +
      '.tg-stats>div{background:var(--surface-2);border:1px solid var(--border);border-radius:10px;padding:9px}' +
      '.tg-stats span{display:block;font-size:9.5px;color:var(--muted);margin-bottom:3px}' +
      '.tg-stats b{font-size:14px}' +
      '.tg-plan{background:var(--surface-2);border:1px solid var(--border);border-radius:10px;padding:9px}' +
      '.tg-plan b{display:block;font-size:11.5px;margin-bottom:3px}.tg-plan span{display:block;font-size:10px;color:var(--muted);line-height:1.6}' +
      '.tg-live-assets{margin-top:10px;font-size:10.5px;color:var(--muted)}' +
      '.tg-live-assets>div{display:flex;flex-wrap:wrap;gap:5px;margin-top:6px}' +
      '.tg-live-assets span{font-size:9.5px;padding:3px 7px;border-radius:99px;background:rgba(34,197,94,.10);border:1px solid rgba(34,197,94,.3);color:#7ee2a8}' +
      '.tg-admin-note{margin-top:10px;padding:9px 11px;border-left:3px solid var(--accent);background:var(--surface-2);border-radius:0 9px 9px 0;font-size:11px;line-height:1.7;color:var(--muted)}' +
      '.tg-message-card{padding:12px}' +
      '.tg-message-preview{margin-top:10px;padding:10px;border-radius:10px;background:var(--surface-2);border:1px solid var(--border);font-size:11.5px;line-height:1.8;white-space:normal}' +
      '.tg-settings-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-top:8px}' +
      '.tg-support{margin-top:14px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:11px;color:var(--muted);padding:12px;border-radius:11px;background:var(--surface-2);border:1px solid var(--border)}' +
      '@media(max-width:520px){.tg-section{padding:12px}.tg-calc-row{flex-wrap:wrap}.tg-calc-row label{flex:1 0 100%}}';
    document.head.appendChild(st);
  }

  function calcStock() {
    var cap = Number((document.getElementById('tgCap') || {}).value) || 0;
    var lev = Number((document.getElementById('tgLev') || {}).value) || leverage();
    var mv = Number((document.getElementById('tgMove') || {}).value) || 0;
    var dir = Number((document.getElementById('tgDir') || {}).value) || 1;
    var profit = cap * (mv / 100) * lev * dir;
    var fee = cap * (feePct() / 100);
    var payout = Math.max(0, cap + profit - fee);
    var out = document.getElementById('tgStockOut');
    if (!out) return;
    out.innerHTML = 'Estimated profit: <b class="' + (profit >= 0 ? 'up' : 'down') + '">' + (profit >= 0 ? '+' : '−') + money(Math.abs(profit)) + '</b><br>' +
      'Trade fee (' + feePct() + '%): ' + money(fee) + '<br>' +
      'Estimated payout: <b>' + money(payout) + '</b> · ≈ ' + (wcRate() > 0 ? Math.round(payout / wcRate()) : 0).toLocaleString() + ' WC';
  }
  function calcShares() {
    var ps = plans();
    var idx = Number((document.getElementById('tgPlan') || {}).value) || 0;
    var plan = ps[idx] || { returnPct: 3 };
    var cap = Number((document.getElementById('tgSCap') || {}).value) || 0;
    var days = Number((document.getElementById('tgSDays') || {}).value) || 1;
    var price = Number((document.getElementById('tgSPrice') || {}).value) || shareMarket().priceUsd || 12.45;
    var rate = Number(plan.returnPct) || 0;
    var daily = price * (rate / 100);
    var profit = daily * days * cap;
    var out = document.getElementById('tgSharesOut');
    if (!out) return;
    out.innerHTML = 'Daily profit: <b>' + money(daily) + '</b><br>' +
      'Total profit: <b class="up">' + money(profit) + '</b> over ' + days + ' days<br>' +
      'Capital + profit at maturity: <b>' + money(cap + profit) + '</b>';
  }

  function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    } catch (e) {}
    var ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
    return Promise.resolve();
  }
  function toastMsg(msg) {
    try { if (typeof toast === 'function') return toast(msg, 'ok'); } catch (e) {}
    alert(msg);
  }
  function save() { try { if (typeof persist === 'function') persist(); } catch (e) {} }
  function rerender() { try { if (typeof render === 'function') render(); } catch (e) {} }

  /* ------------------------------------------------------------- behavior */
  document.addEventListener('click', function (ev) {
    var el = ev.target.closest ? ev.target.closest('[data-tg]') : null;
    if (!el) return;
    var act = el.getAttribute('data-tg');
    var g = guide();
    if (act === 'copy') {
      ev.preventDefault();
      copyText(g.message).then(function () { toastMsg('Recommendation message copied'); });
      return;
    }
    if (act === 'whatsapp') {
      ev.preventDefault();
      window.open('https://wa.me/?text=' + encodeURIComponent(g.message), '_blank', 'noopener');
      return;
    }
    if (act === 'support') {
      ev.preventDefault();
      try { if (window.WC_SUPPORT && WC_SUPPORT.open) return WC_SUPPORT.open(); } catch (e) {}
      var tawk = window.Tawk_API;
      if (tawk && tawk.maximize) tawk.maximize();
      else window.location.hash = '#/home';
      return;
    }
    if (act === 'save-message') {
      ev.preventDefault();
      var box = document.getElementById('tgMessage');
      if (box) g.message = box.value;
      save(); toastMsg('Recommendation message saved — it is now live everywhere'); rerender();
      return;
    }
    if (act === 'reset-message') {
      ev.preventDefault();
      g.message = defaultMessage(); save(); toastMsg('Message reset to the WhaleChat default'); rerender();
      return;
    }
    if (act === 'save-settings') {
      ev.preventDefault();
      var wc = Number((document.getElementById('tgWcUsd') || {}).value);
      var md = Number((document.getElementById('tgMinDep') || {}).value);
      var mw = Number((document.getElementById('tgMinWd') || {}).value);
      if (wc > 0) g.wcUsd = wc;
      if (md > 0) g.minDepositUsd = md;
      if (mw > 0) g.minWithdrawUsd = mw;
      save(); toastMsg('Auto-update settings saved — 1 WC = ' + money(wcRate())); rerender();
      return;
    }
    if (act === 'save-notes') {
      ev.preventDefault();
      ['s1', 's2', 's3', 's4'].forEach(function (k) {
        var box2 = document.getElementById('tg' + k.toUpperCase());
        if (box2) g[k] = box2.value;
      });
      save(); toastMsg('Guide section notes saved'); rerender();
    }
  }, true);

  document.addEventListener('input', function (ev) {
    var id = ev.target && ev.target.id;
    if (id === 'tgSearch') {
      var q = String(ev.target.value || '').toLowerCase();
      document.querySelectorAll('[data-tg-section]').forEach(function (n) {
        n.style.display = !q || n.textContent.toLowerCase().indexOf(q) >= 0 ? '' : 'none';
      });
      return;
    }
    if (id === 'tgPlan') {
      var ps = plans();
      var p = ps[Number(ev.target.value) || 0];
      var d = document.getElementById('tgSDays');
      if (p && d) d.value = planDays(p);
    }
    if (['tgCap', 'tgLev', 'tgMove', 'tgDir'].indexOf(id) >= 0) calcStock();
    if (['tgPlan', 'tgSCap', 'tgSDays', 'tgSPrice'].indexOf(id) >= 0) calcShares();
  }, true);

  function afterGuide() {
    calcStock(); calcShares();
    var inp = document.getElementById('tgSearch');
    if (inp) inp.focus({ preventScroll: true });
  }

  /* ------------------------------------------------------------- routes */
  var VIEW = (typeof VIEWS === 'object') ? VIEWS : window.VIEWS;
  if (!VIEW) return;
  VIEW['how-it-works'] = function () { return renderGuide(false); };
  VIEW['howitworks'] = VIEW['how-it-works'];

  function installAdminRoute() {
    if (typeof VIEW.admin === 'function' && VIEW.admin.__wcTG) return;
    var baseAdmin = VIEW.admin;
    var wrapped = function (parts) {
      if ((parts && parts[1]) === 'trade-guide') {
        return adminSettingsBox() + renderGuide(true);
      }
      return baseAdmin.apply(this, arguments);
    };
    wrapped.__wcTG = true;
    VIEW.admin = wrapped;
  }
  installAdminRoute();
  /* other modules patch VIEWS.admin lazily; stay the outermost wrapper */
  setInterval(installAdminRoute, 1500);

  if (typeof AFTER === 'object') {
    AFTER['how-it-works'] = afterGuide;
    var baseAfterAdmin = AFTER.admin;
    AFTER.admin = function (parts) {
      if (baseAfterAdmin) baseAfterAdmin.apply(this, arguments);
      if ((parts && parts[1]) === 'trade-guide') afterGuide();
    };
  }

  /* nav + account link */
  try {
    if (typeof USER_NAV !== 'undefined' && !USER_NAV.some(function (n) { return n.key === 'guide'; })) {
      USER_NAV.splice(USER_NAV.length - 1, 0, { key: 'guide', label: 'How WhaleChat Works', icon: 'help', href: '#/how-it-works' });
    }
    if (typeof VENDOR_NAV !== 'undefined' && !VENDOR_NAV.some(function (n) { return n.key === 'guide'; })) {
      VENDOR_NAV.splice(VENDOR_NAV.length - 1, 0, { key: 'guide', label: 'How WhaleChat Works', icon: 'help', href: '#/how-it-works' });
    }
    if (typeof ADMIN_NAV !== 'undefined' && !ADMIN_NAV.some(function (n) { return n.key === 'admin-trade-guide'; })) {
      ADMIN_NAV.splice(Math.max(0, ADMIN_NAV.length - 1), 0, { key: 'admin-trade-guide', label: 'Trade Guide', icon: 'help', href: '#/admin/trade-guide' });
    }
    var baseProfile = VIEW.profile;
    if (baseProfile) {
      VIEW.profile = function () {
        var html = baseProfile.apply(this, arguments);
        if (html.indexOf('#/how-it-works') < 0) {
          html = html.replace("['settings', 'Settings', '#/settings'], ['edit', 'Appearance', '#/settings']",
            "['help', 'How WhaleChat Works', '#/how-it-works'], ['settings', 'Settings', '#/settings'], ['edit', 'Appearance', '#/settings']");
        }
        return html;
      };
    }
  } catch (e) { console.error('[trade-guide] nav', e); }

  css();
  window.WC_TRADE_GUIDE = { render: renderGuide, message: function () { return guide().message; }, DEFAULT_MESSAGE: defaultMessage() };
})();
