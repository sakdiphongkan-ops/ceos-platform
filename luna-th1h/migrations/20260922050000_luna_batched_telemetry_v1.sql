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

  return jsonb_build_object(
    'ok',true,
    'count',v_count,
    'results',v_results
  );
end;
$function$;

revoke execute on function public.luna_update_fast_live_tick_batch(jsonb) from public, anon, authenticated;
grant execute on function public.luna_update_fast_live_tick_batch(jsonb) to service_role;
