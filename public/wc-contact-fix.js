/* =========================================================================
   WhaleChat · contacts that stay saved  (wc-contact-fix)  ·  3.74.0
   -------------------------------------------------------------------------
   Three problems this fixes, all around the "You need to add X first" screen:

   1 · ONE-WAY ADD IS ENOUGH
       Saving someone adds them to YOUR list (and only yours). You can message
       them immediately, whether or not they have saved you back.

   2 · AN INCOMING CONVERSATION IS NEVER BLOCKED
       If the other person has already messaged you, the chat opens and can be
       replied to. Opening it saves them to your contacts automatically — one
       row, forever, until YOU remove them manually. No reciprocal row is ever
       forced on the other account, and no "add contact" notification is sent
       again for a pair that was already added.

   3 · A SYNC REFRESH CANNOT ERASE A NEW CONTACT
       The server refresh used to replace the whole contact table, so a contact
       saved moments earlier (while an Appwrite write was still in flight) could
       vanish and the gate came back — and adding again produced a new notice.
       New local contacts are now merged back after every refresh and flushed
       immediately; a deletion you made locally is re-applied after a refresh.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__wcContactFix) return;
  window.__wcContactFix = true;

  var PENDING_REMOVALS = {};     /* "owner>person" deleted locally, not yet confirmed */
  var KEEP_MS = 10 * 60 * 1000;  /* a contact added this recently survives a refresh */
  var REMOVAL_MS = 10 * 60 * 1000;

  function safe(fn, dflt) { try { return fn(); } catch (e) { return dflt; } }
  function g(name) { try { return window[name]; } catch (e) { return undefined; } }
  function meUser() { return safe(function () { var f = g('me'); return typeof f === 'function' ? f() : null; }, null); }
  function db() { return safe(function () { return g('DB') || null; }, null); }
  function contacts() { var d = db(); return (d && Array.isArray(d.contacts)) ? d.contacts : []; }
  function isContact(a, b) { return safe(function () { return typeof window.isContact === 'function' ? window.isContact(a, b) : contacts().some(function (c) { return c && c.ownerId === a && c.userId === b; }); }, false); }
  function chatIdOf(a, b) { return safe(function () { return typeof window.chatId === 'function' ? window.chatId(a, b) : [a, b].sort().join('__'); }, ''); }
  function findUser(id) { return safe(function () { return typeof window.findUser === 'function' ? window.findUser(id) : (contacts() && (db().users || []).find(function (u) { return u && u.id === id; })); }, null); }
  function persist() { safe(function () { var p = g('persist'); if (typeof p === 'function') p(true); }); }
  function sync() { safe(function () { var s = g('sync'); if (typeof s === 'function') s(); }); }
  function render() { safe(function () { var r = g('render'); if (typeof r === 'function') r(); }); }
  function saveLocal() { safe(function () { var f = g('saveLocalNow'); if (typeof f === 'function') f(); }); }

  function ensureContact(ownerId, userId) {
    if (!ownerId || !userId || ownerId === userId) return false;
    /* the app's own helper is authoritative when present (it also de-dupes) */
    if (typeof window.ensureContact === 'function') return window.ensureContact(ownerId, userId);
    var d = db();
    if (!d) return false;
    d.contacts = Array.isArray(d.contacts) ? d.contacts : [];
    var rows = d.contacts.filter(function (c) { return c && c.ownerId === ownerId && c.userId === userId; });
    if (rows.length) {
      if (rows.length > 1) d.contacts = d.contacts.filter(function (c) { return !(c && c.ownerId === ownerId && c.userId === userId) || c === rows[0]; });
      return false;
    }
    d.contacts.push({ id: 'ct_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7), ownerId: ownerId, userId: userId, createdAt: Date.now() });
    return true;
  }

  function flushNow() {
    var R = g('Remote');
    if (R && R.enabled && typeof R.flush === 'function') setTimeout(function () { try { R.flush(); } catch (e) {} }, 40);
  }

  function prune() {
    var now = Date.now();
    Object.keys(PENDING_REMOVALS).forEach(function (k) {
      if (now - PENDING_REMOVALS[k] > REMOVAL_MS) delete PENDING_REMOVALS[k];
    });
  }
  setInterval(prune, 60000);

  /* --------------------------------------------------- incoming chats ---- */
  function hookAfterChat() {
    var A = g('AFTER');
    if (!A || typeof A.chat !== 'function' || A.chat.__wcContactFix) return false;
    var orig = A.chat;
    A.chat = function (parts) {
      var out = orig.apply(this, arguments);
      try {
        var u = meUser();
        var other = parts && parts[1] ? findUser(parts[1]) : null;
        if (!u || !other || other.id === u.id) return out;
        var cid = chatIdOf(u.id, other.id);
        var d = db();
        var hasHistory = !!(d && Array.isArray(d.messages) && d.messages.some(function (m) { return m && m.chatId === cid && m.from !== u.id; }));
        if (!hasHistory || isContact(u.id, other.id)) return out;
        if (safe(function () { return typeof isBlocked === 'function' && isBlocked(u.id, other.id); }, false)) return out;
        if (safe(function () { return typeof blockedMe === 'function' && blockedMe(u.id, other.id); }, false)) return out;
        if (ensureContact(u.id, other.id)) {
          persist();
          sync();
          flushNow();
          /* one quiet repaint so the "not a contact" state disappears */
          setTimeout(render, 90);
        }
      } catch (e) {}
      return out;
    };
    A.chat.__wcContactFix = true;
    return true;
  }

  /* ------------------------------------------- protect pending contacts -- */
  function hookRemote() {
    var R = g('Remote');
    if (!R || typeof R.refresh !== 'function' || R.__wcContactFix) return false;
    var orig = R.refresh;
    R.refresh = function (force) {
      var self = this;
      var before = contacts().slice();
      return Promise.resolve(orig.apply(self, arguments)).then(function (out) {
        try {
          var now = Date.now();
          var server = contacts().slice();
          var have = {};
          server.forEach(function (c) { if (c && c.id) have[c.id] = 1; });

          /* 1 · a contact saved moments ago must survive a refresh that started
                 before its Appwrite write landed */
          var keep = before.filter(function (c) {
            if (!c || !c.id || !c.ownerId || !c.userId) return false;
            if (have[c.id]) return false;
            if (PENDING_REMOVALS[c.ownerId + '>' + c.userId]) return false;
            return (now - (Number(c.createdAt) || 0)) < KEEP_MS;
          });

          var changed = false;
          if (keep.length) {
            var d = db();
            if (d) { d.contacts = server.concat(keep); changed = true; }
          }

          /* 2 · a deletion must not be undone by a stale server copy */
          var marks = Object.keys(PENDING_REMOVALS);
          if (marks.length) {
            var d2 = db();
            var filtered = (d2.contacts || []).filter(function (c) { return !(c && PENDING_REMOVALS[c.ownerId + '>' + c.userId]); });
            if (filtered.length !== (d2.contacts || []).length) { d2.contacts = filtered; changed = true; }
          }

          if (changed) {
            saveLocal();
            self.dirty = true;
            if (typeof render === 'function') render();
            setTimeout(function () { try { R.flush(); } catch (e) {} }, 60);
          }
        } catch (e) {}
        return out;
      });
    };
    R.__wcContactFix = true;
    return true;
  }

  /* ------------------------------------------------ deletions stay gone -- */
  function hookDelete() {
    var A = g('App');
    if (!A || typeof A.deleteContact !== 'function' || A.deleteContact.__wcContactFix) return false;
    var orig = A.deleteContact;
    A.deleteContact = async function (id) {
      var u = meUser();
      var key = u && id ? (u.id + '>' + id) : '';
      if (key) PENDING_REMOVALS[key] = Date.now();
      var out = await orig.apply(this, arguments);
      if (key && isContact(u.id, id)) delete PENDING_REMOVALS[key]; /* cancelled or failed */
      else flushNow();
      return out;
    };
    A.deleteContact.__wcContactFix = true;
    return true;
  }

  /* also make the app's own save path robust if it is ever replaced */
  function hookSave() {
    var A = g('App');
    if (!A || typeof A.saveContact !== 'function' || A.saveContact.__wcContactFix) return false;
    var orig = A.saveContact;
    A.saveContact = function (id) {
      var u = meUser();
      var x = findUser(id);
      if (u && x && !isContact(u.id, x.id)) {
        var added = ensureContact(u.id, x.id);
        if (added) {
          var n = g('notifyContactOnce');
          if (typeof n === 'function') n(u, x);
        }
        persist();
        sync();
        flushNow();
        safe(function () { var c = g('closeModal'); if (typeof c === 'function') c(); });
        safe(function () { var go = g('go'); if (typeof go === 'function') go('chat/' + id); });
        return;
      }
      return orig.apply(this, arguments);
    };
    A.saveContact.__wcContactFix = true;
    return true;
  }

  /* one row per person for every account already saved (cleans rows stacked by
     the old repeated-add bug) */
  function dedupeAll() {
    var d = db();
    if (!d || !Array.isArray(d.contacts)) return;
    var seen = {};
    var out = [];
    var changed = false;
    d.contacts.forEach(function (c) {
      if (!c || !c.ownerId || !c.userId || c.ownerId === c.userId) { changed = true; return; }
      var key = c.ownerId + '>' + c.userId;
      if (seen[key]) { changed = true; return; }
      seen[key] = 1;
      out.push(c);
    });
    if (changed) {
      d.contacts = out;
      persist(); saveLocal(); sync(); flushNow();
    }
  }

  var tries = 0;
  (function bind() {
    var a = hookAfterChat();
    var r = hookRemote();
    var d = hookDelete();
    var s = hookSave();
    if (a && r && d && s) { dedupeAll(); return; }
    if (tries++ < 60) setTimeout(bind, 500);
  })();

  window.WCContacts = {
    ensure: ensureContact,
    autoSave: function (ownerId, personId) {
      var added = ensureContact(ownerId, personId);
      if (added) { persist(); sync(); flushNow(); }
      return added;
    },
    pendingRemovals: function () { return Object.keys(PENDING_REMOVALS); }
  };
})();
