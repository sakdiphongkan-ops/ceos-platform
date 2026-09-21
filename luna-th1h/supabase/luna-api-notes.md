The worker writes through the Supabase luna-api Edge Function. Direct table access is protected by RLS. The Edge Function uses its server-side secret key for inserts and returns a compact control-room feed for GET requests.
## Live order/fill ledger v34 — 2026-09-22

luna-api is deployed at version 34. The record_fill action now calls public.luna_record_fill_v2 and requires order_qty, cumulative_filled_qty, and idempotency_key. Live reconciliation uses a cumulative-fill key of client_order_id:FILL:<cumulative_filled_qty>, so repeated broker snapshots for the same cumulative fill are idempotent while later partial fills are recorded as new deltas.

The live schema adds luna_orders.broker_order_id, luna_fills.idempotency_key, and luna_fills.cumulative_filled_qty, with unique indexes for broker order identity and fill idempotency. A transaction-level production DB test verified 50% fill, duplicate retry, second 50% fill, and duplicate retry results in exactly two fills with the order ending 100/100 FILLED.
## RPC security hardening — 2026-09-22

luna_record_fill_v2 is SECURITY DEFINER but EXECUTE is now revoked from public, anon, and authenticated. Only service_role can execute the RPC; the Edge Function reaches it through its server-side service-role client. Supabase security advisor no longer reports luna_record_fill_v2 as publicly executable.
## Public feed minimization v35 — 2026-09-22

luna-api version 35 keeps the browser-facing GET feed intentionally narrower: public orders omit client_order_id and broker_order_id, fills omit idempotency_key and cumulative_filled_qty, and audit rows omit raw payload. These fields remain available to the authenticated server-side execution path and database ledger.

## Batched telemetry v36 — 2026-09-22

The runtime telemetry path now uses a bounded queue instead of one Edge Function request per persisted tick/signal. Ticks are coalesced by session + symbol and signals remain FIFO. The queue defaults to 50 items or 50 ms, whichever comes first.

The `telemetry_batch` Edge Function action inserts ticks/signals in batches. Tick persistence uses the unique key `session_id + symbol + ts`, and signal persistence uses the same runtime event key; duplicate retries are ignored. Fast live-state updates are processed through `luna_update_fast_live_tick_batch(jsonb)`.

The production migration added unique indexes for both telemetry streams and restricted the new SECURITY DEFINER batch RPC to `service_role`.

A rollback database test verified duplicate submission leaves exactly one tick and one signal while fast live state updates to the latest price. No test rows remained after rollback.
