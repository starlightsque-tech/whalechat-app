#!/usr/bin/env node
/* Brevo / B2B alert email check.

   Sends one real B2B alert email through the exact code path the price-alert
   watcher uses (email.js → template 'b2bAlert' → Brevo transactional API).

     BREVO_SMTP_USER=you@example.com BREVO_SMTP_KEY=xsmtpsib-... \
       npm run test:brevo -- --to=you@example.com

   Nothing is committed: the key is read from the environment only. */
'use strict';
const path = require('path');

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.split('=').slice(1).join('=') : dflt;
};

const to = arg('to', '');
const from = arg('from', process.env.MAIL_FROM || 'whalechat1@gmail.com');
const ticker = arg('ticker', 'BTCUSDT');

if (!process.env.BREVO_SMTP_KEY && !process.env.BREVO_SMTP_PASS && !process.env.BREVO_API_KEY) {
  console.error('Set BREVO_SMTP_KEY (+ BREVO_SMTP_USER) or BREVO_API_KEY first.');
  process.exit(2);
}
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
  console.error('Pass a destination: --to=you@example.com');
  process.exit(2);
}

process.env.DATA_DIR = process.env.DATA_DIR || path.join(require('os').tmpdir(), 'wc-mailtest');
process.env.MAIL_FROM = from;
process.env.MAIL_FROM_NAME = process.env.MAIL_FROM_NAME || 'WhaleChat';

const email = require('../email');

(async () => {
  const st = email.status();
  console.log('provider   ', st && st.provider);
  console.log('configured ', email.configured());
  console.log('from       ', from);
  console.log('to         ', to);

  if (st && st.provider !== 'brevo-smtp' && st.provider !== 'brevo-api' && st.provider !== 'smtp') {
    console.error('\nBrevo was not selected — check BREVO_SMTP_USER / BREVO_SMTP_KEY / MAIL_FROM.');
    process.exit(1);
  }

  const appUrl = arg('app', process.env.PUBLIC_URL || 'https://whalechat.onrender.com');
  const queued = email.enqueue({
    key: 'brevo-check:' + Date.now(),
    to,
    template: 'b2bAlert',
    data: {
      user: { fullName: 'WhaleChat test', username: 'whalechat-test' },
      ticker,
      side: 'buy',
      price: 100.25,
      target: 100.5,
      buyUrl: appUrl + '/whalechat.html#/investment/b2b',
      sellUrl: appUrl + '/whalechat.html#/investment/b2b'
    },
    appUrl
  });
  console.log('queued     ', queued);

  const before = (email.status() || {});
  const res = await email.flush();
  const after = email.status();

  console.log('flush      ', res);
  console.log('status     ', {
    queued: after && after.queued,
    sent: after && after.sent,
    failed: after && after.failed,
    lastError: after && after.lastError
  });

  const ok = !!(after && Number(after.sent) > Number(before.sent || 0));
  console.log(ok ? '\nBrevo accepted the B2B alert email — count it in the inbox (' + to + ').' : '\nSend did not confirm — see lastError above.');
  process.exit(ok ? 0 : 1);
})();
