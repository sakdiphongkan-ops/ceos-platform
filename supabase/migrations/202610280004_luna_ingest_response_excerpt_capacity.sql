-- Preserve the full bounded WebSocket ingest diagnostics in the private request history.
-- The response includes per-chunk metrics and up to 20 mismatch summaries; 3,500 characters
-- can truncate its tail. This keeps the same retention and reconciliation semantics while
-- raising only the maximum stored response excerpt length.
create or replace function private.luna_reconcile_ingest_http_requests(p_limit integer default 500)
 returns integer
 language plpgsql
 security definer
 set search_path to 'pg_catalog', 'private', 'net', 'pg_temp'
as $function$
declare
  v_updated integer := 0;
begin
  with candidates as (
    select
      a.request_id,
      r.status_code,
      r.timed_out,
      r.error_msg,
      r.created,
      r.content
    from private.luna_ingest_http_requests a
    join net._http_response r on r.id = a.request_id
    where a.response_observed_at is null
    order by a.queued_at
    limit greatest(1, least(coalesce(p_limit, 500), 2000))
  ),
  updated as (
    update private.luna_ingest_http_requests a
    set http_status = c.status_code,
        timed_out = coalesce(c.timed_out, false),
        error_msg = nullif(c.error_msg, ''),
        response_at = c.created,
        response_excerpt = left(coalesce(c.content, ''), 7500),
        response_observed_at = clock_timestamp(),
        reconciled_at = clock_timestamp()
    from candidates c
    where a.request_id = c.request_id
      and a.response_observed_at is null
    returning a.request_id
  )
  select count(*)::integer into v_updated from updated;

  -- Keep the bounded diagnostic history policy that already exists.
  delete from private.luna_ingest_http_requests
  where queued_at < now() - interval '7 days';

  return v_updated;
end;
$function$;
