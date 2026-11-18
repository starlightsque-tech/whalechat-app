/* =========================================================================
   WhaleChat B2B price-alert engine + Auto Buy/Sell tool  (server side)

   Price alerts used to fire only while the app was open in a browser tab.
   This watcher evaluates every stored B2B alert against the live market on
   the server, so a user gets the in-app notification AND an email with a
   working "Buy now" / "Sell now" deep link even when the app is closed.

   Alerts live on user.investAcct.b2bAlerts (synced from the client):
     { id, ticker, buy, sell, email, buyHit, sellHit, buyHitAt, sellHitAt,
       auto, autoAmount, autoRepeat, autoArmedAt,            <- set by the user
       autoState, autoUnits, autoLog, autoError }             <- mirrored by the server

   Auto Buy/Sell (tool id "autobuysell")
   -------------------------------------
   Works only when ALL of these are true:
     1. the user has an active Auto Buy/Sell subscription (investAcct.tools.autobuysell)
     2. the tool is switched on (investAcct.autoBuySellOn !== false)
     3. the alert for that asset has "Use Auto Buy/Sell" ticked (alert.auto)
     4. the alert has an estimated buy and/or sell price
   Every price tick is checked (market.onQuote), so a target is never skipped:
     - buy price reached  -> buys autoAmount USD of the asset from the B2B capital
                             balance, filled at exactly the buy price the user set
     - sell price reached -> sells the units the tool bought (or the whole holding
                             for a sell-only alert) at exactly the sell price; the
                             profit goes to the B2B profit balance and the capital
                             (cost of the units) returns to the capital balance.
   Each fill is written to a server journal (db.b2bAutoJournal) first and then
   applied to the account once (investAcct.b2bAutoApplied), so a fill is never lost
   or doubled even if a device syncs an older copy of the account.
   ========================================================================= */
'use strict';

const PAGE = '/whalechat.html';
const AUTO_TOOL = 'autobuysell';
const DEFAULT_INVENTORY = 100000;

function normTicker(t) { return String(t || '').toUpperCase(); }
function money(v) { return '$' + (Math.round((Number(v) || 0) * 100) / 100).toFixed(2); }
function rid(p) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function r2(v) { return Math.round((Number(v) || 0) * 100) / 100; }
function r8(v) { return Math.round((Number(v) || 0) * 1e8) / 1e8; }
function unitsText(n) { return Number(Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 6 }); }

function buyLink(appUrl, ticker) {
  return appUrl + PAGE + '#/investment/b2b/buy?asset=' + encodeURIComponent(normTicker(ticker));
}
function sellLink(appUrl, ticker) {
  return appUrl + PAGE + '#/investment/b2b/sell?asset=' + encodeURIComponent(normTicker(ticker));
}

/* Is the Auto Buy/Sell tool paid up and switched on for this user? */
function autoToolOn(user, now) {
  const a = user && user.investAcct;
  if (!a || a.autoBuySellOn === false) return false;
  const rec = a.tools && a.tools[AUTO_TOOL];
  return !!(rec && rec.active && !rec.paused && (!rec.expiresAt || Number(rec.expiresAt) > (now || Date.now())));
}
/* ...and has the user selected the tool for this asset's alert? */
function autoOn(user, al) { return !!(al && al.auto && autoToolOn(user)); }

function createB2BAlertWatcher({ getDb, persist, broadcast, quotes, email, appUrl, everyMs, onQuote }) {
  const state = {
    lastRunAt: 0, lastHitAt: 0, emailsQueued: 0, notifications: 0, lastError: '', runs: 0,
    auto: { buys: 0, sells: 0, failures: 0, watched: 0, lastFillAt: 0, ticksChecked: 0, reapplied: 0 }
  };

  function quoteOf(ticker) {
    const q = quotes()[normTicker(ticker)];
    if (!q) return null;
    const price = Number(q.price);
    if (!(price > 0)) return null;
    return { price, changePct: Number(q.changePct) || 0 };
  }

  function notify(db, user, title, body, link, icon) {
    const item = {
      id: rid('nt_'), userId: user.id, title, body, link, icon: icon || 'trend',
      read: false, channel: 'b2b-alert', createdAt: Date.now()
    };
    (db.notifications = db.notifications || []).unshift(item);
    if (db.notifications.length > 2000) db.notifications.length = 2000;
    return item;
  }

  function mail(user, alert, side, price, opts) {
    if (!email || !email.configured || !email.configured()) return false;
    if (!user || !user.email) return false;
    if (alert.email === false) return false;
    const stamp = side === 'buy' ? Number(alert.buyHitAt) || Date.now() : Number(alert.sellHitAt) || Date.now();
    const key = 'b2b-alert:' + user.id + ':' + alert.id + ':' + side + ':' + stamp;
    const queued = email.enqueue({
      key,
      to: user.email,
      template: 'b2bAlert',
      data: {
        user,
        ticker: normTicker(alert.ticker),
        side,
        price,
        target: side === 'buy' ? alert.buy : alert.sell,
        buyUrl: buyLink(appUrl(), alert.ticker),
        sellUrl: sellLink(appUrl(), alert.ticker)
      },
      appUrl: appUrl()
    });
    if (queued) state.emailsQueued++;
    return queued;
  }

  /* ======================= Auto Buy/Sell engine ======================= */
  function autoStore(db) {
    if (!db.b2bAuto || typeof db.b2bAuto !== 'object' || Array.isArray(db.b2bAuto)) db.b2bAuto = {};
    if (!Array.isArray(db.b2bAutoJournal)) db.b2bAutoJournal = [];
    return db.b2bAuto;
  }
  function acctOf(user) {
    if (!user.investAcct || typeof user.investAcct !== 'object') return null;
    const a = user.investAcct;
    if (!a.portfolios || typeof a.portfolios !== 'object') a.portfolios = { stock: 0, wc: 0, b2b: 0, bot: 0 };
    if (!a.b2b || typeof a.b2b !== 'object') a.b2b = {};
    if (!Array.isArray(a.ledger)) a.ledger = [];
    if (!Array.isArray(a.b2bAutoApplied)) a.b2bAutoApplied = [];
    return a;
  }
  function capitalOf(a) { return Number(a.portfolios.b2b) || 0; }
  function inventory(db) {
    db.settings = db.settings || {};
    if (!db.settings.b2bInventory || typeof db.settings.b2bInventory !== 'object') db.settings.b2bInventory = {};
    return db.settings.b2bInventory;
  }
  function availOf(db, t) { const v = Number(inventory(db)[t]); return v >= 0 ? v : DEFAULT_INVENTORY; }
  function ledgerLine(a, label, usd, meta) {
    a.ledger.unshift({ id: rid('il_'), label, usd: Number(usd) || 0, coins: 0, meta: meta || null, at: Date.now() });
    if (a.ledger.length > 300) a.ledger.length = 300;
  }
  /* same lifetime totals the desk uses (deposited in / profit ever) */
  function ensureTotals(a) {
    if (a.b2bDeposited === undefined || !(Number(a.b2bDeposited) >= 0)) {
      let basis = 0;
      Object.keys(a.b2b).forEach((t) => { const h = a.b2b[t]; if (h && Number(h.units) > 0) basis += Number(h.units) * (Number(h.avgPrice) || 0); });
      a.b2bDeposited = r2(capitalOf(a) + basis);
    }
    if (a.b2bProfitEver === undefined || isNaN(Number(a.b2bProfitEver))) a.b2bProfitEver = Number(a.b2bProfit) || 0;
  }

  /* Apply one journal fill to the account, exactly once. */
  function applyEntry(a, e) {
    if (!a || !e || a.b2bAutoApplied.indexOf(e.id) >= 0) return false;
    const t = e.ticker;
    if (e.side === 'buy') {
      ensureTotals(a);
      a.portfolios.b2b = r2(capitalOf(a) - e.amount);
      const h = a.b2b[t] || { units: 0, avgPrice: e.price };
      const u0 = Number(h.units) || 0;
      h.avgPrice = ((u0 * (Number(h.avgPrice) || e.price)) + e.amount) / (u0 + e.units);
      h.units = r8(u0 + e.units);
      a.b2b[t] = h;
      ledgerLine(a, 'Auto Buy/Sell bought ' + t + ' at ' + money(e.price), -e.amount, { ticker: t, units: e.units, price: e.price, auto: true, journalId: e.id });
    } else {
      ensureTotals(a);
      a.b2bProfitEver = r2((Number(a.b2bProfitEver) || 0) + e.payout);
      a.b2bProfit = r2((Number(a.b2bProfit) || 0) + e.payout);
      a.portfolios.b2b = r2(capitalOf(a) + e.basis);
      const h = a.b2b[t];
      if (h) {
        h.units = r8((Number(h.units) || 0) - e.units);
        if (h.units <= 1e-8) delete a.b2b[t]; else a.b2b[t] = h;
      }
      ledgerLine(a, 'Auto Buy/Sell sold ' + t + ' at ' + money(e.price) + ' · payout ' + (e.payout >= 0 ? '+' : '') + money(e.payout) + ' to profit balance', 0,
        { ticker: t, units: e.units, price: e.price, proceeds: e.proceeds, payout: e.payout, basis: e.basis, auto: true, journalId: e.id });
    }
    a.b2bAutoApplied.unshift(e.id);
    if (a.b2bAutoApplied.length > 400) a.b2bAutoApplied.length = 400;
    return true;
  }

  function initialState(al) {
    const buy = Number(al.buy) || 0, sell = Number(al.sell) || 0;
    const units = Number(al.autoUnits) || 0;
    if (units > 0 && al.autoState !== 'buy' && al.autoState !== 'done') return { state: sell > 0 ? 'sell' : 'held', units };
    return { state: buy > 0 ? 'buy' : (sell > 0 ? 'sell' : 'done'), units: 0 };
  }
  /* Server-side state per user+alert is authoritative. It resets only when the user
     saves the alert again (new autoArmedAt), never because a device synced old data. */
  function stateFor(db, user, al) {
    const S = autoStore(db);
    const key = user.id + ':' + al.id;
    const cfgAt = Number(al.autoArmedAt || al.createdAt || 0) || 0;
    let s = S[key];
    /* only a newer save resets the state; an older copy synced from another device cannot */
    if (!s || cfgAt > (Number(s.cfgAt) || 0)) {
      const i = initialState(al);
      s = S[key] = {
        cfgAt, userId: user.id, alertId: al.id, ticker: normTicker(al.ticker),
        state: i.state, units: i.units, cycle: (s && s.cycle) || 0,
        log: (s && Array.isArray(s.log)) ? s.log : [], error: '', errorAt: 0,
        lastBuyPrice: (s && s.lastBuyPrice) || 0, lastSellPrice: (s && s.lastSellPrice) || 0, updatedAt: Date.now()
      };
    }
    return s;
  }
  function mirror(al, s) {
    const want = {
      autoState: s.state, autoUnits: r8(s.units), autoCycle: s.cycle || 0, autoLog: (s.log || []).slice(0, 20),
      autoError: s.error || '', autoErrorAt: s.errorAt || 0, autoBuyPrice: s.lastBuyPrice || 0, autoSellPrice: s.lastSellPrice || 0
    };
    let changed = false;
    Object.keys(want).forEach((k) => {
      if (JSON.stringify(al[k]) !== JSON.stringify(want[k])) { al[k] = want[k]; changed = true; }
    });
    return changed;
  }
  function fail(db, user, al, s, side, msg, now) {
    state.auto.failures++;
    if (s.error === msg && now - Number(s.errorAt || 0) < 6 * 3600e3) return false;
    s.error = msg; s.errorAt = now;
    notify(db, user, 'Auto Buy/Sell could not ' + side + ' ' + normTicker(al.ticker), msg + ' The price alert is still active — you can ' + side + ' manually from the B2B desk.',
      '#/investment/b2b/' + side + '?asset=' + encodeURIComponent(normTicker(al.ticker)), 'ban');
    state.notifications++;
    return true;
  }
  function mailAuto(user, al, e) {
    if (!email || !email.configured || !email.configured() || !user.email || al.email === false) return;
    try {
      const q = email.enqueue({
        key: 'b2b-auto:' + user.id + ':' + e.id,
        to: user.email,
        template: 'b2bAutoTrade',
        data: {
          user, ticker: e.ticker, side: e.side, price: e.price, units: e.units, amount: e.amount,
          proceeds: e.proceeds, payout: e.payout, basis: e.basis,
          deskUrl: appUrl() + PAGE + '#/investment/b2b'
        },
        appUrl: appUrl()
      });
      if (q) state.emailsQueued++;
    } catch (err) { state.lastError = err.message; }
  }

  function execute(db, user, al, s, side, price, now) {
    const a = acctOf(user);
    if (!a) return false;
    const t = normTicker(al.ticker);
    let e;
    if (side === 'buy') {
      const amount = r2(al.autoAmount);
      if (!(amount > 0)) return fail(db, user, al, s, 'buy', 'No auto-buy amount is set for ' + t + '.', now);
      if (capitalOf(a) + 1e-9 < amount) return fail(db, user, al, s, 'buy', 'Your B2B capital balance (' + money(capitalOf(a)) + ') is below the ' + money(amount) + ' auto-buy amount.', now);
      const units = r8(amount / price);
      if (units > availOf(db, t)) return fail(db, user, al, s, 'buy', 'The company contract does not have enough ' + t + ' available.', now);
      e = { id: rid('ab_'), userId: user.id, alertId: al.id, ticker: t, side: 'buy', price, units, amount, at: now, cycle: (s.cycle || 0) + 1 };
      inventory(db)[t] = r8(availOf(db, t) - units);
    } else {
      const h = a.b2b[t];
      const held = h ? Number(h.units) || 0 : 0;
      const units = r8(s.units > 0 ? Math.min(s.units, held) : held);
      if (!(units > 1e-8)) return fail(db, user, al, s, 'sell', 'You have no ' + t + ' holding to sell.', now);
      const proceeds = r2(units * price);
      const basis = r2(units * (Number(h.avgPrice) || price));
      const payout = r2(proceeds - basis);
      e = { id: rid('as_'), userId: user.id, alertId: al.id, ticker: t, side: 'sell', price, units, proceeds, basis, payout, at: now, cycle: s.cycle || 0 };
      inventory(db)[t] = r8(availOf(db, t) + units);
    }
    /* journal first, then apply once */
    db.b2bAutoJournal.unshift(e);
    if (db.b2bAutoJournal.length > 3000) db.b2bAutoJournal.length = 3000;
    applyEntry(a, e);

    const buy = Number(al.buy) || 0, sell = Number(al.sell) || 0;
    s.log = Array.isArray(s.log) ? s.log : [];
    s.log.unshift({ id: e.id, side: e.side, price: e.price, units: e.units, amount: e.amount || 0, payout: e.payout || 0, at: now });
    if (s.log.length > 40) s.log.length = 40;
    s.error = ''; s.errorAt = 0; s.updatedAt = now;
    if (side === 'buy') {
      s.units = r8((Number(s.units) || 0) + e.units);
      s.cycle = e.cycle;
      s.lastBuyPrice = price;
      s.state = sell > 0 ? 'sell' : 'held';
      /* the auto fill replaces the plain "buy now" alert for this hit */
      al.buyHit = true; al.buyHitAt = now; al.buyHitPrice = price; al.buyEmailAt = now; al.buyNotifyAt = now;
      state.auto.buys++;
      notify(db, user, 'Auto Buy/Sell bought ' + t,
        'Bought ' + unitsText(e.units) + ' ' + t + ' for ' + money(e.amount) + ' at your buy price of ' + money(price) + ', paid from your B2B capital.' +
          (sell > 0 ? ' It will sell automatically at ' + money(sell) + '.' : ' No sell price is set, so it stays in your holdings.'),
        '#/investment/b2b', 'trend');
    } else {
      s.units = 0;
      s.lastSellPrice = price;
      s.state = (al.autoRepeat && buy > 0) ? 'buy' : 'done';
      al.sellHit = true; al.sellHitAt = now; al.sellHitPrice = price; al.sellEmailAt = now; al.sellNotifyAt = now;
      state.auto.sells++;
      notify(db, user, 'Auto Buy/Sell sold ' + t,
        'Sold ' + unitsText(e.units) + ' ' + t + ' at your sell price of ' + money(price) + '. Payout ' + (e.payout >= 0 ? '+' : '') + money(e.payout) +
          ' credited to your B2B profit balance and ' + money(e.basis) + ' capital returned to your capital balance.' +
          (s.state === 'buy' ? ' It will buy again at ' + money(buy) + '.' : ''),
        '#/investment/b2b', 'wallet');
    }
    state.notifications++;
    state.auto.lastFillAt = now;
    mailAuto(user, al, e);
    console.log('[b2b-auto]', side, t, 'for', user.username || user.id, '@', price, 'units', e.units);
    return true;
  }

  /* Check one alert against one price. Fills at exactly the price the user set. */
  function evaluate(db, user, al, price, now) {
    if (!autoOn(user, al) || !(price > 0)) return false;
    const s = stateFor(db, user, al);
    const buy = Number(al.buy) || 0, sell = Number(al.sell) || 0;
    let changed = false;
    if (buy > 0 && sell > 0 && sell <= buy) {
      changed = fail(db, user, al, s, s.state === 'sell' ? 'sell' : 'buy', 'The sell price (' + money(sell) + ') must be above the buy price (' + money(buy) + ').', now) || changed;
    } else if (s.state === 'buy' && buy > 0 && price <= buy) {
      changed = execute(db, user, al, s, 'buy', buy, now) || changed;
    } else if (s.state === 'sell' && sell > 0 && price >= sell) {
      changed = execute(db, user, al, s, 'sell', sell, now) || changed;
    }
    if (mirror(al, s)) changed = true;
    return changed;
  }

  /* ticker -> [userId, alertId] for every alert with the tool selected */
  let index = new Map();
  function rebuildIndex(db) {
    const next = new Map();
    let n = 0;
    for (const user of (db && db.users) || []) {
      const a = user && user.investAcct;
      if (!a || !Array.isArray(a.b2bAlerts) || !autoToolOn(user)) continue;
      for (const al of a.b2bAlerts) {
        if (!al || !al.auto || !al.ticker || !al.id) continue;
        const k = normTicker(al.ticker);
        if (!next.has(k)) next.set(k, []);
        next.get(k).push([user.id, al.id]);
        n++;
      }
    }
    index = next;
    state.auto.watched = n;
  }

  let flushTimer = null;
  function flushSoon(source) {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      try { persist && persist(); } catch (e) { state.lastError = e.message; }
      try { broadcast && broadcast('change', { rev: null, source: source || 'b2b-auto', at: Date.now() }); } catch (e) {}
    }, 200);
    if (flushTimer.unref) flushTimer.unref();
  }

  /* every live price tick */
  function onTick(ticker, price) {
    const list = index.get(normTicker(ticker));
    if (!list || !list.length) return;
    const db = getDb && getDb();
    if (!db || !Array.isArray(db.users)) return;
    const now = Date.now();
    let dirty = false;
    for (const [uid, aid] of list) {
      const user = db.users.find((u) => u && u.id === uid);
      if (!user || !user.investAcct) continue;
      const al = (user.investAcct.b2bAlerts || []).find((x) => x && x.id === aid);
      if (!al) continue;
      state.auto.ticksChecked++;
      if (evaluate(db, user, al, Number(price), now)) dirty = true;
    }
    if (dirty) flushSoon('b2b-auto');
  }

  /* re-apply any fill a device overwrote with an older copy of the account */
  function reconcile(db) {
    const J = db.b2bAutoJournal;
    if (!Array.isArray(J) || !J.length) return false;
    const cutoff = Date.now() - 30 * 864e5;
    let dirty = false;
    const byUser = new Map();
    for (const e of J) {
      if (!e || Number(e.at) < cutoff) continue;
      if (!byUser.has(e.userId)) byUser.set(e.userId, []);
      byUser.get(e.userId).push(e);
    }
    byUser.forEach((list, uid) => {
      const user = db.users.find((u) => u && u.id === uid);
      const a = user && acctOf(user);
      if (!a) return;
      list.slice().reverse().forEach((e) => {
        if (applyEntry(a, e)) { dirty = true; state.auto.reapplied++; }
      });
    });
    return dirty;
  }

  function autoSweep() {
    const db = getDb && getDb();
    if (!db || !Array.isArray(db.users)) return;
    autoStore(db);
    rebuildIndex(db);
    let dirty = reconcile(db);
    const now = Date.now();
    index.forEach((list, ticker) => {
      const q = quoteOf(ticker);
      for (const [uid, aid] of list) {
        const user = db.users.find((u) => u && u.id === uid);
        if (!user || !user.investAcct) continue;
        const al = (user.investAcct.b2bAlerts || []).find((x) => x && x.id === aid);
        if (!al) continue;
        if (q) { if (evaluate(db, user, al, q.price, now)) dirty = true; }
        else if (mirror(al, stateFor(db, user, al))) dirty = true;
      }
    });
    if (dirty) flushSoon('b2b-auto');
  }

  function run() {
    const db = getDb && getDb();
    if (!db || !Array.isArray(db.users)) return state;
    state.runs++;
    state.lastRunAt = Date.now();
    let dirty = false;
    const now = Date.now();

    for (const user of db.users) {
      if (!user || !user.investAcct) continue;
      const list = user.investAcct.b2bAlerts;
      if (!Array.isArray(list) || !list.length) continue;

      for (const al of list) {
        if (!al || !al.ticker) continue;
        const q = quoteOf(al.ticker);
        if (!q) continue;
        const price = q.price;
        /* with Auto Buy/Sell selected for this asset the tool sends its own messages when it
           buys or sells; the plain "buy now / sell now" alert is only sent if the tool fails */
        const quiet = autoOn(user, al) && !al.autoError;

        /* ---- buy target: arm / fire / re-arm ---- */
        const buy = Number(al.buy) || 0;
        if (buy > 0) {
          if (price <= buy) {
            if (Number(al.buyHitAt || 0) < (al.buyRearmAt || 0)) { al.buyHit = false; al.buyHitAt = 0; dirty = true; }
            if (!al.buyHit) {
              al.buyHit = true; al.buyHitAt = now; al.buyHitPrice = price; dirty = true;
            }
            if (!quiet && Number(al.buyEmailAt || 0) < Number(al.buyHitAt || 0)) {
              if (mail(user, al, 'buy', price)) { al.buyEmailAt = al.buyHitAt; dirty = true; }
            }
            if (!quiet && Number(al.buyNotifyAt || 0) < Number(al.buyHitAt || 0)) {
              notify(db, user, 'Buy target reached · ' + normTicker(al.ticker),
                normTicker(al.ticker) + ' is ' + money(price) + ', at or below your buy target of ' + money(buy) + '. Open the buy page to buy now.',
                '#/investment/b2b/buy?asset=' + encodeURIComponent(normTicker(al.ticker)), 'trend');
              al.buyNotifyAt = al.buyHitAt; state.notifications++; dirty = true;
            }
          } else if (al.buyHit) {
            /* price moved back above the target — re-arm for the next dip */
            al.buyHit = false; al.buyHitAt = 0; al.buyRearmAt = now; dirty = true;
          }
        }

        /* ---- sell target ---- */
        const sell = Number(al.sell) || 0;
        if (sell > 0) {
          if (price >= sell) {
            if (Number(al.sellHitAt || 0) < (al.sellRearmAt || 0)) { al.sellHit = false; al.sellHitAt = 0; dirty = true; }
            if (!al.sellHit) {
              al.sellHit = true; al.sellHitAt = now; al.sellHitPrice = price; dirty = true;
            }
            if (!quiet && Number(al.sellEmailAt || 0) < Number(al.sellHitAt || 0)) {
              if (mail(user, al, 'sell', price)) { al.sellEmailAt = al.sellHitAt; dirty = true; }
            }
            if (!quiet && Number(al.sellNotifyAt || 0) < Number(al.sellHitAt || 0)) {
              notify(db, user, 'Sell target reached · ' + normTicker(al.ticker),
                normTicker(al.ticker) + ' is ' + money(price) + ', at or above your sell target of ' + money(sell) + '. Open the sell page to sell now.',
                '#/investment/b2b/sell?asset=' + encodeURIComponent(normTicker(al.ticker)), 'wallet');
              al.sellNotifyAt = al.sellHitAt; state.notifications++; dirty = true;
            }
          } else if (al.sellHit) {
            al.sellHit = false; al.sellHitAt = 0; al.sellRearmAt = now; dirty = true;
          }
        }
      }
    }

    if (dirty) {
      try { persist && persist(); } catch (e) { state.lastError = e.message; }
      try { broadcast && broadcast('change', { rev: null, source: 'b2b-alert', at: now }); } catch (e) {}
    }
    return state;
  }

  let timer = null;
  let autoTimer = null;
  let hooked = false;
  function start() {
    if (timer) return;
    try { autoSweep(); } catch (e) { state.lastError = e.message; }
    if (!hooked && typeof onQuote === 'function') {
      try { onQuote((ticker, price) => { try { onTick(ticker, price); } catch (e) { state.lastError = e.message; console.error('[b2b-auto]', e.message); } }); hooked = true; } catch (e) {}
    }
    autoTimer = setInterval(() => {
      try { autoSweep(); } catch (e) { state.lastError = e.message; console.error('[b2b-auto]', e.message); }
    }, Math.max(1000, Number(process.env.B2B_AUTO_MS || 2000)));
    if (autoTimer.unref) autoTimer.unref();
    timer = setInterval(() => {
      try { run(); } catch (e) { state.lastError = e.message; console.error('[b2b-alert]', e.message); }
    }, Math.max(5000, Number(everyMs) || 15000));
    if (timer.unref) timer.unref();
  }
  function stop() {
    if (timer) clearInterval(timer); timer = null;
    if (autoTimer) clearInterval(autoTimer); autoTimer = null;
  }

  return {
    run: () => { try { autoSweep(); } catch (e) { state.lastError = e.message; } return run(); },
    start, stop, status: () => JSON.parse(JSON.stringify(state)), buyLink, sellLink,
    /* exposed for tests */
    _evaluate: evaluate, _autoSweep: autoSweep, _onTick: onTick, _rebuildIndex: rebuildIndex
  };
}

module.exports = { createB2BAlertWatcher, buyLink, sellLink, autoToolOn, AUTO_TOOL };
