-- LUNA TopTrader HTTP request audit.
-- Staged source-control change only: do not apply to production until reviewed.
-- Stores request metadata and a bounded response excerpt, never auth headers or payloads.
CREATE TABLE IF NOT EXISTS private.luna_ingest_http_requests (
  request_id bigint PRIMARY KEY,
  endpoint text NOT NULL CHECK (
    endpoint IN ('luna-toptrader-market-ingest', 'luna-toptrader-ws-ingest')
  ),
  request_mode text NOT NULL CHECK (
    request_mode IN ('full', 'priority', 'websocket')
  ),
  queued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  http_status integer,
  timed_out boolean,
  error_msg text,
  response_at timestamptz,
  response_excerpt text,
  reconciled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (response_at IS NULL
      AND http_status IS NULL
      AND timed_out IS NULL
      AND error_msg IS NULL
      AND response_excerpt IS NULL)
    OR response_at IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS luna_ingest_http_requests_pending_idx
  ON private.luna_ingest_http_requests (queued_at)
  WHERE response_at IS NULL;

CREATE INDEX IF NOT EXISTS luna_ingest_http_requests_queued_idx
  ON private.luna_ingest_http_requests (queued_at DESC);

REVOKE ALL ON TABLE private.luna_ingest_http_requests FROM PUBLIC;

CREATE OR REPLACE FUNCTION private.luna_reconcile_ingest_http_requests(
  p_limit integer DEFAULT 500
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'private', 'net', 'pg_temp'
AS $function$
DECLARE
  v_updated integer := 0;
BEGIN
  WITH candidates AS (
    SELECT
      a.request_id,
      r.status_code,
      r.timed_out,
      r.error_msg,
      r.created,
      r.content
    FROM private.luna_ingest_http_requests a
    JOIN net._http_response r ON r.id = a.request_id
    WHERE a.response_at IS NULL
    ORDER BY a.queued_at
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 500), 2000))
  ),
  updated AS (
    UPDATE private.luna_ingest_http_requests a
    SET http_status = c.status_code,
        timed_out = COALESCE(c.timed_out, false),
        error_msg = NULLIF(c.error_msg, ''),
        response_at = c.created,
        response_excerpt = LEFT(COALESCE(c.content, ''), 400),
        reconciled_at = clock_timestamp()
    FROM candidates c
    WHERE a.request_id = c.request_id
      AND a.response_at IS NULL
    RETURNING a.request_id
  )
  SELECT count(*)::integer INTO v_updated FROM updated;

  -- Keep a bounded diagnostic history; do not retain unresolved requests forever.
  DELETE FROM private.luna_ingest_http_requests
  WHERE queued_at < now() - interval '7 days';

  RETURN v_updated;
END;
$function$;

REVOKE ALL ON FUNCTION private.luna_reconcile_ingest_http_requests(integer) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.luna_trigger_toptrader_market_ingest(
  p_payload jsonb DEFAULT '{}'::jsonb
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'private', 'net', 'pg_temp'
AS $function$
DECLARE
  v_secret text;
  v_request_id bigint;
  v_payload jsonb := COALESCE(p_payload, '{}'::jsonb);
  v_request_mode text := CASE
    WHEN COALESCE(p_payload->>'priority_only', 'false') = 'true' THEN 'priority'
    ELSE 'full'
  END;
BEGIN
  PERFORM private.luna_reconcile_ingest_http_requests(500);

  SELECT secret INTO v_secret
  FROM private.luna_scheduler_secrets
  WHERE name = 'tradingview_ingest';

  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'LUNA scheduler secret missing';
  END IF;

  SELECT net.http_post(
    'https://wigzicwgcsrhdummrbjx.supabase.co/functions/v1/luna-toptrader-market-ingest',
    v_payload,
    '{}'::jsonb,
    jsonb_build_object('Content-Type', 'application/json', 'x-luna-scheduler', v_secret),
    10000
  ) INTO v_request_id;

  INSERT INTO private.luna_ingest_http_requests(request_id, endpoint, request_mode)
  VALUES (v_request_id, 'luna-toptrader-market-ingest', v_request_mode)
  ON CONFLICT (request_id) DO NOTHING;

  RETURN v_request_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.luna_trigger_toptrader_ws_ingest()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'private', 'net', 'pg_temp'
AS $function$
DECLARE
  v_secret text;
  v_request_id bigint;
BEGIN
  PERFORM private.luna_reconcile_ingest_http_requests(500);

  SELECT secret INTO v_secret
  FROM private.luna_scheduler_secrets
  WHERE name = 'tradingview_ingest';

  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'LUNA scheduler secret missing';
  END IF;

  SELECT net.http_post(
    'https://wigzicwgcsrhdummrbjx.supabase.co/functions/v1/luna-toptrader-ws-ingest',
    '{}'::jsonb,
    '{}'::jsonb,
    jsonb_build_object('Content-Type', 'application/json', 'x-luna-scheduler', v_secret),
    15000
  ) INTO v_request_id;

  INSERT INTO private.luna_ingest_http_requests(request_id, endpoint, request_mode)
  VALUES (v_request_id, 'luna-toptrader-ws-ingest', 'websocket')
  ON CONFLICT (request_id) DO NOTHING;

  RETURN v_request_id;
END;
$function$;

-- Diagnostic query (read only):
-- SELECT a.*, r.status_code, r.timed_out, r.error_msg, r.created AS response_created
-- FROM private.luna_ingest_http_requests a
-- LEFT JOIN net._http_response r ON r.id = a.request_id
-- ORDER BY a.queued_at DESC LIMIT 100;
