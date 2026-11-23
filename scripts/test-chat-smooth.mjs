#!/usr/bin/env node
/* Regression test — chatting must never be interrupted (3.63.0).
 *
 * Reported by users: "the app kept shaking as if it's tripping on and off
 * quickly and kept on interrupting my typing" — every background change used
 * to rebuild `app.innerHTML`, which destroyed the composer, re-focused it (the
 * keyboard flashed) and scrolled the thread.
 *
 * This test boots the real built app in jsdom and checks:
 *   1. a background render (typing notice / delivery tick / sync) does not
 *      replace the composer node, clear its text or steal its focus
 *   2. an incoming message is appended in place while the user is typing
 *   3. sending keeps the composer focused, empty, and shows the bubble
 *   4. stickers send and save on the account (user.stickers)
 *   5. a posted status can be deleted from the Status screen
 *
 * Run: node scripts/test-chat-smooth.mjs      (npm run test:smooth-chat)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JSDOM_PATH = fs.existsSync('/home/user/node_modules/jsdom/lib/api.js')
  ? '/home/user/node_modules/jsdom/lib/api.js'
  : 'jsdom';
const mod = await import(JSDOM_PATH);
const { JSDOM } = mod.default || mod;

const APP = fs.readFileSync(path.join(ROOT, 'public/whalechat.html'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
}

const ME = 'u_me';
const OTHER = 'u_friend';

function seed() {
  const now = Date.now();
  const db = {
    version: 1,
    users: [
      {
        id: ME, fullName: 'Ada Whale', username: 'ada', email: 'ada@test.dev', password: 'x',
        role: 'user', emailVerified: true, verified: true, balance: 0, createdAt: now - 8.64e7,
        settings: {}, cart: [], stickers: [], stickerRecent: []
      },
      {
        id: OTHER, fullName: 'Sam Tide', username: 'sam', email: 'sam@test.dev', password: 'x',
        role: 'user', emailVerified: true, verified: true, balance: 0, createdAt: now - 8.64e7,
        settings: {}, cart: []
      }
    ],
    vendors: [], companyProducts: [], products: [], orders: [], deposits: [], withdrawals: [],
    messages: [{ id: 'm1', chatId: [ME, OTHER].sort().join('__'), from: OTHER, to: ME, type: 'text', text: 'hey!', createdAt: now - 60000, status: 'sent', deleted: false, readBy: [] }],
    statuses: [{ id: 'st1', userId: ME, type: 'text', text: 'my first status', bg: 'linear-gradient(135deg,#0f766e,#0ea5e9)', createdAt: now - 3600000, privacy: 'everyone', viewers: [], selected: [] }],
    chatsMeta: {}, referrals: [], purchases: [], blocks: [], notifications: [], txs: [], reports: [],
    refunds: [], vendorApplications: [], bonuses: [], bonusClaims: [], emailCampaigns: [], traffic: [],
    contacts: [{ id: 'c1', ownerId: ME, userId: OTHER, createdAt: now }, { id: 'c2', ownerId: OTHER, userId: ME, createdAt: now }],
    settings: {}
  };
  return JSON.stringify(db);
}

function makeDom(hash) {
  const dom = new JSDOM(APP, {
    url: 'https://app.test/' + (hash || ''),
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(win) {
      win.localStorage.setItem('whalechat.db.v1', seed());
      win.localStorage.setItem('whalechat.session.v1', JSON.stringify({ userId: ME, at: Date.now() }));
      win.matchMedia = win.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
      if (!win.BroadcastChannel) win.BroadcastChannel = class { constructor() {} postMessage() {} close() {} };
      if (!win.requestIdleCallback) win.requestIdleCallback = (fn) => setTimeout(() => fn({ timeRemaining: () => 8 }), 1);
      win.Notification = win.Notification || { permission: 'denied', requestPermission: async () => 'denied' };
      Object.defineProperty(win.navigator, 'serviceWorker', { value: { register: async () => ({}), addEventListener() {}, ready: Promise.resolve({}) }, configurable: true });
      win.fetch = async () => ({ ok: false, status: 404, json: async () => ({ ok: false }), text: async () => '' });
      win.indexedDB = undefined;
      win.alert = () => {};
      win.confirm = () => true;
    }
  });
  return dom;
}

function composer() { return null; }

async function main() {
  const dom = makeDom('#/chat/' + OTHER);
  const win = dom.window;
  await sleep(2500);

  const doc = win.document;
  const inp = doc.getElementById('msgInput');
  check('chat screen opened with a composer', !!inp);
  if (!inp) { finish(); return; }

  /* ---- 1. background render must not touch the composer ---------------- */
  inp.focus();
  inp.value = 'I am typing a long message';
  inp.dispatchEvent(new win.Event('input', { bubbles: true }));
  await sleep(120);

  const before = inp;
  let intercepted = false;
  win.eval('(function(){ try { intercepted = !!(window.WC_SMOOTH && WC_SMOOTH.intercept()); } catch(e) { intercepted = false; } })()');
  intercepted = win.intercepted === true || win.eval('window.__wcProbeIntercept = !!(window.WC_SMOOTH && WC_SMOOTH.composerActive());');
  check('the smooth-chat guard exists', !!(win.WC_SMOOTH && win.WC_SMOOTH.intercept));
  check('composer counts as active while typing', win.WC_SMOOTH.composerActive() === true);
  check('render() is intercepted while typing (no rebuild)', win.WC_SMOOTH.intercept() === true);

  /* the real render() path — exactly what the intervals used to call */
  win.eval('render()');
  const after = doc.getElementById('msgInput');
  check('composer element survives a background render', after === before);
  check('typed text is not lost', (after && after.value) === 'I am typing a long message', JSON.stringify(after && after.value));
  check('focus stays in the composer', doc.activeElement === after);

  /* ---- 2. an incoming message is appended in place --------------------- */
  win.eval(`(function(){
    DB.messages.push({ id:'m2', chatId: '${[ME, OTHER].sort().join('__')}', from:'${OTHER}', to:'${ME}', type:'text', text:'incoming while you type', createdAt: Date.now(), status:'sent', deleted:false, readBy:[] });
    if (window.WC_SMOOTH) WC_SMOOTH.syncChat();
  })()`);
  await sleep(120);
  const bubbles = doc.querySelectorAll('[data-msg="m2"]');
  check('incoming message appears without a rebuild', bubbles.length === 1);
  check('composer still holds the draft after the incoming message', doc.getElementById('msgInput') === before && before.value.length > 0);
  check('focus still in the composer after the incoming message', doc.activeElement === before);

  /* ---- 3. sending ------------------------------------------------------ */
  win.eval('App.send()');
  await sleep(400);
  const afterSend = doc.getElementById('msgInput');
  check('composer is empty after sending', afterSend && afterSend.value === '', JSON.stringify(afterSend && afterSend.value));
  check('composer element not replaced by the send', afterSend === before);
  const outgoing = doc.querySelectorAll('.msg.out');
  check('the sent bubble is on screen', outgoing.length >= 1);
  check('typing is possible right after sending', afterSend && (doc.activeElement === afterSend || doc.activeElement === doc.body));

  /* ---- 3b. a real navigation still rebuilds the screen ------------------ */
  afterSend.blur();
  doc.body.focus && doc.body.focus();
  await sleep(80);
  win.eval('render()');
  await sleep(80);
  const afterBlur = doc.getElementById('msgInput');
  check('with nobody typing a full render still rebuilds the screen', afterBlur !== afterSend);

  /* presence paint must not rebuild either */
  win.eval(`TYPING['${[ME, OTHER].sort().join('__')}'] = TYPING['${[ME, OTHER].sort().join('__')}'] || {}; TYPING['${[ME, OTHER].sort().join('__')}']['${OTHER}'] = Date.now();`);
  const headBefore = doc.getElementById('chatHeadSub');
  win.eval('WC_SMOOTH.paintPresence()');
  await sleep(60);
  check('the header painting does not replace the composer', doc.getElementById('msgInput') === afterBlur);
  check('the typing notice is painted in the header',
    (doc.getElementById('chatHeadSub') || {}).textContent === 'typing…',
    JSON.stringify((doc.getElementById('chatHeadSub') || {}).textContent));
  check('header node itself was not recreated', doc.getElementById('chatHeadSub') === headBefore);

  /* ---- 3c. navigation while typing still works ------------------------- */
  win.eval(`go('home')`);
  await sleep(400);
  check('tapping away while the composer is focused still navigates',
    !doc.querySelector('.chat-room') && !!doc.querySelector('.content'),
    win.eval('location.hash'));
  win.eval(`go('chat/${OTHER}')`);
  await sleep(600);
  check('the chat reopens after navigating back', !!doc.getElementById('msgInput'));

  /* ---- 4. stickers ------------------------------------------------------ */
  const stickerApi = win.WC_STICKERS;
  check('sticker engine loaded', !!stickerApi);
  const nBefore = win.eval('DB.messages.length');
  win.eval(`WC_STICKERS.save('b:mood:1'); WC_STICKERS.send('b:mood:1')`);
  await sleep(300);
  const nAfter = Number(win.eval('DB.messages.length'));
  check('a sticker message was sent', nAfter === nBefore + 1, `${nBefore} -> ${nAfter}`);
  const last = win.eval('DB.messages[DB.messages.length-1]');
  check('the message is type sticker', last && last.type === 'sticker', last && last.type);
  const savedList = win.eval('(me().stickers||[])');
  check('the sticker was saved on the account', Array.isArray(savedList) && savedList.some((s) => s.ref === 'b:mood:1'));
  await sleep(120);
  check('the sticker bubble is rendered', doc.querySelectorAll('.stk-tile').length >= 1);

  /* ---- 5. status delete ------------------------------------------------- */
  win.eval(`go('status')`);
  await sleep(500);
  check('status screen lists my post with a delete control',
    !!doc.querySelector('[data-act="delete-status"]'));
  win.eval(`confirmDialog = async () => true`);
  win.eval(`App.deleteStatus('st1')`);
  await sleep(400);
  const statuses = win.eval('DB.statuses.length');
  check('the status was deleted from the account', statuses === 0, 'left=' + statuses);

  win.close();
  finish();
}

function finish() {
  const failed = results.filter((r) => !r.ok);
  console.log('---');
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('TEST CRASHED', e);
  process.exit(1);
});
