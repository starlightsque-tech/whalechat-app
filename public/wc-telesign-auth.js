/* =========================================================================
   WhaleChat · Telesign SMS OTP for signup & login (wc-telesign-auth)
   -------------------------------------------------------------------------
   The app never holds a Telesign credential. It calls our own endpoints,
   which the sync server / Appwrite function sign with HTTP Basic auth:

     POST /api/telesign/start   { phone, purpose }  → { referenceId, expiresInMs }
     POST /api/telesign/verify  { phone, code }     → { verified, status }
     GET  /api/telesign/status                      → { configured }

   Behaviour
     · Telesign not configured  → the module stays completely invisible and the
       existing password signup/login is untouched.
     · configured + signup      → the phone field gains a "Send code" control
       and the account cannot be created until the number is verified.
     · configured + login       → a "Sign in with SMS code" option appears, so
       a user can sign in with their registered phone and a 6-digit code.

   Codes are never stored in the app; the verified state is kept in memory for
   the current page (and tied to the exact phone string) for 15 minutes.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.WC_OTP) return;

  var state = { configured: false, checked: false, verifiedPhone: '', verifiedAt: 0, phone: '', referenceId: '', busy: false, providerOk: false };
  var VERIFY_TTL = 15 * 60 * 1000;

  function api(p) {
    try { return window.WC_SERVERS ? WC_SERVERS.api(p) : p; } catch (e) { return p; }
  }
  function post(p, body) {
    return fetch(api(p), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, json: j || {} }; }).catch(function () { return { ok: r.ok, json: {} }; }); })
      .catch(function () { return { ok: false, json: { error: 'network' } }; });
  }
  function toastSafe(msg, kind) { try { if (typeof toast === 'function') return toast(msg, kind || 'ok'); } catch (e) {} }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function digits(s) { return String(s || '').replace(/\D/g, ''); }

  function check() {
    if (state.checked) return Promise.resolve(state.configured);
    return fetch(api('/api/telesign/status'), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        state.configured = !!(j && j.configured);
        state.checked = true;
        try { document.documentElement.setAttribute('data-otp', state.configured ? 'on' : 'off'); } catch (e) {}
        return state.configured;
      })
      .catch(function () { state.configured = false; state.checked = true; return false; });
  }

  function isVerified(phone) {
    return state.verifiedPhone === digits(phone) && state.verifiedPhone !== '' && (Date.now() - state.verifiedAt) < VERIFY_TTL;
  }

  function card(phone, purpose) {
    return '' +
      '<div class="panel" id="wcOtpCard" style="padding:12px 14px;margin:8px 0 14px;border:1px solid rgba(46,230,201,.35)">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px">' +
          '<b style="font-size:12px;letter-spacing:.02em">Verify your phone</b>' +
          '<span style="font-size:10px;font-weight:800;color:#2ee6c9">SMS · Telesign</span>' +
        '</div>' +
        '<div style="font-size:11.5px;opacity:.75;margin:6px 0 10px">We text a 6-digit code to the number above. It expires in 5 minutes.</div>' +
        '<div style="display:flex;gap:8px">' +
          '<input class="input" id="wcOtpCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" style="flex:1;letter-spacing:6px;font-weight:800;text-align:center" />' +
          '<button type="button" class="btn btn-primary" id="wcOtpSend" style="white-space:nowrap">Send code</button>' +
        '</div>' +
        '<div id="wcOtpMsg" style="font-size:11px;margin-top:8px;min-height:14px"></div>' +
        '<input type="hidden" id="wcOtpPhone" value="' + esc(phone) + '" />' +
        '<input type="hidden" id="wcOtpPurpose" value="' + esc(purpose) + '" />' +
      '</div>';
  }

  function msg(text, kind) {
    var el = document.getElementById('wcOtpMsg');
    if (!el) return;
    el.textContent = text || '';
    el.style.color = kind === 'err' ? '#ff5c6e' : kind === 'ok' ? '#2ee6c9' : 'rgba(255,255,255,.6)';
  }

  function wireCard() {
    var send = document.getElementById('wcOtpSend');
    var codeEl = document.getElementById('wcOtpCode');
    if (!send || !codeEl || send.__wcWired) return;
    send.__wcWired = true;
    send.addEventListener('click', function (e) {
      e.preventDefault();
      var phone = (document.getElementById('wcOtpPhone') || {}).value || (document.getElementById('suPhone') || {}).value || '';
      if (digits(phone).length < 8) { msg('Enter a valid phone number first', 'err'); return; }
      state.phone = digits(phone);
      send.disabled = true;
      msg('Sending…');
      post('/api/telesign/start', { phone: phone, purpose: 'signup' }).then(function (out) {
        send.disabled = false;
        if (!out.ok || !out.json.ok) {
          var err = out.json.error || 'send_failed';
          if (err === 'code_already_sent') msg('A code was just sent — wait a minute and retry', 'err');
          else if (out.json.message) msg(out.json.message + (out.json.trial ? ' — verify this number in your Telesign account first.' : ''), 'err');
          else msg('Could not send the code (' + err + ')', 'err');
          /* the SMS provider refused: never lock the user out of signup */
          msg((out.json.message || 'SMS unavailable right now') + ' — you can still create the account; your phone will stay unverified.', 'err');
          return;
        }
        state.referenceId = out.json.referenceId || '';
        state.providerOk = true;
        send.textContent = 'Resend';
        msg('Code sent to ' + (out.json.phone || phone) + '. Enter it below.');
        codeEl.focus();
      });
    });
    codeEl.addEventListener('input', function () {
      codeEl.value = codeEl.value.replace(/\D/g, '').slice(0, 6);
      if (codeEl.value.length === 6) verifyNow();
    });
    function verifyNow() {
      var phone = (document.getElementById('wcOtpPhone') || {}).value || '';
      var code = codeEl.value;
      if (code.length !== 6) { msg('Enter the 6-digit code', 'err'); return; }
      msg('Checking…');
      post('/api/telesign/verify', { phone: phone, code: code, referenceId: state.referenceId }).then(function (out) {
        if (out.json && out.json.verified) {
          state.verifiedPhone = digits(phone);
          state.verifiedAt = Date.now();
          document.getElementById('wcOtpCard').style.borderColor = 'rgba(46,230,201,.75)';
          msg('Phone verified ✓', 'ok');
          codeEl.disabled = true;
          var btn = document.getElementById('wcOtpSend');
          if (btn) { btn.textContent = 'Verified'; btn.disabled = true; }
          toastSafe('Phone number verified');
        } else if (out.json && out.json.status === 'TOO_MANY_ATTEMPTS') {
          msg('Too many attempts — request a new code', 'err');
        } else {
          msg('Incorrect code' + (out.json && out.json.attemptsLeft != null ? ' · ' + out.json.attemptsLeft + ' tries left' : ''), 'err');
        }
      });
    }
  }

  /* ------------------------------------------------------------- signup UI */
  function enhanceSignup() {
    var phone = document.getElementById('suPhone');
    if (!phone || document.getElementById('wcOtpCard')) return;
    var anchor = phone.closest('.field') || phone.parentElement;
    if (!anchor) return;
    anchor.insertAdjacentHTML('afterend', card(phone.value || '', 'signup'));
    wireCard();
    phone.addEventListener('change', function () {
      var hidden = document.getElementById('wcOtpPhone');
      if (hidden) hidden.value = phone.value;
      if (state.verifiedPhone && !isVerified(phone.value)) {
        var el = document.getElementById('wcOtpCard');
        if (el) { el.style.borderColor = 'rgba(46,230,201,.35)'; }
        msg('Phone changed — verify the new number', 'err');
      }
    });
  }

  /* -------------------------------------------------------------- login UI */
  function enhanceLogin() {
    if (document.getElementById('wcOtpLogin')) return;
    var form = document.getElementById('loginForm');
    if (!form) return;
    var foot = form.querySelector('button[type="submit"]');
    var block = document.createElement('div');
    block.id = 'wcOtpLogin';
    block.style.cssText = 'margin-top:14px';
    block.innerHTML =
      '<button type="button" class="btn btn-block" id="wcOtpToggle" style="font-weight:700">Sign in with SMS code</button>' +
      '<div id="wcOtpLoginPanel" style="display:none;margin-top:10px">' +
        '<input class="input" id="wcOtpLoginPhone" type="tel" autocomplete="tel" placeholder="Registered phone, e.g. +1 555 000 0000" style="margin-bottom:8px" />' +
        '<div style="display:flex;gap:8px">' +
          '<input class="input" id="wcOtpLoginCode" inputmode="numeric" maxlength="6" placeholder="000000" style="flex:1;letter-spacing:6px;font-weight:800;text-align:center" />' +
          '<button type="button" class="btn btn-primary" id="wcOtpLoginSend" style="white-space:nowrap">Send code</button>' +
        '</div>' +
        '<div id="wcOtpLoginMsg" style="font-size:11px;margin-top:8px;min-height:14px"></div>' +
      '</div>';
    if (foot && foot.parentNode) foot.parentNode.insertBefore(block, foot.nextSibling);
    else form.appendChild(block);

    document.getElementById('wcOtpToggle').addEventListener('click', function () {
      var panel = document.getElementById('wcOtpLoginPanel');
      panel.style.display = panel.style.display === 'none' ? '' : 'none';
    });

    function loginMsg(t, kind) {
      var el = document.getElementById('wcOtpLoginMsg');
      el.textContent = t || '';
      el.style.color = kind === 'err' ? '#ff5c6e' : kind === 'ok' ? '#2ee6c9' : 'rgba(255,255,255,.6)';
    }

    document.getElementById('wcOtpLoginSend').addEventListener('click', function () {
      var phone = document.getElementById('wcOtpLoginPhone').value.trim();
      if (digits(phone).length < 8) { loginMsg('Enter your registered phone number', 'err'); return; }
      var btn = this;
      btn.disabled = true;
      loginMsg('Sending…');
      post('/api/telesign/start', { phone: phone, purpose: 'login' }).then(function (out) {
        btn.disabled = false;
        if (!out.ok || !out.json.ok) {
          var why = (out.json && out.json.message) || ((out.json && out.json.error) || 'error');
          if (out.json && out.json.trial) why += ' — verify this number in your Telesign account first.';
          loginMsg(why, 'err');
          return;
        }
        state.referenceId = out.json.referenceId || '';
        state.phone = digits(phone);
        loginMsg('Code sent. Enter the 6 digits.');
        document.getElementById('wcOtpLoginCode').focus();
      });
    });

    document.getElementById('wcOtpLoginCode').addEventListener('input', function () {
      var el = this;
      el.value = el.value.replace(/\D/g, '').slice(0, 6);
      if (el.value.length !== 6) return;
      var phone = document.getElementById('wcOtpLoginPhone').value.trim();
      loginMsg('Checking…');
      post('/api/telesign/verify', { phone: phone, code: el.value, referenceId: state.referenceId }).then(function (out) {
        if (!out.json || !out.json.verified) {
          loginMsg('Incorrect or expired code', 'err');
          el.value = '';
          return;
        }
        /* find the account by phone and open the same session App.login opens */
        var user = null;
        try {
          var users = (typeof DB !== 'undefined' && DB.users) || [];
          user = users.filter(function (u) { return u && digits(u.phone) && digits(u.phone) === digits(phone); })[0] || null;
        } catch (e) {}
        if (!user) { loginMsg('No WhaleChat account uses that phone number', 'err'); return; }
        if (user.banned) { loginMsg('This account is suspended. Contact support.', 'err'); return; }
        try {
          SESSION = { userId: user.id, at: Date.now() };
          localStorage.setItem(LS_SESSION, JSON.stringify(SESSION));
          persist(true);
        } catch (e) { loginMsg('Could not start the session', 'err'); return; }
        loginMsg('Signed in ✓', 'ok');
        toastSafe('Welcome back, ' + String(user.fullName || user.username || '').split(' ')[0]);
        try {
          if (user.role === 'admin') go('admin');
          else if (!user.pin) go('set-pin');
          else go('home');
        } catch (e) { location.hash = '#/home'; }
      });
    });
  }

  /* --------------------------------------------------------------- guards */
  function installGuards() {
    if (window.__wcOtpGuards) return;
    window.__wcOtpGuards = true;

    if (typeof App !== 'undefined' && App && typeof App.signup === 'function') {
      var originalSignup = App.signup.bind(App);
      App.signup = function () {
        if (!state.configured) return originalSignup();
        var phoneEl = document.getElementById('suPhone');
        var phone = phoneEl ? phoneEl.value : '';
        /* if Telesign itself is refusing (trial account, unverified number,
           outage) the account is created unverified rather than blocked */
        if (state.providerOk && !isVerified(phone)) {
          try { if (typeof formError === 'function' && phoneEl) formError('suPhone', 'Verify this phone number with the SMS code first'); } catch (e) {}
          msg('Enter the code we sent to your phone', 'err');
          var code = document.getElementById('wcOtpCode');
          if (code) code.focus();
          toastSafe('Verify your phone number to create the account', 'warn');
          return Promise.resolve(false);
        }
        var wasVerified = isVerified(phone);
        return Promise.resolve(originalSignup()).then(function (out) {
          if (!wasVerified) return out;
          /* stamp the verification on the account the signup just created */
          try {
            var users = (typeof DB !== 'undefined' && DB.users) || [];
            var me = (typeof SESSION !== 'undefined' && SESSION) ? users.filter(function (u) { return u && u.id === SESSION.userId; })[0] : null;
            if (me) { me.phoneVerified = true; me.phoneVerifiedAt = Date.now(); if (typeof persist === 'function') persist(true); }
          } catch (e) {}
          return out;
        });
      };
    }

    /* keep the UI injected as the router swaps views */
    setInterval(function () {
      if (!state.configured) return;
      if (location.hash.indexOf('/signup') >= 0) enhanceSignup();
      if (location.hash.indexOf('/login') >= 0) enhanceLogin();
    }, 700);
  }

  window.WC_OTP = {
    check: check,
    configured: function () { return state.configured; },
    isVerified: isVerified,
    request: function (phone, purpose) { return post('/api/telesign/start', { phone: phone, purpose: purpose }); },
    verify: function (phone, code) { return post('/api/telesign/verify', { phone: phone, code: code }); }
  };

  function boot() {
    check().then(function (on) {
      if (on) installGuards();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
