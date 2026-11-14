/* =========================================================================
   WhaleChat session guard (module wc-session-guard)
   -------------------------------------------------------------------------
   Goals
   1. A user can sign up / sign in and use the app on ANY device with the link
      — no device registration, no local-only gate. If a login lands while the
      server database is still syncing, the form waits for the sync and retries
      instead of answering "no account found".
   2. An automatic refresh never interrupts what the user is doing: updates are
      held back while they are typing / a form is open, and every field, tick
      box, scroll position and route is snapshotted continuously and restored
      after ANY reload (update, admin force refresh, crash, offline bounce).
   3. The app stays responsive: keep-alive pings, an SSE watchdog, a session
      backup so a sync race cannot log the user out, and a fast draft restore.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  if (window.WC_SESSION_GUARD) return;

  const DRAFT_KEY = 'wc_draft_v1';
  const SESSION_BACKUP = 'wc_session_backup_v1';
  const BUSY_MS = 9000;          /* treat the user as busy this long after input */
  const IDLE_APPLY_MS = 15000;   /* how often a deferred update re-checks for idle */

  const G = window.WC_SESSION_GUARD = {
    version: '1.0.0',
    busyUntil: 0,
    dirty: new Set(),
    pendingAuto: false,
    deferred: 0,
    restored: 0,
    started: Date.now()
  };

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.prototype.slice.call(document.querySelectorAll(s));

  /* ------------------------------------------------------------ busy state */
  G.markBusy = function (ms) { G.busyUntil = Math.max(G.busyUntil, Date.now() + (ms || BUSY_MS)); };

  G.isBusy = function () {
    if (Date.now() < G.busyUntil) return true;
    const ae = document.activeElement;
    if (ae) {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return true;
      if (ae.isContentEditable) return true;
    }
    /* a modal is open: let them finish, the sheet would cover it */
    if ($('.modal')) return true;
    return false;
  };

  /* --------------------------------------------------------- draft snapshots */
  function fieldKey(el) {
    if (el.id) return '#' + el.id;
    const form = el.form;
    const name = el.getAttribute('name');
    if (form && name) return '#' + (form.id || 'form') + '[name="' + name + '"]';
    return null;
  }

  function captureFields() {
    const fields = {};
    $$('input, textarea, select').forEach((el) => {
      const k = fieldKey(el);
      if (!k) return;
      const type = (el.type || '').toLowerCase();
      if (type === 'password' || type === 'hidden' || type === 'file') return;
      if (type === 'checkbox' || type === 'radio') { fields[k] = { v: el.checked ? 1 : 0, t: 'c' }; return; }
      if (!el.value) return;
      fields[k] = { v: el.value, t: 'v' };
    });
    return fields;
  }

  function saveDraft(force) {
    try {
      const fields = captureFields();
      if (!Object.keys(fields).length && !force) return;
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify({
        route: location.hash || '#/',
        fields,
        scrollY: window.scrollY || 0,
        at: Date.now()
      }));
    } catch (e) {}
  }

  function restoreDraft() {
    let d = null;
    try { d = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || 'null'); } catch (e) { d = null; }
    if (!d) return;
    const route = d.route || '#/';
    const here = location.hash || '#/';
    /* restore the route-independent field values only on the same screen */
    if (route.split('?')[0] !== here.split('?')[0]) return;
    let restored = 0;
    Object.keys(d.fields || {}).forEach((k) => {
      let el = null;
      try { el = $(k); } catch (e) { el = null; }
      if (!el) return;
      const f = d.fields[k];
      if (f.t === 'c') { el.checked = !!f.v; }
      else if (el.value !== f.v) { el.value = f.v; }
      try {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } catch (e) {}
      restored++;
    });
    G.restored += restored;
    if (restored) {
      try { window.scrollTo(0, Number(d.scrollY) || 0); } catch (e) {}
      /* the app may re-render over the restored values — repeat once shortly after */
      setTimeout(() => {
        Object.keys(d.fields || {}).forEach((k) => {
          let el = null;
          try { el = $(k); } catch (e) { el = null; }
          if (!el) return;
          const f = d.fields[k];
          if (f.t === 'c') el.checked = !!f.v;
          else if (el.value !== f.v) el.value = f.v;
        });
      }, 700);
    }
  }

  /* ------------------------------------------------------------------ events */
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (!t) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable) {
      G.markBusy();
      const k = fieldKey(t);
      if (k) G.dirty.add(k);
      clearTimeout(saveDraft._t);
      saveDraft._t = setTimeout(() => saveDraft(), 220);
    }
  }, true);

  document.addEventListener('focusin', (e) => {
    const t = e.target;
    if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) G.markBusy();
  }, true);

  document.addEventListener('focusout', () => {
    setTimeout(() => {
      const ae = document.activeElement;
      const stillTyping = ae && (/^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) || ae.isContentEditable);
      if (!stillTyping) G.busyUntil = Math.min(G.busyUntil, Date.now() + 1200);
    }, 60);
  }, true);

  document.addEventListener('change', () => saveDraft(), true);
  window.addEventListener('scroll', () => { clearTimeout(saveDraft._s); saveDraft._s = setTimeout(() => saveDraft(), 400); }, { passive: true });
  window.addEventListener('beforeunload', () => saveDraft(true));
  window.addEventListener('pagehide', () => saveDraft(true));

  /* form submits end the "dirty" window so a following render is not held up */
  document.addEventListener('submit', (e) => {
    const id = e.target && e.target.id;
    if (id === 'loginForm' || id === 'signupForm') return;   /* handled below */
    G.dirty.clear();
    saveDraft(true);
  }, true);

  /* -------------------------------------------------------------- auth retry
     A brand-new device can submit the login form before /api/state has landed.
     Wait for the sync, then let the real handler run once. */
  let syncingForm = false;
  function isStaleAuth() {
    if (typeof Remote === 'undefined' || !Remote || !Remote.enabled) return false;
    if (Remote.status !== 'online') return true;
    return !!(G._lastSync && Date.now() - G._lastSync > 60000);
  }

  document.addEventListener('submit', async (e) => {
    const form = e.target;
    if (!form || (form.id !== 'loginForm' && form.id !== 'signupForm')) return;
    if (form.__wcRetried || syncingForm) return;
    if (!isStaleAuth()) { G._lastSync = Date.now(); return; }
    e.preventDefault();
    e.stopImmediatePropagation();
    syncingForm = true;
    const btn = form.querySelector('button[type=submit]');
    const label = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Syncing your account…'; }
    try { await Remote.refresh(true); } catch (err) {}
    G._lastSync = Date.now();
    syncingForm = false;
    if (btn) { btn.disabled = false; btn.innerHTML = label; }
    form.__wcRetried = true;
    saveDraft(true);
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    setTimeout(() => { try { form.__wcRetried = false; } catch (err) {} }, 4000);
  }, true);

  /* ------------------------------------------------- non-disruptive updates */
  function wrapUpdateFlow() {
    if (typeof window.applyUpdate !== 'function') return false;
    if (window.applyUpdate.__wcGuarded) return true;

    const realApply = window.applyUpdate;
    const realPrompt = window.showUpdatePrompt;

    window.applyUpdate = function () {
      if (G.isBusy()) {
        G.deferred++;
        saveDraft(true);
        try { if (typeof toast === 'function') toast('Update ready — it will install when you are done', 'ok'); } catch (e) {}
        G.pendingAuto = true;
        return;
      }
      saveDraft(true);
      try { return realApply.apply(this, arguments); } catch (e) {}
    };
    window.applyUpdate.__wcGuarded = true;

    if (typeof realPrompt === 'function') {
      window.showUpdatePrompt = function (v, opts) {
        const wantsAuto = !!(opts && opts.auto);
        G.pendingVersion = (v && v.version) || G.pendingVersion;
        if (G.isBusy()) {
          /* an update is ready, but the sheet would cover what they are doing:
             leave a small pill instead and open the sheet once the screen is idle */
          G.pendingPrompt = v;
          G.pendingAuto = G.pendingAuto || wantsAuto;
          showUpdatePill(G.pendingVersion);
          if (wantsAuto) scheduleIdleApply();
          return false;
        }
        const out = realPrompt.call(this, v, Object.assign({}, opts, { auto: false }));
        if (wantsAuto) { G.pendingAuto = true; scheduleIdleApply(); }
        return out;
      };
      window.showUpdatePrompt.__wcGuarded = true;
    }
    return true;
  }

  function showUpdatePill(version) {
    if (document.getElementById('wcUpdatePill')) return;
    const pill = document.createElement('button');
    pill.id = 'wcUpdatePill';
    pill.type = 'button';
    pill.innerHTML = '&#8635; Update ready' + (version ? ' · ' + version : '');
    pill.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:9998;display:flex;align-items:center;gap:6px;' +
      'padding:9px 13px;border-radius:999px;border:1px solid rgba(46,230,201,.35);background:rgba(10,26,32,.94);' +
      'color:#2ee6c9;font:600 12px Inter,-apple-system,Segoe UI,Roboto,sans-serif;cursor:pointer;' +
      'box-shadow:0 10px 24px rgba(0,0,0,.35);backdrop-filter:blur(8px)';
    pill.onclick = () => {
      pill.remove();
      if (!G.pendingPrompt) return;
      const v = G.pendingPrompt;
      G.pendingPrompt = null;
      try { if (typeof window.showUpdatePrompt === 'function') window.showUpdatePrompt(v, { auto: false }); } catch (e) {}
    };
    document.body.appendChild(pill);
    setTimeout(() => { const p = document.getElementById('wcUpdatePill'); if (p) p.style.opacity = '0.85'; }, 6000);
  }

  let idleTimer = null;
  function scheduleIdleApply() {
    if (idleTimer) return;
    idleTimer = setInterval(() => {
      if (!G.pendingAuto) { clearInterval(idleTimer); idleTimer = null; return; }
      /* never reload while the tab is hidden mid-typing unless it is truly idle */
      if (G.isBusy()) return;
      const inAuth = /^#\/(login|signup|forgot|reset|set-pin)/.test(location.hash || '');
      if (inAuth && !document.hidden) return;   /* never reload mid-sign-up */
      if (G.pendingPrompt) {
        const pill = document.getElementById('wcUpdatePill');
        if (pill) pill.remove();
      }
      saveDraft(true);
      G.pendingAuto = false;
      clearInterval(idleTimer); idleTimer = null;
      try { if (typeof applyUpdate === 'function') applyUpdate(); } catch (e) {}
    }, IDLE_APPLY_MS);
  }

  /* --------------------------------------------------------- session backup
     Never lose a signed-in session because a sync raced the boot. */
  function backupSession() {
    try {
      const s = localStorage.getItem('whalechat.session.v1');
      if (s && s !== 'null') sessionStorage.setItem(SESSION_BACKUP, s);
    } catch (e) {}
  }

  function restoreSession() {
    let backup = null, live = null;
    try { backup = JSON.parse(sessionStorage.getItem(SESSION_BACKUP) || 'null'); } catch (e) {}
    try { live = JSON.parse(localStorage.getItem('whalechat.session.v1') || 'null'); } catch (e) {}
    if (live || !backup || !backup.userId) return false;
    if (typeof DB === 'undefined' || !DB || !Array.isArray(DB.users)) return false;
    if (!DB.users.some((u) => u.id === backup.userId)) return false;
    try {
      localStorage.setItem('whalechat.session.v1', JSON.stringify(backup));
      if (typeof SESSION !== 'undefined') { try { /* eslint-disable no-global-assign */ SESSION = backup; } catch (e) {} }
      if (typeof render === 'function') render();
      return true;
    } catch (e) { return false; }
  }

  /* --------------------------------------------------------------- keep alive */
  let lastPing = 0;
  async function keepAlive() {
    if (document.hidden) return;
    if (Date.now() - lastPing < 40000) return;
    lastPing = Date.now();
    try {
      const r = await fetch((location.origin || '') + '/api/health', { cache: 'no-store' });
      if (!r.ok) throw new Error('health ' + r.status);
      G.online = true;
    } catch (e) {
      G.online = false;
      if (typeof Remote !== 'undefined' && Remote && Remote.enabled && Remote.status === 'offline') {
        try { Remote.refresh(true); } catch (err) {}
      }
    }
  }

  /* --------------------------------------------------------------- bootstrap */
  function boot() {
    backupSession();
    restoreSession();
    saveDraft._started = true;

    /* restore whatever was on screen before the reload */
    restoreDraft();
    setTimeout(restoreDraft, 350);
    setTimeout(restoreDraft, 1200);

    if (!wrapUpdateFlow()) {
      let tries = 0;
      const t = setInterval(() => {
        tries++;
        if (wrapUpdateFlow() || tries > 40) clearInterval(t);
      }, 250);
    }

    /* session restore attempts while the first sync settles */
    let n = 0;
    const s = setInterval(() => {
      n++;
      restoreSession();
      if (n > 24) clearInterval(s);
    }, 750);

    setInterval(keepAlive, 15000);
    keepAlive();
    setInterval(() => {
      if (typeof Remote !== 'undefined' && Remote && Remote.enabled && Remote.status === 'offline') {
        try { Remote.refresh(true); } catch (e) {}
      }
    }, 45000);

    window.addEventListener('hashchange', () => { G.dirty.clear(); setTimeout(restoreDraft, 400); });
    setInterval(backupSession, 20000);
  }

  G.saveDraft = saveDraft;
  G.restoreDraft = restoreDraft;
  G.keepAlive = keepAlive;
  G.restoreSession = restoreSession;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 60));
  else setTimeout(boot, 60);
})();
