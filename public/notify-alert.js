/* =========================================================================
   WhaleChat notification sound + vibration  (wc-notify-alert)

   · Loud three-tone chime (Web Audio, unlocked on the first tap) plus a
     strong vibration pattern for every new notification or incoming chat.
   · Wraps notify() so any account notification rings for the signed-in user.
   · Chat messages call WC_ALERT.play('message') from the realtime ingest.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined' || window.__WC_ALERT) return;
  window.__WC_ALERT = true;

  var ctx = null;
  function ensureCtx() {
    try {
      if (!ctx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
      }
      if (ctx.state === 'suspended') ctx.resume().catch(function () {});
      return ctx;
    } catch (e) { return null; }
  }

  /* Browsers only allow audio after a gesture — unlock silently on the first
     tap/keypress so the very next message rings out loud. */
  function unlock() {
    var c = ensureCtx();
    if (!c) return;
    try {
      var o = c.createOscillator(), g = c.createGain();
      g.gain.value = 0.0001;
      o.connect(g); g.connect(c.destination);
      o.start(); o.stop(c.currentTime + 0.02);
    } catch (e) {}
  }
  ['pointerdown', 'touchstart', 'keydown', 'click'].forEach(function (ev) {
    window.addEventListener(ev, unlock, { once: true, passive: true });
  });

  function tone(c, freq, at, dur, type, vol) {
    var o = c.createOscillator(), g = c.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, at);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(vol, at + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g); g.connect(c.destination);
    o.start(at); o.stop(at + dur + 0.02);
  }

  function play(kind) {
    /* vibration first: works even when the device is on silent */
    try {
      if (navigator.vibrate) navigator.vibrate(kind === 'message' ? [500, 160, 500, 160, 800] : [450, 150, 450, 150, 700]);
    } catch (e) {}
    var c = ensureCtx();
    if (!c) return;
    try {
      var t = c.currentTime + 0.02;
      /* loud three-note rising chime + a low thump so it cuts through */
      tone(c, 880, t, 0.22, 'triangle', 0.85);
      tone(c, 1174.7, t + 0.20, 0.22, 'triangle', 0.9);
      tone(c, 1568, t + 0.40, 0.34, 'triangle', 0.95);
      tone(c, 120, t, 0.18, 'sine', 0.7);
      if (kind === 'message') {
        tone(c, 1760, t + 0.78, 0.20, 'triangle', 0.85);
        tone(c, 2093, t + 0.92, 0.24, 'triangle', 0.8);
      }
    } catch (e) {}
  }

  window.WC_ALERT = { play: play, unlock: unlock };

  /* Any notification created for the signed-in account rings. */
  try {
    var origNotify = window.notify;
    if (typeof origNotify === 'function' && !origNotify.__wcAlertWrapped) {
      var wrapped = function (userId, title, body, link, icon, action) {
        var out = origNotify.apply(this, arguments);
        try {
          var mine = (typeof SESSION !== 'undefined' && SESSION && SESSION.userId === userId);
          if (mine) play('notification');
        } catch (e) {}
        return out;
      };
      wrapped.__wcAlertWrapped = true;
      window.notify = wrapped;
    }
  } catch (e) {}
})();
