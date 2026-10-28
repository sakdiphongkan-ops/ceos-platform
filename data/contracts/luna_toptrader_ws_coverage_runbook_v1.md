# LUNA TopTrader WebSocket coverage diagnostics

## Objective

Separate four different reasons a symbol may not appear in the verified market-tick table:
1. It is absent from the provider's symbol catalog.
2. No tick or book event occurred in the short WebSocket sampling window.
3. An event arrived but failed validation (timestamp, shape, price/depth, or symbol membership).
4. The HTTP invocation did not finish within the pg_net request timeout.

Do not treat these as the same failure, and do not loosen freshness or tick/book parity checks to improve reported coverage.

## Evidence captured on 2026-10-28 (Asia/Bangkok)

- The TopTrader REST symbol catalog returned 5,110 unique symbol entries; the active LUNA universe had 930 symbols and all 930 were present (700 SET + 230 mai).
- The current WebSocket ingestion requests all 930 symbols across 8 chunks (128 symbols per chunk, with the last chunk smaller). All 8 connections normally open and send the explicit subscription message. The normal listen window is 7 seconds.
- Recent production responses reported roughly 85–119 valid two-sided matched symbols per invocation. This is a measured count of events observed in that 7-second window, not evidence that the remaining symbols are unsupported.
- Diagnostic-only probes opened successfully and sent subscriptions. A 10-symbol active SET sample received Tick and Book events for 7 symbols in 3 seconds. A 10-symbol long-tail mai sample received no Tick or Book event in 3 seconds and reported no transport errors. A no-event result by itself cannot distinguish an unchanged book from a provider subscription/event limitation.
- REST Tick probes returned timestamped rows for both active and long-tail samples, but one quiet long-tail quote was over 3 hours old while a liquid sample's oldest quote was about 44 seconds old. Each quote must be judged by its own event timestamp.
- REST Book probes returned non-empty depth for 19 of 20 sampled symbols, but none of the 20 rows included a market-event `datetime`; they exposed only `generatedAt`. The latter is response-generation time, not a market-event time, and is not execution-grade freshness evidence.
- A few WebSocket HTTP requests also hit the 15-second pg_net timeout before the TCP/SSL/HTTP request stage; this must be analysed separately from missing symbol events.

## Source-contract references

- TopTrader official developer docs: https://developers.toptrader.co.th/docs/
- REST endpoints: `/v1/market/symbols`, `/v1/market/tick`, and `/v1/market/book`.
- WebSocket base: `wss://ws.toptrader.co.th/market`.
- The provider documents event-driven Tick/Book updates. A WebSocket window is not a guaranteed full-universe periodic snapshot.
- The API documentation says the Book `datetime` may be absent and documents `generatedAt` as server generation time. Never substitute `generatedAt` for the market event timestamp.

## Safeguards preserved

- Tick age <= 60 seconds.
- Book age <= 60 seconds.
- Tick/Book event timestamp skew <= 25 seconds.
- Future timestamp tolerance <= 2 seconds.
- Readiness coverage threshold remains 80%; passing it is not broker authorization.
- REST Book observations without event timestamps remain execution-ineligible.
- The diagnostic probe does not write to market-data tables or create orders; live execution remains locked.

## How to read the new telemetry

Each production WebSocket run returns a compact `chunk_diagnostics` array. For every chunk it records:
- number and lexical range of requested symbols;
- WebSocket opened, query-string subscription used, and explicit subscription sent;
- total frame messages, unique symbols with usable Tick/Book events;
- frame counters for Tick/Book/other types, missing symbol, outside chunk, missing/invalid timestamp, future timestamp, invalid Tick/Book, and parse errors.

Use `probe_only=true` with `subscription_mode=both|query|message` to compare subscription modes on up to 10 symbols. This is diagnostic-only. It does not write market-data rows or orders. Compare equivalent symbol lists at the same market session; a short no-event response is not proof that a symbol is unavailable.

## Next decision

Only consider changing the scheduled subscription strategy after a repeatable A/B result shows a different mode materially improves per-chunk event delivery without degrading timestamp validity, quote/book matching, or per-symbol freshness. Do not adopt REST Book for execution unless the provider supplies a documented event timestamp (or an independently verifiable market-data sequence/time contract).
