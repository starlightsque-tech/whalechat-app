# WhaleChat 3.46 · Market Controls, admin sessions, audit log

Set these environment variables before deploying 3.46 (long random strings, `openssl rand -hex 32`):

- `ADMIN_SESSION_SECRET` signs admin session tokens. Without it, admins must re-confirm their password after every restart.
- `WC_ENCRYPTION_KEY` encrypts provider API keys (AES-256-GCM). Without it, keys cannot be saved in Admin > Market Controls. Never change it once keys are saved, or they must be re-entered.
- `DATABASE_URL` (Postgres or Supabase). The server creates `market_provider_config`, `tradable_symbols`, `trading_controls`, `admin_logs` and `market_price_cache` on boot from `db/migrations/001_market_admin.sql`, including Row Level Security. Without it, these settings and the audit log live in memory and reset on restart.

Behaviour:

- `/api/market/quote` and `/api/market/symbols` read only from `market_price_cache` / `tradable_symbols`. The cache is written only from Binance, Twelve Data or Finnhub; the database rejects any other price source. On provider failure the last cached price is returned with `is_delayed: true` and the label "Delayed Data". With no cached price the API returns `503 no_price`, never an invented price.
- Admin endpoints need a server-issued admin session (`POST /api/admin/session`, then the `x-admin-token` header). The web app asks the admin for their password once per tab.
- Every admin change in Market Controls and the Shares admin is written to `admin_logs` (append-only) with old and new values, admin, IP and user agent.
- RLS: the server connects as the table owner, which bypasses RLS, and enforces admin access itself. RLS protects direct database access (e.g. Supabase anon/authenticated clients); admins there are identified by `app_metadata.role = 'admin'` in their JWT.
