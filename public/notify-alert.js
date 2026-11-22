/* =========================================================================
   WhaleChat notification sound + vibration  (wc-notify-alert)

   · VERY LOUD multi-burst alarm (Web Audio, unlocked on the first tap) plus a
     long vibration pattern for every new notification, new incoming chat
     message and every other new activity on the account.
   · Volume is pushed to the maximum the device allows: every tone is doubled
     an octave apart and the whole chain runs through a hard limiter, so the
     alarm is as loud as the speaker goes without distorting.
   · Wraps notify() so any account notification rings for the signed-in user,
     and watches the synced database so a notification or message that arrives
     from the server (another device, a contact's status, an admin action)
     also rings loudly.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined' || window.__WC_ALERT) return;
  window.__WC_ALERT = true;

  var MASTER_VOLUME = 1.0;   /* 1.0 = full scale; limiter keeps it clean */
  var ctx = null, master = null, lastPlay = 0;

  function ensureCtx() {
    try {
      if (!ctx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
        /* limiter: everything is driven as hot as possible without clipping */
        var limiter = ctx.createDynamicsCompressor();
        limiter.threshold.value = -4;
        limiter.knee.value = 0;
        limiter.ratio.value = 20;
        limiter.attack.value = 0.002;
        limiter.release.value = 0.15;
        master = ctx.createGain();
        master.gain.value = MASTER_VOLUME;
        master.connect(limiter);
        limiter.connect(ctx.destination);
      }
      if (ctx.state === 'suspended') ctx.resume().catch(function () {});
      return ctx;
    } catch (e) { return null; }
  }

  /* Browsers only allow audio after a gesture — unlock silently on every early
     interaction (not just the first) so the very next message rings out loud. */
  function unlock() {
    var c = ensureCtx();
    if (!c) return;
    try {
      var o = c.createOscillator(), g = c.createGain();
      g.gain.value = 0.0001;
      o.connect(g); g.connect(master || c.destination);
      o.start(); o.stop(c.currentTime + 0.02);
    } catch (e) {}
  }
  ['pointerdown', 'touchstart', 'touchend', 'keydown', 'click'].forEach(function (ev) {
    window.addEventListener(ev, unlock, { passive: true });
  });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) ensureCtx(); });

  function tone(c, freq, at, dur, type, vol) {
    /* fundamental + one octave up: the octave makes the alarm carry far */
    var layers = [
      { f: freq, v: vol },
      { f: freq * 2, v: vol * 0.55 }
    ];
    layers.forEach(function (L) {
      var o = c.createOscillator(), g = c.createGain();
      o.type = type || 'square';
      o.frequency.setValueAtTime(L.f, at);
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, L.v), at + 0.01);
      g.gain.setValueAtTime(Math.max(0.0002, L.v), at + dur * 0.72);
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      o.connect(g); g.connect(master || c.destination);
      o.start(at); o.stop(at + dur + 0.03);
    });
  }

  function burst(c, t0, kind) {
    if (kind === 'message') {
      /* rising four-note siren + low thump */
      tone(c, 784, t0, 0.30, 'square', 1.0);
      tone(c, 1046.5, t0 + 0.26, 0.30, 'square', 1.0);
      tone(c, 1318.5, t0 + 0.52, 0.34, 'square', 1.0);
      tone(c, 1568, t0 + 0.80, 0.42, 'square', 1.0);
      tone(c, 110, t0, 0.24, 'sine', 0.95);
      tone(c, 196, t0 + 0.55, 0.22, 'sine', 0.8);
    } else {
      /* alert chime: three rising notes, twice as loud as the old one */
      tone(c, 880, t0, 0.30, 'square', 1.0);
      tone(c, 1174.7, t0 + 0.28, 0.30, 'square', 1.0);
      tone(c, 1568, t0 + 0.56, 0.44, 'square', 1.0);
      tone(c, 120, t0, 0.22, 'sine', 0.95);
    }
  }

  function play(kind) {
    var now = Date.now();
    /* never stack two alarms on top of each other (two code paths can fire) */
    if (now - lastPlay < 450) return;
    lastPlay = now;
    var isMsg = kind === 'message';

    /* vibration first: works even when the phone is on silent */
    try {
      if (navigator.vibrate) {
        navigator.vibrate(isMsg
          ? [900, 220, 900, 220, 900, 260, 1200]
          : [800, 220, 800, 220, 1000]);
      }
    } catch (e) {}

    var c = ensureCtx();
    if (!c) return;
    try {
      unlock();
      var t = c.currentTime + 0.02;
      /* three alarm bursts for a message, two for anything else: long and loud
         enough that a user in another room still hears it */
      var repeats = isMsg ? 3 : 2;
      var len = isMsg ? 1.35 : 1.10;
      for (var i = 0; i < repeats; i++) burst(c, t + i * len, kind);
    } catch (e) {}
  }

  window.WC_ALERT = {
    play: play,
    unlock: unlock,
    setVolume: function (v) {
      MASTER_VOLUME = Math.max(0, Math.min(1, Number(v) || 0));
      if (master) { try { master.gain.value = MASTER_VOLUME; } catch (e) {} }
    },
    getVolume: function () { return MASTER_VOLUME; }
  };

  /* Any notification created for the signed-in account rings. */
  try {
    var origNotify = window.notify;
    if (typeof origNotify === 'function' && !origNotify.__wcAlertWrapped) {
      var wrapped = function (userId, title, body, link, icon, action) {
        var out = origNotify.apply(this, arguments);
        try {
          var mine = (typeof SESSION !== 'undefined' && SESSION && SESSION.userId === userId);
          if (mine) { lastPlay = 0; play('notification'); }
        } catch (e) {}
        return out;
      };
      wrapped.__wcAlertWrapped = true;
      window.notify = wrapped;
    }
  } catch (e) {}

  /* ---------------------------------------------------------------------
     Synced-activity watcher.
     Notifications and messages that arrive from the server (a contact's new
     status, an admin action, a message from another device) never pass
     through notify() on this device — so watch the synced data and ring the
     same loud alarm when something new for this account appears.
     --------------------------------------------------------------------- */
  var seenNotif = null, seenMsg = null;

  function myId() {
    try { return (typeof SESSION !== 'undefined' && SESSION && SESSION.userId) || null; } catch (e) { return null; }
  }
  function db() {
    try { return (typeof DB !== 'undefined' && DB) ? DB : null; } catch (e) { return null; }
  }

  function scan() {
    var d = db(), uid = myId();
    if (!d || !uid) return;

    /* notifications for me */
    var notifs = (d.notifications || []).filter(function (n) { return n && n.userId === uid; }).slice(0, 40);
    if (seenNotif === null) {
      seenNotif = new Set(notifs.map(function (n) { return n.id; }));
    } else {
      var fresh = null;
      notifs.forEach(function (n) {
        if (!seenNotif.has(n.id)) { seenNotif.add(n.id); if (!n.read) fresh = n; }
      });
      if (fresh) play('notification');
    }

    /* messages addressed to me */
    var msgs = (d.messages || []).filter(function (m) { return m && m.to === uid && !m.deleted; }).slice(-40);
    if (seenMsg === null) {
      seenMsg = new Set(msgs.map(function (m) { return m.id; }));
    } else {
      var newMsg = null;
      msgs.forEach(function (m) {
        if (!seenMsg.has(m.id)) { seenMsg.add(m.id); if (Date.now() - (Number(m.createdAt) || 0) < 120000) newMsg = m; }
      });
      if (newMsg) play('message');
    }
  }

  function startWatcher() {
    if (window.__WC_ALERT_WATCH) return;
    window.__WC_ALERT_WATCH = true;
    setTimeout(scan, 1500);
    setInterval(scan, 2500);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) { ensureCtx(); scan(); } });
    window.addEventListener('focus', function () { ensureCtx(); scan(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startWatcher);
  else startWatcher();
})();
