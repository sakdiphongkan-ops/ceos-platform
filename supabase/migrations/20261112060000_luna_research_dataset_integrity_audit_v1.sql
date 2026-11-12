-- LUNA daily research dataset integrity audit v1
-- Read-only quality scan; no price rows are modified or removed.
begin;

create table if not exists public.luna_research_data_quality_audits (
  id uuid primary key default gen_random_uuid(),
  dataset_id uuid not null references public.luna_research_datasets(id),
  audit_date date not null,
  status text not null check(status in ('PASS','WARN','FAIL')),
  expected_row_count bigint,
  actual_row_count bigint not null,
  expected_symbol_count integer,
  actual_symbol_count integer not null,
  first_date date,
  last_date date,
  null_ohlc_rows bigint not null default 0,
  inconsistent_ohlc_rows bigint not null default 0,
  invalid_adj_close_rows bigint not null default 0,
  invalid_volume_rows bigint not null default 0,
  invalid_amount_rows bigint not null default 0,
  missing_available_at_rows bigint not null default 0,
  duplicate_symbol_date_rows bigint not null default 0,
  stale_symbols_45d integer not null default 0,
  short_history_symbols integer not null default 0,
  source_counts jsonb not null default '{}'::jsonb,
  details jsonb not null default '{}'::jsonb,
  audited_at timestamptz not null default now(),
  unique(dataset_id,audit_date)
);

create index if not exists luna_research_data_quality_audits_date_idx
  on public.luna_research_data_quality_audits(audit_date desc);

alter table public.luna_research_data_quality_audits enable row level security;
drop policy if exists luna_research_data_quality_audits_service_role_all on public.luna_research_data_quality_audits;
create policy luna_research_data_quality_audits_service_role_all on public.luna_research_data_quality_audits
  as permissive for all to service_role using(true) with check(true);
revoke all on public.luna_research_data_quality_audits from public,anon,authenticated;
grant select,insert,update,delete on public.luna_research_data_quality_audits to service_role;

create or replace function public.luna_run_research_dataset_integrity_audit(
  p_dataset_id uuid default '1af83c59-a56f-461f-b03e-f3d04e67e384'
) returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $audit$
declare
  v_dataset record;
  v_actual_rows bigint;
  v_actual_symbols integer;
  v_first_date date;
  v_last_date date;
  v_null_ohlc bigint;
  v_inconsistent bigint;
  v_invalid_adj bigint;
  v_invalid_volume bigint;
  v_invalid_amount bigint;
  v_missing_available bigint;
  v_duplicates bigint;
  v_stale_symbols integer;
  v_short_history integer;
  v_source_counts jsonb;
  v_status text;
  v_audit_date date := (now() at time zone 'Asia/Bangkok')::date;
  v_id uuid;
begin
  select id,name,row_count,symbol_count,start_date,end_date,source
    into v_dataset
  from public.luna_research_datasets
  where id=p_dataset_id;
  if not found then raise exception 'RESEARCH_DATASET_NOT_FOUND'; end if;

  select
    count(*),
    count(distinct symbol),
    min(date),
    max(date),
    count(*) filter(where open is null or high is null or low is null or close is null),
    count(*) filter(where open is not null and high is not null and low is not null and close is not null
      and (high<low or high<greatest(open,close) or low>least(open,close))),
    count(*) filter(where open is not null and high is not null and low is not null and close is not null
      and (adj_close is null or adj_close<=0)),
    count(*) filter(where open is not null and high is not null and low is not null and close is not null
      and (volume is null or volume<0)),
    count(*) filter(where open is not null and high is not null and low is not null and close is not null
      and (amount is null or amount<0)),
    count(*) filter(where available_at is null),
    count(*)-count(distinct(symbol,date))
  into v_actual_rows,v_actual_symbols,v_first_date,v_last_date,
       v_null_ohlc,v_inconsistent,v_invalid_adj,v_invalid_volume,
       v_invalid_amount,v_missing_available,v_duplicates
  from public.luna_research_prices
  where dataset_id=p_dataset_id;

  select
    count(*) filter(where max_date < v_last_date-45),
    count(*) filter(where min_date > v_first_date+365)
  into v_stale_symbols,v_short_history
  from (
    select symbol,min(date) as min_date,max(date) as max_date
    from public.luna_research_prices
    where dataset_id=p_dataset_id
    group by symbol
  ) coverage;

  select coalesce(jsonb_object_agg(source_name,rows),'{}'::jsonb)
  into v_source_counts
  from (
    select source::text as source_name,count(*) as rows
    from public.luna_research_prices
    where dataset_id=p_dataset_id
    group by source
  ) sources;

  v_status := case
    when v_duplicates>0 or v_missing_available>0 or v_invalid_adj>0 then 'FAIL'
    when v_null_ohlc>0 or v_inconsistent>0 or v_invalid_volume>0 or v_invalid_amount>0 then 'WARN'
    else 'PASS'
  end;

  insert into public.luna_research_data_quality_audits(
    dataset_id,audit_date,status,expected_row_count,actual_row_count,
    expected_symbol_count,actual_symbol_count,first_date,last_date,
    null_ohlc_rows,inconsistent_ohlc_rows,invalid_adj_close_rows,
    invalid_volume_rows,invalid_amount_rows,missing_available_at_rows,
    duplicate_symbol_date_rows,stale_symbols_45d,short_history_symbols,
    source_counts,details,audited_at
  ) values(
    p_dataset_id,v_audit_date,v_status,v_dataset.row_count,v_actual_rows,
    v_dataset.symbol_count,v_actual_symbols,v_first_date,v_last_date,
    v_null_ohlc,v_inconsistent,v_invalid_adj,v_invalid_volume,
    v_invalid_amount,v_missing_available,v_duplicates,v_stale_symbols,v_short_history,
    v_source_counts,
    jsonb_build_object(
      'dataset_name',v_dataset.name,
      'dataset_source',v_dataset.source,
      'manifest_row_count_matches',v_dataset.row_count=v_actual_rows,
      'manifest_symbol_count_matches',v_dataset.symbol_count=v_actual_symbols,
      'coverage_note','Short-history and stale symbols are reported, not automatically removed.',
      'null_ohlc_note','Null OHLC rows can be non-trading/no-observation records and must be excluded from bar calculations, not forward-filled.'
    ),now()
  )
  on conflict(dataset_id,audit_date) do update set
    status=excluded.status,expected_row_count=excluded.expected_row_count,
    actual_row_count=excluded.actual_row_count,expected_symbol_count=excluded.expected_symbol_count,
    actual_symbol_count=excluded.actual_symbol_count,first_date=excluded.first_date,
    last_date=excluded.last_date,null_ohlc_rows=excluded.null_ohlc_rows,
    inconsistent_ohlc_rows=excluded.inconsistent_ohlc_rows,
    invalid_adj_close_rows=excluded.invalid_adj_close_rows,
    invalid_volume_rows=excluded.invalid_volume_rows,invalid_amount_rows=excluded.invalid_amount_rows,
    missing_available_at_rows=excluded.missing_available_at_rows,
    duplicate_symbol_date_rows=excluded.duplicate_symbol_date_rows,
    stale_symbols_45d=excluded.stale_symbols_45d,
    short_history_symbols=excluded.short_history_symbols,
    source_counts=excluded.source_counts,details=excluded.details,audited_at=excluded.audited_at
  returning id into v_id;

  return jsonb_build_object(
    'ok',true,'audit_id',v_id,'status',v_status,'audit_date',v_audit_date,
    'dataset_id',p_dataset_id,'row_count',v_actual_rows,'symbol_count',v_actual_symbols,
    'first_date',v_first_date,'last_date',v_last_date,
    'null_ohlc_rows',v_null_ohlc,'inconsistent_ohlc_rows',v_inconsistent,
    'invalid_adj_close_rows',v_invalid_adj,'invalid_volume_rows',v_invalid_volume,
    'invalid_amount_rows',v_invalid_amount,'missing_available_at_rows',v_missing_available,
    'duplicate_symbol_date_rows',v_duplicates,'stale_symbols_45d',v_stale_symbols,
    'short_history_symbols',v_short_history,'source_counts',v_source_counts
  );
end;
$audit$;

revoke all on function public.luna_run_research_dataset_integrity_audit(uuid) from public,anon,authenticated;
grant execute on function public.luna_run_research_dataset_integrity_audit(uuid) to service_role;

do $schedule$
declare v_job_id bigint;
begin
  select jobid into v_job_id from cron.job where jobname='luna-research-dataset-integrity-audit-daily' limit 1;
  if v_job_id is not null then perform cron.unschedule(v_job_id); end if;
  perform cron.schedule('luna-research-dataset-integrity-audit-daily','10 13 * * *',
    $$select public.luna_run_research_dataset_integrity_audit();$$);
end;
$schedule$;

commit;
