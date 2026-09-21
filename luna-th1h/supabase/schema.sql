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


create unique index if not exists luna_market_ticks_session_symbol_ts_uq
  on public.luna_market_ticks(session_id,symbol,ts);
create unique index if not exists luna_signals_session_symbol_ts_uq
  on public.luna_signals(session_id,symbol,ts);


create or replace function public.luna_update_fast_live_tick_batch(p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path=public
as $function$
declare
  v_item jsonb;
  v_result jsonb;
  v_results jsonb := '[]'::jsonb;
  v_count integer := 0;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'invalid_batch_items';
  end if;
  if jsonb_array_length(p_items) > 100 then
    raise exception 'batch_too_large';
  end if;
  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_result := public.luna_update_fast_live_tick(
      coalesce(v_item->>'strategy_version',''),
      (v_item->>'as_of_date')::date,
      upper(coalesce(v_item->>'symbol','')),
      (v_item->>'price')::numeric,
      (v_item->>'ts')::timestamptz,
      coalesce(v_item->>'source','LIVE_TICK')
    );
    v_results := v_results || jsonb_build_array(v_result);
    v_count := v_count + 1;
  end loop;
  return jsonb_build_object('ok',true,'count',v_count,'results',v_results);
end;
$function$;

revoke execute on function public.luna_update_fast_live_tick_batch(jsonb) from public, anon, authenticated;
grant execute on function public.luna_update_fast_live_tick_batch(jsonb) to service_role;
