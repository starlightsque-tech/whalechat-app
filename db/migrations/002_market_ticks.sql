-- WhaleChat 3.53.0 — durable market tick ring-buffer
-- Created automatically by server.js on boot; kept here for manual setups.
create table if not exists whalechat_market_ticks (
  ticker  text   not null,
  t       bigint not null,              -- epoch milliseconds
  p       numeric not null,
  is_real boolean not null default false,
  source  text,
  primary key (ticker, t)
);
create index if not exists whalechat_market_ticks_t_idx
  on whalechat_market_ticks (t);
