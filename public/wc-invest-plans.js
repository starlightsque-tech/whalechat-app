/* =========================================================================
   WhaleChat WC-Investing plan engine  (wc-invest-plans)

   Owns the WhaleChat Shares investing portfolio inside the investment
   account: the plan catalogue, activation, live ROI accrual, maturity,
   auto-reinvestment and the two share-accurate balance buckets.

   Payout formula (as specified):
       daily profit = Whalecoin price that day × plan rate %
       total profit = Σ (each day's daily profit) × capital
                      (= daily profit × plan days × capital when the price holds)
       at maturity  : profit → Profit balance, capital → Capital balance

   Example: price $12.45 held, starter 3%, 7 days, $100 capital
       daily  = 12.45 × 3%          = $0.3735
       total  = 0.3735 × 7 × 100    = $261.45
   Example: price falls to $8 and holds
       daily  = 8 × 3%              = $0.24
       total  = 0.24 × 7 × 100      = $168.00

   Crash rule: if the AVERAGE daily Whalecoin price over the plan ends below
   the crash level (default 50% of the activation price, admin setting
   DB.settings.wcCrashPct) the plan is a total loss — no profit and the
   capital is not returned.

   Money in this engine is USD. WC is only ever a derived display value
   (1 WC = $0.50 → WC = USD ÷ 0.5), per the USD-first convention.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined' || window.__wcInvestPlans) return;
  window.__wcInvestPlans = true;

  var RATE = 0.5;                 /* 1 WC = $0.50 */
  var P = window.WC_INVEST = window.WC_INVEST || {};

  var DEFAULT_PLANS = [
    { id: 'starter', name: 'Whale Starter', ratePct: 3, days: 7, minUsd: 10, maxUsd: 500, blurb: 'One-week plan · daily return on the shares you hold.' },
    { id: 'growth', name: 'Whale Growth', ratePct: 5, days: 14, minUsd: 50, maxUsd: 2500, blurb: 'Two-week plan · higher daily return.' },
    { id: 'elite', name: 'Whale Elite', ratePct: 8, days: 30, minUsd: 250, maxUsd: 25000, blurb: 'Monthly plan for larger allocations.' }
  ];

  P.defaults = DEFAULT_PLANS;
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function usd(v) { return '$' + (Math.round((Number(v) || 0) * 100) / 100).toFixed(2); }
  function wcv(v) { return (Math.round(((Number(v) || 0) / RATE) * 100) / 100).toFixed(2); }
  function nowId(p) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function user() { try { return typeof me === 'function' ? me() : null; } catch (e) { return null; } }
  function save() { try { if (typeof persist === 'function') persist(); } catch (e) {} try { if (typeof sync === 'function') sync(); } catch (e) {} }
  function repaint() { try { if (typeof render === 'function') render(); } catch (e) {} }
  function tmsg(m, t) { try { if (typeof toast === 'function') toast(m, t || 'ok'); } catch (e) {} }
  function money(v) { return usd(v); }
  function round2(v) { return Math.round((Number(v) || 0) * 100) / 100; }

  /* ---- share price ------------------------------------------------------- */
  P.sharePrice = function () {
    /* the live Whalecoin market (kept by the local engine or the server) */
    try {
      var m = typeof DB !== 'undefined' && DB && DB.shareMarket;
      var mp = m && Number(m.priceUsd);
      if (mp > 0) return mp;
    } catch (e) {}
    try {
      var st = window.WC_SHARES && window.WC_SHARES.state;
      var p = st && st.shareMarket && Number(st.shareMarket.priceUsd);
      if (p > 0) return p;
      var s2 = st && st.summary && Number(st.summary.sharePriceUsd);
      if (s2 > 0) return s2;
    } catch (e) {}
    try {
      var set = DB && DB.settings && DB.settings;
      if (set && Number(set.sharePriceUsd) > 0) return Number(set.sharePriceUsd);
    } catch (e) {}
    return 12.45;
  };

  /* ---- catalogue --------------------------------------------------------- */
  P.catalog = function () {
    try {
      if (DB) {
        if (!DB.settings) DB.settings = {};
        if (!Array.isArray(DB.settings.investPlans) || !DB.settings.investPlans.length) {
          DB.settings.investPlans = DEFAULT_PLANS.map(function (p) { return Object.assign({}, p); });
        }
        return DB.settings.investPlans;
      }
    } catch (e) {}
    return DEFAULT_PLANS;
  };
  P.plan = function (id) {
    var found = null;
    P.catalog().forEach(function (p) { if (p.id === id) found = p; });
    return found;
  };

  /* ---- the portfolio record ---------------------------------------------- */
  function wallet(u) {
    u = u || user();
    if (!u) return null;
    if (!u.investAcct) u.investAcct = { usd: 0, payout: 0, wcBalance: 0, portfolios: { stock: 0, wc: 0, b2b: 0, bot: 0 }, tools: {}, b2b: {}, b2bFav: [], b2bAlerts: [], b2bProfit: 0, disputes: [], requests: [], ledger: [] };
    var a = u.investAcct;
    if (!a.wcInvest || typeof a.wcInvest !== 'object') {
      a.wcInvest = { capital: 0, profit: 0, leftover: 0, autoReinvest: false, plans: [], history: [] };
    }
    var w = a.wcInvest;
    /* the WC-Investing capital balance IS the investment account's WC-Investing
       portfolio (a.portfolios.wc), so every transfer shows up here */
    if (!a.portfolios) a.portfolios = { stock: 0, wc: 0, b2b: 0, bot: 0 };
    if (Object.prototype.hasOwnProperty.call(w, 'capital') && !Object.getOwnPropertyDescriptor(w, 'capital').get) {
      a.portfolios.wc = Math.round(((Number(a.portfolios.wc) || 0) + (Number(w.capital) || 0)) * 100) / 100;
      delete w.capital;
    }
    if (!Object.getOwnPropertyDescriptor(w, 'capital')) {
      Object.defineProperty(w, 'capital', {
        enumerable: false, configurable: true,
        get: function () { return Number(a.portfolios.wc) || 0; },
        set: function (v) { a.portfolios.wc = Math.round((Number(v) || 0) * 100) / 100; }
      });
    }
    ['profit', 'leftover'].forEach(function (k) { if (!(Number(w[k]) >= 0)) w[k] = Number(w[k]) || 0; });
    if (!Array.isArray(w.plans)) w.plans = [];
    if (!Array.isArray(w.history)) w.history = [];
    w.autoReinvest = !!w.autoReinvest;
    return w;
  }
  P.wallet = wallet;
  P.state = function (u) { return wallet(u); };

  function log(w, label, v) {
    w.history.unshift({ id: nowId('wh_'), label: label, usd: round2(v), at: Date.now() });
    if (w.history.length > 200) w.history.length = 200;
  }
  function ledgerLine(u, label, usdDelta) {
    try {
      var a = u.investAcct;
      a.ledger.unshift({ id: nowId('il_'), label: label, usd: round2(usdDelta), coins: 0, at: Date.now() });
      if (a.ledger.length > 300) a.ledger.length = 300;
    } catch (e) {}
  }

  /* ---- Whalecoin share price movements ----------------------------------- */
  /* The same price series the WhaleChat share-price chart draws: the shares
     market history from the sync server / synced database, plus every price
     this device has recorded. WC-Investing payouts are calculated from these
     real movements instead of a fixed rate table. */
  P.shareHistory = function () {
    var out = [];
    function push(t, p) {
      t = Number(t) || 0; p = Number(p) || 0;
      if (t > 0 && p > 0) out.push({ t: t, p: round4(p) });
    }
    try {
      var st = window.WC_SHARES && window.WC_SHARES.state;
      var h1 = (st && st.shareMarket && st.shareMarket.history) || [];
      h1.forEach(function (h) { push(h.t, h.p != null ? h.p : h.price); });
    } catch (e) {}
    try {
      if (typeof DB !== 'undefined' && DB && DB.shareMarket && Array.isArray(DB.shareMarket.history))
        DB.shareMarket.history.forEach(function (h) { push(h.t || h.time, h.p != null ? h.p : (h.price || h.priceUsd)); });
    } catch (e) {}
    out.sort(function (a, b) { return a.t - b.t; });
    /* de-duplicate identical timestamps */
    var clean = [];
    out.forEach(function (pt) { var last = clean[clean.length - 1]; if (last && pt.t === last.t) last.p = pt.p; else clean.push(pt); });
    return clean;
  };
  /* price at a moment from the recorded movements (nearest point at or before) */
  P.priceAt = function (at, fallback) {
    var h = P.shareHistory();
    var p = Number(fallback) || 0;
    for (var i = h.length - 1; i >= 0; i--) { if (h[i].t <= at) { p = h[i].p; break; } }
    if (!(p > 0)) p = P.sharePrice();
    return p;
  };

  /* ---- the formula ------------------------------------------------------- */
  P.dailyRoi = function (priceUsd, ratePct) {
    return round2(Number(priceUsd) * (Number(ratePct) / 100) * 1); /* 12.45 × 3% = 0.3735 */
  };
  P.dailyRoiExact = function (priceUsd, ratePct) {
    return (Number(priceUsd) || 0) * ((Number(ratePct) || 0) / 100);
  };
  /* total projected profit: daily profit × days × capital,
     where daily profit = share price × plan rate (per the trade guide) */
  P.totalRoi = function (priceUsd, ratePct, days, capitalUsd) {
    return round2(P.dailyRoiExact(priceUsd, ratePct) * (Number(days) || 1) * (Number(capitalUsd) || 0));
  };
  /* total profit from the daily share prices the plan actually saw:
     Σ(price × rate%) × capital — driven by the live share-price movements */
  P.totalRoiFromPrices = function (prices, ratePct, capitalUsd) {
    var sum = 0;
    (prices || []).forEach(function (p) { sum += P.dailyRoiExact(p, ratePct); });
    return round2(sum * (Number(capitalUsd) || 0));
  };

  /* crash level: % of the activation price the plan's average price must stay at */
  P.crashPct = function () {
    try { var v = Number(DB && DB.settings && DB.settings.wcCrashPct); if (v > 0 && v < 100) return v; } catch (e) {}
    return 50;
  };
  P.crashLevel = function (plan) {
    return round2((Number(plan && plan.entryPriceUsd) || 0) * P.crashPct() / 100);
  };

  function dayIndex(plan, at) {
    var start = Number(plan.startedAt) || at;
    var days = Math.max(1, Number(plan.days) || 1);
    return Math.max(0, Math.min(days - 1, Math.floor((at - start) / 864e5)));
  }

  /* record the real-time Whalecoin price against each plan day. The running
     day keeps being overwritten so it settles on that day's last price;
     days missed while the app was closed take the price seen on return.
     Returns true when a new day was added. */
  P.recordPrice = function (plan, price, at) {
    at = at || Date.now();
    price = Number(price) || 0;
    if (!(price > 0) || !plan) return false;
    if (!Array.isArray(plan.priceLog)) plan.priceLog = [];
    var log = plan.priceLog;
    var entry = Number(plan.entryPriceUsd) || price;
    var idx = dayIndex(plan, Math.min(at, Number(plan.endsAt) || at));
    var added = false;
    if (!log.length) { log.push(round4(entry)); added = true; }
    while (log.length <= idx) { log.push(round4(price)); added = true; }
    if (at < (Number(plan.endsAt) || at + 1)) log[idx] = round4(price);
    return added;
  };
  function round4(v) { return Math.round((Number(v) || 0) * 1e4) / 1e4; }

  /* profit numbers for a plan from its daily price record.
     Every figure is driven by the recorded WhaleChat share-price movements:
     each day earns capital × rate% × that day's share price. */
  P.roiFor = function (plan, price, at) {
    at = at || Date.now();
    price = Number(price) || Number(plan.entryPriceUsd) || 0;
    var days = Math.max(1, Number(plan.days) || 1);
    var cap = Number(plan.capitalUsd) || 0;
    var rate = Number(plan.ratePct) || 0;
    var entry = Number(plan.entryPriceUsd) || price || 1;
    var log = (Array.isArray(plan.priceLog) && plan.priceLog.length) ? plan.priceLog.slice(0, days) : [entry];
    var start = Number(plan.startedAt) || at;
    var elapsedDays = Math.max(0, (Math.min(at, Number(plan.endsAt) || at) - start) / 864e5);
    var idx = Math.min(days - 1, Math.floor(elapsedDays));
    var done = plan.status === 'completed' || elapsedDays >= days;
    function dayPx(i) {
      var v = log[i] != null ? Number(log[i]) : (log.length ? Number(log[log.length - 1]) : entry);
      return v > 0 ? v : entry;
    }
    var todayPx = dayPx(idx);
    var priceSum = 0, accSum = 0;
    for (var i = 0; i < days; i++) {
      var p = dayPx(i);
      priceSum += p;
      if (done || i < idx) accSum += p;
      else if (i === idx) accSum += p * (elapsedDays - idx);
    }
    var seen = done ? days : Math.min(days, idx + 1);
    var seenSum = 0;
    for (var k = 0; k < seen; k++) seenSum += dayPx(k);
    var avg = seen ? seenSum / seen : todayPx;
    var crashAt = P.crashLevel(plan);
    return {
      accruedUsd: round2(accSum * (rate / 100) * cap),
      projectedUsd: round2(priceSum * (rate / 100) * cap),
      todayDailyUsd: round2(P.dailyRoiExact(todayPx, rate) * cap),
      avgPriceUsd: round4(avg),
      entryPriceUsd: round4(entry),
      priceNowUsd: round4(todayPx),
      movePct: Math.round((todayPx / (entry || 1) - 1) * 10000) / 100,
      crashLevelUsd: crashAt,
      atRisk: crashAt > 0 && avg < crashAt,
      dayNo: Math.min(days, idx + 1)
    };
  };

  /* live view of a plan: accrued ROI, progress, projected payout */
  P.progress = function (plan, price, at) {
    at = at || Date.now();
    var start = Number(plan.startedAt) || at;
    var end = Number(plan.endsAt) || start;
    var span = Math.max(1, end - start);
    var frac = Math.max(0, Math.min(1, (at - start) / span));
    var r;
    if (plan.status === 'completed') {
      var paid = Number(plan.maturityRoiUsd);
      r = { accruedUsd: paid >= 0 ? paid : 0, projectedUsd: paid >= 0 ? paid : 0, avgPriceUsd: Number(plan.avgPriceUsd) || 0, crashLevelUsd: P.crashLevel(plan), atRisk: !!plan.totalLoss, todayDailyUsd: 0, dayNo: Number(plan.days) || 1 };
    } else {
      r = P.roiFor(plan, price, at);
      plan.projectedRoiUsd = r.projectedUsd;
    }
    return {
      frac: frac,
      pct: Math.round(frac * 1000) / 10,
      accruedUsd: r.accruedUsd,
      totalRoiUsd: r.projectedUsd,
      capitalUsd: Number(plan.capitalUsd) || 0,
      valueUsd: round2((Number(plan.capitalUsd) || 0) + r.accruedUsd),
      days: Number(plan.days) || 1,
      dayNo: r.dayNo,
      daysLeft: Math.max(0, Math.ceil((end - at) / 864e5)),
      priceNow: Number(r.priceNowUsd) || Number(price) || 0,
      entryPriceUsd: Number(r.entryPriceUsd) || Number(plan.entryPriceUsd) || 0,
      movePct: Number(r.movePct) || 0,
      avgPriceUsd: r.avgPriceUsd,
      crashLevelUsd: r.crashLevelUsd,
      atRisk: r.atRisk,
      todayDailyUsd: r.todayDailyUsd
    };
  };

  /* ---- daily close profit history --------------------------------------- */
  /* One entry per plan day, recorded at that day's close: the Whalecoin price
     of the day, what the day earned and the running total. Every figure is the
     same one the payout uses, so the log explains the payout exactly. */
  P.profitLog = function (plan) {
    var out = [];
    if (!plan) return out;
    var days = Math.max(1, Number(plan.days) || 1);
    var cap = Number(plan.capitalUsd) || 0;
    var rate = Number(plan.ratePct) || 0;
    var entry = Number(plan.entryPriceUsd) || 0;
    var log = Array.isArray(plan.priceLog) ? plan.priceLog : [];
    var start = Number(plan.startedAt) || 0;
    var now = Date.now();
    var cum = 0;
    for (var i = 0; i < days; i++) {
      if (log[i] == null) break;
      if (!(entry > 0)) entry = Number(log[i]) || 0;
      var px = Number(log[i]) || entry;
      var closedAt = start + (i + 1) * 864e5;
      if (closedAt > now && plan.status === 'active') break;   /* day still running */
      var dayUsd = cap * (rate / 100) * px;
      cum += dayUsd;
      out.push({
        day: i + 1,
        at: closedAt,
        priceUsd: round4(px),
        changePct: entry > 0 ? Math.round((px / entry - 1) * 10000) / 100 : 0,
        dailyUsd: round2(dayUsd),
        accruedUsd: round2(cum)
      });
    }
    return out;
  };
  /* persist the log on the plan (backfills plans created before it existed) */
  P.syncProfitLog = function (plan) {
    if (!plan) return [];
    var log = P.profitLog(plan);
    plan.profitLog = log;
    return log;
  };

  /* ---- activate ---------------------------------------------------------- */
  P.activate = function (opts) {
    opts = opts || {};
    var u = user(); if (!u) return { error: 'Not signed in' };
    var w = wallet(u);
    var plan = P.plan(opts.planId);
    if (!plan) return { error: 'Choose an investment plan' };

    var capital = round2(opts.capitalUsd);
    if (!(capital > 0)) return { error: 'Enter the amount you want to invest' };
    if (Number(plan.minUsd) && capital < Number(plan.minUsd)) return { error: 'Minimum for ' + plan.name + ' is ' + usd(plan.minUsd) };
    if (Number(plan.maxUsd) && capital > Number(plan.maxUsd)) return { error: 'Maximum for ' + plan.name + ' is ' + usd(plan.maxUsd) };
    /* Pay from the WC-Investing capital, or directly from a crypto balance.
       Crypto balances are stored in USD, so the USD value is spent as-is. */
    var source = String(opts.source || 'capital');
    var coin = String(opts.coin || '');
    var paidFrom = 'capital';
    if (source === 'crypto') {
      if (!coin) return { error: 'Choose a crypto balance' };
      if (!u.depositBalances) u.depositBalances = {};
      var availCrypto = Number(u.depositBalances[coin]) || 0;
      if (availCrypto + 1e-9 < capital) return { error: 'Not enough ' + coin + ' — you need ' + usd(capital) + ' (available ' + usd(availCrypto) + ')' };
      u.depositBalances[coin] = round2(availCrypto - capital);
      if (u.depositBalances[coin] <= 0.004) delete u.depositBalances[coin];
      paidFrom = 'crypto:' + coin;
    } else if (round2(w.capital) < capital) {
      return { error: 'Not enough capital in your WC-Investing balance — top up ' + usd(capital - w.capital) };
    }

    var days = Number(opts.days) > 0 ? Math.round(Number(opts.days)) : Number(plan.days) || 1;
    var price = P.sharePrice();
    var ratePct = Number(plan.ratePct) || 0;
    var start = Date.now();

    var inv = {
      id: nowId('wcp_'),
      planId: plan.id,
      planName: plan.name,
      capitalUsd: capital,
      days: days,
      ratePct: ratePct,
      entryPriceUsd: price,
      dailyRoiUsd: round2(P.dailyRoiExact(price, ratePct)),
      projectedRoiUsd: P.totalRoi(price, ratePct, days, capital),
      priceLog: [round4(price)],
      startedAt: start,
      endsAt: start + days * 864e5,
      status: 'active',
      shares: price > 0 ? Math.round((capital / price) * 1e6) / 1e6 : 0
    };

    if (paidFrom === 'capital') w.capital = round2(w.capital - capital);
    inv.paidFrom = paidFrom;
    w.plans.unshift(inv);
    log(w, 'Activated ' + plan.name + ' · ' + usd(capital) + ' for ' + days + ' days · funded from ' + (paidFrom === 'capital' ? 'WC-Investing capital' : 'crypto ' + coin), -0);
    ledgerLine(u, 'WC-Investing plan activated · ' + plan.name, 0);
    save(); repaint();
    return { ok: true, investment: inv };
  };

  /* ---- maturity / accrual sweep ----------------------------------------- */
  P.sweep = function () {
    var u = user(); if (!u) return false;
    var w = wallet(u);
    var now = Date.now();
    var changed = false;
    var auto = [];

    var price = P.sharePrice();
    w.plans.forEach(function (inv) {
      if (!inv || inv.status !== 'active') return;
      /* older plans without a price record: the days already run were
         projected at the activation price */
      if (!Array.isArray(inv.priceLog) || !inv.priceLog.length) {
        inv.priceLog = [];
        var ran = Math.min(Number(inv.days) || 1, Math.floor((Math.min(now, Number(inv.endsAt)) - Number(inv.startedAt)) / 864e5));
        for (var k = 0; k < Math.max(1, ran); k++) inv.priceLog.push(round4(inv.entryPriceUsd || price));
        changed = true;
      }
      if (P.recordPrice(inv, price, now)) changed = true;
      P.syncProfitLog(inv);
      if (now < Number(inv.endsAt)) return;

      var days = Math.max(1, Number(inv.days) || 1);
      var capital = Number(inv.capitalUsd) || 0;
      while (inv.priceLog.length < days) inv.priceLog.push(round4(price));
      var prices = inv.priceLog.slice(0, days);
      var avg = prices.reduce(function (s, p) { return s + Number(p); }, 0) / days;
      var crashAt = P.crashLevel(inv);
      var profit = P.totalRoiFromPrices(prices, inv.ratePct, capital);

      inv.maturedPriceUsd = price;
      inv.avgPriceUsd = round4(avg);
      inv.crashLevelUsd = crashAt;
      inv.status = 'completed';
      inv.completedAt = now;

      if (crashAt > 0 && avg < crashAt) {
        /* total loss: no profit, capital is not returned */
        inv.totalLoss = true;
        inv.maturityRoiUsd = -capital;
        inv.projectedRoiUsd = 0;
        log(w, inv.planName + ' matured at a total loss · average price ' + usd(avg) + ' fell below the crash level ' + usd(crashAt), 0);
        ledgerLine(u, 'WC-Investing total loss · ' + inv.planName, -capital);
      } else {
        inv.maturityRoiUsd = profit;
        inv.projectedRoiUsd = profit;
        /* profit → profit balance, capital → capital balance */
        w.profit = round2(w.profit + profit);
        w.capital = round2(w.capital + capital);
        log(w, inv.planName + ' matured · profit ' + usd(profit) + ' → profit balance', profit);
        log(w, inv.planName + ' · capital ' + usd(capital) + ' returned to capital balance', capital);
        ledgerLine(u, 'WC-Investing profit · ' + inv.planName, profit);
        if (w.autoReinvest) auto.push({ inv: inv, capital: capital });
      }
      changed = true;
    });

    /* auto-reinvestment: only the original capital goes back to work */
    auto.forEach(function (a) {
      var plan = P.plan(a.inv.planId);
      if (!plan) return;
      if (!(a.capital > 0)) return;
      if (round2(w.capital) < round2(a.capital)) return;
      w.capital = round2(w.capital - a.capital);
      var start = Date.now();
      var days = Number(a.inv.days) || Number(plan.days) || 1;
      w.plans.unshift({
        id: nowId('wcp_'), planId: plan.id, planName: plan.name,
        capitalUsd: round2(a.capital), days: days, ratePct: Number(plan.ratePct) || 0,
        entryPriceUsd: price,
        dailyRoiUsd: round2(P.dailyRoiExact(price, Number(plan.ratePct) || 0)),
        projectedRoiUsd: P.totalRoi(price, Number(plan.ratePct) || 0, days, a.capital),
        priceLog: [round4(price)],
        startedAt: start, endsAt: start + days * 864e5, status: 'active',
        autoReinvested: true, fromInvestmentId: a.inv.id,
        shares: price > 0 ? Math.round((a.capital / price) * 1e6) / 1e6 : 0
      });
      log(w, 'Auto-reinvested ' + plan.name + ' · ' + usd(a.capital), 0);
    });

    if (changed) { save(); }
    return changed;
  };

  /* ---- transfers --------------------------------------------------------- */
  P.transfer = function (opts) {
    opts = opts || {};
    var u = user(); if (!u) return { error: 'Not signed in' };
    var w = wallet(u); var a = u.investAcct;
    var amount = round2(opts.amountUsd);
    if (!(amount > 0)) return { error: 'Enter an amount' };
    var mode = opts.mode || 'profit2invest';

    if (mode === 'invest2capital') {
      /* the main path users expect: investment account USD -> WC-Investing capital */
      if ((Number(a.usd) || 0) < amount) return { error: 'Not enough in your investment account' };
      a.usd = round2((Number(a.usd) || 0) - amount);
      w.capital = round2((Number(w.capital) || 0) + amount);
      log(w, 'Investment account → WC-Investing capital · ' + usd(amount), 0);
      ledgerLine(u, 'Investment account → WC-Investing capital', amount);
    } else if (mode === 'capital2invest') {
      if ((Number(w.capital) || 0) < amount) return { error: 'Not enough capital balance' };
      w.capital = round2((Number(w.capital) || 0) - amount);
      a.usd = round2((Number(a.usd) || 0) + amount);
      log(w, 'WC-Investing capital → investment account · ' + usd(amount), 0);
      ledgerLine(u, 'WC-Investing capital → investment account', -amount);
    } else if (mode === 'profit2invest') {
      if (w.profit < amount) return { error: 'Not enough profit balance' };
      w.profit = round2(w.profit - amount);
      a.usd = round2((Number(a.usd) || 0) + amount);
      log(w, 'Profit → investment USD balance · ' + usd(amount), -amount);
      ledgerLine(u, 'WC-Investing profit → investment balance', -amount);
    } else if (mode === 'profit2capital') {
      if (w.profit < amount) return { error: 'Not enough profit balance' };
      w.profit = round2(w.profit - amount);
      w.capital = round2(w.capital + amount);
      log(w, 'Profit → capital balance · ' + usd(amount), -amount);
    } else if (mode === 'leftover2capital') {
      if (w.leftover < amount) return { error: 'Not enough leftover capital' };
      w.leftover = round2(w.leftover - amount);
      w.capital = round2(w.capital + amount);
      log(w, 'Leftover capital → capital balance · ' + usd(amount), 0);
    } else if (mode === 'leftover2invest') {
      if (w.leftover < amount) return { error: 'Not enough leftover capital' };
      w.leftover = round2(w.leftover - amount);
      a.usd = round2((Number(a.usd) || 0) + amount);
      log(w, 'Leftover capital → investment USD balance · ' + usd(amount), -amount);
      ledgerLine(u, 'WC-Investing leftover → investment balance', -amount);
    } else {
      return { error: 'Unknown transfer' };
    }
    save(); repaint();
    return { ok: true };
  };

  /* ---- summary ----------------------------------------------------------- */
  P.summary = function (u) {
    var w = wallet(u || user());
    if (!w) return { capital: 0, profit: 0, leftover: 0, active: [], activeCount: 0, totalRoi: 0, value: 0 };
    var price = P.sharePrice();
    var active = w.plans.filter(function (p) { return p.status === 'active'; });
    var totalRoi = active.reduce(function (s, p) { return s + P.progress(p, price).accruedUsd; }, 0);
    var invested = active.reduce(function (s, p) { return s + (Number(p.capitalUsd) || 0); }, 0);
    return {
      capital: round2(w.capital), profit: round2(w.profit), leftover: round2(w.leftover),
      active: active, activeCount: active.length,
      investedUsd: round2(invested), accruedUsd: round2(totalRoi),
      valueUsd: round2(w.capital + w.profit + w.leftover + invested + totalRoi),
      autoReinvest: !!w.autoReinvest, price: price
    };
  };

  /* ---- small svg chart, live-safe --------------------------------------- */
  function num2(v) { var n = Number(v); if (!isFinite(n)) n = 0; return n.toFixed(2); }
  /* Dark market chart in the reference style: red/green line, soft fill,
     right-hand USD scale with the current value in a coloured badge, time
     labels along the bottom. Used for every WC-Investing/ROI chart. */
  P.chart = function (points, opts) {
    opts = opts || {};
    var W = 340, H = opts.height || 140;
    var padL = 8, padR = 58, padT = 12, padB = 20;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var pts = (points || []).filter(function (v) { return isFinite(v); }).map(Number);
    if (pts.length < 2) pts = [0, 0.0001];
    var min = Math.min.apply(null, pts), max = Math.max.apply(null, pts);
    if (max - min < 1e-9) { max += Math.max(0.01, Math.abs(max) * 0.02); min -= Math.max(0.01, Math.abs(min) * 0.02); }
    var span = max - min;
    var rising = pts[pts.length - 1] >= pts[0];
    var color = opts.color || (rising ? '#2ee6c9' : '#ff4d5e');
    var uid = String(opts.uid || 'a').replace(/[^a-z0-9_-]/gi, '');
    var xAt = function (i) { return padL + (i / (pts.length - 1)) * plotW; };
    var yAt = function (v) { return padT + plotH - ((v - min) / span) * plotH; };
    var line = pts.map(function (v, i) { return (i ? 'L' : 'M') + xAt(i).toFixed(1) + ' ' + yAt(v).toFixed(1); }).join(' ');
    var area = line + ' L' + xAt(pts.length - 1).toFixed(1) + ' ' + (padT + plotH) + ' L' + padL + ' ' + (padT + plotH) + ' Z';
    var ticks = 5, grid = '', labels = '';
    for (var t = 0; t < ticks; t++) {
      var val = max - (span * t) / (ticks - 1);
      var y = yAt(val).toFixed(1);
      grid += '<line x1="' + padL + '" y1="' + y + '" x2="' + (padL + plotW) + '" y2="' + y + '" stroke="rgba(255,255,255,.055)" stroke-dasharray="2 4"/>';
      if (Math.abs(Number(y) - yAt(pts[pts.length - 1])) > 12)
        labels += '<text x="' + (W - 11) + '" y="' + (Number(y) + 3.5).toFixed(1) + '" text-anchor="end" class="wci-chart-y" font-size="8.5" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif" font-weight="600">$' + num2(val) + '</text>';
    }
    for (var gx = 1; gx <= 2; gx++) {
      var gxp = (padL + (plotW * gx / 3)).toFixed(1);
      grid += '<line x1="' + gxp + '" y1="' + padT + '" x2="' + gxp + '" y2="' + (padT + plotH) + '" stroke="rgba(255,255,255,.045)"/>';
    }
    var lastY = yAt(pts[pts.length - 1]);
    var badge = '<rect x="' + (W - 70) + '" y="' + (lastY - 9).toFixed(1) + '" width="66" height="18" rx="4" fill="' + color + '"/>' +
      '<text x="' + (W - 67) + '" y="' + (lastY + 3.8).toFixed(1) + '" text-anchor="start" class="wci-chart-now" font-size="9" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif" font-weight="800">$' + num2(pts[pts.length - 1]) + '</text>';
    var now = Date.now();
    var startT = Number(opts.start) || now - 6 * 3600e3;
    var endT = Number(opts.end) || now;
    var tl = [];
    if (Array.isArray(opts.times) && opts.times.length) tl = opts.times;
    else for (var k = 0; k < 3; k++) tl.push(startT + ((endT - startT) * k) / 2);
    var xlabels = '';
    tl.slice(0, 3).forEach(function (ts, i) {
      var xx = padL + (plotW * i / 2);
      var lbl = ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
      xlabels += '<text x="' + xx.toFixed(1) + '" y="' + (H - 4) + '" text-anchor="' + (i === 0 ? 'start' : i === 2 ? 'end' : 'middle') + '" class="wci-chart-x" font-size="8" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif" font-weight="600">' + lbl + '</text>';
    });
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" class="wci-chart wci-chart-v2" preserveAspectRatio="none">' +
      '<defs><linearGradient id="wciFill' + uid + '" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0%" stop-color="' + color + '" stop-opacity=".30"/>' +
        '<stop offset="100%" stop-color="' + color + '" stop-opacity="0"/></linearGradient></defs>' +
      '<rect x="0" y="0" width="' + W + '" height="' + H + '" rx="8" fill="rgba(6,12,18,.55)"/>' +
      grid +
      '<path d="' + area + '" fill="url(#wciFill' + uid + ')" stroke="none"/>' +
      '<path d="' + line + '" fill="none" stroke="' + color + '" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round"/>' +
      labels + badge + xlabels +
    '</svg>';
  };

  /* accrued series for one plan (or all) — drives the ROI charts */
  /* Whalecoin share price at a moment inside a plan window: the recorded
     share-market movement first, then that day's recorded price. */
  P.planPriceAt = function (plan, t, hist) {
    hist = hist || P.shareHistory();
    var p = 0;
    for (var i = hist.length - 1; i >= 0; i--) { if (hist[i].t <= t) { p = hist[i].p; break; } }
    if (!(p > 0)) {
      var log = (plan && plan.priceLog) || [];
      var start = Number(plan && plan.startedAt) || t;
      var idx = Math.max(0, Math.floor((t - start) / 864e5));
      if (log.length) p = Number(log[Math.min(idx, log.length - 1)]);
    }
    if (!(p > 0)) p = Number(plan && plan.entryPriceUsd) || P.sharePrice();
    return p;
  };

  /* Plan value curve (capital + ROI in USD) built from the WhaleChat share
     price movements — the series the trading-style plan chart draws. */
  P.planSeriesUsd = function (plan, steps) {
    steps = steps || 60;
    var out = [];
    if (!plan) return out;
    var now = Date.now();
    var start = Number(plan.startedAt) || now;
    var end = Math.min(now, Number(plan.endsAt) || now);
    if (!(end > start)) end = start + 60000;
    var hist = P.shareHistory();
    var cap = Number(plan.capitalUsd) || 0;
    for (var i = 0; i <= steps; i++) {
      var t = start + ((end - start) * i) / steps;
      var px = P.planPriceAt(plan, Math.min(now, Math.max(start + 1, t)), hist);
      var r = P.roiFor(plan, px, Math.min(now, Math.max(start + 1, t)));
      out.push({ t: Math.min(now, Math.round(t)), v: Math.round((cap + r.accruedUsd) * 100) / 100 });
    }
    if (out.length < 2) out = [{ t: start, v: cap }, { t: Math.max(start + 60000, end), v: cap + (P.roiFor(plan, P.sharePrice(), now).accruedUsd || 0) }];
    return out;
  };

  P.series = function (plan, steps) {
    steps = steps || 24;
    var out = [];
    var now = Date.now();
    var start = Number(plan.startedAt) || now;
    var end = Number(plan.endsAt) || now;
    var px = P.sharePrice();
    for (var i = 0; i <= steps; i++) {
      var t = start + ((end - start) * i) / steps;
      if (t > now) break;
      out.push(P.roiFor(plan, px, Math.max(start + 1, t)).accruedUsd);
    }
    if (out.length < 2) out = [0, Math.max(0.0001, (P.progress(plan, P.sharePrice()).accruedUsd))];
    return out;
  };
  /* ROI series limited to a rolling window (30m, 1h, 24h, 7d …).
     The value at each point is the accrued ROI up to that time, so the line
     shows how the plan grew inside the selected window. */
  P.rangeSeries = function (plan, rangeMs, steps) {
    steps = steps || 30;
    if (!plan) return [0, 0.0001];
    var now = Date.now();
    var start = Number(plan.startedAt) || now;
    var end = Math.min(now, Number(plan.endsAt) || now);
    if (rangeMs > 0) start = Math.max(start, end - rangeMs);
    if (!(end > start)) { start = end - 60000; }
    var px = P.sharePrice();
    var out = [];
    for (var i = 0; i <= steps; i++) {
      var t = start + ((end - start) * i) / steps;
      if (t < (Number(plan.startedAt) || now)) { out.push(0); continue; }
      out.push(P.roiFor(plan, px, Math.max(start + 1, t)).accruedUsd);
    }
    var last = out.length ? out[out.length - 1] : 0;
    if (out.length < 2) out = [0, Math.max(0.0001, last)];
    return out;
  };
  P.rangeCombined = function (rangeMs, steps) {
    steps = steps || 30;
    var s = P.summary();
    var active = s.active || [];
    if (!active.length) return [0, 0.0001];
    var now = Date.now();
    var end = now;
    var start = rangeMs > 0 ? end - rangeMs : Math.min.apply(null, active.map(function (p) { return Number(p.startedAt) || now; }));
    var series = active.map(function (p) { return P.rangeSeries(p, rangeMs, steps); });
    var out = [];
    for (var i = 0; i <= steps; i++) {
      out.push(series.reduce(function (sum, arr) { return sum + (Number(arr[Math.min(i, arr.length - 1)]) || 0); }, 0));
    }
    return out.length > 1 ? out : [0, 0.0001];
  };

  P.combinedSeries = function (steps) {
    var s = P.summary();
    if (!s.active.length) return [0, 0.0001];
    var series = s.active.map(function (p) { return P.series(p, steps || 24); });
    var len = Math.max.apply(null, series.map(function (x) { return x.length; }));
    var out = [];
    for (var i = 0; i < len; i++) {
      out.push(series.reduce(function (sum, arr) { return sum + (arr[Math.min(i, arr.length - 1)] || 0); }, 0));
    }
    return out.length > 1 ? out : [0, 0.0001];
  };

  /* ---- Whalecoin share market: the movement every payout is based on ----- */
  /* The WhaleChat share price is what a WC-Investing plan earns on, so the
     local engine keeps the same gentle random walk the sync server's shares
     worker runs, stores it in DB.shareMarket (history + current price) and
     records it against every active plan day. The share-price card, the plan
     charts and the payout all read this one series. */
  P.market = function () {
    if (typeof DB === 'undefined' || !DB) return null;
    if (!DB.shareMarket || typeof DB.shareMarket !== 'object') DB.shareMarket = {};
    var m = DB.shareMarket;
    var adminPrice = 0;
    try { adminPrice = Number(DB.settings && DB.settings.sharePriceUsd) || 0; } catch (e) {}
    if (!(Number(m.basePriceUsd) > 0)) m.basePriceUsd = adminPrice || P.sharePrice() || 12.45;
    if (!(Number(m.priceUsd) > 0)) m.priceUsd = Number(m.basePriceUsd);
    if (!Array.isArray(m.history)) m.history = [];
    return m;
  };
  P.tickMarket = function () {
    try {
      /* a server-side shares engine owns the market when it is running */
      if (window.WC_SHARES && window.WC_SHARES.state && !window.WC_SHARES.state.__local) return false;
      var m = P.market(); if (!m) return false;
      var now = Date.now();
      var base = Number(m.basePriceUsd) || 12.45;
      var price = Number(m.priceUsd) || base;
      if (Math.abs(price / base - 1) > 0.25) { base = price; m.basePriceUsd = base; }
      var noise = (Math.random() - 0.5) * 0.006;
      var drift = ((base - price) / base) * 0.004;
      price = Math.max(0.25, price * (1 + noise + drift));
      m.priceUsd = round4(price);
      m.updatedAt = now;
      var last = m.history[m.history.length - 1];
      if (!m.history.length) {
        /* seed the series so the chart has a line from the first tick */
        m.history.push({ t: now - 3600e3, p: round4(Number(m.basePriceUsd) || m.priceUsd) });
        m.history.push({ t: now, p: m.priceUsd });
      } else if (now - (Number(last.t) || 0) >= 5000) {
        m.history.push({ t: now, p: m.priceUsd });
        if (m.history.length > 720) m.history.splice(0, m.history.length - 720);
      } else {
        last.p = m.priceUsd;
      }
      try { if (DB.settings) DB.settings.sharePriceUsd = m.priceUsd; } catch (e) {}
      var u = null; try { u = user(); } catch (e) {}
      if (u) {
        var w = wallet(u);
        w.plans.forEach(function (inv) { if (inv && inv.status === 'active') { P.recordPrice(inv, m.priceUsd, now); P.syncProfitLog(inv); } });
      }
      return true;
    } catch (e) { return false; }
  };

  /* ---- keep time moving -------------------------------------------------- */
  var tries = 0;
  (function boot() {
    if (typeof render !== 'function' || typeof DB === 'undefined') {
      if (tries++ < 80) return setTimeout(boot, 500);
      return;
    }
    P.sweep();
    P.tickMarket();
    /* the shares market ticks every 6s; every plan accrues on this movement */
    setInterval(function () { try { P.tickMarket(); } catch (e) {} }, 6000);
    setInterval(function () { try { if (P.sweep()) repaint(); } catch (e) {} }, 30000);
    /* live payout: keep today's price current every 5s on the WC-Investing pages */
    setInterval(function () {
      try {
        var h = String((typeof location !== 'undefined' && location.hash) || '');
        if (h.indexOf('/invest/shares') < 0 || /shares\/(invest|transfer)/.test(h)) return;
        var u = user(); if (!u) return;
        var w = wallet(u), px = P.sharePrice(), any = false;
        w.plans.forEach(function (inv) { if (inv && inv.status === 'active') { P.recordPrice(inv, px); any = true; } });
        if (any) repaint();
      } catch (e) {}
    }, 5000);
  })();
})();
