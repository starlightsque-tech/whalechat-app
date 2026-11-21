-- WhaleChat Cloudflare D1 schema (3.60.0)
-- Apply with: npm run db:init  (wrangler d1 execute whalechat_db --file=./schema.sql --remote)

CREATE TABLE IF NOT EXISTS app_state_chunks (
  id INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  chunk TEXT NOT NULL,
  rev INTEGER DEFAULT 0,
  PRIMARY KEY (id, idx)
);

CREATE TABLE IF NOT EXISTS app_state (
  k TEXT PRIMARY KEY,
  v TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT,
  email TEXT,
  password_hash TEXT,
  phone TEXT,
  avatar TEXT,
  created_at INTEGER,
  last_seen INTEGER,
  username TEXT,
  data TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users (lower(username));

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT,
  sender_id TEXT,
  to_id TEXT,
  text TEXT,
  file_url TEXT,
  file_type TEXT,
  created_at INTEGER,
  status TEXT,
  read_by TEXT,
  data TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages (chat_id);

CREATE TABLE IF NOT EXISTS files (
  key TEXT PRIMARY KEY,
  user_id TEXT,
  content_type TEXT,
  size INTEGER,
  data TEXT,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
