# Brevo SMTP, email and SMS

WhaleChat 3.77 uses Brevo for every outbound message.

## 1. Create the SMTP key

Brevo → **SMTP & API → SMTP** → *Generate a new SMTP key*.

- Host: `smtp-relay.brevo.com`
- Port: `587` (STARTTLS) or `465` (implicit TLS)
- SMTP user: your Brevo login email
- SMTP key: starts with `xsmtpsib-`

Set `BREVO_SMTP_USER`, `BREVO_SMTP_KEY`, and a verified `MAIL_FROM` sender.
The Node server uses `smtp.js` (dependency-free); the Appwrite Function uses
the same module bundled in `appwrite-function/smtp.js`.

## 2. SMS / OTP

SMS notifications and OTP are sent through **Telesign** first. Set
`TELESIGN_CUSTOMER_ID` and `TELESIGN_API_KEY` (and optionally
`TELESIGN_SENDER_ID`). If Telesign is absent or a send fails, WhaleChat falls
back to Brevo transactional SMS: create an API key in Brevo → **SMTP & API →
API keys** (`xkeysib-…`), set `BREVO_API_KEY`, add an approved SMS sender in
Brevo → **SMS** and set `BREVO_SMS_SENDER` (max 11 characters).

The OTP flow:

1. `POST /api/telesign/start {phone, purpose}` — generates a 6-digit code,
   hashes it, sends the SMS through Brevo, returns `referenceId`.
2. `POST /api/telesign/verify {phone, code}` — single use, 5 attempts,
   5-minute expiry.
3. `POST /api/telesign/sms` — one-off notification (admin desk).
4. `POST /api/telesign/broadcast` — audience broadcast with an optional
   tappable link "button".

Telesign variables remain supported and take precedence when configured.

## 3. Verify

```bash
BREVO_SMTP_USER=you@example.com BREVO_SMTP_KEY=xsmtpsib-... \
  npm run test:brevo -- --to=you@example.com
```

`GET /api/email/status` reports `provider: "brevo-smtp"` when the relay is in
use, and `GET /api/telesign/status` reports `provider: "telesign"` (or `brevo` when the fallback is active).
