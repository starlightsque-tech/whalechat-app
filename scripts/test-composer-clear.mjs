#!/usr/bin/env node
/* Regression test — a sent message must never come back into the chat composer.
 *
 * Reported from a phone screenshot: the user types a message, taps Send, the
 * bubble appears in the thread — and the same text is still sitting in the
 * composer above the keyboard, so it looks unsent and the user keeps clearing
 * it by hand.
 *
 * Cause: session-guard.js snapshots every field it has seen (`memory` + the
 * sessionStorage draft) and re-applies it after each re-render. The send path
 * clears the textarea programmatically (no `input` event), so the snapshot kept
 * the sent text and the next re-render pushed it into the new textarea node.
 *
 * This test drives the real public/session-guard.js in jsdom:
 *   1. type -> send -> re-render: the composer must stay empty (memory + retry)
 *   2. a full reload must not resurrect an already-sent message
 *   3. text typed AFTER sending survives a re-render
 *   4. an UNSENT draft is still restored (the feature must not regress)
 *
 * Run: npm run test:composer
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JSDOM_PATH = fs.existsSync('/home/user/node_modules/jsdom/lib/api.js')
  ? '/home/user/node_modules/jsdom/lib/api.js'
  : 'jsdom';
const mod = await import(JSDOM_PATH.startsWith('/') ? JSDOM_PATH : JSDOM_PATH);
const { JSDOM } = mod.default || mod;

const GUARD_SRC = fs.readFileSync(path.join(ROOT, 'public/session-guard.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SENT = 'Como você está aproveitando o fim de semana por aí hoje?';

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
}

function composerHTML(text = '') {
  return `<div class="chat-input">
    <textarea id="msgInput" rows="1">${text}</textarea>
    <button class="send-btn" data-act="send">send</button>
  </div>`;
}

function buildDom() {
  const dom = new JSDOM(
    `<!doctype html><html><body><div class="main chat-mode">
       <div class="content" id="content">${composerHTML('')}</div></div></body></html>`,
    { url: 'https://app.test/#/chat/caio', runScripts: 'outside-only', pretendToBeVisual: true }
  );
  dom.window.eval(GUARD_SRC);
  return dom;
}

/* the app's re-render: the whole chat screen is rewritten from its template */
function rerender(win, text = '') {
  win.document.getElementById('content').innerHTML = composerHTML(text);
  const node = win.document.createElement('div');
  node.className = 'chat-body-rerender';
  win.document.body.appendChild(node);   /* any insertion used to trigger restore */
}

function type(win, value) {
  const inp = win.document.getElementById('msgInput');
  inp.focus();
  inp.value = value;
  inp.dispatchEvent(new win.Event('input', { bubbles: true }));
  inp.dispatchEvent(new win.Event('change', { bubbles: true }));
  return inp;
}

/* what App.send / the chat-instant send override do after queueing the message */
function send(win) {
  const inp = win.document.getElementById('msgInput');
  if (inp) inp.value = '';
  rerender(win, '');
}

const val = (win) => win.document.getElementById('msgInput').value;

/* ---- 1. the reported bug ------------------------------------------------ */
{
  const dom = buildDom();
  const win = dom.window;
  await sleep(200);
  type(win, SENT);
  await sleep(280);
  send(win);
  await sleep(1000);                 /* restore pass (120ms) + retry (700ms) */
  check('sent text is cleared from the composer', val(win) === '', `value=${JSON.stringify(val(win).slice(0, 22))}`);

  /* typing after a send must not be wiped */
  type(win, 'tudo bem?');
  await sleep(300);
  rerender(win, 'tudo bem?');
  await sleep(900);
  check('text typed after the send survives a re-render', val(win) === 'tudo bem?', `value=${JSON.stringify(val(win))}`);
  win.close();
}

/* ---- 2. a reload must not bring it back --------------------------------- */
{
  const dom = buildDom();
  const win = dom.window;
  await sleep(200);
  type(win, SENT);
  await sleep(280);
  send(win);
  await sleep(300);
  /* fresh page: new DOM + a fresh copy of the guard reading sessionStorage */
  const dom2 = new JSDOM(
    `<!doctype html><html><body><div class="main chat-mode">
       <div class="content" id="content">${composerHTML('')}</div></div></body></html>`,
    { url: 'https://app.test/#/chat/caio', runScripts: 'outside-only', pretendToBeVisual: true }
  );
  /* carry the same sessionStorage (same tab) across the reload */
  try {
    const raw = win.sessionStorage.getItem('wc_draft_v1');
    dom2.window.sessionStorage.clear();
    if (raw) dom2.window.sessionStorage.setItem('wc_draft_v1', raw);
  } catch (e) {}
  dom2.window.eval(GUARD_SRC);
  await sleep(1400);
  check('reload does not restore an already-sent message',
    dom2.window.document.getElementById('msgInput').value === '',
    `value=${JSON.stringify(dom2.window.document.getElementById('msgInput').value)}`);
  win.close();
  dom2.window.close();
}

/* ---- 3. the draft feature still works ----------------------------------- */
{
  const dom = buildDom();
  const win = dom.window;
  await sleep(200);
  type(win, 'unsent half-typed draft');
  await sleep(320);
  rerender(win, '');                 /* a re-render wiped the field */
  await sleep(900);
  check('unsent draft is still restored after a re-render (feature kept)',
    val(win) === 'unsent half-typed draft', `value=${JSON.stringify(val(win))}`);
  win.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
