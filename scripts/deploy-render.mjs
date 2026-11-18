#!/usr/bin/env node
/* Deploy WhaleChat to Render from this machine.

     RENDER_API_KEY=rnd_... BREVO_API_KEY=xkeysib-... npm run deploy:render

   What it does
     1. finds the `whalechat` web service on the key's workspace (creates it
        from this repo if it does not exist yet, with the 1 GB disk the
        database needs)
     2. pushes the runtime secrets it is given (Brevo, Finnhub) into the
        service environment — they are never written into the repo
     3. triggers a deploy of `main` and follows it until it is live

   Secrets are read from the environment only, never printed. */
import fs from 'node:fs';
import path from 'node:path';

const API = 'https://api.render.com/v1';
const KEY = process.env.RENDER_API_KEY || '';
const BREVO = process.env.BREVO_API_KEY || '';
const FINNHUB = process.env.FINNHUB_API_KEY || '';
const SERVICE_NAME = process.env.RENDER_SERVICE_NAME || 'whalechat';
const BRANCH = process.env.RENDER_BRANCH || 'main';
const REPO = process.env.RENDER_REPO || 'https://github.com/starlightsque-tech/whalechat-app';
const PLAN = process.env.RENDER_PLAN || 'starter';

if (!KEY) {
  console.error('RENDER_API_KEY is not set.');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, route, body) {
  const res = await fetch(API + route, {
    method,
    headers: {
      Authorization: 'Bearer ' + KEY,
      'content-type': 'application/json',
      accept: 'application/json'
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  if (!res.ok) {
    const msg = (data && data.message) || text || res.statusText;
    const err = new Error(method + ' ' + route + ' → ' + res.status + ' ' + msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/* ---------------------------------------------------------------- owner */
const owners = await api('GET', '/owners?limit=20');
const ownerId = owners && owners[0] && owners[0].owner && owners[0].owner.id;
if (!ownerId) {
  console.error('No Render workspace found for this key.');
  process.exit(1);
}

/* -------------------------------------------------------------- service */
let services = await api('GET', '/services?limit=100');
let entry = (services || []).map((s) => s.service || s).find((s) => s.name === SERVICE_NAME);

const release = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'public', 'release.json'), 'utf8'));

if (!entry) {
  console.log('creating service ' + SERVICE_NAME + ' (' + PLAN + ', disk 1GB) …');
  const envVars = [
    { key: 'DATA_DIR', value: '/var/data' },
    { key: 'VAPID_EMAIL', value: 'support@whalechat.app' },
    { key: 'MAIL_FROM', value: 'whalechat1@gmail.com' },
    { key: 'MAIL_FROM_NAME', value: 'WhaleChat' },
    { key: 'FINNHUB_MODE', value: 'live' },
    { key: 'ADMIN_SESSION_SECRET', generateValue: true },
    { key: 'WC_ENCRYPTION_KEY', generateValue: true }
  ];
  if (BREVO) envVars.push({ key: 'BREVO_API_KEY', value: BREVO });
  if (FINNHUB) envVars.push({ key: 'FINNHUB_API_KEY', value: FINNHUB });

  try {
    const created = await api('POST', '/services', {
      type: 'web_service',
      name: SERVICE_NAME,
      ownerId,
      repo: REPO,
      branch: BRANCH,
      autoDeploy: 'yes',
      serviceDetails: {
        env: 'node',
        plan: PLAN,
        region: process.env.RENDER_REGION || 'oregon',
        healthCheckPath: '/api/health',
        envSpecificDetails: {
          buildCommand: 'node scripts/prepare-assets.js && npm install --omit=dev',
          startCommand: 'node server.js'
        },
        disk: { name: SERVICE_NAME + '-data', mountPath: '/var/data', sizeGB: 1 },
        envVars
      }
    });
    entry = created.service || created;
    console.log('created ' + entry.id);
  } catch (e) {
    if (e.status === 402) {
      console.error('\nRender refused the service: ' + ((e.data && e.data.message) || 'payment required'));
      console.error('That is an account billing state (402 billing_suspended), not a code problem.');
      console.error('Settle the invoice / add a payment method on Render, then re-run this command.');
      process.exit(3);
    }
    throw e;
  }
} else {
  console.log('service exists: ' + entry.id + ' (' + entry.serviceDetails?.plan + ', ' + entry.serviceDetails?.region + ')');
}

/* ----------------------------------------------------------- env secrets */
async function setEnv(key, value) {
  try {
    await api('PUT', '/services/' + entry.id + '/env-vars/' + encodeURIComponent(key), { value });
    console.log('env ' + key + ' set');
  } catch (e) {
    /* older API shape: add to the list */
    const cur = await api('GET', '/services/' + entry.id + '/env-vars?limit=100').catch(() => []);
    const list = (cur || []).map((v) => v.envVar || v).filter((v) => v && v.key && v.key !== key);
    list.push({ key, value });
    await api('PUT', '/services/' + entry.id + '/env-vars', list.map((v) => ({ key: v.key, value: v.value })));
    console.log('env ' + key + ' set (list update)');
  }
}
if (BREVO) await setEnv('BREVO_API_KEY', BREVO);
if (FINNHUB) await setEnv('FINNHUB_API_KEY', FINNHUB);

/* -------------------------------------------------------------- deploy */
const deploy = await api('POST', '/services/' + entry.id + '/deploys', { clearCache: 'do_not_clear' });
const deployId = (deploy && (deploy.deploy || deploy)).id;
console.log('deploy started for ' + BRANCH + ' (' + release.version + ') · ' + deployId);

let status = '';
for (let i = 0; i < 90; i++) {
  await sleep(5000);
  const d = await api('GET', '/services/' + entry.id + '/deploys/' + deployId).catch(() => null);
  const dep = d && (d.deploy || d);
  status = dep && dep.status;
  if (i % 6 === 0) console.log('  ' + status + ' …');
  if (status === 'live' || status === 'build_failed' || status === 'canceled' || status === 'deactivated') break;
}

const host = (entry.serviceDetails && entry.serviceDetails.url) || entry.service?.url || ('https://' + SERVICE_NAME + '.onrender.com');
console.log('\nstatus: ' + status);
console.log('url:    ' + host);
if (status !== 'live') {
  console.error('Deploy did not reach live — check the Render dashboard log for ' + deployId);
  process.exit(1);
}
const health = await fetch(host + '/api/health').then((r) => r.json()).catch(() => null);
console.log('health: ' + JSON.stringify(health && {
  ok: health.ok, version: health.version, email: health.email, push: health.push, storage: health.storage
}));
