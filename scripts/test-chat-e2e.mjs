/* =========================================================================
   Two-user chat, end to end, against a REAL server.

   Boots the app's own sync server (server.js) on a free port with a throwaway
   data directory, then drives two independent clients with the real
   wc-live-chat.js module: send, measure arrival, take both offline, exchange,
   reconnect, and prove nothing was lost or duplicated.
   ========================================================================= */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { JSDOM } from 'jsdom';

const ROOT = new URL('..', import.meta.url).pathname;
const LANE = fs.readFileSync(path.join(ROOT, 'public/wc-live-chat.js'), 'utf8');

const pass = [], fail = [];
const ok = (c, m, extra) => (c ? pass : fail).push(m + (extra !== undefined && !c ? ' → ' + JSON.stringify(extra) : ''));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const RUN = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/* ------------------------------------------------------------- server */
const REMOTE = process.env.WC_E2E_BASE || '';   /* set to test the deployed API */
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-e2e-'));
const PORT = 8900 + Math.floor(Math.random() * 90);
const srv = REMOTE ? { stdout: { on() {} }, stderr: { on() {} }, kill() {} } : spawn('node', ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, WC_SKIP_VERIFY: '1', NODE_ENV: 'test' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let srvLog = '';
srv.stdout.on('data', (d) => { srvLog += d.toString(); });
srv.stderr.on('data', (d) => { srvLog += d.toString(); });

const BASE = REMOTE || `http://127.0.0.1:${PORT}`;
async function waitForServer() {
  if (REMOTE) return true;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) return true;
    } catch (e) {}
    await wait(250);
  }
  throw new Error('server did not start: ' + srvLog.slice(-400));
}

/* -------------------------------------------------------------- client */
function makeClient(name, otherId) {
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
    url: BASE + '/whalechat.html#/chat/x', pretendToBeVisual: true,
    /* without this, jsdom's eval runs in the Node context and `window` is not
       defined, so every browser module would bail on its first line */
    runScripts: 'outside-only'
  });
  const w = dom.window;
  w.scrollTo = () => {};
  let online = true;
  Object.defineProperty(w.navigator, 'onLine', { configurable: true, get: () => online });

  w.WC_SERVERS = { apiBase: () => BASE };
  w.DEFAULT_SYNC_SERVER = BASE;
  w.render = () => {};
  w.persist = () => {};
  w.toast = () => {};
  w.Media = { hydrate: () => {} };
  w.me = () => w.DB.users.find((u) => u.id === w.ME);
  w.ME = name;
  w.DB = {
    users: [{ id: name, fullName: name, username: name }, { id: otherId, fullName: otherId, username: otherId }],
    messages: [], chatsMeta: {}
  };
  if (process.env.WC_E2E_DEBUG) {
    const realPush = w.DB.messages.push.bind(w.DB.messages);
    w.DB.messages.push = function (m) {
      const st = String(new Error().stack || '').split('\n').slice(1, 5).map((l) => l.trim()).join(' | ');
      console.log(`      PUSH ${name} ${m && m.id} :: ${st}`);
      return realPush(m);
    };
  }
  w.ACTIVE_CHAT = [name, otherId].sort().join('__');
  w.SESSION = { userId: name, at: Date.now() };
  w.messageHTML = (m, u) => `<div class="msg" data-msg="${m.id}"><span>${m.text}</span></div>`;
  /* mirrors the real App.send: the message is written to the local database
     first, which is what the lane wrapper then paints and ships */
  w.App = {
    send: async function (msg) {
      w.DB.messages.push(Object.assign({}, msg));
      return w.WCLiveChat.send([msg]);
    }
  };
  w.Remote = { base: BASE, enabled: true, connect: async () => true, refresh: async () => true, flush: () => {} };

  /* jsdom has no fetch: give the page the real one, then put the network
     switch in front of it. Offline = every request fails like a dead radio. */
  const realFetch = (...args) => globalThis.fetch(...args);
  w.fetch = function (url, opts) {
    if (!online) return Promise.reject(new TypeError('Failed to fetch'));
    return realFetch(url, opts);
  };

  w._setOnline = (v) => {
    online = v;
    w.dispatchEvent(new w.Event(v ? 'online' : 'offline'));
  };
  w.eval(LANE);
  return w;
}

function deliver(w, msgs) {
  /* the device side of the lane: merge + paint, exactly as the module does */
  const before = w.DB.messages.length;
  w.WCLiveChat.merge(msgs);
  if (process.env.WC_E2E_DEBUG) {
    const ids = msgs.map((m) => m.id);
    console.log(`      deliver ${w.ME}: offered ${ids.join(',')} · db ${before} → ${w.DB.messages.length}`);
  }
}

let exitCode = 1;
try {
  await waitForServer();
  /* warm the lane: a cold Appwrite instance pays a multi-second boot, and the
     numbers below are meant to describe steady-state chatting */
  for (let i = 0; i < 3; i++) { try { await fetch(BASE + '/api/chat/state?since=0'); } catch (e) {} await wait(250); }
  console.log('server up on ' + BASE);

  /* synthetic accounts so a live run never touches a real user's conversation */
  const AID = REMOTE ? 'e2ea' : 'alice';
  const BID = REMOTE ? 'e2eb' : 'bob';
  const A = makeClient(AID, BID);
  const B = makeClient(BID, AID);
  await wait(300);

  /* ---------------------------------------------------- 1 · online send */
  const t0 = Date.now();
  const CHAT = [AID, BID].sort().join('__');
  const msg = {
    id: 'm_online_1_' + RUN, chatId: CHAT, from: AID, to: BID, type: 'text',
    text: 'hello bob, first message', createdAt: Date.now(), status: 'sent', readBy: []
  };
  await A.App.send(msg);
  const afterSend = Date.now();
  ok(A.WCLiveChat.pending() === 0, 'the sender does not keep it in the outbox after the lane accepted it', A.WCLiveChat.pending());

  /* B's own poll picks it up — measured, not assumed */
  let arrived = null;
  for (let i = 0; i < 40; i++) {
    const r = await fetch(`${BASE}/api/chat/state?since=0`).then((x) => x.json());
    if (r.messages && r.messages.some((m) => m.id === msg.id)) { arrived = Date.now(); deliver(B, r.messages); break; }
    await wait(50);
  }
  const travel = arrived ? arrived - t0 : -1;
  ok(arrived !== null, 'the message arrived on the second account');
  console.log(`      send request: ${afterSend - t0} ms · arrived at the peer: ${travel} ms`);
  ok(travel > 0 && travel < 3000, 'it arrived quickly (well under the old multi-second path)', travel);
  ok(B.DB.messages.filter((m) => m.id === msg.id).length === 1, 'it is in the peer database exactly once');

  /* --------------------------------- 2 · both offline, exchange, reconnect */
  A._setOnline(false);
  B._setOnline(false);
  await wait(120);

  const fromA = { id: 'm_off_a1_' + RUN, chatId: CHAT, from: AID, to: BID, type: 'text', text: 'offline from alice', createdAt: Date.now(), status: 'sent', readBy: [] };
  const fromB = { id: 'm_off_b1_' + RUN, chatId: CHAT, from: BID, to: AID, type: 'text', text: 'offline from bob', createdAt: Date.now() + 5, status: 'sent', readBy: [] };
  await A.App.send(fromA);
  await B.App.send(fromB);
  ok(A.WCLiveChat.pending() === 1 && B.WCLiveChat.pending() === 1,
    'each device holds its offline message in the outbox', { a: A.WCLiveChat.pending(), b: B.WCLiveChat.pending() });

  /* the bubble is already on the sender's screen while offline */
  ok(A.DB.messages.some((m) => m.id === fromA.id), 'the offline message is visible in the sender database immediately');

  /* reconnect: A first, then B */
  A._setOnline(true);
  await wait(700);
  ok(A.WCLiveChat.pending() === 0, 'A drained its outbox on reconnect', A.WCLiveChat.pending());
  B._setOnline(true);
  await wait(900);

  /* both pull the full lane and merge, like the app does after a reconnect */
  const lane = await fetch(`${BASE}/api/chat/state?since=0`).then((r) => r.json());
  ok(lane.messages.some((m) => m.id === fromA.id) && lane.messages.some((m) => m.id === fromB.id),
    'both offline messages reached the server');
  deliver(A, lane.messages);
  deliver(B, lane.messages);
  await wait(200);

  const count = (w, id) => w.DB.messages.filter((m) => m.id === id).length;
  ok(count(A, fromA.id) === 1, 'nothing was duplicated on the sender (alice)');
  ok(count(B, fromA.id) === 1, 'alice\'s offline message landed on bob exactly once');
  ok(count(A, fromB.id) === 1, 'bob\'s offline message landed on alice exactly once');
  ok(count(B, fromB.id) === 1, 'nothing was duplicated on bob');
  ok(A.WCLiveChat.pending() === 0 && B.WCLiveChat.pending() === 0, 'both outboxes are empty after reconnect');

  /* a second merge must not create duplicates either */
  deliver(A, lane.messages);
  deliver(B, lane.messages);
  ok(count(A, fromB.id) === 1 && count(B, fromA.id) === 1, 'merging the same lane twice adds nothing');

  /* ------------------------------------------------ 3 · reply round trip */
  const reply = { id: 'm_reply_1_' + RUN, chatId: CHAT, from: BID, to: AID, type: 'text', text: 'got them', createdAt: Date.now(), status: 'sent', readBy: [] };
  const r0 = Date.now();
  await B.App.send(reply);
  let rArrived = null;
  for (let i = 0; i < 40; i++) {
    const r = await fetch(`${BASE}/api/chat/state?since=0`).then((x) => x.json());
    if (r.messages.some((m) => m.id === reply.id)) { rArrived = Date.now(); deliver(A, r.messages); break; }
    await wait(40);
  }
  ok(rArrived !== null, 'the reply arrived');
  console.log(`      reply travelled: ${rArrived ? rArrived - r0 : -1} ms`);
  ok(A.DB.messages.filter((m) => m.id === reply.id).length === 1, 'the reply is in alice\'s transcript once');

  if (process.env.WC_E2E_DEBUG) {
    console.log('A ids:', A.DB.messages.map((m) => m.id).sort().join(','));
    console.log('B ids:', B.DB.messages.map((m) => m.id).sort().join(','));
  }
  /* a long-lived lane can still hold messages from an earlier run: count only
     this run's four, and count them once per device */
  const mine = (w) => w.DB.messages.filter((m) => String(m.id).endsWith(RUN));
  const total = mine(A).length + mine(B).length;
  ok(total === 8, 'exactly the four messages, once on each device', { total, a: mine(A).length, b: mine(B).length });
  ok(mine(A).length === 4 && mine(B).length === 4, 'each device holds exactly four', { a: mine(A).map((m) => m.id), b: mine(B).map((m) => m.id) });

  console.log(pass.map((m) => '  ok   ' + m).join('\n'));
  if (fail.length) console.log(fail.map((m) => '  FAIL ' + m).join('\n'));
  console.log('\n' + (fail.length ? '✗ ' + fail.length + ' failed, ' : '✓ ') + pass.length + ' passed');
  exitCode = fail.length ? 1 : 0;
} catch (e) {
  console.log('harness error: ' + e.message);
  console.log(srvLog.slice(-600));
} finally {
  srv.kill('SIGKILL');
  process.exit(exitCode);
}
