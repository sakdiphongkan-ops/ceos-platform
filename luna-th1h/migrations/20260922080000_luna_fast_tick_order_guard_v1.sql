-- LUNA fast live tick ordering guard v1
-- Prevent out-of-order quotes from regressing the real-time fast state.

create or replace function public.luna_update_fast_live_tick(
  p_strategy_version text,
  p_as_of_date date,
  p_symbol text,
  p_price numeric,
  p_ts timestamptz,
  p_source text default 'LIVE_TICK'
)
returns jsonb
language plpgsql
security definer
set search_path=public
as $function$
declare
  v_ref numeric;
  v_score numeric;
  v_current_price numeric;
  v_current_score numeric;
  v_current_ts timestamptz;
begin
  if p_price is null or p_price<=0 then
    return jsonb_build_object('ok',false,'error','invalid_price');
  end if;

  if p_ts is null then
    return jsonb_build_object('ok',false,'error','invalid_quote_ts');
  end if;

  select reference_close,current_price,score,last_quote_ts
    into v_ref,v_current_price,v_current_score,v_current_ts
  from public.luna_fast_live_state
  where strategy_version=p_strategy_version
    and as_of_date=p_as_of_date
    and symbol=upper(p_symbol);

  if v_ref is null then
    return jsonb_build_object(
      'ok',false,
      'error','symbol_not_prepared',
      'symbol',upper(p_symbol)
    );
  end if;

  if v_current_ts is not null and p_ts < v_current_ts then
    return jsonb_build_object(
      'ok',true,
      'stale_ignored',true,
      'strategy_version',p_strategy_version,
      'as_of_date',p_as_of_date,
      'symbol',upper(p_symbol),
      'score',v_current_score,
      'current_price',v_current_price,
      'last_quote_ts',v_current_ts,
      'ignored_quote_ts',p_ts,
      'updated_at',now()
    );
  end if;

  v_score := p_price/nullif(v_ref,0)-1;

  update public.luna_fast_live_state
  set current_price=p_price,
      score=v_score,
      last_quote_ts=p_ts,
      source=p_source,
      updated_at=now()
  where strategy_version=p_strategy_version
    and as_of_date=p_as_of_date
    and symbol=upper(p_symbol);

  return jsonb_build_object(
    'ok',true,
    'stale_ignored',false,
    'strategy_version',p_strategy_version,
    'as_of_date',p_as_of_date,
    'symbol',upper(p_symbol),
    'score',v_score,
    'updated_at',now()
  );
end;
$function$;

revoke execute on function public.luna_update_fast_live_tick(text,date,text,numeric,timestamptz,text) from public,anon,authenticated;
grant execute on function public.luna_update_fast_live_tick(text,date,text,numeric,timestamptz,text) to service_role;