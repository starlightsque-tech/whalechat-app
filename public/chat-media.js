/* =========================================================================
   WhaleChat shared voice notes  (wc-chat-media)

   The chat composer stores media in the device IndexedDB (fast, private).
   That meant a voice note recorded by user A existed only on A's phone: the
   message metadata synced, but B had no audio to play.

   This module makes voice notes travel with the message:
     - the recorder is tuned to a small Opus bitrate so a clip stays light
     - the audio is converted to a data URL and attached to the message
     - every device that receives the message can play it immediately
     - the sender keeps playing from the local blob as before

   Images and videos keep the local-first path (they are far too large to
   inline); voice notes are the conversation feature that must work on both
   sides, so they are shared end-to-end.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  if (window.__wcChatMedia) return;
  window.__wcChatMedia = true;

  var DATA = {};                       /* mediaId -> data URL (this session) */
  var MAX_BYTES = 2.2 * 1024 * 1024;   /* per voice note, before base64 */

  function log() { try { console.log.apply(console, ['[chat-media]'].concat([].slice.call(arguments))); } catch (e) {} }

  /* Small Opus encode: voice is perfectly clear at 24 kbps and a one-minute
     clip stays around 180 KB, so it can travel inside the message safely. */
  try {
    var NativeMR = window.MediaRecorder;
    if (NativeMR && !NativeMR.__wcPatched) {
      var Patched = function (stream, opts) {
        var o = { audioBitsPerSecond: 24000 };
        try { if (NativeMR.isTypeSupported && NativeMR.isTypeSupported('audio/webm;codecs=opus')) o.mimeType = 'audio/webm;codecs=opus'; } catch (e) {}
        return new NativeMR(stream, Object.assign(o, opts || {}));
      };
      Patched.prototype = NativeMR.prototype;
      Patched.isTypeSupported = NativeMR.isTypeSupported ? NativeMR.isTypeSupported.bind(NativeMR) : function () { return true; };
      Patched.__wcPatched = true;
      window.MediaRecorder = Patched;
    }
  } catch (e) { log('recorder tune skipped', e && e.message); }

  function toDataURL(blob) {
    return new Promise(function (resolve) {
      try {
        var fr = new FileReader();
        fr.onload = function () { resolve(String(fr.result || '')); };
        fr.onerror = function () { resolve(''); };
        fr.readAsDataURL(blob);
      } catch (e) { resolve(''); }
    });
  }

  function attach() {
    try {
      if (typeof DB === 'undefined' || !DB || !Array.isArray(DB.messages)) return;
      DB.messages.forEach(function (m) {
        if (!m || m.type !== 'audio' || !m.mediaId || m.mediaData) return;
        var data = DATA[m.mediaId];
        if (data) m.mediaData = data;
      });
    } catch (e) {}
  }
  window.WC_CHAT_MEDIA = { data: DATA, attach: attach };

  function patchMediaStore() {
    if (typeof Media === 'undefined' || !Media || Media.__wcShared) return false;
    Media.__wcShared = true;
    var put = Media.put.bind(Media);
    Media.put = function (blob) {
      return put(blob).then(function (id) {
        if (!id || !blob) return id;
        var type = String(blob.type || '');
        if (!/^audio\//.test(type)) return id;
        if (Number(blob.size) > MAX_BYTES) {
          try { if (typeof toast === 'function') toast('Voice note is long — it will play on this device only', 'err', 4200); } catch (e) {}
          return id;
        }
        return toDataURL(blob).then(function (data) {
          if (data) DATA[id] = data;
          return id;
        });
      });
    };
    return true;
  }

  function patchPersist() {
    if (typeof window.persist !== 'function' || window.persist.__wcShared) return false;
    var orig = window.persist;
    var wrapped = function () {
      /* attach before the state diff so the same push that carries the message
         also carries its audio — the other side never sees a silent note */
      attach();
      return orig.apply(this, arguments);
    };
    wrapped.__wcShared = true;
    window.persist = wrapped;
    return true;
  }

  function patchMessageHTML() {
    if (typeof window.messageHTML !== 'function' || window.messageHTML.__wcShared) return false;
    var orig = window.messageHTML;
    var wrapped = function (m, u, other) {
      var html = orig.apply(this, arguments);
      try {
        if (m && m.type === 'audio' && m.mediaData) {
          var needle = '<audio data-media="' + m.mediaId + '"';
          if (html.indexOf(needle) >= 0) {
            html = html.replace(needle, '<audio src="' + String(m.mediaData).replace(/"/g, '&quot;') + '" data-media="' + m.mediaId + '"');
          }
        }
      } catch (e) {}
      return html;
    };
    wrapped.__wcShared = true;
    window.messageHTML = wrapped;
    return true;
  }

  /* Audio delivered while the thread is open is drawn straight from the
     message payload; this covers older re-renders that still use hydrate. */
  function patchHydrate() {
    if (typeof Media === 'undefined' || !Media || !Media.hydrate || Media.hydrate.__wcShared) return false;
    var orig = Media.hydrate;
    var wrapped = function (container) {
      return Promise.resolve(orig.apply(this, arguments)).then(function (v) {
        try {
          var els = container && container.querySelectorAll ? container.querySelectorAll('audio[data-media]') : [];
          Array.prototype.forEach.call(els, function (el) {
            if (el.getAttribute('src')) return;
            var id = el.getAttribute('data-media');
            var m = (DB.messages || []).find(function (x) { return x && x.mediaId === id; });
            if (m && m.mediaData) el.setAttribute('src', m.mediaData);
            else if (DATA[id]) el.setAttribute('src', DATA[id]);
          });
        } catch (e) {}
        return v;
      });
    };
    wrapped.__wcShared = true;
    Media.hydrate = wrapped;
    return true;
  }

  function boot() {
    var ready = patchMediaStore();
    patchPersist();
    patchMessageHTML();
    patchHydrate();
    if (!ready) setTimeout(boot, 400);
  }
  boot();
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { attach(); } });
})();
