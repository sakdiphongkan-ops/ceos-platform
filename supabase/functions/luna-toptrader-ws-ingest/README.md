# TopTrader WebSocket ingest source

This is a version-controlled source mirror of the active `luna-toptrader-ws-ingest` Supabase Edge Function, inspected at deployed version 1 (2026-10-15T10:45:14.952Z).

The deployed function uses public TopTrader WebSocket market data and checks quote age, book age, tick/book pair skew, valid bid/ask and positive depth before it asks the verified-ingest RPC to insert rows. It does not route broker orders.

This file is tracked for source parity; **adding it to the repository does not deploy or replace the active function**. Runtime secrets are read from environment variables and are not stored here.
