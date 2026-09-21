create table if not exists public.luna_sessions (
  id uuid primary key default gen_random_uuid(),
  session_date date not null,
  mode text not null default 'paper',
  strategy_version text not null,
  initial_capital numeric(18,2) not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  status text not null default 'OPEN'
);
create table if not exists public.luna_market_ticks (
  id bigint generated always as identity primary key,
  session_id uuid references public.luna_sessions(id),
  symbol text not null,
  ts timestamptz not null,
  bid numeric(18,6),
  ask numeric(18,6),
  last numeric(18,6),
  bid_size bigint,
  ask_size bigint,
  source text not null,
  raw jsonb,
  created_at timestamptz not null default now()
);
create index if not exists luna_market_ticks_symbol_ts on public.luna_market_ticks(symbol,ts);
create table if not exists public.luna_signals (
  id bigint generated always as identity primary key,
  session_id uuid references public.luna_sessions(id),
  symbol text not null,
  ts timestamptz not null,
  action text not null,
  reason text not null,
  strategy_version text not null,
  created_at timestamptz not null default now()
);
create table if not exists public.luna_orders (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references public.luna_sessions(id),
  symbol text not null,
  side text not null,
  qty bigint not null,
  limit_price numeric(18,6),
  status text not null,
  reason text,
  created_at timestamptz not null default now(),
  client_order_id text,
  broker_order_id text,
  filled_qty bigint not null default 0,
  avg_fill_price numeric(18,6),
  updated_at timestamptz not null default now()
);
create unique index if not exists luna_orders_client_order_id_uq
  on public.luna_orders(client_order_id)
  where client_order_id is not null;
create unique index if not exists luna_orders_broker_order_id_uq
  on public.luna_orders(broker_order_id)
  where broker_order_id is not null;
create table if not exists public.luna_fills (
  id bigint generated always as identity primary key,
  order_id uuid references public.luna_orders(id),
  ts timestamptz not null,
  qty bigint not null,
  price numeric(18,6) not null,
  fee numeric(18,6) not null default 0,
  slippage numeric(18,6) not null default 0,
  idempotency_key text,
  cumulative_filled_qty bigint
);
create unique index if not exists luna_fills_idempotency_key_uq
  on public.luna_fills(idempotency_key)
  where idempotency_key is not null;
create index if not exists luna_fills_order_ts
  on public.luna_fills(order_id,ts);
create table if not exists public.luna_positions (
  session_id uuid references public.luna_sessions(id),
  symbol text not null,
  qty bigint not null default 0,
  avg_price numeric(18,6) not null default 0,
  updated_at timestamptz not null default now(),
  primary key(session_id,symbol)
);
create table if not exists public.luna_portfolio_snapshots (
  id bigint generated always as identity primary key,
  session_id uuid references public.luna_sessions(id),
  ts timestamptz not null,
  cash numeric(18,2) not null,
  market_value numeric(18,2) not null,
  gross_exposure numeric(18,2) not null,
  realized_pnl numeric(18,2) not null,
  unrealized_pnl numeric(18,2) not null,
  fees numeric(18,2) not null default 0
);
create table if not exists public.luna_audit_events (
  id bigint generated always as identity primary key,
  session_id uuid references public.luna_sessions(id),
  ts timestamptz not null default now(),
  event_type text not null,
  payload jsonb not null,
  strategy_version text,
  hash text
);
create table if not exists public.luna_errors (
  id bigint generated always as identity primary key,
  session_id uuid references public.luna_sessions(id),
  ts timestamptz not null default now(),
  component text not null,
  error text not null,
  payload jsonb
);
create table if not exists public.luna_strategy_versions (
  version text primary key,
  description text not null,
  code_hash text,
  created_at timestamptz not null default now()
);
