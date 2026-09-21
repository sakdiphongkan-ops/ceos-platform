The worker writes through the Supabase luna-api Edge Function. Direct table access is protected by RLS. The Edge Function uses its server-side secret key for inserts and returns a compact control-room feed for GET requests.
## Live order/fill ledger v34 — 2026-09-22

luna-api is deployed at version 34. The record_fill action now calls public.luna_record_fill_v2 and requires order_qty, cumulative_filled_qty, and idempotency_key. Live reconciliation uses a cumulative-fill key of client_order_id:FILL:<cumulative_filled_qty>, so repeated broker snapshots for the same cumulative fill are idempotent while later partial fills are recorded as new deltas.

The live schema adds luna_orders.broker_order_id, luna_fills.idempotency_key, and luna_fills.cumulative_filled_qty, with unique indexes for broker order identity and fill idempotency. A transaction-level production DB test verified 50% fill, duplicate retry, second 50% fill, and duplicate retry results in exactly two fills with the order ending 100/100 FILLED.
## RPC security hardening — 2026-09-22

luna_record_fill_v2 is SECURITY DEFINER but EXECUTE is now revoked from public, anon, and authenticated. Only service_role can execute the RPC; the Edge Function reaches it through its server-side service-role client. Supabase security advisor no longer reports luna_record_fill_v2 as publicly executable.