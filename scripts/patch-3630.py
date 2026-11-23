#!/usr/bin/env python3
"""Apply the 3.63.0 edits across the committed whalechat.html parts."""
import glob, io, sys, os

PUB = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public')
PARTS = sorted(glob.glob(os.path.join(PUB, 'whalechat.html.part*')))

def patch(anchor, old, new, label):
    hits = []
    for p in PARTS:
        s = open(p, encoding='utf8').read()
        n = s.count(old)
        if n:
            hits.append((p, n, s))
    total = sum(h[1] for h in hits)
    if total != 1:
        print('FAIL [%s] found %d occurrences across %s' % (label, total, [h[0] for h in hits]))
        return False
    p, n, s = hits[0]
    s = s.replace(old, new)
    open(p, 'w', encoding='utf8').write(s)
    print('ok   [%s] %s' % (label, os.path.basename(p)))
    return True

EDITS = []

def E(label, old, new):
    EDITS.append((label, old, new))

# ---------------------------------------------------------------- icons
E('icons',
  "  smartphone:'<rect x=\"6\" y=\"2\" width=\"12\" height=\"20\" rx=\"2\"/><path d=\"M11 18h2\"/>'",
  "  smartphone:'<rect x=\"6\" y=\"2\" width=\"12\" height=\"20\" rx=\"2\"/><path d=\"M11 18h2\"/>',\n"
  "  sticker:'<path d=\"M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8l6-6V5a2 2 0 0 0-2-2z\"/><path d=\"M14 21v-5a2 2 0 0 1 2-2h5\"/>',\n"
  "  server:'<rect x=\"2\" y=\"3\" width=\"20\" height=\"7\" rx=\"2\"/><rect x=\"2\" y=\"14\" width=\"20\" height=\"7\" rx=\"2\"/><path d=\"M6 6.5h.01M6 17.5h.01\"/>',\n"
  "  mail:'<rect x=\"2\" y=\"4\" width=\"20\" height=\"16\" rx=\"2\"/><path d=\"m2 7 10 7 10-7\"/>'")

# ---------------------------------------------------------------- render guard
E('render-guard',
  "function render() {\n  if (!DB_READY) { renderSplash(); return; }",
  "function render() {\n  if (!DB_READY) { renderSplash(); return; }\n"
  "  /* WC smooth chat: while the user is typing on a chat screen the screen is\n"
  "     painted in place (new bubbles, ticks, \"typing…\") instead of rebuilt, so the\n"
  "     composer, its text, the caret and the keyboard are never touched. */\n"
  "  if (window.WC_SMOOTH && WC_SMOOTH.intercept && WC_SMOOTH.intercept()) return;")

# ---------------------------------------------------------------- chat header id
E('chat-head-sub',
  "<div class=\"tiny\" style=\"color:${typing ? 'var(--accent)' : 'var(--muted)'}\">",
  "<div class=\"tiny\" id=\"chatHeadSub\" style=\"color:${typing ? 'var(--accent)' : 'var(--muted)'}\">")

# ---------------------------------------------------------------- typing node id
E('chat-typing-id',
  "${typing ? `<div class=\"typing\"><i></i><i></i><i></i></div>` : ''}",
  "${typing ? `<div class=\"typing\" id=\"chatTyping\"><i></i><i></i><i></i></div>` : ''}")

# ---------------------------------------------------------------- sticker button
E('composer-sticker-btn',
  "<button class=\"icon-btn-round\" data-act=\"attach\" title=\"Attach\">${ic('clip', 19)}</button>",
  "<button class=\"icon-btn-round chat-stk-btn\" data-act=\"stickers\" title=\"Stickers\">${ic('sticker', 19)}</button>\n"
  "        <button class=\"icon-btn-round\" data-act=\"attach\" title=\"Attach\">${ic('clip', 19)}</button>")

# ---------------------------------------------------------------- sticker bubbles
E('message-html-sticker',
  "  if (m.type === 'image') {",
  "  if (m.type === 'sticker') {\n"
  "    content = (window.WC_STICKERS && WC_STICKERS.html) ? WC_STICKERS.html(m)\n"
  "      : '<div class=\"stk\"><div class=\"stk-tile\" style=\"background:linear-gradient(135deg,#0f766e,#0ea5e9)\"><span class=\"stk-e\">\\ud83d\\udc33</span></div></div>';\n"
  "  } else if (m.type === 'image') {")

# ---------------------------------------------------------------- previews
E('preview-sticker',
  "const map = { image: '📷 Photo', video: '🎬 Video', audio: '🎤 Voice message', file: '📎 Attachment' };",
  "const map = { image: '📷 Photo', video: '🎬 Video', audio: '🎤 Voice message', file: '📎 Attachment', sticker: 'Sticker' };")

# ---------------------------------------------------------------- presence heartbeat
E('presence-interval',
  "setInterval(() => { if (me()) { Presence.touch(); if (ACTIVE_CHAT) render(); } }, 25000);",
  "setInterval(() => { if (me()) { Presence.touch(); if (ACTIVE_CHAT) { if (window.WC_SMOOTH && WC_SMOOTH.paintPresence) WC_SMOOTH.paintPresence(); else render(); } } }, 25000);")

# ---------------------------------------------------------------- live channel
E('chan-handlers',
  "  if (d.t === 'typing' && d.chatId) {\n"
  "    TYPING[d.chatId] = TYPING[d.chatId] || {};\n"
  "    TYPING[d.chatId][d.from] = Date.now();\n"
  "    if (ACTIVE_CHAT === d.chatId) render();\n"
  "  }\n"
  "  if (d.t === 'message') { DB = loadDB(); render(); }",
  "  if (d.t === 'typing' && d.chatId) {\n"
  "    TYPING[d.chatId] = TYPING[d.chatId] || {};\n"
  "    TYPING[d.chatId][d.from] = Date.now();\n"
  "    /* a typing notice must never rebuild the chat — paint the header only */\n"
  "    if (ACTIVE_CHAT === d.chatId) {\n"
  "      if (window.WC_SMOOTH && WC_SMOOTH.paintPresence) WC_SMOOTH.paintPresence();\n"
  "      else render();\n"
  "    }\n"
  "  }\n"
  "  if (d.t === 'message') {\n"
  "    DB = loadDB();\n"
  "    /* append the new bubbles in place so typing is never interrupted */\n"
  "    if (!(window.WC_SMOOTH && WC_SMOOTH.syncChat && WC_SMOOTH.syncChat())) render();\n"
  "  }")

# ---------------------------------------------------------------- delivery ticks
E('delivery-ticks',
  "  if (had) { doMaintenance(); render(); }",
  "  if (had) {\n"
  "    doMaintenance();\n"
  "    /* update ✓✓ in place: a re-render here ate whatever the user was typing */\n"
  "    if (!(window.WC_SMOOTH && WC_SMOOTH.paintTicks && WC_SMOOTH.paintTicks())) {\n"
  "      if (!(window.WC_SMOOTH && WC_SMOOTH.composerActive && WC_SMOOTH.composerActive())) render();\n"
  "    }\n"
  "  }")

# ---------------------------------------------------------------- send path
E('send-paints-in-place',
  "  if (chan) { try { chan.postMessage({ t: 'message', from: u.id }); } catch (e) {} }\n"
  "  render();\n"
  "  setTimeout(() => { if (ACTIVE_CHAT === cid) { const b = document.getElementById('chatBody'); if (b) b.scrollTop = b.scrollHeight; } }, 30);",
  "  if (chan) { try { chan.postMessage({ t: 'message', from: u.id }); } catch (e) {} }\n"
  "  /* draw the sent bubbles in place: the composer keeps its height, its focus\n"
  "     and the keyboard stays open (a full render reset all three) */\n"
  "  if (!(window.WC_SMOOTH && WC_SMOOTH.afterSend && WC_SMOOTH.afterSend())) {\n"
  "    render();\n"
  "    setTimeout(() => { if (ACTIVE_CHAT === cid) { const b = document.getElementById('chatBody'); if (b) b.scrollTop = b.scrollHeight; } }, 30);\n"
  "  }")

E('send-ack-ticks',
  "    if (ch) { DB = fresh; persist(); if (ACTIVE_CHAT === cid) render(); }",
  "    if (ch) { DB = fresh; persist(); if (ACTIVE_CHAT === cid && !(window.WC_SMOOTH && WC_SMOOTH.paintTicks && WC_SMOOTH.paintTicks())) render(); }")

# ---------------------------------------------------------------- composer autofocus
E('chat-autofocus-once',
  "  const inp = document.getElementById('msgInput');\n"
  "  if (inp) {\n"
  "    inp.focus({ preventScroll: true });\n"
  "    inp.style.height = 'auto';\n"
  "    inp.style.height = Math.min(120, inp.scrollHeight) + 'px';",
  "  const inp = document.getElementById('msgInput');\n"
  "  if (inp) {\n"
  "    /* Take the keyboard only the first time this chat opens. Re-focusing on\n"
  "       every re-render is what made the keyboard flash open and closed. */\n"
  "    const sameChat = window.__wcChatFocusCid === ACTIVE_CHAT;\n"
  "    window.__wcChatFocusCid = ACTIVE_CHAT;\n"
  "    const writingNow = !!(window.WC_SMOOTH && WC_SMOOTH.composerActive && WC_SMOOTH.composerActive());\n"
  "    if (!sameChat && !writingNow) { try { inp.focus({ preventScroll: true }); } catch (e) {} }\n"
  "    inp.style.height = 'auto';\n"
  "    inp.style.height = Math.min(120, inp.scrollHeight) + 'px';")

# ---------------------------------------------------------------- support callout
E('support-callout',
  "      if (waiting !== present) render();",
  "      if (waiting !== present) {\n"
  "        if (window.WC_SMOOTH && WC_SMOOTH.composerActive && WC_SMOOTH.composerActive()) WC_SMOOTH.renderIdle(render);\n"
  "        else render();\n"
  "      }")

# ---------------------------------------------------------------- version
E('version',
  "const APP_VERSION = '3.62.10';",
  "const APP_VERSION = '3.63.0';")

# ---------------------------------------------------------------- admin nav entry
E('admin-nav-servers',
  "  { key: 'admin-release', label: 'Release', icon: 'refresh', href: '#/admin/release' },",
  "  { key: 'admin-connections', label: 'Servers & API', icon: 'server', href: '#/admin/connections' },\n"
  "  { key: 'admin-release', label: 'Release', icon: 'refresh', href: '#/admin/release' },")

# ---------------------------------------------------------------- my status manager
E('my-status-manager',
  "        <button class=\"btn btn-primary btn-sm\" data-act=\"compose-status\">${ic('plus', 15)} Create</button>\n"
  "      </div>\n"
  "    </div>\n"
  "    <div class=\"section-title\"><h3>Recent updates</h3>",
  "        <div class=\"row gap6\">\n"
  "          ${mine.length ? `<button class=\"btn btn-ghost btn-sm\" data-act=\"open-status\" data-id=\"${u.id}\">${ic('eye', 14)} View mine</button>` : ''}\n"
  "          <button class=\"btn btn-primary btn-sm\" data-act=\"compose-status\">${ic('plus', 15)} Create</button>\n"
  "        </div>\n"
  "      </div>\n"
  "      ${mine.length ? `<div class=\"hr\" style=\"margin:14px 0 10px\"></div>\n"
  "      <div class=\"between mb8\"><span class=\"small\" style=\"font-weight:650\">Your updates</span><span class=\"tiny muted\">Delete any post instantly</span></div>\n"
  "      <div class=\"list\">${mine.map(s => `<div class=\"list-item\">\n"
  "        <div style=\"width:34px;height:34px;border-radius:9px;flex:none;display:flex;align-items:center;justify-content:center;background:rgba(46,230,201,.14);color:var(--accent)\">${ic(s.type === 'text' ? 'edit' : s.type === 'video' ? 'video' : 'image', 16)}</div>\n"
  "        <div class=\"grow\" style=\"min-width:0\"><div class=\"small\" style=\"font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap\">${s.type === 'text' ? esc((s.text || '').slice(0, 70) || 'Text status') : (s.type === 'video' ? 'Video status' : 'Photo status')}</div>\n"
  "        <div class=\"tiny muted\">${timeAgo(s.createdAt)} ago · ${(s.viewers || []).length} view${(s.viewers || []).length === 1 ? '' : 's'} · ${Math.max(1, Math.round((s.createdAt + 86400000 - Date.now()) / 3600000))}h left</div></div>\n"
  "        <button class=\"btn btn-xs btn-ghost\" data-act=\"open-status\" data-id=\"${u.id}\">${ic('eye', 13)}</button>\n"
  "        <button class=\"btn btn-xs btn-ghost\" data-act=\"delete-status\" data-id=\"${s.id}\" style=\"color:var(--danger)\" title=\"Delete this status\">${ic('trash', 13)}</button>\n"
  "      </div>`).join('')}</div>` : ''}\n"
  "    </div>\n"
  "    <div class=\"section-title\"><h3>Recent updates</h3>")

ok = True
for label, old, new in EDITS:
    if not patch(None, old, new, label):
        ok = False
print('---')
print('ALL PATCHED' if ok else 'SOME PATCHES FAILED')
sys.exit(0 if ok else 1)
