# LUNA connector decision: TISCO account and zero incremental cost

**Date:** 2026-10-17  
**Scope:** Thai equities on SET/mai only; zero additional monthly connector/data fees; paper trading only until independently verified.

## Decision

Do not configure the existing Settrade Open API bridge with TISCO credentials unless TISCO explicitly confirms that the account is eligible and issues the required Open API credentials. In the Settrade broker capability table retrieved on 2026-10-17, the TISCO row does not indicate Settrade Open API availability for either equities or TFEX. The table states its data is as of 2026-07-15.

Official references:
- https://www.settrade.com/th/services-and-tools/brokers
- https://www.settrade.com/th/services-and-tools/trading-program/advance/main
- https://developer.settrade.com/open-api/
- TISCO contact/FAQ: https://www.tiscosec.com/faqs/ (phone shown by TISCO: 02 080 6000 or 02 633 6000, press 5)

## Cost and data policy

1. No SET Market Data paid API is approved for this zero-incremental-cost path.
2. Public GitHub data may be used for offline universe/reference-data tests only. It is not an execution-grade real-time feed and must never satisfy a live quote or order-book gate.
3. Existing TopTrader ingestion is not automatically approved as an authorized redistribution or execution-grade source. Keep it classified as unverified until its terms, source identity, timestamps, and data completeness are verified.
4. Never scrape or automate TISCO's authenticated trading website, reuse session cookies, or reverse-engineer undocumented endpoints as a substitute for a supported API.
5. Do not request or store brokerage passwords, trading PINs, OTPs, or session cookies in this repository or chat.

## LUNA implementation posture

- Keep LIVE_TRADING_ARMED=false.
- Keep paper-only mode and the gateway kill switch enabled.
- Keep LUNA_REQUIRE_VERIFIED_BOOK=true.
- Keep LUNA_PRICE_ONLY_FALLBACK=false for any execution-grade signal path.
- A connector heartbeat alone is not proof of a verified feed. Require a fresh exchange/vendor timestamp, symbol identity, sane last price, best bid and ask, sizes where available, monotonic freshness, and documented permission to consume the data.
- Do not emit executable signals while NO_VERIFIED_EXECUTION_BOOK or UNVERIFIED_FEED_SOURCE is present.
- Do not call LUNA production-ready until deployments are online, health/readiness checks pass, and live-session paper checks demonstrate fresh verified data and complete audit records.

## Acceptance checklist

- [ ] TISCO confirms in writing whether it supports Settrade Open API for this customer's equity account and whether API access/data carry any incremental fees.
- [ ] If TISCO does not support it, either keep LUNA in research/paper-only mode or compare a broker switch only after confirming that broker's API and data fees are zero for the intended use.
- [ ] Document the exact data provider, permitted use, timestamp semantics, market coverage, rate limits, and failover behavior.
- [ ] Verify 5-10 symbols during an open SET session before expanding toward the 929-symbol target.
- [ ] Confirm bid/ask freshness, symbol coverage, rejection behavior, reconnect behavior, duplicate handling, latency percentiles, and traceability from quote to paper fill.
- [ ] Restore authorized GitHub-to-Railway deployment access and successfully deploy Worker and Gateway from the reviewed current source; do not redeploy old failed snapshots.
- [ ] Keep all live order paths disabled unless a separate future authorization and full safety review explicitly permits them.

## Current blockers observed on 2026-10-17

- Railway production environment showed luna-worker, luna-worker-v4, and luna-execution-gateway offline, with the latest deployments failed.
- The latest accepted TOPTRADER_REALTIME ingest batch in Supabase was created at 2026-10-15 08:35:02 UTC. This is historical evidence, not proof of a live feed now.
- Existing Settrade bridge code requires SETTRADE_APP_ID, SETTRADE_APP_SECRET, SETTRADE_APP_CODE, and SETTRADE_BROKER_ID; do not fill these with TISCO values unless the broker confirms eligibility and issues valid credentials.

## Next operational step

Contact TISCO through its official service channel and ask:
1. Does TISCO currently offer Settrade Open API to an individual SET/mai equity customer?
2. If yes, how does the customer apply, and are API access, real-time equity market data, and best bid/offer included without additional monthly charges?
3. Is programmatic data ingestion into a private paper-trading research system permitted?
4. Is order submission available through the API, and what are the paper/demo restrictions and safety requirements?

Until these answers and deployment/feed checks pass, the correct status is **research/paper-only; not production-ready for automated trading**.
