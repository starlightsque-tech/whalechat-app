#!/usr/bin/env node
/* Verify the live WhaleChat Cloudflare database is bound and holding data.
   Usage: CLOUDFLARE_API_TOKEN=… node scripts/check-cloudflare-db.mjs
   Optional: CLOUDFLARE_ACCOUNT_ID, WORKER_NAME, D1_NAME. */
const TOKEN = process.env.CLOUDFLARE_API_TOKEN || '';
const API = 'https://api.cloudflare.com/client/v4';
if (!TOKEN) { console.error('CLOUDFLARE_API_TOKEN is required'); process.exit(2); }
const H = { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' };
const get = async (url) => (await fetch(url, { headers: H })).json();
const post = async (url, body) => (await fetch(url, { method: 'POST', headers: H, body: JSON.stringify(body) })).json();

let accountId = process.env.CLOUDFLARE_ACCOUNT_ID || '';
if (!accountId) {
  const acc = await get(API + '/accounts');
  accountId = ((acc.result || [])[0] || {}).id || '';
}
if (!accountId) { console.error('No Cloudflare account found'); process.exit(2); }

const worker = process.env.WORKER_NAME || 'whalechat-api';
const settings = await get(`${API}/accounts/${accountId}/workers/scripts/${worker}/settings`);
const bindings = (settings.result && settings.result.bindings) || [];
const d1 = bindings.find((b) => b.type === 'd1' && b.name === 'DB');
if (!d1) { console.error('❌ worker ' + worker + ' has no D1 binding named DB'); process.exit(1); }

const q = async (sql) => {
  const r = await post(`${API}/accounts/${accountId}/d1/database/${d1.database_id}/query`, { sql });
  if (!r.success) throw new Error(JSON.stringify(r.errors));
  return (r.result && r.result[0] && r.result[0].results) || [];
};
const tables = (await q("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")).map((r) => r.name);
const chunks = await q('SELECT count(*) n, coalesce(sum(length(chunk)),0) bytes FROM app_state_chunks WHERE id = 1');
const users = await q('SELECT count(*) n FROM users');
const restored = await q("SELECT username, email FROM users WHERE lower(username) IN ('jane','investord') ORDER BY username");
const state = await get(`https://${worker}.${(process.env.WORKERS_SUBDOMAIN || 'starlightsque')}.workers.dev/api/health`).catch(() => ({}));

console.log(JSON.stringify({
  ok: true,
  accountId,
  worker,
  d1: { name: 'whalechat_db', id: d1.database_id },
  tables,
  stateChunks: chunks[0] || null,
  users: (users[0] || {}).n || 0,
  restoredUsers: restored,
  liveWorker: state && state.ok ? { version: state.version, users: state.users, rev: state.rev } : 'unreachable'
}, null, 2));
