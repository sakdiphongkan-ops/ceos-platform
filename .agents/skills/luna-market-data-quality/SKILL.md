---
name: luna-market-data-quality
description: Validate LUNA quotes using source-event freshness, ingestion timestamps, price invariants and feed provenance. Use before modifying market-data adapters or quality gates.
---

# LUNA market data quality

## Scope
This skill applies to the `luna-th1h` worker and its `Quote` contract. It is an engineering checklist, not a provider or a replacement for the production execution gate.

## Timestamp rules
- Keep `ts` (ingestion timestamp) separate from `sourceTs` (provider/source event timestamp).
- A recently received HTTP/WebSocket payload is not necessarily fresh market data. When `sourceTs` is present, validate its age independently; the ingestion timestamp must not refresh an old quote.
- Reject malformed timestamps, source timestamps that exceed the configured future tolerance, source timestamps later than ingestion, and stale source timestamps.
- Do not promote `generatedAt`, `generated_at`, request time or cache update time to event time unless the provider contract explicitly defines that field as the market event timestamp.
- The current `assessQuoteQuality` defaults in `luna-th1h/src/data-quality.ts` are `maxAgeMs=2000` and `maxFutureSkewMs=1000`. These are specific to this worker. Do not copy thresholds from another LUNA service without verifying its source contract and deployment configuration.

## Quote checks
- Require a non-empty symbol and at least one usable positive price.
- Reject non-positive bid/ask, crossed bid/ask, and negative bid/ask sizes.
- For execution-grade use, require a source timestamp, authorized/verified provider evidence, complete two-sided depth, and provider-specific tick/book parity. A generic `Quote` that passes `assessQuoteQuality` alone is not proof that the order book is execution-grade.
- Keep original observations immutable; write diagnostics or normalized results separately.

## Required regression cases
Test fresh data, stale ingestion time, stale source time with a fresh ingestion timestamp, invalid timestamps, future timestamps, source-after-ingest, no usable price, crossed book, and invalid depth. Add a regression test for every new failure mode.

## Safe workflow
1. Read the provider adapter and `Quote` type before changing validation.
2. Add deterministic tests with a fixed `nowMs`.
3. Run `npm run typecheck` and `npm run test:data-quality` from `luna-th1h`.
4. Preserve all separate live-execution guards. Do not relax freshness thresholds to improve coverage.
