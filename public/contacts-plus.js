/* =========================================================================
   WhaleChat contacts + vendors  (wc-contacts-plus)

   - One search box accepts a username, @username, email address or phone
     number, exactly as saved on the other account.
   - Vendors appear in the directory with a Vendor badge and can be saved and
     chatted with like any other contact.
   - Saving adds both sides, so whoever saves first can message immediately and
     the other person sees the new contact and can reply.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  if (window.__wcContactsPlus) return;
  window.__wcContactsPlus = true;

  function install() {
    if (typeof App === 'undefined' || !App || typeof App.addContact !== 'function' || App.addContact.__wcPlus) return false;
    var orig = App.addContact;
    var wrapped = function () {
      var out = orig.apply(this, arguments);
      setTimeout(function () {
        try {
          var el = document.getElementById('acUser');
          if (el) {
            el.placeholder = 'username, @username, email or phone';
            el.setAttribute('aria-label', 'Username, email or phone number');
          }
          var label = document.querySelector('label[for="acUser"], #acUser');
          var help = document.querySelector('#acUser') && document.querySelector('#acUser').closest('.field');
          if (help && !help.querySelector('.wc-ac-hint')) {
            var h = document.createElement('div');
            h.className = 'help wc-ac-hint';
            h.textContent = 'Works for usernames, email addresses and phone numbers — vendors included.';
            help.appendChild(h);
          }
        } catch (e) {}
      }, 80);
      return out;
    };
    wrapped.__wcPlus = true;
    App.addContact = wrapped;
    return true;
  }

  if (!install()) {
    var t = 0;
    var iv = setInterval(function () { if (install() || ++t > 40) clearInterval(iv); }, 300);
  }

  /* add a Vendor badge to directory results without touching the search logic */
  try {
    if (typeof window.contactResultCard === 'function' && !window.contactResultCard.__wcPlus) {
      var origCard = window.contactResultCard;
      var card = function (x) {
        var html = origCard.apply(this, arguments);
        try {
          var isVendorUser = !!(x && (x.vendorId || (typeof vendorOf === 'function' && vendorOf(x.id))));
          if (isVendorUser && html.indexOf('wc-vendor-badge') < 0) {
            html = html.replace(
              '<div class="tiny muted">',
              '<div class="tiny muted"><span class="wc-vendor-badge" style="display:inline-block;margin-right:5px;padding:1px 6px;border-radius:99px;background:rgba(46,230,201,.14);color:var(--accent);font-size:9px;font-weight:800;letter-spacing:.04em">VENDOR</span>'
            );
          }
        } catch (e) {}
        return html;
      };
      card.__wcPlus = true;
      window.contactResultCard = card;
    }
  } catch (e) {}

  /* after saving, make sure the other side gets the contact + a thread instantly */
  try {
    if (typeof App !== 'undefined' && App.saveContact && !App.saveContact.__wcPlus) {
      var origSave = App.saveContact;
      var save = function (id) {
        var out = origSave.apply(this, arguments);
        try {
          var u = (typeof me === 'function') ? me() : null;
          if (u && typeof sys === 'function') sys();
          if (u && typeof sync === 'function') sync();
          if (u && typeof Remote !== 'undefined' && Remote.enabled) {
            try { Remote.dirty = true; Remote.flush && Remote.flush(); } catch (e) {}
          }
        } catch (e) {}
        return out;
      };
      save.__wcPlus = true;
      App.saveContact = save;
    }
  } catch (e) {}
})();
