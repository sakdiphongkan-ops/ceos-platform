-- LUNA TopTrader next-market-open diagnostics
-- READ ONLY: every statement is SELECT. No migrations, writes, orders, or secrets.
-- Run in Supabase SQL Editor during an actual SET/mai session, then repeat 2-3 minutes later.
-- Current endpoint gates: quote observation <=50s; book observation <=30s; matching, non-crossed two-sided book required.
-- Note: current cron wrappers return the pg_net request ID, not the final HTTP/Edge Function result.

-- 1) Compact freshness summary. An empty tick table outside session may be normal under 35-minute retention.
select
  now() as checked_at_utc,
  (select count(*) from public.luna_market_ingest_batches
    where source='TOPTRADER_REALTIME' and accepted=true) as accepted_batch_history,
  (select max(created_at) from public.luna_market_ingest_batches
    where source='TOPTRADER_REALTIME' and accepted=true) as latest_accepted_batch_created_at,
  (select max(feed_ts) from public.luna_market_ingest_batches
    where source='TOPTRADER_REALTIME' and accepted=true) as latest_accepted_feed_ts,
  (select count(*) from public.luna_market_ticks
    where source='TOPTRADER_REALTIME') as currently_retained_ticks,
  (select max(ts) from public.luna_market_ticks
    where source='TOPTRADER_REALTIME') as latest_retained_tick_ts,
  (select count(*) from public.luna_worker_quote_cache) as worker_cache_rows,
  (select max(received_at) from public.luna_worker_quote_cache) as latest_worker_received_at,
  (select max(updated_at) from public.luna_worker_quote_cache) as worker_cache_updated_at;

-- 2) Current tick ages by source. For an open session, focus on fresh timestamps, not just counts.
select
  source,
  count(*) as retained_rows,
  count(distinct symbol) as symbols,
  max(ts) as latest_tick_ts,
  round(extract(epoch from (now() - max(ts)))::numeric, 1) as latest_tick_age_seconds
from public.luna_market_ticks
group by source
order by latest_tick_ts desc nulls last;

-- 3) Worker telemetry cache: verify both freshness and eligibility instead of assuming any cached quote is usable.
select
  provider_source,
  data_quality,
  execution_eligible,
  count(*) as rows,
  count(distinct symbol) as symbols,
  max(quote_ts) as latest_quote_ts,
  max(received_at) as latest_received_at,
  round(extract(epoch from (now() - max(quote_ts)))::numeric, 1) as latest_quote_age_seconds
from public.luna_worker_quote_cache
group by provider_source, data_quality, execution_eligible
order by latest_received_at desc nulls last;

-- 4) Scheduled job outcome counts. "succeeded / 1 row" only confirms the enqueue RPC ran, not that the remote ingest accepted ticks.
select
  jobid,
  count(*) filter (where status='succeeded') as succeeded_runs,
  count(*) filter (where status='failed') as failed_runs,
  max(start_time) filter (where status='succeeded') as latest_success_at,
  max(start_time) filter (where status='failed') as latest_failure_at,
  string_agg(distinct return_message, ' | ') filter (where status='failed') as failure_messages
from cron.job_run_details
where jobid in (10,12,13)
  and start_time > now() - interval '24 hours'
group by jobid
order by jobid;

-- 5) Recent run details for the REST full sweep (10), priority REST (12), and WS ingest (13).
select
  jobid, status, start_time, end_time,
  round(extract(epoch from (end_time-start_time))::numeric, 2) as elapsed_seconds,
  return_message
from cron.job_run_details
where jobid in (10,12,13)
  and start_time > now() - interval '24 hours'
order by start_time desc
limit 60;

-- 6) pg_cron scheduler state and relevant settings. Do not change settings based on this snapshot alone.
select
  pid as scheduler_pid, usename, application_name, backend_start,
  wait_event_type, state, backend_type
from pg_stat_activity
where application_name ilike 'pg_cron scheduler';

select
  current_setting('cron.timezone', true) as cron_timezone,
  current_setting('cron.use_background_workers', true) as use_background_workers,
  current_setting('cron.max_running_jobs', true) as max_running_jobs,
  current_setting('max_worker_processes') as max_worker_processes,
  current_setting('max_connections') as max_connections,
  (select count(*) from pg_stat_activity) as current_sessions,
  (select count(*) from cron.job where active) as active_cron_jobs;

-- 7) Recent pg_net HTTP responses. This table does not store the target URL, so correlate rows by timestamp.
-- The production cron wrapper currently discards the request ID after returning it to pg_cron; this is useful context, not definitive endpoint attribution.
select
  id, status_code, timed_out, error_msg, created,
  left(coalesce(content, ''), 600) as response_body_excerpt
from net._http_response
where created > now() - interval '2 hours'
order by created desc
limit 100;

-- 8) Exact ingest batches for the current/previous session.
select
  batch_id, source, feed_ts, created_at, tick_count, symbol_count,
  book_complete, accepted, reject_reason
from public.luna_market_ingest_batches
where source='TOPTRADER_REALTIME'
  and created_at > now() - interval '3 days'
order by created_at desc
limit 100;
