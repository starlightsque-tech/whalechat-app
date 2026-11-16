/* =========================================================================
   WhaleChat B2B price-alert engine  (server side)

   Price alerts used to fire only while the app was open in a browser tab.
   This watcher evaluates every stored B2B alert against the live market on
   the server, so a user gets the in-app notification AND an email with a
   working "Buy now" / "Sell now" deep link even when the app is closed.

   Alerts live on user.investAcct.b2bAlerts (synced from the client):
     { id, ticker, buy, sell, email, buyHit, sellHit, buyHitAt, sellHitAt }
   ========================================================================= */
'use strict';

const PAGE = '/whalechat.html';

function normTicker(t) { return String(t || '').toUpperCase(); }
function money(v) { return '$' + (Math.round((Number(v) || 0) * 100) / 100).toFixed(2); }
function rid(p) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

function buyLink(appUrl, ticker) {
  return appUrl + PAGE + '#/investment/b2b/buy?asset=' + encodeURIComponent(normTicker(ticker));
}
function sellLink(appUrl, ticker) {
  return appUrl + PAGE + '#/investment/b2b/sell?asset=' + encodeURIComponent(normTicker(ticker));
}

function createB2BAlertWatcher({ getDb, persist, broadcast, quotes, email, appUrl, everyMs }) {
  const state = { lastRunAt: 0, lastHitAt: 0, emailsQueued: 0, notifications: 0, lastError: '', runs: 0 };

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

        /* ---- buy target: arm / fire / re-arm ---- */
        const buy = Number(al.buy) || 0;
        if (buy > 0) {
          if (price <= buy) {
            if (Number(al.buyHitAt || 0) < (al.buyRearmAt || 0)) { al.buyHit = false; al.buyHitAt = 0; dirty = true; }
            if (!al.buyHit) {
              al.buyHit = true; al.buyHitAt = now; al.buyHitPrice = price; dirty = true;
            }
            if (Number(al.buyEmailAt || 0) < Number(al.buyHitAt || 0)) {
              if (mail(user, al, 'buy', price)) { al.buyEmailAt = al.buyHitAt; dirty = true; }
            }
            if (Number(al.buyNotifyAt || 0) < Number(al.buyHitAt || 0)) {
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
            if (Number(al.sellEmailAt || 0) < Number(al.sellHitAt || 0)) {
              if (mail(user, al, 'sell', price)) { al.sellEmailAt = al.sellHitAt; dirty = true; }
            }
            if (Number(al.sellNotifyAt || 0) < Number(al.sellHitAt || 0)) {
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
  function start() {
    if (timer) return;
    timer = setInterval(() => {
      try { run(); } catch (e) { state.lastError = e.message; console.error('[b2b-alert]', e.message); }
    }, Math.max(5000, Number(everyMs) || 15000));
    if (timer.unref) timer.unref();
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  return { run, start, stop, status: () => Object.assign({}, state), buyLink, sellLink };
}

module.exports = { createB2BAlertWatcher, buyLink, sellLink };
