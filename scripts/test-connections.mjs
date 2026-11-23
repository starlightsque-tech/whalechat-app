#!/usr/bin/env node
/* Servers & API — Worker regression test (3.63.0)
 *
 * Drives the real ChatHub class from cloudflare/whalechat-api/src/index.js with
 * a fake D1 database and a fake network, so the admin panel's connect/verify/
 * test paths are exercised without deploying:
 *   1. only an admin may read or change the connections
 *   2. an app server is health-probed before it is accepted (bad URL refused)
 *   3. the Brevo key is verified before it is stored (bad key refused)
 *   4. the saved key is used by the email engine, not only the Worker secret
 *   5. settings are persisted in D1 app_state (survive a redeploy)
 *
 * Run: node scripts/test-connections.mjs     (npm run test:connections)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'cloudflare/whalechat-api/src/index.js');
/* the bundled Worker installs a Cloudflare `process` shim; keep Node's own so
   the test can report its results */
const realProcess = globalThis.process;
const realExit = realProcess.exit.bind(realProcess);
const realConsole = globalThis.console;
const mod = await import(SRC);
globalThis.process = realProcess;
globalThis.console = realConsole;
const ChatHub = mod.ChatHub;

const SRC_TEXT = fs.readFileSync(SRC, 'utf8');
const results = [];
/* the bundled Worker replaces console/process with Cloudflare shims, so the
   test writes straight to fd 1 */
function say(line) {
  try { fs.writeSync(1, line + '\n'); } catch (e) { console.log(line); }
}
function check(name, ok, extra = '') {
  results.push({ name, ok });
  say(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
}

/* ---------------- fake D1 ---------------- */
function fakeDB() {
  const kv = new Map();
  return {
    kv,
    prepare(sql) {
      const stmt = {
        _args: [],
        bind(...a) { stmt._args = a; return stmt; },
        async first() {
          if (/FROM app_settings WHERE k = \?/.test(sql)) {
            const v = kv.get(stmt._args[0]);
            return v ? { v } : null;
          }
          return null;
        },
        async run() {
          if (/INSERT INTO app_settings/.test(sql)) kv.set(stmt._args[0], stmt._args[1]);
          return { success: true };
        },
        async all() { return { results: [] }; }
      };
      return stmt;
    }
  };
}

/* ---------------- fake network ---------------- */
const calls = [];
globalThis.fetch = async (input, init) => {
  const url = String(input && input.url ? input.url : input);
  calls.push({ url, init });
  const j = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  });
  if (url.endsWith('/api/health')) {
    if (url.includes('broken.example')) return j(500, { ok: false });
    return j(200, { ok: true, app: 'whalechat', version: '3.63.0', rev: 42, users: 7, storage: 'd1+durable-object' });
  }
  if (url === 'https://api.brevo.com/v3/account') {
    const key = (init && init.headers && init.headers['api-key']) || '';
    if (key === 'xkeysib-bad') return j(401, { code: 'unauthorized' });
    return j(200, { companyName: 'WhaleChat', plan: [{ type: 'free' }] });
  }
  if (url === 'https://api.brevo.com/v3/senders')
    return j(200, { senders: [{ email: 'whalechat1@gmail.com' }] });
  if (url === 'https://api.brevo.com/v3/smtp/email') return j(201, { messageId: '<test>' });
  return j(404, { error: 'no_route' });
};

/* ---------------- harness ---------------- */
const ADMIN = 'u_admin';
const USER = 'u_plain';

function hub() {
  const env = { DB: fakeDB(), BREVO_API_KEY: '' };
  const state = { storage: {}, waitUntil() {}, blockConcurrencyWhile(fn) { return fn(); } };
  const h = new ChatHub(state, env);
  h.db = { users: [{ id: ADMIN, role: 'admin', email: 'admin@whalechat.app' }, { id: USER, role: 'user', email: 'user@whalechat.app' }], messages: [], settings: {} };
  h.rev = 1;
  h.updatedAt = Date.now();
  h.scheduleSave = () => {};
  return h;
}
function req(method, body) {
  return new Request('https://whalechat-api.test/api/connections', {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
}
const bodyFn = (b) => async () => b;

async function status(h) {
  const u = new URL('https://whalechat-api.test/api/connections');
  u.searchParams.set('adminId', ADMIN);
  const r = await h.handleConnections(req('GET'), u, async () => ({}));
  return r.json();
}

async function main() {
  const h = hub();

  /* 0. the settings table (production app_state is a snapshot table) */
  check('connections use their own settings table', SRC_TEXT.includes('app_settings') && !/FROM app_state WHERE k/.test(SRC_TEXT));
  check('the settings table is created on first use', /CREATE TABLE IF NOT EXISTS app_settings/.test(SRC_TEXT));

  /* 1. admin only */
  let r = await h.handleConnections(req('GET'), new URL('https://x/api/connections'), async () => ({ adminId: USER }));
          r = await r.json();
  check('a normal user cannot read the connections', r.ok === false && r.error === 'admin_only');

  /* 2. empty state */
  let s = await status(h);
  check('status starts empty', s.ok === true && (s.app.servers || []).length === 0);
  check('no email server configured yet', s.brevo.configured === false);

  /* 3. connect an app server (probed first) */
  r = await h.handleConnections(req('POST', { adminId: ADMIN, app: { url: 'https://sync.whalechat.app/', label: 'Primary' } }), new URL('https://x/api/connections'), bodyFn({ adminId: ADMIN, app: { url: 'https://sync.whalechat.app/', label: 'Primary' } }));
  r = await r.json();
  check('a reachable app server is accepted', r.ok === true && (r.applied || []).includes('app-server'), r.error || '');
  s = r.status;
  const srv = (s.app.servers || [])[0] || {};
  check('server stored with health data', srv.url === 'https://sync.whalechat.app' && srv.connected === true && srv.rev === 42);
  check('first server becomes primary', srv.primary === true);

  /* 4. a broken server is refused */
  r = await h.handleConnections(req('POST', { adminId: ADMIN, app: { url: 'https://broken.example' } }), new URL('https://x/api/connections'), bodyFn({ adminId: ADMIN, app: { url: 'https://broken.example' } }));
  r = await r.json();
  check('an unhealthy app server is refused', r.ok === false && /server_unreachable|not_a_whalechat_server|health_http/.test(r.error), r.error);
  check('the refused server was not saved', ((r.status || {}).app.servers || []).length === 1);

  /* 5. brevo with a bad key is refused */
  r = await h.handleConnections(req('POST', { adminId: ADMIN, brevo: { apiKey: 'xkeysib-bad', from: 'whalechat1@gmail.com' } }), new URL('https://x/api/connections'), bodyFn({ adminId: ADMIN, brevo: { apiKey: 'xkeysib-bad', from: 'whalechat1@gmail.com' } }));
  r = await r.json();
  check('a rejected Brevo key is refused', r.ok === false && r.error === 'brevo_key_rejected', r.error);
  s = await status(h);
  check('the refused key was not stored', s.brevo.configured === false);

  /* 6. brevo with a good key */
  const good = 'xkeysib-0123456789abcdef';
  r = await h.handleConnections(req('POST', { adminId: ADMIN, brevo: { apiKey: good, from: 'whalechat1@gmail.com', name: 'WhaleChat' } }), new URL('https://x/api/connections'), bodyFn({ adminId: ADMIN, brevo: { apiKey: good, from: 'whalechat1@gmail.com', name: 'WhaleChat' } }));
  r = await r.json();
  s = r.status;
  check('a valid Brevo key connects the email server', r.ok === true && s.brevo.configured === true);
  check('the key is masked in the response', s.brevo.key && s.brevo.key !== good && s.brevo.key.includes('••'), s.brevo.key);
  check('the sender is stored', s.brevo.from === 'whalechat1@gmail.com');
  check('email now reports the panel as the source', s.brevo.source === 'admin panel');

  /* 7. the email engine uses the saved key (not only the Worker secret) */
  check('effective key is the one saved in the panel', h.effectiveBrevoKey() === good);

  /* 8. test email */
  r = await h.handleConnectionTest(req('POST', { adminId: ADMIN, which: 'brevo', to: 'admin@whalechat.app' }), new URL('https://x/api/connections/test'), bodyFn({ adminId: ADMIN, which: 'brevo', to: 'admin@whalechat.app' }));
  r = await r.json();
  check('test email is sent to the admin', !!(r.results && r.results.brevo && r.results.brevo.sent === true), JSON.stringify(r.results && r.results.brevo && r.results.brevo.sendError || ''));

  /* 9. test the app server */
  r = await h.handleConnectionTest(req('POST', { adminId: ADMIN, which: 'app' }), new URL('https://x/api/connections/test'), bodyFn({ adminId: ADMIN, which: 'app' }));
  r = await r.json();
  check('the app server answers the test', !!(r.results && r.results.app && r.results.app.ok));
  check('the test reports latency', (r.results.app.servers[0] || {}).latencyMs >= 0);

  /* 10. durability: a fresh hub (new deploy) reads the same settings from D1 */
  const env = h.env;
  const h2 = new ChatHub({ storage: {}, waitUntil() {} }, env);
  h2.db = { users: [{ id: ADMIN, role: 'admin' }], messages: [], settings: {} };
  const s2 = await status(h2);
  check('settings survive a restart (stored in D1)', s2.ok === true && s2.brevo.configured === true && (s2.app.servers || []).length === 1);
  check('the stored key is reused after a restart', h2.effectiveBrevoKey() === good);

  /* 11. disconnect */
  r = await h2.handleConnections(req('POST', { adminId: ADMIN, brevo: { disconnect: true } }), new URL('https://x/api/connections'), bodyFn({ adminId: ADMIN, brevo: { disconnect: true } }));
  r = await r.json();
  check('the admin can disconnect the email server', r.ok === true && r.status.brevo.configured === false);

  const failed = results.filter((x) => !x.ok);
  say('---');
  say(`${results.length - failed.length}/${results.length} checks passed`);
  realExit(failed.length ? 1 : 0);
}

try { await main(); } catch (e) {
  say('TEST CRASHED ' + (e && e.stack || e));
  realExit(1);
}
