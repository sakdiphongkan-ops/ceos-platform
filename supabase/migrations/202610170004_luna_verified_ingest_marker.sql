-- LUNA verified-ingestion marker contract.
-- Draft migration only: apply only after isolated PostgreSQL regression tests pass.
-- The marker is written by the database only after the source registry, feed freshness,
-- complete-book flag, row integrity, active-universe membership, and open-session checks pass.
-- This does not create orders or enable live trading.

CREATE OR REPLACE FUNCTION public.luna_ingest_verified_market_batch(
  p_source text,
  p_feed_ts timestamp with time zone,
  p_payload_hash text,
  p_book_complete boolean,
  p_rows jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_configured boolean:=false; v_enabled boolean:=false;
  v_execution_grade boolean:=false; v_book_grade boolean:=false;
  v_source_type text; v_authority text;
  v_max_staleness integer:=60;
  v_session uuid; v_rows integer:=0; v_valid integer:=0;
  v_universe_valid integer:=0; v_distinct_symbols integer:=0;
  v_batch uuid:=gen_random_uuid(); v_reject text;
  v_existing uuid;
begin
  select batch_id into v_existing
  from public.luna_market_ingest_batches
  where upper(source)=upper(p_source)
    and feed_ts=p_feed_ts
    and payload_hash=p_payload_hash
  limit 1;

  if v_existing is not null then
    return jsonb_build_object(
      'ok',true,'accepted',true,'idempotent',true,
      'batch_id',v_existing,'source',p_source
    );
  end if;

  select configured, enabled, execution_grade, book_grade,
         source_type, authority, max_staleness_seconds
    into v_configured, v_enabled, v_execution_grade, v_book_grade,
         v_source_type, v_authority, v_max_staleness
  from public.luna_verified_market_sources
  where upper(source_code)=upper(p_source);

  if not v_configured or not v_enabled then
    v_reject:='SOURCE_NOT_CONFIGURED_OR_ENABLED';
  elsif not v_execution_grade then
    v_reject:='SOURCE_NOT_EXECUTION_GRADE';
  elsif not v_book_grade then
    v_reject:='SOURCE_NOT_BOOK_GRADE';
  end if;

  if p_feed_ts is null or p_feed_ts > now() + interval '30 seconds' then
    v_reject:=coalesce(v_reject,'INVALID_OR_FUTURE_FEED_TIMESTAMP');
  elsif p_feed_ts < now() - make_interval(secs=>greatest(v_max_staleness,1)) then
    v_reject:=coalesce(v_reject,'STALE_FEED_TIMESTAMP');
  elsif nullif(trim(coalesce(p_payload_hash,'')),'') is null then
    v_reject:=coalesce(v_reject,'MISSING_PAYLOAD_HASH');
  elsif not coalesce(p_book_complete,false) then
    v_reject:=coalesce(v_reject,'INCOMPLETE_ORDER_BOOK');
  elsif jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)=0 then
    v_reject:=coalesce(v_reject,'EMPTY_OR_INVALID_BATCH');
  end if;

  select id into v_session
  from public.luna_sessions
  where session_date=current_date
    and started_at <= now()
    and (ended_at is null or ended_at >= now())
    and status not in ('CLOSED','MARKET_CLOSED')
  order by started_at desc
  limit 1;

  if v_session is null then
    v_reject:=coalesce(v_reject,'NO_OPEN_MARKET_SESSION');
  end if;

  if jsonb_typeof(p_rows)='array' then
    select count(*) into v_rows from jsonb_array_elements(p_rows);

    select count(*) into v_distinct_symbols
    from (
      select distinct upper(trim(x.symbol)) symbol
      from jsonb_to_recordset(p_rows) x(symbol text)
      where nullif(trim(x.symbol),'') is not null
    ) d;

    if v_distinct_symbols<>v_rows then
      v_reject:=coalesce(v_reject,'DUPLICATE_SYMBOL_IN_BATCH');
    end if;

    -- Execution-grade book rows must contain a real, non-crossed top of book and sizes.
    select count(*) into v_valid
    from jsonb_to_recordset(p_rows) x(
      symbol text, ts timestamptz, bid numeric, ask numeric, last numeric,
      bid_size bigint, ask_size bigint, raw jsonb
    )
    where nullif(trim(x.symbol),'') is not null
      and x.ts is not null and x.ts <= now() + interval '30 seconds'
      and x.bid is not null and x.ask is not null and x.last is not null
      and x.bid > 0 and x.ask >= x.bid and x.last > 0
      and x.bid_size is not null and x.bid_size > 0
      and x.ask_size is not null and x.ask_size > 0;

    if v_valid<>v_rows then
      v_reject:=coalesce(v_reject,'INVALID_MARKET_TICK_ROW');
    end if;

    select count(*) into v_universe_valid
    from (
      select distinct upper(trim(x.symbol)) symbol
      from jsonb_to_recordset(p_rows) x(symbol text)
    ) d
    join public.luna_universe u
      on upper(u.symbol)=d.symbol and u.is_active=true;

    if v_universe_valid<>v_distinct_symbols then
      v_reject:=coalesce(v_reject,'SYMBOL_NOT_IN_ACTIVE_UNIVERSE');
    end if;
  end if;

  insert into public.luna_market_ingest_batches(
    batch_id,source,feed_ts,symbol_count,tick_count,book_complete,
    payload_hash,accepted,reject_reason,session_id
  )
  values(
    v_batch,p_source,p_feed_ts,v_rows,v_rows,p_book_complete,
    p_payload_hash,v_reject is null,v_reject,v_session
  );

  if v_reject is not null then
    return jsonb_build_object(
      'ok',false,'accepted',false,'batch_id',v_batch,
      'source',p_source,'reject_reason',v_reject
    );
  end if;

  insert into public.luna_market_ticks(
    session_id,symbol,ts,bid,ask,last,bid_size,ask_size,source,raw,created_at
  )
  select
    v_session,
    upper(trim(x.symbol)),
    x.ts,
    x.bid,
    x.ask,
    x.last,
    x.bid_size,
    x.ask_size,
    p_source,
    coalesce(x.raw,'{}'::jsonb) || jsonb_build_object(
      'data_quality','verified',
      'verified',true,
      'verification_source',p_source,
      'verification_batch_id',v_batch,
      'verified_at',now()
    ),
    now()
  from jsonb_to_recordset(p_rows) x(
    symbol text, ts timestamptz, bid numeric, ask numeric, last numeric,
    bid_size bigint, ask_size bigint, raw jsonb
  )
  on conflict do nothing;

  perform public.luna_register_verified_feed_heartbeat(
    p_source,p_feed_ts,v_rows,p_book_complete,p_payload_hash
  );

  update public.luna_market_ingest_batches
  set accepted=true
  where batch_id=v_batch;

  return jsonb_build_object(
    'ok',true,'accepted',true,'idempotent',false,'batch_id',v_batch,
    'source',p_source,'session_id',v_session,'rows_ingested',v_rows,
    'feed_ts',p_feed_ts,'source_type',v_source_type,'authority',v_authority
  );
end;
$function$;

COMMENT ON FUNCTION public.luna_ingest_verified_market_batch(text,timestamp with time zone,text,boolean,jsonb) IS
  'Accepts only enabled execution-grade/book-grade sources and fresh, complete, valid book rows; database stamps explicit verification metadata after validation. Paper-only valuation consumes this marker plus its own <=60-second quote freshness check.';
