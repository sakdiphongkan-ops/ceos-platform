-- Prevent stale accepted-batch metadata from masquerading as a live verified feed.
-- This migration is intentionally staged in the PR branch only; it has NOT been
-- applied to the connected production database.
CREATE OR REPLACE FUNCTION public.luna_ingest_verified_market_batch(p_source text, p_feed_ts timestamp with time zone, p_payload_hash text, p_book_complete boolean, p_rows jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
declare
  v_configured boolean:=false; v_enabled boolean:=false; v_source_found boolean:=false;
  v_execution_grade boolean:=false; v_book_grade boolean:=false;
  v_source_type text; v_authority text;
  v_max_staleness integer:=60;
  v_session uuid; v_rows integer:=0; v_valid integer:=0; v_inserted integer:=0;
  v_universe_valid integer:=0; v_distinct_symbols integer:=0;
  v_batch uuid:=gen_random_uuid(); v_reject text;
  v_existing uuid; v_existing_accepted boolean; v_reuse_existing boolean:=false;
  v_existing_tick_rows bigint:=0; v_existing_fresh_tick_rows bigint:=0;
  v_existing_expected integer:=0;
begin
  if nullif(trim(coalesce(p_source,'')),'') is null then
    return jsonb_build_object(
      'ok',false,'accepted',false,'idempotent',false,
      'source',p_source,'reject_reason','SOURCE_NOT_CONFIGURED_OR_ENABLED'
    );
  end if;

  if p_feed_ts is null then
    return jsonb_build_object(
      'ok',false,'accepted',false,'idempotent',false,
      'source',p_source,'reject_reason','INVALID_OR_FUTURE_FEED_TIMESTAMP'
    );
  end if;

  -- Reject malformed JSON shapes/rows before jsonb_to_recordset casts can throw.
  if coalesce(jsonb_typeof(p_rows),'') <> 'array' then
    return jsonb_build_object(
      'ok',false,'accepted',false,'idempotent',false,
      'source',p_source,'reject_reason','EMPTY_OR_INVALID_BATCH'
    );
  end if;
  if jsonb_array_length(p_rows)=0 then
    return jsonb_build_object(
      'ok',false,'accepted',false,'idempotent',false,
      'source',p_source,'reject_reason','EMPTY_OR_INVALID_BATCH'
    );
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_rows) as item(value)
    where jsonb_typeof(item.value) <> 'object'
  ) then
    return jsonb_build_object(
      'ok',false,'accepted',false,'idempotent',false,
      'source',p_source,'reject_reason','INVALID_MARKET_TICK_ROW'
    );
  end if;

  -- An absent/blank hash cannot be stored in the ingest ledger (payload_hash is NOT NULL).
  -- Reject it cleanly rather than raising a database constraint error.
  if nullif(trim(coalesce(p_payload_hash,'')),'') is null then
    return jsonb_build_object(
      'ok',false,'accepted',false,'idempotent',false,
      'source',p_source,'reject_reason','MISSING_PAYLOAD_HASH'
    );
  end if;

  select configured, enabled, execution_grade, book_grade,
         source_type, authority, max_staleness_seconds
    into v_configured, v_enabled, v_execution_grade, v_book_grade,
         v_source_type, v_authority, v_max_staleness
  from public.luna_verified_market_sources
  where upper(source_code)=upper(p_source);

  v_source_found := FOUND;
  if not v_source_found or v_configured is not true or v_enabled is not true then
    v_reject:='SOURCE_NOT_CONFIGURED_OR_ENABLED';
  elsif v_execution_grade is not true then
    v_reject:='SOURCE_NOT_EXECUTION_GRADE';
  elsif v_book_grade is not true then
    v_reject:='SOURCE_NOT_BOOK_GRADE';
  end if;

  -- Run current freshness/contract gates before any idempotent early return.
  if p_feed_ts is null or p_feed_ts > now() + interval '30 seconds' then
    v_reject:=coalesce(v_reject,'INVALID_OR_FUTURE_FEED_TIMESTAMP');
  elsif p_feed_ts < now() - make_interval(secs=>greatest(coalesce(v_max_staleness,60),1)) then
    v_reject:=coalesce(v_reject,'STALE_FEED_TIMESTAMP');
  elsif not coalesce(p_book_complete,false) then
    v_reject:=coalesce(v_reject,'INCOMPLETE_ORDER_BOOK');
  elsif coalesce(jsonb_typeof(p_rows),'') <> 'array' then
    v_reject:=coalesce(v_reject,'EMPTY_OR_INVALID_BATCH');
  elsif jsonb_array_length(p_rows)=0 then
    v_reject:=coalesce(v_reject,'EMPTY_OR_INVALID_BATCH');
  end if;

  select batch_id,accepted into v_existing,v_existing_accepted
  from public.luna_market_ingest_batches
  where upper(source)=upper(p_source)
    and feed_ts=p_feed_ts
    and payload_hash=p_payload_hash
  limit 1;

  -- An idempotent response is allowed only when current source/freshness gates pass,
  -- the caller's batch shape matches the metadata, and every retained tick is fresh.
  if v_existing is not null and v_existing_accepted is true then
    select tick_count into v_existing_expected
    from public.luna_market_ingest_batches
    where batch_id=v_existing;

    select
      count(*),
      count(*) filter (
        where ts >= now() - make_interval(secs=>greatest(coalesce(v_max_staleness,60),1))
          and ts <= now() + interval '30 seconds'
      )
    into v_existing_tick_rows,v_existing_fresh_tick_rows
    from public.luna_market_ticks
    where raw->>'verification_batch_id'=v_existing::text;

    -- This nested conditional intentionally evaluates array_length only after
    -- the earlier guards established that p_rows is a non-empty JSON array.
    if v_reject is null then
      if jsonb_array_length(p_rows)=v_existing_expected
         and v_existing_expected > 0
         and v_existing_tick_rows = v_existing_expected
         and v_existing_fresh_tick_rows = v_existing_expected then
        return jsonb_build_object(
          'ok',true,'accepted',true,'idempotent',true,
          'batch_id',v_existing,'source',p_source,
          'rows_expected',v_existing_expected,'rows_retained',v_existing_tick_rows,
          'rows_fresh',v_existing_fresh_tick_rows
        );
      end if;
    end if;

    v_reject := coalesce(
      v_reject,
      case
        when v_existing_tick_rows <> v_existing_expected then 'IDEMPOTENCY_TICKS_NOT_RETAINED'
        when v_existing_fresh_tick_rows <> v_existing_expected then 'STALE_FEED_TIMESTAMP'
        else 'IDEMPOTENCY_TICK_COUNT_MISMATCH'
      end
    );

    update public.luna_market_ingest_batches
    set accepted=false,reject_reason=v_reject
    where batch_id=v_existing;

    return jsonb_build_object(
      'ok',false,'accepted',false,'idempotent',false,
      'batch_id',v_existing,'source',p_source,
      'reject_reason',v_reject,
      'rows_expected',v_existing_expected,'rows_retained',v_existing_tick_rows,
      'rows_fresh',v_existing_fresh_tick_rows,
      'retry_requires_new_snapshot',true
    );
  elsif v_existing is not null then
    -- Never reuse a rejected batch ID while it still owns tick rows: otherwise
    -- an ON CONFLICT replay could delete the surviving rows during cleanup.
    select tick_count into v_existing_expected
    from public.luna_market_ingest_batches where batch_id=v_existing;
    select count(*) into v_existing_tick_rows
    from public.luna_market_ticks
    where raw->>'verification_batch_id'=v_existing::text;

    if exists (
      select 1 from public.luna_market_ingest_batches
      where batch_id=v_existing
        and accepted=false
        and reject_reason='IDEMPOTENCY_TICKS_NOT_RETAINED'
    ) or v_existing_tick_rows > 0 then
      return jsonb_build_object(
        'ok',false,'accepted',false,'idempotent',false,
        'batch_id',v_existing,'source',p_source,
        'reject_reason',coalesce(
          (select reject_reason from public.luna_market_ingest_batches where batch_id=v_existing),
          'PREVIOUS_BATCH_REQUIRES_NEW_SNAPSHOT'
        ),
        'rows_expected',v_existing_expected,'rows_retained',v_existing_tick_rows,
        'retry_requires_new_snapshot',true
      );
    end if;

    v_batch := v_existing;
    v_reuse_existing := true;
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
      and x.ts is not null
      and x.ts >= now() - make_interval(secs=>greatest(v_max_staleness,1))
      and x.ts <= now() + interval '30 seconds'
      and x.bid is not null and x.ask is not null and x.last is not null
      and lower(x.bid::text) not in ('nan','infinity','-infinity')
      and lower(x.ask::text) not in ('nan','infinity','-infinity')
      and lower(x.last::text) not in ('nan','infinity','-infinity')
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

  if v_reuse_existing then
    update public.luna_market_ingest_batches
    set symbol_count=v_rows,
        tick_count=v_rows,
        book_complete=p_book_complete,
        accepted=v_reject is null,
        reject_reason=v_reject,
        session_id=v_session
    where batch_id=v_batch;
  else
    insert into public.luna_market_ingest_batches(
      batch_id,source,feed_ts,symbol_count,tick_count,book_complete,
      payload_hash,accepted,reject_reason,session_id
    )
    values(
      v_batch,p_source,p_feed_ts,v_rows,v_rows,p_book_complete,
      p_payload_hash,v_reject is null,v_reject,v_session
    );
  end if;

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

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted <> v_rows THEN
    -- On a partial conflict, remove any rows from this attempted batch before returning.
    -- This guarantees we never mark a partially persisted set of ticks as verified/accepted.
    DELETE FROM public.luna_market_ticks
    WHERE raw->>'verification_batch_id'=v_batch::text;

    UPDATE public.luna_market_ingest_batches
    SET accepted=false,reject_reason='TICK_INSERT_CONFLICT'
    WHERE batch_id=v_batch;

    RETURN jsonb_build_object(
      'ok',false,'accepted',false,'idempotent',false,'batch_id',v_batch,
      'source',p_source,'session_id',v_session,
      'reject_reason','TICK_INSERT_CONFLICT',
      'rows_expected',v_rows,'rows_persisted',0,
      'rows_inserted_before_cleanup',v_inserted,'conflict_rows',v_rows-v_inserted
    );
  END IF;

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
exception
  when invalid_text_representation
    or invalid_datetime_format
    or datetime_field_overflow
    or numeric_value_out_of_range
    or invalid_parameter_value then
    -- Malformed upstream field casts return a structured rejection instead of
    -- leaking a PostgreSQL exception. The exception subtransaction rolls back
    -- any partial writes made by this call.
    return jsonb_build_object(
      'ok',false,'accepted',false,'idempotent',false,
      'source',p_source,'reject_reason','INVALID_MARKET_TICK_ROW'
    );
end;
$function$

