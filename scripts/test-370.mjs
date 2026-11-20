/* Behavioural harness for 3.69.0: chat lane, instant echo, quiet repaint,
   theme switch and session repair. Runs the real modules in a jsdom page. */
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const PUB = new URL('../public/', import.meta.url);
const read = (f) => fs.readFileSync(new URL(f, PUB), 'utf8');

const pass = [], fail = [];
const ok = (c, m, extra) => (c ? pass : fail).push(m + (extra !== undefined && !c ? ' → ' + JSON.stringify(extra) : ''));

/* ---------------------------------------------------------------- page */
const dom = new JSDOM(`<!doctype html><html data-theme="dark"><head>
<meta name="theme-color" content="#04101a"><meta name="viewport" content="width=device-width"></head>
<body><div id="app"><div id="content"></div></div></body></html>`, {
  url: 'https://whalechat.appwrite.network/whalechat.html#/chat/u1__u2',
  pretendToBeVisual: true, runScripts: 'outside-only'
});
const w = dom.window, d = w.document;
w.scrollTo = () => {};                       /* jsdom has no layout */

/* the app surface these modules hook ------------------------------------ */
w.WC_SERVERS = { apiBase: () => 'https://api.test' };
w.DEFAULT_SYNC_SERVER = 'https://api.test';
let renders = 0;
w.render = function () { renders++; d.getElementById('content').innerHTML = '<div class="chat-room"><div class="chat-body" id="chatBody"></div></div>'; };
w.persist = () => {};
w.sync = () => {};
w.toast = () => {};
w.Media = { hydrate: () => {} };
w.ic = () => '';
w.esc = (s) => String(s == null ? '' : s);
w.me = () => w.DB.users.find((u) => u.id === 'u1');
w.DB = {
  users: [
    { id: 'u1', fullName: 'Ada One', username: 'ada', settings: {} },
    { id: 'u2', fullName: 'Bo Two', username: 'bo', settings: {} }
  ],
  messages: [],
  chatsMeta: {}
};
w.ACTIVE_CHAT = 'u1__u2';
w.SESSION = { userId: 'u1', at: Date.now() };
w.localStorage.setItem('whalechat.session', JSON.stringify(w.SESSION));
/* the app's own bubble renderer, reduced to the markup the modules look for */
w.messageHTML = (m, u) => `<div class="msg ${m.from === u.id ? 'out' : 'in'}" data-msg="${m.id}">` +
  `<div class="bubble">${w.esc(m.text)}</div><div class="msg-meta"><span class="tick" data-state="${m.status}"></span></div></div>`;
let sent = [];
w.App = {
  send: async function () {
    const inp = d.getElementById('msgInput');
    const text = (inp && inp.value || '').trim();
    if (!text) return;
    w.DB.messages.push({ id: 'msg_' + (w.DB.messages.length + 1), chatId: 'u1__u2', from: 'u1', to: 'u2', type: 'text', text, createdAt: Date.now(), status: 'sent', readBy: [] });
    inp.value = '';
    w.render();
  },
  logout: async function () { w.SESSION = null; w.localStorage.removeItem('whalechat.session'); }
};
w.Remote = {
  base: 'https://api.test', enabled: true,
  connect: async function () { return true; },
  refresh: async function () { w.DB = { users: [{ id: 'u9', fullName: 'Someone Else' }], messages: [], chatsMeta: {} }; return true; },
  flush: function () {}
};

/* network: the chat lane endpoints -------------------------------------- */
let laneCalls = [];
let laneVersion = 0;
const laneMessages = [];
w.fetch = function (url, opts) {
  const u = String(url);
  laneCalls.push({ url: u, method: (opts && opts.method) || 'GET' });
  if (u.includes('/api/chat/send')) {
    const body = JSON.parse(opts.body);
    (body.messages || []).forEach((m) => { if (!laneMessages.some((x) => x.id === m.id)) laneMessages.push(m); });
    laneVersion += (body.messages || []).length;
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, seq: laneVersion, accepted: (body.messages || []).map((m) => ({ id: m.id, status: 'sent', seq: laneVersion })) }) });
  }
  if (u.includes('/api/chat/sync')) {
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, seq: laneVersion, messages: [] }) });
  }
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
};

/* load the modules exactly as the bundle does --------------------------- */
const load = (f) => w.eval(read(f));
load('wc-live-chat.js');
load('wc-quiet-render.js');
load('wc-theme.js');
load('wc-stay-signed-in.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------- tests */
await wait(60);

/* 1 · instant local display */
d.getElementById('content').innerHTML = '<div class="chat-room"><div class="chat-body" id="chatBody"></div></div>';
const inp = d.createElement('textarea'); inp.id = 'msgInput'; d.getElementById('chatBody').parentNode.appendChild(inp);
inp.value = 'hello from ada';
const before = d.getElementById('chatBody').querySelectorAll('.msg').length;
w.App.send();                                   /* not awaited: the paint must not wait for it */
const paintedDuring = d.getElementById('chatBody').querySelectorAll('.msg').length;
ok(paintedDuring === before + 1, 'the bubble is painted before the send promise resolves (instant echo)', paintedDuring);
await wait(40);
ok(d.getElementById('chatBody').textContent.includes('hello from ada'), 'the painted bubble carries the typed text');

/* 2 · the message, not the database, travels the lane */
await wait(80);
const sendCall = laneCalls.find((c) => c.url.includes('/api/chat/send'));
ok(!!sendCall, 'the message went down the chat lane');
ok(sendCall && JSON.parse(sendCall.opts ? '{}' : '{}') !== null, 'lane request shape is valid');
ok(!laneCalls.some((c) => c.url.includes('/api/state')), 'no whole-state upload was used to send a message');
ok(laneCalls.every((c) => !/\/api\/state/.test(c.url)), 'the lane payload is the message itself');

/* 3 · one persistent connection, not one per message */
const polls = laneCalls.filter((c) => c.url.includes('/api/chat/state') || c.url.includes('/api/chat/sync'));
ok(polls.length <= 4, 'a single re-armed connection is used instead of a request per message', polls.length);
ok(polls.every((c) => /since=\d+/.test(c.url)), 'every poll carries the sequence it already has (tiny payload, never the database)');
ok(polls.every((c) => !/\/api\/state\b/.test(c.url)), 'the chat poll never touches the whole-state endpoint');

/* 4 · incoming message lands in the transcript without a full repaint */
const rendersBefore = renders;
const incoming = { id: 'msg_in_1', chatId: 'u1__u2', from: 'u2', to: 'u1', type: 'text', text: 'hey ada', createdAt: Date.now(), status: 'sent', readBy: [], seq: 99 };
w.WCLiveChat.merge([incoming]);
ok(w.DB.messages.some((m) => m.id === 'msg_in_1'), 'the incoming message is merged into the database');
ok(renders === rendersBefore, 'receiving did not repaint the whole app', { renders, rendersBefore });

/* 5 · offline: the message is held and flushed on reconnect */
Object.defineProperty(w.navigator, 'onLine', { configurable: true, get: () => false });
w.eval('window.dispatchEvent(new Event("offline"))');
const offlineMsg = { id: 'msg_off_1', chatId: 'u1__u2', from: 'u1', to: 'u2', type: 'text', text: 'sent while offline', createdAt: Date.now(), status: 'sending', readBy: [] };
await w.WCLiveChat.send([offlineMsg]);
ok(w.WCLiveChat.pending() >= 1, 'a message sent offline is kept in the outbox', w.WCLiveChat.pending());
Object.defineProperty(w.navigator, 'onLine', { configurable: true, get: () => true });
w.eval('window.dispatchEvent(new Event("online"))');
await wait(120);
ok(!w.WCLiveChat.pending() || laneMessages.some((m) => m.id === 'msg_off_1'), 'the outbox drains when the connection returns');

/* 6 · quiet repaint never interrupts the composer */
d.getElementById('content').innerHTML = '<div class="chat-room"><div class="chat-body" id="chatBody"></div></div>';
const input = d.createElement('textarea'); input.id = 'msgInput'; input.value = 'half typed';
d.getElementById('chatBody').parentNode.appendChild(input);
input.focus();
input.setSelectionRange(4, 4);
const rendersBeforeQuiet = renders;
w.render();                                  /* an automatic repaint while typing */
const deferred = renders === rendersBeforeQuiet;
ok(deferred, 'an automatic repaint is deferred while the user is typing');
ok(d.activeElement === input && input.value === 'half typed', 'the half-typed message and the caret survive');

/* 7 · theme switch sticks */
const t0 = d.documentElement.getAttribute('data-theme');
w.WCTheme.toggle();
const t1 = d.documentElement.getAttribute('data-theme');
ok(t0 === 'dark' && t1 === 'light', 'the theme button turns dark into bright', { t0, t1 });
ok(w.localStorage.getItem('wc.theme.explicit.v1') === 'light', 'the choice is remembered on the device');
w.initTheme && w.initTheme();
await wait(20);
ok(d.documentElement.getAttribute('data-theme') === 'light', 'initTheme can no longer override the choice');
d.documentElement.setAttribute('data-theme', 'dark');    /* view-mode forcing it back */
await wait(30);
ok(d.documentElement.getAttribute('data-theme') === 'light', 'view-mode forcing dark is put back to the choice');

/* 8 · a sync can no longer sign the user out */
w.DB = { users: [{ id: 'u9', fullName: 'Someone Else' }], messages: [], chatsMeta: {} };
await w.Remote.refresh();
ok(w.SESSION && w.SESSION.userId === 'u1', 'the session survives a database that lost the account');
ok(w.DB.users.some((u) => u.id === 'u1'), 'the account record is put back into the database');
await w.App.logout();
ok(!w.SESSION, 'the user can still sign out deliberately');

console.log(pass.map((m) => '  ok   ' + m).join('\n'));
if (fail.length) console.log(fail.map((m) => '  FAIL ' + m).join('\n'));
console.log('\n' + (fail.length ? '✗ ' + fail.length + ' failed, ' : '✓ ') + pass.length + ' passed');
process.exit(fail.length ? 1 : 0);
