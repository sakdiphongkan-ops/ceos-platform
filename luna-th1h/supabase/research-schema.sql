-- Research datasets are immutable source manifests. Raw ticks remain in the provider/archive layer.
create table if not exists public.luna_research_datasets (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  source text not null,
  granularity text not null,
  start_ts timestamptz not null,
  end_ts timestamptz not null,
  symbol_count integer not null,
  row_count bigint not null,
  checksum_sha256 text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists luna_research_datasets_source_start
  on public.luna_research_datasets(source,start_ts);

create table if not exists public.luna_backtest_runs (
  id uuid primary key default gen_random_uuid(),
  dataset_id uuid references public.luna_research_datasets(id),
  name text not null,
  strategy_version text not null,
  split text not null check(split in ('TRAIN','VALIDATION','TEST','FULL')),
  initial_capital numeric(18,2) not null,
  final_equity numeric(18,2) not null,
  net_pnl numeric(18,2) not null,
  return_pct numeric(18,6) not null,
  max_drawdown numeric(18,2) not null,
  trade_count integer not null,
  win_count integer not null,
  loss_count integer not null,
  total_fees numeric(18,2) not null,
  total_slippage numeric(18,2) not null,
  config jsonb not null default '{}'::jsonb,
  status text not null default 'COMPLETED',
  created_at timestamptz not null default now()
);

create index if not exists luna_backtest_runs_dataset_created
  on public.luna_backtest_runs(dataset_id,created_at desc);
