/* =========================================================================
   WhaleChat 3.57.0 — account, investing and offline upgrade
   -------------------------------------------------------------------------
   This module is injected last (after every other repo module) and layers the
   3.57 release on top of the assembled app without touching the giant parts:

     · dashboard card: "stocks-trade" button, larger card, WC-invest + vendor
     · My account is the default page after sign-in / sign-up
     · email 6-digit verification on sign-up, password reset by emailed code
     · transaction PIN lives in Settings (set / change / forgot-PIN reset)
     · WC-Investing: a green/red ROI chart per active plan + ROI progress
     · stock charts render locally (TradingView-style) when offline
     · account data is never dropped: safe DB boot, backups, legacy merge
     · the offline banner no longer overlaps the bottom navigation

   Every patch is defensive: if the host app does not expose something this
   module degrades to a no-op instead of breaking the page.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined' || window.__wcBuild357) return;
  window.__wcBuild357 = true;

  var VERSION = '3.57.0';
  var DB_NAME = 'whalechat.v357.backup';
  var EMAIL_KEY = 'whalechat.v357.pendingVerify';

  function safe(fn, d) { try { return fn(); } catch (e) { return d; } }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function isFn(name) { return safe(function () { return typeof window[name] === 'function'; }, false); }
  function call(name) {
    var args = Array.prototype.slice.call(arguments, 1);
    return safe(function () {
      var fn = null;
      try { fn = eval(name); } catch (e) { fn = null; }
      if (typeof fn !== 'function') return undefined;
      return fn.apply(null, args);
    });
  }
  function toast357(m, k) { call('toast', m, k || 'ok'); }
  function go357(p) { call('go', p); }
  function me357() { return safe(function () { return me(); }, null); }
  function db357() { return safe(function () { return DB; }, null); }
  function save357() {
    safe(function () { if (typeof persist === 'function') persist(true); });
    safe(function () { if (typeof sync === 'function') sync(); });
  }
  function money(v) {
    var n = Number(v) || 0;
    var d = Math.abs(n) >= 1000 ? 2 : Math.abs(n) >= 1 ? 2 : 4;
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function api(path, body) {
    var base = '';
    try { base = (typeof Remote !== 'undefined' && Remote && Remote.base) ? String(Remote.base) : ''; } catch (e) {}
    if (!base) base = 'https://whalechat-api.appwrite.network';
    return fetch(base.replace(/\/+$/, '') + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (r) { return r.json().catch(function () { return {}; }); })
      .catch(function () { return { ok: false, error: 'offline' }; });
  }

  /* =====================================================================
     1 · account data safety
     The app keeps accounts in localStorage; a release upgrade, a cache clear
     or a sleeping Render instance must never delete them. We keep a second
     snapshot under a version-independent key and merge it back if the primary
     store comes back empty. Accounts already on the server are merged too.
     ===================================================================== */
  function backupNow() {
    var db = db357();
    if (!db || !Array.isArray(db.users)) return;
    safe(function () {
      localStorage.setItem(DB_NAME, JSON.stringify({ at: Date.now(), version: VERSION, db: db }));
    });
  }

  function mergeUsersFrom(other) {
    var db = db357();
    if (!db || !other || !Array.isArray(other.users)) return 0;
    db.users = db.users || [];
    var added = 0;
    other.users.forEach(function (u) {
      if (!u || !u.id) return;
      var found = db.users.filter(function (x) {
        return x && (x.id === u.id ||
          String(x.username || '').toLowerCase() === String(u.username || '').toLowerCase() ||
          String(x.email || '').toLowerCase() === String(u.email || '').toLowerCase());
      })[0];
      if (!found) { db.users.push(u); added++; return; }
      /* never let an older copy overwrite a newer password / balance */
      if ((Number(u.updatedAt) || 0) > (Number(found.updatedAt) || 0) && u.pass) found.pass = u.pass;
      if (u.pin && !found.pin) found.pin = u.pin;
      if (u.verified && !found.verified) found.verified = true;
    });
    return added;
  }

  function restoreLocalBackup() {
    var db = db357();
    if (!db) return 0;
    var raw = safe(function () { return localStorage.getItem(DB_NAME); }, null);
    if (!raw) return 0;
    var snap = safe(function () { return JSON.parse(raw); }, null);
    if (!snap || !snap.db) return 0;
    var added = mergeUsersFrom(snap.db);
    if (added) {
      if (!Array.isArray(db.users) || !db.users.length) db = snap.db;
      save357();
      safe(function () { if (typeof render === 'function') render(); });
      backupNow();
    }
    return added;
  }

  function mergeServerAccounts() {
    if (!navigator.onLine) return Promise.resolve(0);
    return fetch('/api/state', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (payload) {
        var serverDb = payload && (payload.db || payload);
        var added = mergeUsersFrom(serverDb);
        if (added) { save357(); safe(function () { if (typeof render === 'function') render(); }); }
        return added;
      })
      .catch(function () { return 0; });
  }

  /* =====================================================================
     2 · offline banner — hidden, never over the bottom navigation
     ===================================================================== */
  function hideOfflineBanners() {
    ['wcOfflineChip', 'wc-offline-chip'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.remove();
    });
    Array.prototype.forEach.call(document.querySelectorAll('.wc-offline-chip, #wcOfflineChip'), function (el) {
      el.style.display = 'none';
      el.remove();
    });
  }

  function installOfflineCSS() {
    if (document.getElementById('wc357-offline-css')) return;
    var st = document.createElement('style');
    st.id = 'wc357-offline-css';
    st.textContent = [
      /* the banner used to sit on top of the tab bar buttons */
      '#wcOfflineChip,.wc-offline-chip{display:none!important;visibility:hidden!important;pointer-events:none!important}',
      'html.wc-is-offline body::after{content:none!important;display:none!important}',
      /* the small "device mode" badge is informational only; keep it out of the way */
      'html.wc-is-offline [data-wc-offline-badge]{display:none!important}'
    ].join('\n');
    document.head.appendChild(st);
  }

  /* =====================================================================
     3 · dashboard card — larger, stocks-trade / WC-invest / vendor
     ===================================================================== */
  function installDashboardCSS() {
    if (document.getElementById('wc357-dash-css')) return;
    var st = document.createElement('style');
    st.id = 'wc357-dash-css';
    st.textContent = [
      '/* enlarged WhaleChat account balance card */',
      '.wallet-card.wc-dash-lg{padding:30px 28px!important;border-radius:28px!important;min-height:292px;display:flex;flex-direction:column;justify-content:center}',
      '.wallet-card.wc-dash-lg .wallet-bal{font-size:44px!important}',
      '.wallet-card.wc-dash-lg .wallet-actions{margin-top:22px!important;gap:10px!important;grid-template-columns:repeat(3,minmax(0,1fr))!important}',
      '.wallet-card.wc-dash-lg .wallet-actions .btn{min-height:48px!important;font-size:12.5px!important;font-weight:800;line-height:1.15;white-space:normal;padding:7px 6px!important}',
      '.wallet-card .wallet-actions .btn[data-wc-invest],.wallet-card .wallet-actions .btn[data-wc-vendor]{background:rgba(46,230,201,.16)!important;border-color:rgba(46,230,201,.55)!important;color:#062b25!important}',
      '@media(min-width:1200px){.wallet-card.wc-dash-lg{min-height:310px}}',
      '@media(max-width:520px){.wallet-card.wc-dash-lg{padding:24px 20px!important;min-height:270px}.wallet-card.wc-dash-lg .wallet-bal{font-size:38px!important}}',
      /* per-plan ROI chart card */
      '.wci-plan{padding:14px 0!important}',
      '.wci-chartwrap{background:linear-gradient(180deg,rgba(34,197,94,.08),rgba(239,68,68,.03));border:1px solid rgba(255,255,255,.06);border-radius:12px;padding:4px 6px 2px;margin-top:10px}',
      '.wci-roi-ticks{display:flex;justify-content:space-between;font-size:9.5px;color:var(--muted);padding:3px 4px 0;letter-spacing:.02em}',
      '.wc-roi-tag{display:inline-flex;align-items:center;gap:4px;font-size:9.5px;font-weight:800;padding:2px 7px;border-radius:999px;background:rgba(34,197,94,.14);color:#22c55e}',
      /* local (offline) stock chart */
      '.wc-localchart{background:#0b1220;border:1px solid rgba(255,255,255,.08);border-radius:12px;overflow:hidden;padding:6px}',
      '.wc-localchart .wtc-host{min-height:300px}',
      '.wc-localchart-note{font-size:10px;color:#8ba4b6;padding:6px 4px 0;display:flex;justify-content:space-between}'
    ].join('\n');
    document.head.appendChild(st);
  }

  function enhanceDashboard() {
    var cards = document.querySelectorAll('.wallet-card');
    if (!cards.length) return;
    var u = me357();
    if (!u) return;
    Array.prototype.forEach.call(cards, function (card) {
      card.classList.add('wc-dash-lg');
      var acts = card.querySelector('.wallet-actions');
      if (!acts) return;

      /* rename the investment button */
      Array.prototype.forEach.call(acts.querySelectorAll('a,button'), function (b) {
        var label = (b.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (label === 'investment account' || label === 'invest') {
          b.setAttribute('href', '#/investment');
          b.innerHTML = 'stocks-trade';
          b.setAttribute('data-wc-stocks-trade', '1');
          if (label === 'invest') b.setAttribute('href', '#/investment');
        }
      });

      /* add the two new buttons once */
      if (!acts.querySelector('[data-wc-invest]')) {
        var a = document.createElement('a');
        a.className = 'btn';
        a.href = '#/invest/shares';
        a.setAttribute('data-wc-invest', '1');
        a.innerHTML = 'WC-invest';
        acts.appendChild(a);
      }
      if (!acts.querySelector('[data-wc-vendor]')) {
        var v = document.createElement('a');
        v.className = 'btn';
        v.href = '#/vendor';
        v.setAttribute('data-wc-vendor', '1');
        v.innerHTML = 'vendor';
        acts.appendChild(v);
      }
    });
  }

  /* =====================================================================
     4 · default page = My account, no PIN popup after sign-up
     ===================================================================== */
  function patchGo() {
    var base = safe(function () { return go; }, null);
    if (typeof base !== 'function' || base.__wc357) return;
    var wrapped = function (path) {
      if (typeof path === 'string' && /^#?\/?set-pin$/.test(path)) {
        var u = me357();
        if (u) { return base('profile'); }
      }
      return base.apply(null, arguments);
    };
    wrapped.__wc357 = true;
    safe(function () { go = wrapped; });
  }

  function patchLogin() {
    if (!safe(function () { return App && App.login; }, null)) return;
    if (App.login.__wc357) return;
    App.login = async function () {
      var form = document.getElementById('loginForm');
      if (!form) return;
      var btn = document.getElementById('loginBtn');
      var id = document.getElementById('loginUser').value.trim();
      var pw = document.getElementById('loginPass').value;
      call('clearErrors');
      if (!id) return call('formError', 'loginUser', 'Enter your username or email');
      var allowAny = safe(function () { return DB.settings && DB.settings.allowAnyPassword === true; }, false);
      if (!pw && !allowAny) return call('formError', 'loginPass', 'Enter your password');
      if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Signing in…'; }
      await new Promise(function (r) { setTimeout(r, 150); });

      var u = safe(function () { return byUsername(id); }, null);
      /* an account created on another device / restored server must still log in */
      if (!u) { await mergeServerAccounts(); u = safe(function () { return byUsername(id); }, null); }
      var ph = await hash357(pw);
      if (!u || (!allowAny && u.pass !== ph)) {
        if (btn) { btn.disabled = false; btn.innerHTML = 'Sign in'; }
        return call('formError', 'loginPass', u ? 'Incorrect password. Please try again.' : 'No account found with those details.');
      }
      if (u.banned) {
        if (btn) { btn.disabled = false; btn.innerHTML = 'Sign in'; }
        return call('formError', 'loginUser', 'This account has been suspended. Contact support.');
      }
      safe(function () {
        SESSION = { userId: u.id, at: Date.now() };
        localStorage.setItem(LS_SESSION, JSON.stringify(SESSION));
      });
      save357();
      backupNow();
      toast357('Welcome back, ' + String(u.fullName || u.username).split(' ')[0]);
      if (u.role === 'admin') go357('admin');
      else go357('profile');
      safe(function () { requestNotifyPermission(false); });
      safe(function () { if (Remote.enabled) setTimeout(function () { Push.ensure(false); }, 1200); });
    };
    App.login.__wc357 = true;
  }

  function patchLogout() {
    var base = safe(function () { return App && App.logout; }, null);
    if (typeof base !== 'function' || base.__wc357) return;
    App.logout = async function () {
      var out = await base.apply(App, arguments);
      /* session-guard keeps a sessionStorage copy for crash recovery; sign-out
         must remove it or the next render signs the user straight back in */
      safe(function () { sessionStorage.removeItem('wc_session_backup_v1'); });
      safe(function () { localStorage.removeItem(LS_SESSION); });
      safe(function () { SESSION = null; });
      return out;
    };
    App.logout.__wc357 = true;
  }

  function hash357(v) {
    return new Promise(function (resolve) {
      try { Promise.resolve(hash(v)).then(resolve); } catch (e) { resolve(String(v)); }
    });
  }

  /* =====================================================================
     5 · sign-up with emailed 6-digit verification
     ===================================================================== */
  function patchSignup() {
    if (!safe(function () { return App && App.signup; }, null)) return;
    if (App.signup.__wc357) return;
    App.signup = async function () {
      var btn = document.getElementById('suBtn');
      call('clearErrors');
      var fullName = val('suName'), username = val('suUser'), email = val('suEmail');
      var phone = val('suPhone'), pass = val('suPass'), pass2 = val('suPass2');
      var ref = val('suRef');
      var terms = safe(function () { return document.getElementById('suTerms').checked; }, false);
      var users = safe(function () { return DB.users || []; }, []);

      if (fullName.length < 3) return call('formError', 'suName', 'Please enter your full name');
      if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return call('formError', 'suUser', '3–20 characters: letters, numbers or underscores');
      if (users.some(function (u) { return String(u.username || '').toLowerCase() === username.toLowerCase(); })) return call('formError', 'suUser', 'That username is already taken');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return call('formError', 'suEmail', 'Enter a valid email address');
      if (users.some(function (u) { return String(u.email || '').toLowerCase() === email.toLowerCase(); })) return call('formError', 'suEmail', 'An account with this email already exists');
      if (phone.replace(/\D/g, '').length < 7) return call('formError', 'suPhone', 'Enter a valid phone number');
      if (users.some(function (u) { return String(u.phone || '').replace(/\D/g, '') === phone.replace(/\D/g, ''); })) return call('formError', 'suPhone', 'This phone number is already registered');
      if (pass.length < 6) return call('formError', 'suPass', 'Password must be at least 6 characters');
      if (pass !== pass2) return call('formError', 'suPass2', 'Passwords do not match');
      if (!terms) return toast357('Please accept the Terms of Service', 'err');

      var referrer = null, pendingReferralCode = null;
      var refCode = safe(function () { return normalizeRefCode(ref); }, '');
      if (refCode) {
        if (!/^[A-Z0-9]{4,12}$/.test(refCode)) return call('formError', 'suRef', 'Enter a valid referral code, e.g. WC411CA');
        referrer = safe(function () { return findReferrer(refCode); }, null);
        if (referrer && referrer.banned) referrer = null;
        if (!referrer) pendingReferralCode = refCode;
      }

      if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Creating account…'; }
      await new Promise(function (r) { setTimeout(r, 200); });

      var u = {
        id: safe(function () { return uid('usr'); }, 'usr_' + Date.now().toString(36)),
        role: 'user', fullName: fullName, username: username, email: email, phone: phone,
        pass: await hash357(pass), pin: null, avatar: null, balance: 0,
        totalDeposits: 0, totalWithdrawals: 0, totalEarnings: 0,
        referralCode: safe(function () { return uniqueReferralCode(); }, 'WC' + Math.random().toString(36).slice(2, 7).toUpperCase()),
        accountId: '', referredBy: referrer ? referrer.id : null,
        pendingReferralCode: pendingReferralCode || null, referralPaid: false,
        trustScore: 80, completedSales: 0, rating: 5, verified: false, banned: false,
        vendorId: null, cart: [], stars: [],
        settings: { notifications: true, theme: safe(function () { return document.documentElement.getAttribute('data-theme'); }, 'dark') },
        createdAt: Date.now(), updatedAt: Date.now()
      };
      u.accountId = u.referralCode;

      safe(function () { DB.users.push(u); });
      if (pendingReferralCode) toast357('Referral code saved — it will link automatically');
      if (referrer) {
        safe(function () {
          DB.contacts.push({ id: uid('ct'), ownerId: u.id, userId: referrer.id, createdAt: Date.now() });
          DB.contacts.push({ id: uid('ct'), ownerId: referrer.id, userId: u.id, createdAt: Date.now() });
          notify(referrer.id, 'New referral joined', fullName + ' (@' + username + ') signed up with your code.', '#/referrals', 'gift');
        });
      }
      safe(function () { notify(u.id, 'Welcome to WhaleChat 🐋', 'Your account is ready. Set your transaction PIN in Settings whenever you want.', '#/profile', 'gift'); });
      safe(function () { notify('usr_admin', 'New user registered', fullName + ' (@' + username + ') just created an account.', '#/admin/users', 'users'); });

      /* store the account and sign in immediately — an email hiccup can never
         block the account or lose its data */
      safe(function () {
        SESSION = { userId: u.id, at: Date.now() };
        localStorage.setItem(LS_SESSION, JSON.stringify(SESSION));
      });
      save357();
      backupNow();
      if (btn) { btn.disabled = false; btn.innerHTML = 'Create account'; }
      toast357('Account created — welcome aboard!');
      go357('profile');
      safe(function () { requestNotifyPermission(false); });
      safe(function () { if (Remote.enabled) setTimeout(function () { Push.ensure(false); }, 1000); });

      /* email verification code (server-generated, 6 digits) */
      try { await startEmailVerification(u, 'signup'); } catch (e) {}
    };
    App.signup.__wc357 = true;
  }

  function val(id) {
    var el = document.getElementById(id);
    return el ? String(el.value || '').trim() : '';
  }

  function codeDialog(opts) {
    return new Promise(function (resolve) {
      var old = document.getElementById('wc357VerifyOverlay');
      if (old) { try { old.remove(); } catch (e) {} }
      var wrap = document.createElement('div');
      wrap.id = 'wc357VerifyOverlay';
      wrap.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(2,10,16,.78);display:flex;align-items:center;justify-content:center;padding:18px;backdrop-filter:blur(4px)';
      wrap.innerHTML = '' +
        '<div style="width:100%;max-width:420px;background:#0b1d29;border:1px solid rgba(255,255,255,.14);border-radius:18px;padding:20px;color:#e9f4f9;box-shadow:0 24px 60px rgba(0,0,0,.5)">' +
          '<div style="font-size:18px;font-weight:800;margin-bottom:6px">' + esc(opts.title || 'Verify your email') + '</div>' +
          '<div style="font-size:12px;line-height:1.5;color:#8ba4b6;margin-bottom:12px">' + esc(opts.sub || '') + '</div>' +
          '<input id="wc357Code" class="input" inputmode="numeric" maxlength="6" placeholder="000000" ' +
            'style="width:100%;box-sizing:border-box;text-align:center;font-size:24px;letter-spacing:10px;font-weight:800;font-family:Menlo,Consolas,monospace;padding:12px;border-radius:12px;border:1px solid rgba(255,255,255,.18);background:#04101a;color:#e9f4f9"/>' +
          '<div id="wc357CodeErr" style="display:none;margin-top:8px;color:#ff9aaa;font-size:12px"></div>' +
          (opts.fallbackCode ? '<div style="margin-top:10px;padding:10px;border:1px solid rgba(255,255,255,.1);border-radius:10px"><div style="font-size:11px;color:#8ba4b6">Email delivery is not configured on this server yet, so here is your code:</div>' +
            '<div style="text-align:center;font-size:22px;letter-spacing:6px;font-weight:800;color:#2ee6c9;margin-top:6px">' + esc(opts.fallbackCode) + '</div></div>' : '') +
          '<div style="display:flex;gap:8px;margin-top:14px">' +
            '<button type="button" data-close style="flex:1;border:1px solid rgba(255,255,255,.18);background:transparent;color:#e9f4f9;border-radius:10px;padding:10px;font-weight:700;cursor:pointer">Not now</button>' +
            '<button type="button" data-wc357-verify style="flex:1;border:0;background:#2ee6c9;color:#04101a;border-radius:10px;padding:10px;font-weight:800;cursor:pointer">Verify</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(wrap);
      var finished = false;
      function finish(value) {
        if (finished) return;
        finished = true;
        try { wrap.remove(); } catch (e) {}
        resolve(value);
      }
      var submit = async function () {
        var code = (document.getElementById('wc357Code') || {}).value || '';
        var err = document.getElementById('wc357CodeErr');
        if (!/^\d{6}$/.test(code.trim())) {
          if (err) { err.textContent = 'Enter the 6-digit code'; err.style.display = 'block'; }
          return;
        }
        var res = await api('/api/verify/email-check', { email: opts.email, purpose: opts.purpose || 'signup', code: code.trim() });
        if (!res.ok && opts.localCode && code.trim() === opts.localCode) res = { ok: true, fallback: true };
        if (!res.ok) {
          if (err) { err.textContent = res.message || 'Incorrect or expired code'; err.style.display = 'block'; }
          return;
        }
        finish({ ok: true });
      };
      wrap.querySelector('[data-wc357-verify]').onclick = submit;
      wrap.querySelector('[data-close]').onclick = function () { finish(null); };
      var inp = document.getElementById('wc357Code');
      if (inp) { inp.focus(); inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); }); }
      setTimeout(function () { finish(null); }, 10 * 60000);
    });
  }

  async function startEmailVerification(u, purpose) {
    if (!u) return;
    if (!navigator.onLine) {
      toast357('You are offline — verify your email from Settings when you reconnect', 'warn');
      return;
    }
    var res = await api('/api/verify/email-code', {
      email: u.email, purpose: purpose || 'signup', name: u.fullName || u.username,
      userId: u.id
    });
    if (!res.ok) {
      toast357(res.message || 'Could not send the verification code — try again from Settings', 'err');
      return;
    }
    var out = await codeDialog({
      title: 'Verify your email',
      sub: 'We sent a 6-digit code to ' + u.email + '. Paste it below and press Verify.',
      email: u.email, purpose: purpose || 'signup',
      fallbackCode: res.code || ''
    });
    if (out && out.ok) {
      u.verified = true;
      u.emailVerifiedAt = Date.now();
      u.updatedAt = Date.now();
      save357(); backupNow();
      toast357('Email verified — welcome to your account');
      go357('profile');
    }
  }
  window.wc357VerifyEmail = function () {
    var u = me357();
    if (!u) return;
    startEmailVerification(u, 'signup');
  };

  /* =====================================================================
     6 · password reset with emailed code
     ===================================================================== */
  var resetState = { user: null, email: '', code: '', fallback: '', verified: false };

  function resetView() {
    return '' +
      '<div class="page-head"><div><button class="btn btn-ghost btn-sm mb10" data-nav="#/login">' + ic357('back', 14) + ' Back to sign in</button>' +
        '<h1>Reset password</h1><p>Verify your email, then choose a new password.</p></div></div>' +
      '<div class="card" style="max-width:560px;margin:0 auto">' +
        '<div class="steps" style="margin-bottom:14px"><i class="on"></i><i id="wcRStep2"></i><i id="wcRStep3"></i></div>' +
        '<div id="wcRStepA">' +
          '<div class="field"><label class="label">Username or email</label><input class="input" id="wcRUser" placeholder="e.g. janedoe or you@email.com"/></div>' +
          '<button class="btn btn-primary btn-block btn-lg" id="wcRSend">Send verification code</button>' +
          '<div class="tiny muted mt10">We email a 6-digit code to the address registered on the account.</div>' +
        '</div>' +
        '<div id="wcRStepB" style="display:none">' +
          '<div class="tiny muted" id="wcRSentTo" style="margin-bottom:10px"></div>' +
          '<div class="field"><label class="label">Verification code</label><input class="input" id="wcRCode" inputmode="numeric" maxlength="6" placeholder="000000" style="letter-spacing:8px;text-align:center;font-size:20px"/></div>' +
          '<div id="wcRFallback"></div>' +
          '<button class="btn btn-primary btn-block" id="wcRVerify">Verify code</button>' +
          '<button class="btn btn-ghost btn-block mt8" id="wcRResend">Resend code</button>' +
        '</div>' +
        '<div id="wcRStepC" style="display:none">' +
          '<div class="field"><label class="label">New password</label><input class="input" id="wcRPass" type="password" placeholder="At least 6 characters"/></div>' +
          '<div class="field"><label class="label">Confirm new password</label><input class="input" id="wcRPass2" type="password" placeholder="Repeat password"/></div>' +
          '<button class="btn btn-primary btn-block btn-lg" id="wcRConfirm">Confirm password reset</button>' +
        '</div>' +
        '<div id="wcRErr" class="err" style="display:none;margin-top:10px"></div>' +
      '</div>';
  }

  function err357(msg) {
    var e = document.getElementById('wcRErr');
    if (e) { e.textContent = msg; e.style.display = 'block'; }
    else toast357(msg, 'err');
  }

  function bindResetView() {
    var send = document.getElementById('wcRSend');
    if (!send) return;
    var u = null;
    async function dispatchCode() {
      var id = val('wcRUser');
      if (!id) return err357('Enter your username or email');
      u = safe(function () { return byUsername(id); }, null);
      if (!u) { await mergeServerAccounts(); u = safe(function () { return byUsername(id); }, null); }
      if (!u) return err357('No account matches those details');
      resetState.user = u; resetState.email = u.email;
      if (!navigator.onLine) return err357('You are offline — connect to the internet to receive the code');
      var res = await api('/api/verify/email-code', { email: u.email, purpose: 'reset', name: u.fullName || u.username, userId: u.id });
      if (!res.ok) return err357(res.message || 'Could not send the code');
      resetState.fallback = res.code || '';
      document.getElementById('wcRStepA').style.display = 'none';
      document.getElementById('wcRStepB').style.display = 'block';
      var s2 = document.getElementById('wcRStep2'); if (s2) s2.className = 'on';
      document.getElementById('wcRSentTo').innerHTML = 'Code sent to <b>' + esc(u.email) + '</b>. Paste the 6 digits from your email.';
      var fb = document.getElementById('wcRFallback');
      if (fb) fb.innerHTML = res.code ? '<div class="panel" style="padding:10px;margin:8px 0"><div class="tiny muted">Email delivery is not configured yet — your code is:</div><div class="center" style="font-size:22px;letter-spacing:6px;font-weight:800;color:var(--accent);margin-top:4px">' + esc(res.code) + '</div></div>' : '';
    }
    send.onclick = dispatchCode;
    var resend = document.getElementById('wcRResend');
    if (resend) resend.onclick = dispatchCode;
    var verify = document.getElementById('wcRVerify');
    if (verify) verify.onclick = async function () {
      var code = val('wcRCode');
      if (!/^\d{6}$/.test(code)) return err357('Enter the 6-digit code');
      var res = await api('/api/verify/email-check', { email: resetState.email, purpose: 'reset', code: code });
      if (!res.ok && resetState.fallback && code === resetState.fallback) res = { ok: true };
      if (!res.ok) return err357(res.message || 'Incorrect or expired code');
      resetState.verified = true; resetState.code = code;
      document.getElementById('wcRStepB').style.display = 'none';
      document.getElementById('wcRStepC').style.display = 'block';
      var s3 = document.getElementById('wcRStep3'); if (s3) s3.className = 'on';
      document.getElementById('wcRErr').style.display = 'none';
    };
    var confirm = document.getElementById('wcRConfirm');
    if (confirm) confirm.onclick = async function () {
      var uu = resetState.user;
      if (!uu) return err357('Start again — no account selected');
      var p1 = val('wcRPass'), p2 = val('wcRPass2');
      if (p1.length < 6) return err357('Password must be at least 6 characters');
      if (p1 !== p2) return err357('Passwords do not match');
      uu.pass = await hash357(p1);
      uu.passChangedAt = Date.now();
      uu.updatedAt = Date.now();
      uu.oldPass = undefined;
      save357(); backupNow();
      try { localStorage.removeItem('whalechat.v357.reset'); } catch (e) {}
      toast357('Password reset — sign in with your new password');
      go357('login');
    };
  }

  function patchForgot() {
    safe(function () { viewForgot = resetView; });
    safe(function () {
      App.forgot = function (e) {
        if (e && e.preventDefault) e.preventDefault();
        bindResetView();
      };
      App.forgot.__wc357 = true;
    });
    if (typeof window !== 'undefined') window.__wc357BindReset = bindResetView;
  }

  function ic357(n, s) {
    return safe(function () { return ic(n, s); }, '');
  }

  /* =====================================================================
     7 · Settings — transaction PIN (set / change / forgot)
     ===================================================================== */
  function patchSettings() {
    var base = safe(function () { return VIEWS.settings; }, null);
    if (typeof base !== 'function' || base.__wc357) return;
    VIEWS.settings = function () {
      var html = base.apply(this, arguments);
      var u = me357();
      if (!u) return html;
      var extra = '' +
        '<div class="card mt16" id="wc357PinCard">' +
          '<div class="between wrap gap10">' +
            '<div><h3 style="font-size:15px">Transaction PIN</h3>' +
              '<p class="tiny muted mt6">Your 4–6 digit PIN protects withdrawals, transfers and trades. Set it here — it is never asked for during account creation.</p></div>' +
            '<span class="badge ' + (u.pin ? 'badge-success' : 'badge-warn') + '">' + (u.pin ? 'PIN set' : 'Not set') + '</span>' +
          '</div>' +
          '<div class="row gap8 mt14 wrap">' +
            '<button class="btn btn-primary btn-sm" data-act="change-pin">' + ic357('key', 14) + ' ' + (u.pin ? 'Change transaction PIN' : 'Set transaction PIN') + '</button>' +
            '<button class="btn btn-ghost btn-sm" data-act="wc-forgot-pin">' + ic357('shield', 14) + ' Forgot PIN — reset by email</button>' +
          '</div>' +
          '<div class="tiny muted mt10">Forgot your PIN? We email a 6-digit code to ' + esc(u.email || 'your registered email') + ', then you choose a new PIN.</div>' +
        '</div>' +
        '<div class="card mt16" id="wc357VerifyCard">' +
          '<div class="between wrap gap10">' +
            '<div><h3 style="font-size:15px">Email verification</h3>' +
              '<p class="tiny muted mt6">' + (u.verified ? 'Your email is verified.' : 'Verify your email to unlock the full account badge and payment features.') + '</p></div>' +
            '<span class="badge ' + (u.verified ? 'badge-success' : 'badge-warn') + '">' + (u.verified ? 'Verified' : 'Unverified') + '</span>' +
          '</div>' +
          (u.verified ? '' : '<button class="btn btn-primary btn-sm mt14" data-act="wc-verify-email">' + ic357('mail', 14) + ' Send verification code</button>') +
        '</div>';
      if (html.indexOf('id="wc357PinCard"') < 0) html += extra;
      return html;
    };
    VIEWS.settings.__wc357 = true;
  }

  async function forgotPin() {
    var u = me357();
    if (!u) return;
    if (!navigator.onLine) return toast357('Connect to the internet to receive the reset code', 'err');
    var res = await api('/api/verify/email-code', { email: u.email, purpose: 'pin', name: u.fullName || u.username, userId: u.id });
    if (!res.ok) return toast357(res.message || 'Could not send the code', 'err');
    var out = await codeDialog({
      title: 'Reset transaction PIN',
      sub: 'We sent a 6-digit code to ' + u.email + '.',
      email: u.email, purpose: 'pin', fallbackCode: res.code || ''
    });
    if (!out || !out.ok) return;
    var np = await safe(function () { return askPin({ title: 'New transaction PIN', sub: 'Choose 4–6 digits you will remember', confirm: true }); }, null);
    if (!np) return;
    u.pin = await hash357('pin::' + np);
    u.updatedAt = Date.now();
    save357(); backupNow();
    toast357('Transaction PIN updated');
    safe(function () { render(); });
  }

  function bindActions() {
    if (window.__wc357Actions) return;
    window.__wc357Actions = true;
    document.addEventListener('click', function (e) {
      var el = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!el) return;
      var act = el.getAttribute('data-act');
      if (act === 'wc-forgot-pin') { e.preventDefault(); forgotPin(); }
      else if (act === 'wc-verify-email') { e.preventDefault(); window.wc357VerifyEmail(); }
    }, true);
  }

  /* =====================================================================
     8 · WC-Investing charts — green/red ROI line per plan
     ===================================================================== */
  function patchPlanCharts() {
    var P = safe(function () { return window.WC_INVEST; }, null);
    if (!P || P.__wc357chart) return;
    P.__wc357chart = true;

    function buildSvg(vals, opts) {
      var w = 320, h = Math.max(60, Number(opts.height) || 90);
      var padX = 4, padTop = 8, padBot = opts.labels === false ? 4 : 16;
      var pts = (vals || []).map(Number).filter(function (v) { return isFinite(v); });
      var preview = pts.length < 2;
      if (preview) {
        /* deterministic preview curve so an empty plan card is never blank */
        var seed = 0;
        var src = String(opts.uid || 'preview');
        for (var i = 0; i < src.length; i++) seed = (seed * 31 + src.charCodeAt(i)) % 100000;
        pts = [];
        var base = (Number(opts.base) || 0) || 100;
        for (var k = 0; k <= 30; k++) {
          var wave = Math.sin((k / 30) * Math.PI * 2.2 + (seed % 7)) * 0.35;
          var drift = k / 30 * 1.6;
          pts.push(base * (0.55 + drift + wave * (k / 30)));
        }
      }
      var min = Math.min.apply(null, pts), max = Math.max.apply(null, pts);
      var span = (max - min) || Math.abs(max) * 0.05 || 1;
      var bottom = h - padBot;
      var step = (w - padX * 2) / Math.max(1, pts.length - 1);
      var coords = pts.map(function (v, i) {
        return { x: padX + i * step, y: padTop + (1 - ((v - min) / span)) * (bottom - padTop), v: v };
      });
      var line = '', area = '';
      coords.forEach(function (p, i) {
        line += (i ? 'L' : 'M') + p.x.toFixed(1) + ' ' + p.y.toFixed(1) + ' ';
      });
      area = line + 'L' + coords[coords.length - 1].x.toFixed(1) + ' ' + bottom + ' L' + coords[0].x.toFixed(1) + ' ' + bottom + ' Z';
      var uid = 'wcg' + Math.random().toString(36).slice(2, 8);
      var segs = '';
      for (var s = 1; s < coords.length; s++) {
        var up = coords[s].v >= coords[s - 1].v;
        segs += '<line x1="' + coords[s - 1].x.toFixed(1) + '" y1="' + coords[s - 1].y.toFixed(1) +
          '" x2="' + coords[s].x.toFixed(1) + '" y2="' + coords[s].y.toFixed(1) +
          '" stroke="' + (up ? '#22c55e' : '#ef4444') + '" stroke-width="2" stroke-linecap="round"/>';
      }
      var grid = '';
      for (var g = 1; g <= 3; g++) {
        var gy = padTop + ((bottom - padTop) / 4) * g;
        grid += '<line x1="' + padX + '" y1="' + gy.toFixed(1) + '" x2="' + (w - padX) + '" y2="' + gy.toFixed(1) + '" stroke="rgba(255,255,255,.06)" stroke-width="1" stroke-dasharray="2 3"/>';
      }
      var labels = '';
      if (opts.labels !== false && h >= 70) {
        labels = '<div class="wci-roi-ticks"><span>20%</span><span>40%</span><span>60%</span><span>80%</span><span>100%</span></div>';
      }
      return '<span class="wc-roi-tag">' + (preview ? 'PREVIEW' : 'ROI') + '</span>' +
        '<svg viewBox="0 0 ' + w + ' ' + h + '" class="wci-chart" preserveAspectRatio="none" style="width:100%;height:' + h + 'px;display:block">' +
          '<defs><linearGradient id="' + uid + '" x1="0" y1="0" x2="0" y2="1">' +
            '<stop offset="0%" stop-color="#22c55e" stop-opacity=".30"/>' +
            '<stop offset="55%" stop-color="#22c55e" stop-opacity=".08"/>' +
            '<stop offset="100%" stop-color="#ef4444" stop-opacity="0"/>' +
          '</linearGradient></defs>' +
          grid +
          '<path d="' + area + '" fill="url(#' + uid + ')" stroke="none"/>' +
          segs +
        '</svg>' + labels;
    }

    P.chart = function (points, opts) {
      opts = opts || {};
      try { return buildSvg(points, opts); } catch (e) {
        return '<svg viewBox="0 0 320 90" class="wci-chart"><path d="M4 80 L80 60 L160 68 L240 34 L316 20" fill="none" stroke="#22c55e" stroke-width="2"/></svg>';
      }
    };

    /* the ROI page uses combinedSeries; keep an honest live series but make
       sure a brand-new account still sees the chart shell + preview */
    var baseCombined = P.combinedSeries;
    P.combinedSeries = function (steps) {
      var s = P.summary();
      if (!s.active.length) return [];
      return baseCombined.apply(P, arguments);
    };
  }

  /* =====================================================================
     9 · stock charts that work offline (TradingView-style, local data)
     ===================================================================== */
  function localSeries(t, tf) {
    var INV = safe(function () { return window.INV || INV; }, null);
    var out = [];
    safe(function () {
      var s = INV.series(t, tf || '1D') || [];
      out = s.slice(-90);
    });
    if (out.length < 2) {
      var q = safe(function () { return INV.quote(t); }, null);
      var base = Number(q && q.price) || 100;
      out = [];
      for (var i = 0; i < 60; i++) {
        out.push(base * (0.94 + Math.sin(i / 5) * 0.02 + (i / 60) * 0.06 + Math.sin(i / 2.3) * 0.004));
      }
    }
    return out;
  }

  function renderLocalChart(host, ticker) {
    var TC = safe(function () { return window.WC_TRADE_CHART; }, null);
    if (!host) return;
    var t = String(ticker || '').toUpperCase();
    var series = localSeries(t, '1D');
    var q = safe(function () { return INV.quote(t); }, null);
    var price = Number(q && q.price) || series[series.length - 1] || 0;
    var first = series[0] || price;
    var pct = first ? ((price - first) / first) * 100 : 0;
    host.innerHTML =
      '<div class="wc-localchart">' +
        '<div class="between" style="padding:6px 8px 2px;align-items:flex-start">' +
          '<div><div style="font-size:10px;letter-spacing:.08em;color:#8ba4b6;font-weight:800">' + esc(t) + ' · LOCAL PRICE ENGINE</div>' +
          '<div style="font-size:22px;font-weight:800;color:#e9f4f9">' + money(price) + '</div></div>' +
          '<div style="text-align:right"><div style="font-size:13px;font-weight:800;color:' + (pct >= 0 ? '#22c55e' : '#ef4444') + '">' +
            (pct >= 0 ? '+' : '−') + Math.abs(pct).toFixed(2) + '%</div>' +
          '<div style="font-size:9.5px;color:#8ba4b6">today · offline data</div></div>' +
        '</div>' +
        '<div class="wc-localchart-host"></div>' +
        '<div class="wc-localchart-note"><span>Green = price rising · red = price falling</span><span>Works without internet</span></div>' +
      '</div>';
    var chartHost = host.querySelector('.wc-localchart-host');
    if (TC && TC.mount) {
      var inst = TC.mount(chartHost, {
        symbol: t, points: series.map(function (v, i) { return { time: i, value: v }; }),
        height: 300, tabs: true, mode: 'line', baseline: 0
      });
      host.__wc357chart = inst;
    } else {
      chartHost.innerHTML = safe(function () { return INV.lineChart(series, { h: 260 }); }, '');
    }
    var timer = setInterval(function () {
      if (!document.body.contains(host)) { clearInterval(timer); return; }
      if (navigator.onLine) { clearInterval(timer); return; }
      var px = Number((safe(function () { return INV.quote(t); }, null) || {}).price) || price;
      var head = host.querySelector('div[style*="font-size:22px"]');
      if (head) head.textContent = money(px);
    }, 4000);
  }

  function patchTV() {
    var TV = safe(function () { return window.WC_TV; }, null);
    if (!TV || TV.__wc357) return;
    TV.__wc357 = true;
    var base = TV.mount;
    TV.mount = function (host, ticker, kind, exchange) {
      if (host && !navigator.onLine) {
        try { renderLocalChart(host, ticker); return; } catch (e) {}
      }
      return base.apply(TV, arguments);
    };
  }

  function patchAutoSellOnly() {
    var S = safe(function () { return window.WC_SUBS; }, null);
    if (!S || !S.autoFields || S.__wc357auto) return;
    S.__wc357auto = true;
    var base = S.autoFields;
    S.autoFields = function (ticker, al, sfx) {
      var html = base.apply(S, arguments);
      /* selling a holding only needs a sell target: make that explicit */
      return html
        .replace('to buy and sell ' + esc(ticker) + ' at these prices', 'to buy or sell ' + esc(ticker) + ' automatically')
        .replace('</div>', '<div class="tiny muted" style="margin-top:4px">Already holding ' + esc(ticker) + '? Leave the buy price empty, set only your sell target and tick this box — Auto Buy/Sell sells your units as soon as the market reaches the target.</div></div>');
    };
  }

  function repaintChartsForNetwork() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-wc-tv]'), function (host) {
      var t = host.getAttribute('data-wc-tv');
      if (!t) return;
      try {
        if (!navigator.onLine) renderLocalChart(host, t);
        else if (window.WC_TV) { host.innerHTML = ''; window.WC_TV.mount(host, t, host.getAttribute('data-wc-tv-kind')); }
      } catch (e) {}
    });
  }

  /* =====================================================================
     10 · keep local prices moving offline and persist them
     ===================================================================== */
  function patchOfflinePrices() {
    if (window.__wc357Prices) return;
    window.__wc357Prices = true;
    var lastSave = 0;
    setInterval(function () {
      var INV = safe(function () { return window.INV; }, null);
      if (!INV || !INV.quote || !navigator.onLine) return;
      /* online the server feed / tick loop owns the price; offline the local
         engine keeps the same catalogue moving so charts are never frozen */
    }, 6000);
    /* offline ticks: only when the app is offline, so online prices stay real */
    setInterval(function () {
      if (navigator.onLine) return;
      var INV = safe(function () { return window.INV; }, null);
      var db = db357();
      if (!INV || !db || !Array.isArray(db.stocks)) return;
      db.stocks.forEach(function (s) {
        if (!s || !s.ticker) return;
        var px = Number(s.price) || 1;
        var vol = (String(s.assetClass) === 'crypto' ? 0.004 : 0.0022);
        var next = Math.max(0.000001, px * (1 + (Math.random() - 0.48) * 2 * vol));
        s.prevClose = s.prevClose || px;
        s.price = Math.round(next * 1000000) / 1000000;
        if (INV.live) {
          var q = INV.live[s.ticker] || { prevClose: s.prevClose };
          q.price = s.price; q.updatedAt = Date.now();
          q.changePct = q.prevClose ? ((s.price - q.prevClose) / q.prevClose) * 100 : 0;
          q.dir = s.price >= px ? 1 : -1;
          INV.live[s.ticker] = q;
        }
      });
      if (Date.now() - lastSave > 25000) {
        lastSave = Date.now();
        safe(function () { persist(); });
        backupNow();
      }
      safe(function () { if (typeof INV.paint === 'function') INV.paint(); });
    }, 7000);
  }

  /* =====================================================================
     11 · small text / behaviour patches
     ===================================================================== */
  function renameText() {
    /* the investment account is now presented as stocks-trade on all cards */
    Array.prototype.forEach.call(document.querySelectorAll('.wallet-actions .btn'), function (b) {
      var t = (b.textContent || '').trim();
      if (/^investment\s*account$/i.test(t)) b.textContent = 'stocks-trade';
    });
  }

  /* buy buttons always land on the stock market page */
  function patchBuyLinks() {
    document.addEventListener('click', function (e) {
      var a = e.target.closest ? e.target.closest('a[href]') : null;
      if (!a) return;
      var href = a.getAttribute('href') || '';
      if (/^#\/(invest\/)?buy(\/|$|\?)/.test(href)) {
        e.preventDefault();
        go357('invest/market');
      }
    }, true);
  }

  /* =====================================================================
     12 · boot
     ===================================================================== */
  function ensureVerificationStep() {
    /* if the email-verification route is open, bind the reset UI if present */
    safe(function () {
      if (document.getElementById('wcRSend') && !document.getElementById('wcRSend').__bound) {
        document.getElementById('wcRSend').__bound = true;
        bindResetView();
      }
    });
  }

  function tick() {
    hideOfflineBanners();
    enhanceDashboard();
    renameText();
    ensureVerificationStep();
    safe(function () { window.__wc357BindReset && window.__wc357BindReset(); });
  }

  function boot() {
    installOfflineCSS();
    installDashboardCSS();
    patchGo();
    patchLogin();
    patchLogout();
    patchSignup();
    patchForgot();
    patchSettings();
    patchPlanCharts();
    patchTV();
    patchBuyLinks();
    patchAutoSellOnly();
    bindActions();
    patchOfflinePrices();
    restoreLocalBackup();
    mergeServerAccounts().then(function () { restoreLocalBackup(); });
    backupNow();

    var obs = new MutationObserver(function () {
      clearTimeout(obs.__t);
      obs.__t = setTimeout(tick, 120);
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });

    setInterval(tick, 2500);
    window.addEventListener('online', function () { hideOfflineBanners(); repaintChartsForNetwork(); backupNow(); });
    window.addEventListener('offline', function () { hideOfflineBanners(); repaintChartsForNetwork(); });
    window.addEventListener('beforeunload', backupNow);
    document.addEventListener('visibilitychange', function () { if (document.hidden) backupNow(); });
    setInterval(backupNow, 60000);
    tick();

    function ensureVerifyPanel() {
      try {
        var u = safe(function () { return me357(); }, null);
        var panel = document.getElementById('wc357VerifyPanel');
        if (!u || u.verified) { if (panel) panel.remove(); return; }
        if (panel || document.getElementById('wc357VerifyOverlay')) return;
        panel = document.createElement('div');
        panel.id = 'wc357VerifyPanel';
        panel.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;z-index:2147482000;background:#0b1d29;border:1px solid rgba(46,230,201,.35);border-radius:16px;padding:14px;color:#e9f4f9;box-shadow:0 18px 50px rgba(0,0,0,.55);max-width:520px;margin:0 auto';
        panel.innerHTML = '' +
          '<div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">' +
            '<div><b style="font-size:14px">Verify your email</b>' +
            '<div style="font-size:11px;color:#8ba4b6;line-height:1.45;margin-top:3px">Enter the 6-digit code sent to <b style="color:#e9f4f9">' + esc(u.email || '') + '</b>. Check spam if it is not there.</div></div>' +
            '<button type="button" data-vp-close style="background:transparent;border:0;color:#8ba4b6;font-size:18px;cursor:pointer">×</button>' +
          '</div>' +
          '<div style="display:flex;gap:8px;margin-top:10px">' +
            '<input id="wc357PanelCode" inputmode="numeric" maxlength="6" placeholder="000000" style="flex:1;min-width:0;text-align:center;font-size:18px;letter-spacing:7px;font-weight:800;padding:9px;border-radius:10px;border:1px solid rgba(255,255,255,.18);background:#04101a;color:#e9f4f9"/>' +
            '<button type="button" data-vp-verify style="background:#2ee6c9;color:#04101a;border:0;border-radius:10px;padding:0 14px;font-weight:800;cursor:pointer">Verify</button>' +
          '</div>' +
          '<div style="display:flex;justify-content:space-between;margin-top:8px;gap:8px">' +
            '<button type="button" data-vp-resend style="background:transparent;border:0;color:#2ee6c9;font-size:11px;font-weight:700;cursor:pointer;padding:0">Resend code</button>' +
            '<span id="wc357PanelMsg" style="font-size:11px;color:#8ba4b6"></span>' +
          '</div>';
        document.body.appendChild(panel);
        var msg = function (t, bad) { var el = document.getElementById('wc357PanelMsg'); if (el) { el.textContent = t; el.style.color = bad ? '#ff9aaa' : '#8ba4b6'; } };
        panel.querySelector('[data-vp-close]').onclick = function () { panel.remove(); };
        panel.querySelector('[data-vp-resend]').onclick = async function () {
          msg('Sending…');
          var res = await api('/api/verify/email-code', { email: u.email, purpose: 'signup', name: u.fullName || u.username, userId: u.id });
          if (!res.ok) return msg(res.message || 'Could not send the code', true);
          if (res.code) msg('Email is not configured — code: ' + res.code);
          else msg('A new code was sent to your email.');
        };
        panel.querySelector('[data-vp-verify]').onclick = async function () {
          var code = (document.getElementById('wc357PanelCode') || {}).value || '';
          if (!/^\d{6}$/.test(code.trim())) return msg('Enter the 6-digit code', true);
          msg('Checking…');
          var res = await api('/api/verify/email-check', { email: u.email, purpose: 'signup', code: code.trim() });
          if (!res.ok) return msg(res.message || 'Incorrect or expired code', true);
          u.verified = true; u.emailVerifiedAt = Date.now(); u.updatedAt = Date.now();
          save357(); backupNow();
          panel.remove();
          toast357('Email verified — welcome to your account');
          go357('profile');
        };
      } catch (e) { /* never break the app */ }
    }
    setInterval(ensureVerifyPanel, 1800);
    setTimeout(ensureVerifyPanel, 1200);

    /* expose a tiny status surface for diagnostics */
    window.WC_BUILD_357 = { version: VERSION, backupNow: backupNow, verify: startEmailVerification };
  }

  var tries = 0;
  (function waitForApp() {
    var ready = safe(function () { return typeof App !== 'undefined' && typeof VIEWS !== 'undefined' && typeof DB !== 'undefined' && DB; }, false);
    if (ready) { boot(); return; }
    if (tries++ > 120) { boot(); return; }
    setTimeout(waitForApp, 250);
  })();
})();
