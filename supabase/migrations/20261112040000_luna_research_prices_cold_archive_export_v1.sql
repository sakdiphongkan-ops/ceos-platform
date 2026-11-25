-- LUNA cold-archive export contract v1
-- Read-only export of the immutable historical prices table. Never deletes source rows.
begin;

create or replace function public.luna_export_research_prices_chunk(
  p_dataset_id uuid,
  p_after_symbol text default null,
  p_after_date date default null,
  p_limit integer default 5000
) returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $export$
declare
  v_rows jsonb;
  v_count integer;
  v_next_symbol text;
  v_next_date date;
begin
  if p_dataset_id is null then raise exception 'dataset_id_required'; end if;
  if p_limit < 1 or p_limit > 10000 then raise exception 'invalid_limit'; end if;
  if (p_after_symbol is null) <> (p_after_date is null) then
    raise exception 'cursor_requires_symbol_and_date';
  end if;

  with batch as materialized (
    select id,dataset_id,date,symbol,market,open,high,low,close,adj_close,
           volume,amount,available_at,source_seq,source,raw
    from public.luna_research_prices
    where dataset_id=p_dataset_id
      and (p_after_symbol is null or (symbol,date)>(p_after_symbol,p_after_date))
    order by symbol,date
    limit p_limit
  )
  select
    coalesce(jsonb_agg(to_jsonb(batch) order by symbol,date),'[]'::jsonb),
    count(*)::integer,
    (array_agg(symbol order by symbol desc,date desc))[1],
    (array_agg(date order by symbol desc,date desc))[1]
  into v_rows,v_count,v_next_symbol,v_next_date
  from batch;

  return jsonb_build_object(
    'rows',v_rows,
    'row_count',v_count,
    'next_symbol',v_next_symbol,
    'next_date',v_next_date,
    'done',v_count<p_limit
  );
end;
$export$;

revoke all on function public.luna_export_research_prices_chunk(uuid,text,date,integer) from public,anon,authenticated;
grant execute on function public.luna_export_research_prices_chunk(uuid,text,date,integer) to service_role;

commit;
