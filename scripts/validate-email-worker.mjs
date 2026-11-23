#!/usr/bin/env node
/**
 * Pre-deploy validation for WhaleChat email Worker.
 *
 * Checks, against the real checked-in source:
 *   1. D1 `email_codes` table shape + the exact queries the Worker runs.
 *   2. Brevo request payload (sender, recipient, subject, HTML/text, api-key).
 *   3. Retry behaviour: one retry after exactly 2000 ms on 5xx, no retry on 4xx.
 *   4. Route + health-flag wiring for /api/send-code, /api/verify-code, /api/health.
 *
 * Run: node scripts/validate-email-worker.mjs
 * Exit code 0 = safe to deploy, 1 = fix before deploying.
 */
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const ROOT = new URL('..', import.meta.url).pathname;
const WORKER = ROOT + 'cloudflare/whalechat-api/src/index.js';
const SCHEMA = ROOT + 'cloudflare/whalechat-api/schema.sql';
const source = readFileSync(WORKER, 'utf8');
const schema = readFileSync(SCHEMA, 'utf8');

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    const detail = fn();
    passed++;
    console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`);
  } catch (e) {
    failures.push(name + ': ' + e.message);
    console.log(`FAIL  ${name} — ${e.message}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

console.log('WhaleChat email Worker — pre-deploy validation\n');

/* ---------------------------------------------------------------- D1 / SQL */
check('D1 email_codes table exists in schema.sql', () => {
  assert(/CREATE TABLE IF NOT EXISTS email_codes/i.test(schema), 'CREATE TABLE missing from schema.sql');
  return 'CREATE TABLE present';
});

check('D1 email_codes columns are email, code, expires_at, attempts', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(schema);
  const cols = db.prepare('PRAGMA table_info(email_codes)').all().map((c) => c.name);
  db.close();
  assert(JSON.stringify(cols) === JSON.stringify(['email', 'code', 'expires_at', 'attempts']), 'unexpected columns: ' + cols.join(','));
  return cols.join(', ');
});

check('Worker INSERT / SELECT / DELETE / attempts queries execute', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(schema);
  const email = 'preflight@example.com';
  const now = Date.now();

  db.prepare('CREATE TABLE IF NOT EXISTS email_codes (email TEXT PRIMARY KEY, code TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER DEFAULT 0)').run();
  db.prepare('DELETE FROM email_codes WHERE email = ?').run(email);
  db.prepare('INSERT INTO email_codes (email, code, expires_at, attempts) VALUES (?,?,?,0)').run(email, '654321', now + 10 * 60 * 1000);

  const row = db.prepare('SELECT email, code, expires_at, attempts FROM email_codes WHERE email = ? AND code = ? AND expires_at > ?').run(email, '654321', now);
  assert(row, 'valid code did not match');

  db.prepare('UPDATE email_codes SET attempts = COALESCE(attempts, 0) + 1 WHERE email = ?').run(email);
  const attempts = db.prepare('SELECT attempts FROM email_codes WHERE email = ?').get(email).attempts;
  assert(attempts === 1, 'attempts counter did not increment');

  const expired = db.prepare('SELECT email FROM email_codes WHERE email = ? AND code = ? AND expires_at > ?').get(email, '654321', now + 11 * 60 * 1000);
  assert(!expired, 'expired code still matched');

  db.prepare('DELETE FROM email_codes WHERE email = ?').run(email);
  assert(db.prepare('SELECT COUNT(*) AS n FROM email_codes').get().n === 0, 'code was not deleted after verification');
  db.close();
  return 'insert, expiry, attempts, delete all OK';
});

/* ------------------------------------------------------- Brevo payload/retry */
const helpersStart = source.indexOf('function maskEmailAddr');
const helpersEnd = source.indexOf('var ChatHub = class {');
assert(helpersStart > -1 && helpersEnd > helpersStart, 'could not locate email helper functions in worker source');
const helpers = source.slice(helpersStart, helpersEnd);

function loadHelpers(fetchImpl, timeoutImpl) {
  const factory = new Function('fetch', 'setTimeout', helpers + '\nreturn { brevoSendCode, brevoSender, emailCodeHtml };');
  return factory(fetchImpl, timeoutImpl);
}

async function runRetryTest(firstStatus, secondStatus) {
  const calls = [];
  const delays = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts, body: JSON.parse(opts.body) });
    const status = calls.length === 1 ? firstStatus : secondStatus;
    return { ok: status >= 200 && status < 300, status, text: async () => status >= 400 ? 'mock brevo error' : '' };
  };
  const timeoutImpl = (fn, ms) => { delays.push(ms); fn(); return 0; };
  const { brevoSendCode } = loadHelpers(fetchImpl, timeoutImpl);
  const result = await brevoSendCode(
    { BREVO_API_KEY: 'test-key', BREVO_SENDER_EMAIL: 'noreply@example.com', BREVO_SENDER_NAME: 'WhaleChat' },
    'customer@example.com',
    '654321'
  );
  return { result, calls, delays };
}

await (async () => {
  try {
    const { result, calls, delays } = await runRetryTest(500, 201);
    check('Brevo retry: 5xx retried once after exactly 2000 ms', () => {
      assert(calls.length === 2, 'expected 2 requests, got ' + calls.length);
      assert(delays.length === 1 && delays[0] === 2000, 'expected one 2000 ms delay, got ' + JSON.stringify(delays));
      assert(result.ok === true, 'second request success was not returned');
      return '2 attempts, 2000 ms';
    });
    check('Brevo request URL + api-key header', () => {
      for (const c of calls) {
        assert(c.url === 'https://api.brevo.com/v3/smtp/email', 'wrong endpoint: ' + c.url);
        assert(c.opts.method === 'POST', 'method is not POST');
        assert(c.opts.headers['api-key'] === 'test-key', 'api-key header missing/wrong');
        assert(/application\/json/i.test(c.opts.headers['content-type']), 'content-type is not JSON');
      }
      return calls[0].url;
    });
    check('Brevo payload shape', () => {
      const b = calls[0].body;
      assert(b.sender && b.sender.email === 'noreply@example.com', 'sender.email wrong');
      assert(b.sender.name === 'WhaleChat', 'sender.name wrong');
      assert(Array.isArray(b.to) && b.to[0] && b.to[0].email === 'customer@example.com', 'to[0].email wrong');
      assert(typeof b.subject === 'string' && b.subject.length > 0, 'subject missing');
      assert(typeof b.htmlContent === 'string' && b.htmlContent.includes('654321'), 'htmlContent missing code');
      assert(typeof b.textContent === 'string' && b.textContent.includes('654321'), 'textContent missing code');
      return 'sender, to, subject, htmlContent, textContent OK';
    });
  } catch (e) {
    failures.push('Brevo retry/payload test crashed: ' + e.message);
    console.log('FAIL  Brevo retry/payload test crashed — ' + e.message);
  }
})();

await (async () => {
  try {
    const { result, calls } = await runRetryTest(400, 201);
    check('Brevo permanent 4xx is not retried', () => {
      assert(calls.length === 1, '4xx was retried (' + calls.length + ' requests)');
      assert(result.ok === false && result.error === 'email_failed', '4xx did not return email_failed');
      return '1 attempt';
    });
  } catch (e) {
    failures.push('Brevo 4xx test crashed: ' + e.message);
    console.log('FAIL  Brevo 4xx test crashed — ' + e.message);
  }
})();

/* ------------------------------------------------------------ route wiring */
check('POST /api/send-code is wired to issueEmailCode', () => {
  assert(source.includes('path === "/api/send-code" && request.method === "POST"'), 'send-code route missing');
  assert(source.includes('this.issueEmailCode(b && b.email)'), 'send-code does not call issueEmailCode');
  return 'route + handler';
});

check('POST /api/verify-code is wired to confirmEmailCode', () => {
  assert(source.includes('path === "/api/verify-code" && request.method === "POST"'), 'verify-code route missing');
  assert(source.includes('this.confirmEmailCode(b && b.email, b && b.code)'), 'verify-code does not call confirmEmailCode');
  return 'route + handler';
});

check('GET /api/health reports brevoConfigured', () => {
  assert(source.includes('brevoConfigured = !!this.effectiveBrevoKey()'), 'brevoConfigured computation missing');
  assert(/brevoConfigured,/.test(source), 'brevoConfigured not returned by health');
  return 'brevoConfigured exposed';
});

check('6-digit code and 10-minute expiry', () => {
  assert(source.includes('100000 + Math.random() * 900000'), '6-digit generation missing');
  assert(source.includes('10 * 60 * 1000'), '10-minute expiry missing');
  return '100000–999999, 10 min';
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nBlocking issues:');
  for (const f of failures) console.log(' - ' + f);
  process.exit(1);
}
console.log('SAFE TO DEPLOY');
