-- LUNA research surface hardening v1
-- Make public research access explicit, read-only, and RLS-aware.

drop policy if exists luna_research_prices_public_dataset_read on public.luna_research_prices;
create policy luna_research_prices_public_dataset_read
  on public.luna_research_prices
  for select
  to anon, authenticated
  using (
    dataset_id = '1af83c59-a56f-461f-b03e-f3d04e67e384'::uuid
    and date >= date '2021-09-01'
    and date <= date '2026-08-31'
  );

revoke insert, update, delete, truncate, references, trigger
  on public.luna_research_prices from anon, authenticated;

alter view public.luna_research_prices_export_v1 set (security_invoker = true);
revoke all on public.luna_research_prices_export_v1 from anon, authenticated;
grant select on public.luna_research_prices_export_v1 to anon, authenticated;

create or replace function public.luna_research_month_blob(p_start date, p_end date)
returns jsonb
language sql
security invoker
set search_path=public
as $function$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'date', date,
        'symbol', symbol,
        'market', market,
        'open', open,
        'high', high,
        'low', low,
        'close', close,
        'adj_close', adj_close,
        'volume', volume,
        'amount', amount,
        'available_at', available_at
      )
      order by date, symbol
    ),
    '[]'::jsonb
  )
  from public.luna_research_prices
  where dataset_id = '1af83c59-a56f-461f-b03e-f3d04e67e384'::uuid
    and date >= p_start
    and date <= p_end;
$function$;

create or replace function public.luna_research_symbol_batch(p_batch integer, p_batch_size integer default 20)
returns text[]
language sql
security invoker
set search_path=public
as $function$
  with universe as (
    select symbol,
           row_number() over (order by symbol) - 1 as rn
    from (
      select distinct symbol
      from public.luna_research_prices
      where date >= date '2021-09-01'
        and date <= date '2026-08-31'
    ) s
  )
  select coalesce(array_agg(symbol order by symbol), '{}')::text[]
  from universe
  where floor(rn / p_batch_size) = p_batch;
$function$;

alter table public.luna_research_ranked_v2 enable row level security;
alter table public.luna_research_ranked_v2 alter column symbol set not null;
alter table public.luna_research_ranked_v2 alter column month_end set not null;
alter table public.luna_research_ranked_v2 add constraint luna_research_ranked_v2_pkey primary key (symbol, month_end);
drop policy if exists luna_research_ranked_v2_public_read on public.luna_research_ranked_v2;
create policy luna_research_ranked_v2_public_read
  on public.luna_research_ranked_v2
  for select
  to anon, authenticated
  using (true);
revoke insert, update, delete, truncate, references, trigger
  on public.luna_research_ranked_v2 from anon, authenticated;
grant select on public.luna_research_ranked_v2 to anon, authenticated;