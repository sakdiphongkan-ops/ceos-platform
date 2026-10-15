# LUNA worker observe-only API

## Purpose

`supabase/functions/luna-worker-api/index.ts` is the missing action endpoint expected by the `luna-th1h` worker (`SUPABASE_FUNCTION_URL`). It accepts the worker's `telemetry_batch`, `start_session`, `validate_session`, `audit`, and small diagnostic actions. It is deliberately not an order API.

## Data contract and safety properties

- Requests require `x-luna-agent` and a credential enabled with `credential_scope = 'general'`. The endpoint does not accept an anon key as agent authorization.
- `telemetry_batch` is capped at 100 items per call.
- Quote data is written to `public.luna_worker_quote_cache` keyed by symbol, so it stores only the latest observation per symbol instead of an unbounded tick history.
- Signal data is written to `public.luna_worker_signal_cache` keyed by strategy and symbol, so it stores only the latest signal per symbol.
- Both tables have RLS enabled, no grants for `anon` or `authenticated`, and a database constraint preventing `execution_eligible` from being true. Database triggers reject out-of-order overwrites.
- Provider timestamps are trusted only when the gateway explicitly supplies `sourceTs`/`source_ts`; receiving a quote at the gateway does not make its market timestamp fresh. Health reports missing provider timestamps separately.
- The cache is expressly **not** `luna_market_ticks` and does not call `luna_process_tick_batch` or `luna_update_fast_live_tick`. It therefore cannot poison the canonical verified-book feed or change the production decision plane.
- The endpoint refuses `record_fill`, `record_broker_event`, and order-submission actions with HTTP 423. A session snapshot is recorded as an audit observation, not added to the main paper portfolio.
- `GET ?view=health` returns only aggregated/sample health after custom agent authentication. The response labels all cached data as observation-only.
- `start_session` reuses the current open paper session for the exact current strategy/date and never closes the central session when the worker stops.

## Deployment state

The Edge Function `luna-worker-api` is deployed in Supabase project `wigzicwgcsrhdummrbjx` at version 3. Railway's `luna-worker-v4` is configured to paper + observe-only, with public fallback and order authorization disabled; those variables were set with deploys skipped. The worker and gateway services remain without a successful latest deployment because the pinned Railway deployment workflow cannot proceed until GitHub Actions has a non-empty `RAILWAY_TOKEN` repository secret. A direct HTTP smoke test of the new Edge Function could not be completed from the connected browser because the request ended at `ERR_TUNNEL_CONNECTION_FAILED`; so runtime HTTP status has not been independently verified yet. Do not bypass that exact-revision workflow.

The AppDeploy front end remains unchanged because the account is below its 16-credit deployment threshold. See [Mission Control](https://luna-set-intraday-pilot-lw8ffz.v2.appdeploy.ai/) and [LUNA Lab](https://luna-lab-fj5of4.v2.appdeploy.ai/); UI changes require restoring AppDeploy credits first.

## Validation checklist after Railway is deployable

1. Check `luna-worker-api?view=health` using the agent-authenticated worker request; expect cache counts, `execution_eligible=false`, and no order counts.
2. Confirm Railway worker logs include `LUNA_SESSION_STARTED` and stream/telemetry queue flushes without `TELEMETRY_FLUSH_ERROR`.
3. Confirm new rows appear in `luna_worker_quote_cache` while `luna_market_ticks` remains sourced only by the canonical authenticated/verified ingestion path.
4. Run the LUNA self-test. Do not promote the worker cache to the decision or execution feed unless source timestamp, quote/book matching, point-in-time data, CEOS, security and paper gates independently pass.
