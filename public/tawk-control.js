
/* =========================================================================
   Live chat (Tawk.to) — admin on/off switch + placement that never covers
   the bottom navigation, the profile button or any other control.
   The embed is stripped at build time; this module loads it only when on.
   ========================================================================= */
'use strict';

const WC_TAWK = {
  DEFAULTS: { enabled: true, propertyId: '6af412c51859cf3c3d81d341', widgetId: '1k74milq6' },
  loaded: false,
  styleId: 'wc-tawk-style',

  cfg() {
    if (!DB || !DB.settings) return Object.assign({}, this.DEFAULTS);
    if (!DB.settings.liveChat) DB.settings.liveChat = Object.assign({}, this.DEFAULTS);
    return Object.assign(this.DEFAULTS, DB.settings.liveChat);
  },
  enabled() { return !!this.cfg().enabled; },

  css() {
    if (document.getElementById(this.styleId)) return;
    const st = document.createElement('style');
    st.id = this.styleId;
    /* Tawk places its bubble 20px from the bottom edge, which sits on top of the
       app's 70px bottom bar. Lift it clear of the nav and of any sticky action
       bar, and keep it under the app's modals (z-index 1000) so dialogs win. */
    st.textContent = `
      #tawk-bubble-container{
        bottom:calc(env(safe-area-inset-bottom,0px) + 86px) !important;
        right:14px !important; z-index:900 !important;
      }
      #tawkchat-container,#tawkchat-minified-container{
        bottom:calc(env(safe-area-inset-bottom,0px) + 86px) !important;
        right:12px !important; z-index:901 !important;
        height:min(68vh,560px) !important; max-height:calc(100vh - 190px) !important;
      }
      @media(min-width:1024px){
        #tawk-bubble-container{bottom:24px !important;right:24px !important;}
        #tawkchat-container,#tawkchat-minified-container{bottom:24px !important;right:24px !important;height:min(72vh,640px) !important;}
      }
      html.wc-tawk-off #tawk-bubble-container,
      html.wc-tawk-off #tawkchat-container,
      html.wc-tawk-off #tawkchat-minified-container{display:none !important;}
      /* never let the widget sit over the mobile nav / chat composer */
      body.chat-open #tawk-bubble-container{bottom:calc(env(safe-area-inset-bottom,0px) + 86px) !important;}
    `;
    document.head.appendChild(st);
  },

  load() {
    if (this.loaded) return;
    this.loaded = true;
    const c = this.cfg();
    window.Tawk_API = window.Tawk_API || {};
    window.Tawk_LoadStart = new Date();
    /* positioning must be declared before the widget boots */
    try {
      window.Tawk_API.customStyle = {
        zIndex: 900,
        visibility: {
          desktop: { position: 'br', xOffset: 24, yOffset: 24 },
          mobile: { position: 'br', xOffset: 14, yOffset: 90 }
        }
      };
    } catch (e) {}
    const s = document.createElement('script');
    s.async = true;
    s.src = 'https://embed.tawk.to/' + c.propertyId + '/' + c.widgetId;
    s.charset = 'UTF-8';
    s.setAttribute('crossorigin', '*');
    s.id = 'wc-tawk-embed';
    document.head.appendChild(s);
  },

  apply() {
    this.css();
    const on = this.enabled();
    document.documentElement.classList.toggle('wc-tawk-off', !on);
    if (on) {
      this.load();
      try { window.Tawk_API && window.Tawk_API.showWidget && window.Tawk_API.showWidget(); } catch (e) {}
    } else {
      try { window.Tawk_API && window.Tawk_API.hideWidget && window.Tawk_API.hideWidget(); } catch (e) {}
      const host = document.getElementById('wc-tawk-embed');
      if (host) { /* stop re-injection after a reload while off */ host.remove(); this.loaded = false; }
    }
  },

  watch() {
    if (this._watching) return;
    this._watching = true;
    let last = this.enabled();
    /* an admin can flip this from another device: follow the setting live */
    setInterval(() => {
      let now = last;
      try { now = this.enabled(); } catch (e) { return; }
      if (now !== last) { last = now; this.apply(); }
    }, 4000);
  },

  boot() {
    if (!DB) return false;
    this.apply();
    this.watch();
    const u = me();
    if (u && window.Tawk_API) {
      try { window.Tawk_API.visitor = { name: u.fullName || u.username, email: u.email }; } catch (e) {}
    }
    return true;
  }
};

/* keep the existing in-app "Live chat" entry point honest */
const _openLiveChat = App.openLiveChat;
App.openLiveChat = function () {
  if (!WC_TAWK.enabled() || !WC_TAWK.loaded) {
    toast('Live chat is currently switched off', 'err');
    return App.liveChatHelp ? App.liveChatHelp(true) : undefined;
  }
  return _openLiveChat.apply(this, arguments);
};

/* ---------------- admin screen ---------------- */
App.tawkToggle = function () {
  const c = WC_TAWK.cfg();
  c.enabled = !c.enabled;
  if (DB.settings) DB.settings.liveChat = c;
  try { sync(); } catch (e) {}
  try { persist(); } catch (e) {}
  WC_TAWK.apply();
  toast('Live chat ' + (c.enabled ? 'enabled — the chat bubble is now visible' : 'disabled — the chat bubble is hidden'), 'ok');
  render();
};

App.tawkSave = function () {
  const p = (document.getElementById('twProperty') || {}).value || '';
  const w = (document.getElementById('twWidget') || {}).value || '';
  if (!/^[a-z0-9]{10,}$/i.test(p) || !/^[a-z0-9]{6,}$/i.test(w)) return toast('Enter a valid Tawk property and widget id', 'err');
  const c = WC_TAWK.cfg();
  c.propertyId = p.trim(); c.widgetId = w.trim();
  DB.settings.liveChat = c;
  try { sync(); } catch (e) {}
  try { persist(); } catch (e) {}
  /* reload the widget with the new ids */
  const host = document.getElementById('wc-tawk-embed');
  if (host) { host.remove(); WC_TAWK.loaded = false; }
  WC_TAWK.apply();
  toast('Widget details saved', 'ok');
  render();
};

function tawkAdminView() {
  const c = WC_TAWK.cfg();
  const on = !!c.enabled;
  const live = !!document.getElementById('wc-tawk-embed');
  const tabs = `<div class="admin-nav">${ADMIN_NAV.map(n => {
    const key = n.href.replace('#/admin', '') || '';
    return `<a href="${n.href}" class="${key === '/livechat' ? 'on' : ''}">${n.label}</a>`;
  }).join('')}</div>`;
  return `${tabs}
  <div class="page-head"><div><div class="section-title" style="margin:0">Live chat</div>
    <div class="tiny muted">Control the Tawk.to chat bubble for every user</div></div></div>

  <div class="card">
    <div class="between" style="align-items:center;gap:12px;flex-wrap:wrap">
      <div style="min-width:0">
        <div class="card-title" style="margin:0 0 4px">Chat bubble</div>
        <div class="small muted" style="line-height:1.6">
          ${on ? 'Visible on the app for all users. It floats above the bottom navigation and never covers the profile or action buttons.'
               : 'Hidden everywhere. Users see no chat bubble and the widget is not downloaded at all.'}
        </div>
      </div>
      <button class="btn ${on ? 'btn-danger' : 'btn-primary'}" data-act="tawk-toggle" style="min-width:130px">
        ${ic(on ? 'pause' : 'play', 15)} ${on ? 'Turn off' : 'Turn on'}
      </button>
    </div>
    <div class="row" style="gap:8px;margin-top:14px;flex-wrap:wrap">
      <span class="badge ${on ? 'badge-success' : 'badge-warn'}">${on ? 'Enabled' : 'Disabled'}</span>
      <span class="badge">${live ? 'Widget loaded on this device' : (on ? 'Loading…' : 'Not loaded')}</span>
      <span class="badge">Everyone syncs this setting</span>
    </div>
  </div>

  <div class="card">
    <div class="card-title">Widget placement</div>
    <div class="tiny muted" style="line-height:1.7">
      The bubble is offset <b>86px</b> from the bottom on phones, so it clears the 70px bottom navigation and any sticky action bar.
      On desktop it sits 24px from the corner. It always stays below app dialogs (z-index 900 vs 1000), so PIN and checkout modals are never blocked.
    </div>
  </div>

  <div class="card">
    <div class="card-title">Widget details</div>
    <div class="row" style="gap:8px;flex-wrap:wrap;align-items:flex-end">
      <div class="field grow" style="margin:0;min-width:170px"><label class="label">Property ID</label>
        <input class="input" id="twProperty" value="${esc(c.propertyId)}"/></div>
      <div class="field grow" style="margin:0;min-width:130px"><label class="label">Widget ID</label>
        <input class="input" id="twWidget" value="${esc(c.widgetId)}"/></div>
      <button class="btn btn-soft" data-act="tawk-save">Save</button>
    </div>
    <div class="tiny muted mt6">Change these only if you move to a different Tawk property.</div>
  </div>`;
}

const _adminViewTawk = VIEWS.admin;
VIEWS.admin = function (parts, params) {
  if ((parts[1] || '') === 'livechat') {
    const u = me();
    if (!u || u.role !== 'admin') return `<div class="card empty"><div class="ic">${ic('lock', 26)}</div><h3>Admin access only</h3></div>`;
    return tawkAdminView();
  }
  return _adminViewTawk.apply(this, arguments);
};

if (!ADMIN_NAV.some(n => n.key === 'admin-livechat')) {
  ADMIN_NAV.splice(Math.max(0, ADMIN_NAV.length - 2), 0,
    { key: 'admin-livechat', label: 'Live chat', icon: 'chat', href: '#/admin/livechat' });
}

/* boot: after the database is ready, and again after login/logout */
(function tawkBoot() {
  let tries = 0;
  const t = setInterval(() => {
    tries += 1;
    let ok = false;
    try { ok = WC_TAWK.boot(); } catch (e) { ok = false; }
    if (ok || tries > 40) clearInterval(t);
  }, 250);
  window.addEventListener('hashchange', () => { try { WC_TAWK.apply(); } catch (e) {} });
})();
