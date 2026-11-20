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

Create an API key in Brevo → **SMTP & API → API keys** (`xkeysib-…`) and set
`BREVO_API_KEY`. Add an approved SMS sender in Brevo → **SMS** and set
`BREVO_SMS_SENDER` (max 11 alphanumeric characters).

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
use, and `GET /api/telesign/status` reports `provider: "brevo"` for SMS.
