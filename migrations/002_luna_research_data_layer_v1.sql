-- LUNA research data layer v1
-- Canonical research storage for point-in-time SET/mai backtests.
create table if not exists public.luna_research_datasets (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  dataset_type text not null check (dataset_type in ('prices','fundamentals','corporate_actions','features')),
  source text not null,
  start_date date,
  end_date date,
  symbol_count integer,
  row_count bigint,
  checksum_sha256 text,
  status text not null default 'READY',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.luna_research_prices (
  id bigint generated always as identity primary key,
  dataset_id uuid not null references public.luna_research_datasets(id) on delete cascade,
  date date not null,
  symbol text not null,
  market text,
  open numeric,
  high numeric,
  low numeric,
  close numeric,
  adj_close numeric,
  volume numeric,
  amount numeric,
  available_at timestamptz,
  source_seq bigint,
  source text not null,
  raw jsonb not null default '{}'::jsonb,
  unique(dataset_id, date, symbol)
);
create index if not exists idx_luna_research_prices_date_symbol
  on public.luna_research_prices(date, symbol);
create index if not exists idx_luna_research_prices_available
  on public.luna_research_prices(available_at);

create table if not exists public.luna_research_fundamentals (
  id bigint generated always as identity primary key,
  dataset_id uuid not null references public.luna_research_datasets(id) on delete cascade,
  asof_date date not null,
  symbol text not null,
  available_at timestamptz not null,
  pe numeric, pbv numeric, ev_ebitda numeric, fcf_yield numeric,
  earnings_yield numeric, div_yield numeric, roe numeric, roa numeric,
  roic numeric, gpm numeric, npm numeric, cfo_margin numeric,
  rev_g numeric, eps_g numeric, ni_g numeric, fcf_g numeric,
  asset_g numeric, capex_g numeric, investment_rate numeric,
  div_g numeric, payout numeric, buyback numeric, de numeric,
  net_debt_ebitda numeric, interest_cover numeric, current_ratio numeric,
  adv20 numeric, turnover numeric, amount numeric,
  raw jsonb not null default '{}'::jsonb,
  unique(dataset_id, asof_date, symbol, available_at)
);
create index if not exists idx_luna_research_fundamentals_symbol_available
  on public.luna_research_fundamentals(symbol, available_at);

create table if not exists public.luna_research_corporate_actions (
  id bigint generated always as identity primary key,
  dataset_id uuid not null references public.luna_research_datasets(id) on delete cascade,
  symbol text not null,
  action_date date not null,
  effective_date date,
  action_type text not null,
  cash_amount numeric, ratio numeric, old_shares numeric, new_shares numeric,
  available_at timestamptz,
  source text not null,
  raw jsonb not null default '{}'::jsonb,
  unique(dataset_id, symbol, action_date, action_type, effective_date)
);
create index if not exists idx_luna_research_ca_symbol_date
  on public.luna_research_corporate_actions(symbol, action_date);

create table if not exists public.luna_research_features (
  id bigint generated always as identity primary key,
  dataset_id uuid not null references public.luna_research_datasets(id) on delete cascade,
  date date not null,
  symbol text not null,
  market text,
  decision_ts timestamptz not null,
  available_at timestamptz not null,
  pe numeric, pbv numeric, ev_ebitda numeric, fcf_yield numeric,
  earnings_yield numeric, div_yield numeric, roe numeric, roa numeric,
  roic numeric, gpm numeric, npm numeric, cfo_margin numeric,
  rev_g numeric, eps_g numeric, ni_g numeric, fcf_g numeric,
  mom_5 numeric, mom_10 numeric, mom_20 numeric, mom_60 numeric, mom_120 numeric,
  rel_mom numeric, vol_10 numeric, vol_20 numeric, beta numeric,
  maxdd_60 numeric, atr_pct numeric, adv20 numeric, turnover numeric, amount numeric,
  asset_g numeric, capex_g numeric, investment_rate numeric, div_g numeric,
  payout numeric, buyback numeric, de numeric, net_debt_ebitda numeric,
  interest_cover numeric, current_ratio numeric, rsi14 numeric,
  dist_ma20 numeric, dist_ma60 numeric, breakout20 numeric, breakout55 numeric,
  fwd_return_1d numeric, fwd_return_5d numeric, fwd_return_20d numeric,
  feature_version text not null,
  source text not null,
  raw jsonb not null default '{}'::jsonb,
  unique(dataset_id, date, symbol)
);
create index if not exists idx_luna_research_features_date_symbol
  on public.luna_research_features(date, symbol);
create index if not exists idx_luna_research_features_available
  on public.luna_research_features(available_at);

alter table public.luna_research_datasets enable row level security;
alter table public.luna_research_prices enable row level security;
alter table public.luna_research_fundamentals enable row level security;
alter table public.luna_research_corporate_actions enable row level security;
alter table public.luna_research_features enable row level security;

drop policy if exists luna_research_datasets_read_authenticated on public.luna_research_datasets;
create policy luna_research_datasets_read_authenticated
  on public.luna_research_datasets for select to authenticated using (true);
drop policy if exists luna_research_prices_read_authenticated on public.luna_research_prices;
create policy luna_research_prices_read_authenticated
  on public.luna_research_prices for select to authenticated using (true);
drop policy if exists luna_research_fundamentals_read_authenticated on public.luna_research_fundamentals;
create policy luna_research_fundamentals_read_authenticated
  on public.luna_research_fundamentals for select to authenticated using (true);
drop policy if exists luna_research_corporate_actions_read_authenticated on public.luna_research_corporate_actions;
create policy luna_research_corporate_actions_read_authenticated
  on public.luna_research_corporate_actions for select to authenticated using (true);
drop policy if exists luna_research_features_read_authenticated on public.luna_research_features;
create policy luna_research_features_read_authenticated
  on public.luna_research_features for select to authenticated using (true);
