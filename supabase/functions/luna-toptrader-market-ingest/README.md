# TopTrader REST market-ingest source

This folder tracks the source for the deployed `luna-toptrader-market-ingest` Edge Function (previously managed outside this repository; inspected deployment version 9 on 2026-10-15T10:24:47.581Z).

The tracked patch adds a hard rejection for tick-observation timestamps older than `MAX_QUOTE_AGE_MS` in both the REST ingestion path and diagnostics. It does not relax the verified-book checks. This source snapshot is **not deployed by this commit**; production rollout is a separate, explicit gate after CI and live-session validation.

Secrets are supplied by the runtime environment and are not stored in this folder.
