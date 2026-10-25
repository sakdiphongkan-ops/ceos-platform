-- LUNA worker observer-only stream cache.
-- These tables hold only the latest quote/signal per symbol, so stream telemetry
-- cannot grow without bound. They are not execution-authoritative data sources.

create table if not exists public.luna_worker_quote_cache (
  symbol text primary key,
  as_of_date date not null,
  session_id uuid,
  quote_ts timestamptz not null,
  received_at timestamptz not null default now(),
  bid numeric,
  ask numeric,
  last numeric,
  bid_size bigint,
  ask_size bigint,
  provider_source text not null,
  data_quality text,
  raw jsonb not null default '{}'::jsonb,
  execution_eligible boolean not null default false check (execution_eligible = false),
  updated_at timestamptz not null default now(),
  check (last is not null or bid is not null or ask is not null)
);

create table if not exists public.luna_worker_signal_cache (
  strategy_version text not null,
  symbol text not null,
  as_of_date date not null,
  session_id uuid,
  signal_ts timestamptz not null,
  received_at timestamptz not null default now(),
  action text not null,
  trace_id text,
  signal jsonb not null,
  execution_eligible boolean not null default false check (execution_eligible = false),
  updated_at timestamptz not null default now(),
  primary key (strategy_version, symbol)
);

alter table public.luna_worker_quote_cache enable row level security;
alter table public.luna_worker_signal_cache enable row level security;
revoke all on public.luna_worker_quote_cache from public, anon, authenticated;
revoke all on public.luna_worker_signal_cache from public, anon, authenticated;
grant select, insert, update, delete on public.luna_worker_quote_cache to service_role;
grant select, insert, update, delete on public.luna_worker_signal_cache to service_role;

create or replace function private.luna_worker_quote_cache_guard()
returns trigger language plpgsql set search_path to ''
as $$
begin
  if tg_op = 'UPDATE' and new.quote_ts < old.quote_ts then return old; end if;
  new.execution_eligible := false;
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;
revoke all on function private.luna_worker_quote_cache_guard() from public, anon, authenticated;
grant execute on function private.luna_worker_quote_cache_guard() to service_role;
drop trigger if exists luna_worker_quote_cache_guard_trg on public.luna_worker_quote_cache;
create trigger luna_worker_quote_cache_guard_trg
before insert or update on public.luna_worker_quote_cache
for each row execute function private.luna_worker_quote_cache_guard();

create or replace function private.luna_worker_signal_cache_guard()
returns trigger language plpgsql set search_path to ''
as $$
begin
  if tg_op = 'UPDATE' and new.signal_ts < old.signal_ts then return old; end if;
  new.execution_eligible := false;
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;
revoke all on function private.luna_worker_signal_cache_guard() from public, anon, authenticated;
grant execute on function private.luna_worker_signal_cache_guard() to service_role;
drop trigger if exists luna_worker_signal_cache_guard_trg on public.luna_worker_signal_cache;
create trigger luna_worker_signal_cache_guard_trg
before insert or update on public.luna_worker_signal_cache
for each row execute function private.luna_worker_signal_cache_guard();

create index if not exists luna_worker_quote_cache_asof_idx
  on public.luna_worker_quote_cache(as_of_date, received_at desc);
create index if not exists luna_worker_signal_cache_asof_idx
  on public.luna_worker_signal_cache(as_of_date, received_at desc);

comment on table public.luna_worker_quote_cache is
  'Latest-observation cache for the LUNA worker stream. Explicitly non-execution-grade; must never authorize orders.';
comment on table public.luna_worker_signal_cache is
  'Latest worker strategy signal for display/diagnostics only. execution_eligible is constrained to false.';
