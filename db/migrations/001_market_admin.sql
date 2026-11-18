-- =============================================================================
-- WhaleChat 3.46 · market providers, tradable symbols, trading controls,
-- admin audit log and the provider-only price cache.
-- Idempotent: the server runs this file on every boot (DATABASE_URL set).
-- Works on plain Postgres 13+ and on Supabase.
-- =============================================================================

DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pgcrypto not created (%). gen_random_uuid() is built in on PG13+.', SQLERRM;
END $$;

-- 1. market_provider_config - which provider is live ---------------------------
CREATE TABLE IF NOT EXISTS market_provider_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_name VARCHAR(50) NOT NULL UNIQUE,          -- 'binance', 'twelvedata', 'finnhub'
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  api_key_encrypted TEXT,                             -- AES-256-GCM, encrypted in the backend
  api_secret_encrypted TEXT,                          -- Binance secret, encrypted, NULL for others
  is_testnet BOOLEAN NOT NULL DEFAULT false,
  last_test_status VARCHAR(20) DEFAULT 'not_tested',  -- 'success', 'failed', 'not_tested'
  last_test_error TEXT,
  last_test_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO market_provider_config (provider_name, is_enabled) VALUES
  ('binance', true),
  ('twelvedata', true),
  ('finnhub', false)
ON CONFLICT (provider_name) DO NOTHING;

-- 2. tradable_symbols - what users can trade -----------------------------------
CREATE TABLE IF NOT EXISTS tradable_symbols (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol VARCHAR(50) NOT NULL UNIQUE,                 -- 'BINANCE:BTCUSDT', 'AAPL', 'EUR/USD'
  display_name VARCHAR(100) NOT NULL,                 -- 'Bitcoin', 'Apple'
  asset_type VARCHAR(20) NOT NULL,                    -- 'crypto', 'stock', 'forex'
  provider_name VARCHAR(50) NOT NULL REFERENCES market_provider_config(provider_name),
  provider_symbol VARCHAR(50) NOT NULL,               -- symbol as the provider expects it
  is_tradable BOOLEAN NOT NULL DEFAULT true,
  is_visible BOOLEAN NOT NULL DEFAULT true,
  min_trade_amount NUMERIC(18,2) DEFAULT 10.00,
  max_trade_amount NUMERIC(18,2) DEFAULT 10000.00,
  max_leverage INT DEFAULT 1,                         -- keep at 1 unless licensed for leverage
  price_decimals INT DEFAULT 2,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_symbols_type ON tradable_symbols(asset_type);
CREATE INDEX IF NOT EXISTS idx_symbols_tradable ON tradable_symbols(is_tradable);

INSERT INTO tradable_symbols (symbol, display_name, asset_type, provider_name, provider_symbol, price_decimals) VALUES
  ('BINANCE:BTCUSDT',  'Bitcoin',       'crypto', 'binance', 'BTCUSDT',  2),
  ('BINANCE:ETHUSDT',  'Ethereum',      'crypto', 'binance', 'ETHUSDT',  2),
  ('BINANCE:BNBUSDT',  'BNB',           'crypto', 'binance', 'BNBUSDT',  2),
  ('BINANCE:SOLUSDT',  'Solana',        'crypto', 'binance', 'SOLUSDT',  2),
  ('BINANCE:XRPUSDT',  'XRP',           'crypto', 'binance', 'XRPUSDT',  4),
  ('BINANCE:DOGEUSDT', 'Dogecoin',      'crypto', 'binance', 'DOGEUSDT', 5),
  ('BINANCE:ADAUSDT',  'Cardano',       'crypto', 'binance', 'ADAUSDT',  4),
  ('BINANCE:AVAXUSDT', 'Avalanche',     'crypto', 'binance', 'AVAXUSDT', 2),
  ('BINANCE:LINKUSDT', 'Chainlink',     'crypto', 'binance', 'LINKUSDT', 3),
  ('BINANCE:TRXUSDT',  'TRON',          'crypto', 'binance', 'TRXUSDT',  5),
  ('BINANCE:DOTUSDT',  'Polkadot',      'crypto', 'binance', 'DOTUSDT',  3),
  ('BINANCE:LTCUSDT',  'Litecoin',      'crypto', 'binance', 'LTCUSDT',  2),
  ('AAPL',  'Apple',          'stock', 'twelvedata', 'AAPL',  2),
  ('MSFT',  'Microsoft',      'stock', 'twelvedata', 'MSFT',  2),
  ('NVDA',  'NVIDIA',         'stock', 'twelvedata', 'NVDA',  2),
  ('TSLA',  'Tesla',          'stock', 'twelvedata', 'TSLA',  2),
  ('AMZN',  'Amazon',         'stock', 'twelvedata', 'AMZN',  2),
  ('GOOGL', 'Alphabet',       'stock', 'twelvedata', 'GOOGL', 2),
  ('META',  'Meta Platforms', 'stock', 'twelvedata', 'META',  2),
  ('NFLX',  'Netflix',        'stock', 'twelvedata', 'NFLX',  2),
  ('AMD',   'AMD',            'stock', 'twelvedata', 'AMD',   2),
  ('JPM',   'JPMorgan Chase', 'stock', 'twelvedata', 'JPM',   2),
  ('V',     'Visa',           'stock', 'twelvedata', 'V',     2),
  ('DIS',   'Disney',         'stock', 'twelvedata', 'DIS',   2),
  ('EUR/USD', 'Euro / US Dollar',              'forex', 'twelvedata', 'EUR/USD', 5),
  ('GBP/USD', 'British Pound / US Dollar',     'forex', 'twelvedata', 'GBP/USD', 5),
  ('USD/JPY', 'US Dollar / Japanese Yen',      'forex', 'twelvedata', 'USD/JPY', 3),
  ('AUD/USD', 'Australian Dollar / US Dollar', 'forex', 'twelvedata', 'AUD/USD', 5),
  ('USD/CAD', 'US Dollar / Canadian Dollar',   'forex', 'twelvedata', 'USD/CAD', 5),
  ('USD/CHF', 'US Dollar / Swiss Franc',       'forex', 'twelvedata', 'USD/CHF', 5),
  ('NZD/USD', 'NZ Dollar / US Dollar',         'forex', 'twelvedata', 'NZD/USD', 5),
  ('EUR/GBP', 'Euro / British Pound',          'forex', 'twelvedata', 'EUR/GBP', 5)
ON CONFLICT (symbol) DO NOTHING;

-- 3. trading_controls - global pause, never a price change ---------------------
CREATE TABLE IF NOT EXISTS trading_controls (
  id INT PRIMARY KEY DEFAULT 1,
  CHECK (id = 1),
  trading_paused BOOLEAN NOT NULL DEFAULT false,
  pause_reason TEXT,
  new_trades_only_paused BOOLEAN NOT NULL DEFAULT false,
  maintenance_mode BOOLEAN NOT NULL DEFAULT false,
  updated_by UUID,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
INSERT INTO trading_controls (id, trading_paused) VALUES (1, false) ON CONFLICT (id) DO NOTHING;

-- 4. admin_logs - full audit trail ---------------------------------------------
CREATE TABLE IF NOT EXISTS admin_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id UUID NOT NULL,
  admin_email VARCHAR(255) NOT NULL,
  action VARCHAR(100) NOT NULL,
  entity_type VARCHAR(50),
  entity_id VARCHAR(100),
  old_value JSONB,
  new_value JSONB,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
-- WhaleChat user ids are not UUIDs ('usr_admin'). admin_id holds a stable UUID
-- derived from the user id; the original id is kept here for readability.
ALTER TABLE admin_logs ADD COLUMN IF NOT EXISTS admin_user_ref VARCHAR(100);
CREATE INDEX IF NOT EXISTS idx_admin_logs_admin ON admin_logs(admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_logs_action ON admin_logs(action);
CREATE INDEX IF NOT EXISTS idx_admin_logs_created ON admin_logs(created_at DESC);

-- the audit trail is append-only
CREATE OR REPLACE FUNCTION wc_admin_logs_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'admin_logs is append-only';
END $$;
DROP TRIGGER IF EXISTS trg_admin_logs_append_only ON admin_logs;
CREATE TRIGGER trg_admin_logs_append_only BEFORE UPDATE OR DELETE ON admin_logs
  FOR EACH ROW EXECUTE FUNCTION wc_admin_logs_append_only();

-- 5. market_price_cache - filled ONLY from Binance / Twelve Data / Finnhub -----
CREATE TABLE IF NOT EXISTS market_price_cache (
  symbol VARCHAR(50) PRIMARY KEY REFERENCES tradable_symbols(symbol),
  price NUMERIC(24,8) NOT NULL,
  change_percent NUMERIC(10,4),
  high_24h NUMERIC(24,8),
  low_24h NUMERIC(24,8),
  source VARCHAR(50) NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_price_cache_fetched ON market_price_cache(fetched_at DESC);
-- only provider names can be written as a price source: no 'manual' / 'admin'
DO $$ BEGIN
  ALTER TABLE market_price_cache ADD CONSTRAINT chk_price_cache_source CHECK (source IN ('binance', 'twelvedata', 'finnhub'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- updated_at bookkeeping
CREATE OR REPLACE FUNCTION wc_touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := NOW(); RETURN NEW; END $$;
DROP TRIGGER IF EXISTS trg_provider_touch ON market_provider_config;
CREATE TRIGGER trg_provider_touch BEFORE UPDATE ON market_provider_config FOR EACH ROW EXECUTE FUNCTION wc_touch_updated_at();
DROP TRIGGER IF EXISTS trg_symbols_touch ON tradable_symbols;
CREATE TRIGGER trg_symbols_touch BEFORE UPDATE ON tradable_symbols FOR EACH ROW EXECUTE FUNCTION wc_touch_updated_at();
DROP TRIGGER IF EXISTS trg_controls_touch ON trading_controls;
CREATE TRIGGER trg_controls_touch BEFORE UPDATE ON trading_controls FOR EACH ROW EXECUTE FUNCTION wc_touch_updated_at();

-- =============================================================================
-- Row Level Security
--   admin   : read/write market_provider_config, trading_controls, admin_logs
--             (admin_logs: read + insert only), manage tradable_symbols
--   users   : read tradable_symbols where is_visible, read market_price_cache
--   nobody  : writes market_price_cache except the backend (table owner /
--             Supabase service_role, which bypass RLS)
-- Role source:
--   Supabase clients (anon / authenticated): JWT app_metadata.role
--     (app_metadata can only be set with the service key, never by the user)
--   other connections: session setting app.user_role
-- =============================================================================
CREATE OR REPLACE FUNCTION wc_current_role() RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE claims jsonb; r text;
BEGIN
  BEGIN claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  EXCEPTION WHEN OTHERS THEN claims := NULL; END;
  r := claims -> 'app_metadata' ->> 'role';
  IF current_user NOT IN ('anon', 'authenticated') THEN
    r := coalesce(nullif(current_setting('app.user_role', true), ''), r);
  END IF;
  RETURN coalesce(r, '');
END $$;
CREATE OR REPLACE FUNCTION wc_is_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT wc_current_role() = 'admin' $$;

ALTER TABLE market_provider_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE trading_controls       ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_logs             ENABLE ROW LEVEL SECURITY;
ALTER TABLE tradable_symbols       ENABLE ROW LEVEL SECURITY;
ALTER TABLE market_price_cache     ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS provider_admin_all ON market_provider_config;
CREATE POLICY provider_admin_all ON market_provider_config FOR ALL USING (wc_is_admin()) WITH CHECK (wc_is_admin());

DROP POLICY IF EXISTS controls_admin_all ON trading_controls;
CREATE POLICY controls_admin_all ON trading_controls FOR ALL USING (wc_is_admin()) WITH CHECK (wc_is_admin());

DROP POLICY IF EXISTS logs_admin_read ON admin_logs;
CREATE POLICY logs_admin_read ON admin_logs FOR SELECT USING (wc_is_admin());
DROP POLICY IF EXISTS logs_admin_insert ON admin_logs;
CREATE POLICY logs_admin_insert ON admin_logs FOR INSERT WITH CHECK (wc_is_admin());

DROP POLICY IF EXISTS symbols_read ON tradable_symbols;
CREATE POLICY symbols_read ON tradable_symbols FOR SELECT USING (is_visible OR wc_is_admin());
DROP POLICY IF EXISTS symbols_admin_insert ON tradable_symbols;
CREATE POLICY symbols_admin_insert ON tradable_symbols FOR INSERT WITH CHECK (wc_is_admin());
DROP POLICY IF EXISTS symbols_admin_update ON tradable_symbols;
CREATE POLICY symbols_admin_update ON tradable_symbols FOR UPDATE USING (wc_is_admin()) WITH CHECK (wc_is_admin());
DROP POLICY IF EXISTS symbols_admin_delete ON tradable_symbols;
CREATE POLICY symbols_admin_delete ON tradable_symbols FOR DELETE USING (wc_is_admin());

DROP POLICY IF EXISTS price_cache_read ON market_price_cache;
CREATE POLICY price_cache_read ON market_price_cache FOR SELECT USING (true);
-- intentionally no INSERT/UPDATE/DELETE policy: there is no manual price path

-- Supabase API roles (skipped on plain Postgres where they do not exist)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT SELECT ON tradable_symbols, market_price_cache TO authenticated;
    GRANT SELECT, INSERT, UPDATE ON market_provider_config, trading_controls TO authenticated;
    GRANT INSERT, UPDATE, DELETE ON tradable_symbols TO authenticated;
    GRANT SELECT, INSERT ON admin_logs TO authenticated;
    REVOKE INSERT, UPDATE, DELETE ON market_price_cache FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    GRANT SELECT ON tradable_symbols, market_price_cache TO anon;
    REVOKE ALL ON market_provider_config, trading_controls, admin_logs FROM anon;
    REVOKE INSERT, UPDATE, DELETE ON tradable_symbols, market_price_cache FROM anon;
  END IF;
END $$;
