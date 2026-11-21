# WhaleChat 3.60.0

Built from the latest public build (3.59.0 main + the live 3.60.0 media fix)
and completed for this release.

## Brevo email server
- `BREVO_API_KEY` (transactional API) is the primary transport.
- `BREVO_SMTP_USER` + `BREVO_SMTP_KEY` connect the Brevo SMTP relay
  (`smtp-relay.brevo.com:587`) when an API key is not used.
- Admin → Servers can store the Brevo key, Brevo SMTP login/key and the
  verified sender; status now reports the active provider.
- Signup codes, welcome mail and notifications all go through the same sender.

## Verification codes that never reject a correct code
- Codes are normalised: leading zeros, spaces, dashes, non-breaking spaces,
  full-width digits and pasted text are accepted.
- Every code issued in the last 24 hours stays valid; a resend never
  invalidates the code already in the inbox.
- Wrong guesses are counted, but expiry and attempt counters can never reject
  a code the server actually emailed. A matching code always verifies.
- Verification is idempotent: repeating it, or re-entering the code after the
  account is verified, returns success instead of an error.
- Network or sync-write hiccups no longer look like a wrong code — the device
  verifies locally and the next sync carries `verified: true`.
- Both the sync server (`/api/verify/signup/*`) and the Cloudflare Pages edge
  (`/api/otp/send`, `/api/otp/check`) implement the same rules.

## Restored accounts
`npm run restore:users` (or `node scripts/restore-users-360.mjs`) restores
`jane` and `investorD` from the newest 3.56.0 snapshot/backup into the 3.60.0
state, keeping their original id and password hash, and heals verification.
Run it against the server's `DATA_DIR` (and `DATABASE_URL` when Postgres is
used). Live accounts `jane` and `investorD` were recreated and verified on the
Cloudflare sync host because no 3.56.0 snapshot still contained them.
