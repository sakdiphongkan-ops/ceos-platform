\set ON_ERROR_STOP on
-- Disposable PostgreSQL integration test. Run only in the GitHub Actions
-- postgres:16 service container; never point this script at LUNA production.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Minimal disposable pg_net/scheduler fixtures for the request-audit migration.
CREATE SCHEMA IF NOT EXISTS private;
CREATE SCHEMA IF NOT EXISTS net;

CREATE TABLE private.luna_scheduler_secrets (
  name text PRIMARY KEY,
  secret text NOT NULL
);
INSERT INTO private.luna_scheduler_secrets(name, secret)
VALUES ('tradingview_ingest', 'fixture-secret-never-returned');

CREATE TABLE net.http_request_queue (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  method text NOT NULL,
  url text NOT NULL,
  headers jsonb NOT NULL,
  body jsonb NOT NULL,
  timeout_milliseconds integer NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE net._http_response (
  id bigint PRIMARY KEY,
  status_code integer,
  content_type text,
  headers jsonb,
  content text,
  timed_out boolean,
  error_msg text,
  created timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION net.http_post(
  p_url text,
  p_body jsonb,
  p_params jsonb,
  p_headers jsonb,
  p_timeout_milliseconds integer
)
RETURNS bigint
LANGUAGE plpgsql
AS $stub$
DECLARE
  v_request_id bigint;
BEGIN
  INSERT INTO net.http_request_queue(method, url, headers, body, timeout_milliseconds)
  VALUES ('POST', p_url, p_headers, p_body, p_timeout_milliseconds)
  RETURNING id INTO v_request_id;
  RETURN v_request_id;
END;
$stub$;

CREATE TABLE public.luna_verified_market_sources (
  source_code text primary key,
  configured boolean not null,
  enabled boolean not null,
  execution_grade boolean not null,
  book_grade boolean not null,
  source_type text,
  authority text,
  max_staleness_seconds integer not null default 60
);

CREATE TABLE public.luna_sessions (
  id uuid primary key,
  session_date date not null,
  started_at timestamptz not null,
  ended_at timestamptz,
  status text not null
);

CREATE TABLE public.luna_universe (
  symbol text primary key,
  is_active boolean not null default true
);

CREATE TABLE public.luna_market_ingest_batches (
  batch_id uuid primary key default gen_random_uuid(),
  source text not null,
  received_at timestamptz not null default now(),
  feed_ts timestamptz not null,
  symbol_count integer not null,
  tick_count integer not null,
  book_complete boolean not null,
  payload_hash text not null,
  accepted boolean not null default false,
  reject_reason text,
  session_id uuid,
  created_at timestamptz not null default now(),
  unique (source,feed_ts,payload_hash)
);

CREATE TABLE public.luna_market_ticks (
  id bigint generated always as identity primary key,
  session_id uuid not null,
  symbol text not null,
  ts timestamptz not null,
  bid numeric,
  ask numeric,
  last numeric,
  bid_size bigint,
  ask_size bigint,
  source text not null,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (session_id,symbol,ts,source)
);

CREATE FUNCTION public.luna_register_verified_feed_heartbeat(
  text,timestamptz,integer,boolean,text
) RETURNS void LANGUAGE plpgsql AS $stub$ BEGIN RETURN; END; $stub$;

INSERT INTO public.luna_verified_market_sources
(source_code,configured,enabled,execution_grade,book_grade,source_type,authority,max_staleness_seconds)
VALUES ('TOPTRADER_REALTIME',true,true,true,true,'MARKET_DATA','TOPTRADER',60);

INSERT INTO public.luna_sessions(id,session_date,started_at,status)
VALUES ('11111111-1111-4111-8111-111111111111',current_date,now()-interval '5 minutes','OPEN');

INSERT INTO public.luna_universe(symbol,is_active)
VALUES ('PTT',true),('KBANK',true),('AOT',true);

\ir ../migrations/20261018093000_luna_verified_ingest_retention_idempotency.sql
\ir ../migrations/20261018110000_luna_ingest_http_request_audit.sql

DO $$
DECLARE
  v_ts timestamptz;
  v_rows jsonb;
  v_result jsonb;
  v_batch uuid;
  v_accepted boolean;
  v_expected integer;
  v_retained bigint;
BEGIN
  -- Malformed input should return a structured rejection, not raise a NOT NULL error.
  v_result := public.luna_ingest_verified_market_batch(
    'TOPTRADER_REALTIME',clock_timestamp(),NULL,true,'[]'::jsonb
  );
  IF v_result->>'accepted' <> 'false' OR v_result->>'reject_reason' <> 'MISSING_PAYLOAD_HASH' THEN
    RAISE EXCEPTION 'missing payload hash must return a clean rejection: %',v_result;
  END IF;

  -- Case A: a fully persisted accepted batch may report an idempotent retry.
  v_ts := clock_timestamp();
  v_rows := jsonb_build_array(jsonb_build_object(
    'symbol','PTT','ts',v_ts,'bid',31.75,'ask',31.80,'last',31.80,
    'bid_size',1000,'ask_size',1200,'raw',jsonb_build_object('test','complete')
  ));
  v_result := public.luna_ingest_verified_market_batch(
    'TOPTRADER_REALTIME',v_ts,'hash-complete-1',true,v_rows
  );
  IF v_result->>'accepted' <> 'true' OR v_result->>'idempotent' <> 'false' THEN
    RAISE EXCEPTION 'fresh batch should be accepted on first insert: %',v_result;
  END IF;
  v_batch := (v_result->>'batch_id')::uuid;

  v_result := public.luna_ingest_verified_market_batch(
    'TOPTRADER_REALTIME',v_ts,'hash-complete-1',true,v_rows
  );
  IF v_result->>'accepted' <> 'true' OR v_result->>'idempotent' <> 'true' THEN
    RAISE EXCEPTION 'fully retained batch should be an accepted idempotent retry: %',v_result;
  END IF;
  IF (v_result->>'rows_retained')::integer <> 1 THEN
    RAISE EXCEPTION 'idempotent result must report exact retained rows: %',v_result;
  END IF;

  -- Simulate the production 35-minute retention job having removed the ticks.
  DELETE FROM public.luna_market_ticks
  WHERE raw->>'verification_batch_id'=v_batch::text;

  v_result := public.luna_ingest_verified_market_batch(
    'TOPTRADER_REALTIME',v_ts,'hash-complete-1',true,v_rows
  );
  IF v_result->>'accepted' <> 'false'
     OR v_result->>'reject_reason' <> 'IDEMPOTENCY_TICKS_NOT_RETAINED' THEN
    RAISE EXCEPTION 'expired accepted metadata must fail closed: %',v_result;
  END IF;
  SELECT accepted,tick_count INTO STRICT v_accepted,v_expected
  FROM public.luna_market_ingest_batches WHERE batch_id=v_batch;
  SELECT count(*) INTO v_retained FROM public.luna_market_ticks
  WHERE raw->>'verification_batch_id'=v_batch::text;
  IF v_accepted IS DISTINCT FROM false OR v_expected <> 1 OR v_retained <> 0 THEN
    RAISE EXCEPTION 'expired batch metadata must be rejected but retain expected row count (accepted %, expected %, retained %)',
      v_accepted,v_expected,v_retained;
  END IF;

  -- An identical replay must stay rejected until a new observation/hash arrives.
  v_result := public.luna_ingest_verified_market_batch(
    'TOPTRADER_REALTIME',v_ts,'hash-complete-1',true,v_rows
  );
  IF v_result->>'accepted' <> 'false'
     OR v_result->>'reject_reason' <> 'IDEMPOTENCY_TICKS_NOT_RETAINED' THEN
    RAISE EXCEPTION 'expired replay must not regain accepted status: %',v_result;
  END IF;

  -- A newly observed timestamp/hash can pass the normal freshness/row guards.
  v_ts := clock_timestamp();
  v_rows := jsonb_build_array(jsonb_build_object(
    'symbol','PTT','ts',v_ts,'bid',31.76,'ask',31.81,'last',31.80,
    'bid_size',1000,'ask_size',1200,'raw',jsonb_build_object('test','fresh')
  ));
  v_result := public.luna_ingest_verified_market_batch(
    'TOPTRADER_REALTIME',v_ts,'hash-complete-2',true,v_rows
  );
  IF v_result->>'accepted' <> 'true' OR (v_result->>'rows_ingested')::integer <> 1 THEN
    RAISE EXCEPTION 'new fresh snapshot should ingest successfully: %',v_result;
  END IF;

  -- Staleness must also invalidate an idempotent replay even while its rows remain.
  v_batch := (v_result->>'batch_id')::uuid;
  UPDATE public.luna_market_ingest_batches
  SET feed_ts=clock_timestamp()-interval '5 minutes'
  WHERE batch_id=v_batch;
  v_ts := clock_timestamp()-interval '5 minutes';
  v_result := public.luna_ingest_verified_market_batch(
    'TOPTRADER_REALTIME',v_ts,'hash-complete-2',true,v_rows
  );
  IF v_result->>'accepted' <> 'false' OR v_result->>'reject_reason' <> 'STALE_FEED_TIMESTAMP' THEN
    RAISE EXCEPTION 'stale identical replay must fail even if rows are retained: %',v_result;
  END IF;
  SELECT accepted INTO STRICT v_accepted
  FROM public.luna_market_ingest_batches WHERE batch_id=v_batch;
  IF v_accepted IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'stale replay must invalidate accepted metadata';
  END IF;

  -- Case B: partial retention is also not allowed to report accepted=true.
  v_ts := clock_timestamp();
  v_rows := jsonb_build_array(
    jsonb_build_object('symbol','KBANK','ts',v_ts,'bid',100.0,'ask',100.1,'last',100.05,
      'bid_size',500,'ask_size',600,'raw',jsonb_build_object('test','partial')),
    jsonb_build_object('symbol','AOT','ts',v_ts,'bid',55.0,'ask',55.1,'last',55.05,
      'bid_size',700,'ask_size',800,'raw',jsonb_build_object('test','partial'))
  );
  v_result := public.luna_ingest_verified_market_batch(
    'TOPTRADER_REALTIME',v_ts,'hash-partial-1',true,v_rows
  );
  IF v_result->>'accepted' <> 'true' OR (v_result->>'rows_ingested')::integer <> 2 THEN
    RAISE EXCEPTION 'two-symbol fixture should ingest successfully: %',v_result;
  END IF;
  v_batch := (v_result->>'batch_id')::uuid;

  DELETE FROM public.luna_market_ticks
  WHERE raw->>'verification_batch_id'=v_batch::text AND symbol='AOT';

  v_result := public.luna_ingest_verified_market_batch(
    'TOPTRADER_REALTIME',v_ts,'hash-partial-1',true,v_rows
  );
  IF v_result->>'accepted' <> 'false'
     OR v_result->>'reject_reason' <> 'IDEMPOTENCY_TICKS_NOT_RETAINED'
     OR (v_result->>'rows_expected')::integer <> 2
     OR (v_result->>'rows_retained')::integer <> 1 THEN
    RAISE EXCEPTION 'partially retained batch must fail closed with counts: %',v_result;
  END IF;

  RAISE NOTICE 'PASS: accepted idempotency requires exact tick retention';
  RAISE NOTICE 'PASS: expired identical snapshot stays rejected';
  RAISE NOTICE 'PASS: new fresh snapshot is accepted';
  RAISE NOTICE 'PASS: partial retention fails closed with expected/retained counts';
END $$;


DO $audit$
DECLARE
  v_rest_request bigint;
  v_ws_request bigint;
  v_result bigint;
  v_row private.luna_ingest_http_requests%ROWTYPE;
BEGIN
  -- A wrapper must preserve the existing request-ID return contract and store
  -- only endpoint/mode/ID metadata, never its secret-bearing headers or payload.
  v_rest_request := public.luna_trigger_toptrader_market_ingest('{"priority_only":true}'::jsonb);
  SELECT * INTO STRICT v_row
  FROM private.luna_ingest_http_requests
  WHERE request_id = v_rest_request;

  IF v_row.endpoint <> 'luna-toptrader-market-ingest'
     OR v_row.request_mode <> 'priority'
     OR v_row.response_at IS NOT NULL THEN
    RAISE EXCEPTION 'REST request must be queued with safe metadata: %', row_to_json(v_row);
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='private' AND table_name='luna_ingest_http_requests'
      AND column_name IN ('headers','body','secret','authorization')
  ) THEN
    RAISE EXCEPTION 'Audit table must not have columns for secrets or request payloads';
  END IF;

  -- Simulate the async pg_net response becoming available between cron runs.
  INSERT INTO net._http_response(id,status_code,content_type,headers,content,timed_out,error_msg,created)
  VALUES (v_rest_request,200,'application/json','{}'::jsonb,
    '{"ok":true,"status":"NO_FRESH_MATCHED_BOOK","accepted_batches":[],"rejected_batches":[{"reason":"NO_FRESH_MATCHED_BOOK"}]}',
    false,NULL,clock_timestamp());

  -- The next scheduled wrapper reconciles the preceding response before it enqueues its own request.
  v_ws_request := public.luna_trigger_toptrader_ws_ingest();
  SELECT * INTO STRICT v_row
  FROM private.luna_ingest_http_requests
  WHERE request_id = v_rest_request;

  IF v_row.http_status <> 200
     OR v_row.timed_out IS DISTINCT FROM false
     OR v_row.response_at IS NULL
     OR v_row.response_excerpt NOT LIKE '%NO_FRESH_MATCHED_BOOK%' THEN
    RAISE EXCEPTION 'REST HTTP response must be reconciled and archived: %', row_to_json(v_row);
  END IF;

  SELECT * INTO STRICT v_row
  FROM private.luna_ingest_http_requests
  WHERE request_id = v_ws_request;
  IF v_row.endpoint <> 'luna-toptrader-ws-ingest'
     OR v_row.request_mode <> 'websocket' THEN
    RAISE EXCEPTION 'WS request must be tagged as websocket: %', row_to_json(v_row);
  END IF;

  INSERT INTO net._http_response(id,status_code,content_type,headers,content,timed_out,error_msg,created)
  VALUES (v_ws_request,NULL,NULL,NULL,NULL,true,'fixture upstream timeout',clock_timestamp());

  v_result := public.luna_trigger_toptrader_market_ingest('{}'::jsonb);
  SELECT * INTO STRICT v_row
  FROM private.luna_ingest_http_requests
  WHERE request_id = v_ws_request;

  IF v_row.timed_out IS DISTINCT FROM true
     OR v_row.error_msg <> 'fixture upstream timeout'
     OR v_row.response_at IS NULL THEN
    RAISE EXCEPTION 'HTTP timeout must be captured: %', row_to_json(v_row);
  END IF;

  RAISE NOTICE 'PASS: scheduled REST/WS requests retain request ID, endpoint and mode';
  RAISE NOTICE 'PASS: next request reconciles previous HTTP status/body excerpt';
  RAISE NOTICE 'PASS: timeout/error diagnostics are archived without secret or payload columns';
END
$audit$;
