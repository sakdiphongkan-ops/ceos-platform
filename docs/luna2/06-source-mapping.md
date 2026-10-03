# LUNA 2.0 Existing-System Mapping

This inventory distinguishes verified source facts from planned integration.

## Verified from the current repository

### Existing LUNA runtime surface

app/luna/page.tsx consumes:
- fetchPortfolioState
- fetchShadowStatus
- fetchControlRoom
- fetchTournament100
- realtime quote stream

### Existing runtime contract

lib/luna-client.ts already exposes:
- RuntimeStatus
- ShadowStatus
- RealtimeQuote
- FeedSession
- LunaFeed
- ControlRoomState
- Tournament100Result

### Existing runtime configuration

lib/luna-runtime.ts already defines:
- LUNA strategy version
- 15m timeframe
- Bangkok timezone
- market-phase UI mirror
- realtime freshness helper

### Integration already possible

lib/luna2/adapters/luna-feed.ts maps current feed objects into:
- MarketObservation
- FactorObservation
- RiskAssessment
- PortfolioContext
- EvidenceRef

## CEOS verified facts

The repository is a Next.js 14 + TypeScript + Supabase application with:
- app/
- components/
- lib/
- types/
- migrations/ documented in README

The repository contains an existing app/luna portfolio surface.

## Not yet verified

The following must be mapped from the full CEOS source before implementation:
- exact valuation data schemas
- exact financial-statement schemas
- exact Supabase tables/RLS
- exact CEOS DCF/DDM/SOTP implementation
- exact SEC/IR ingestion pipeline
- existing billing/account model, if any

Do not infer these schemas. Inspect source/database definitions first.

## Integration rule

CEOS and LUNA should not be merged by copying code into one large module.

Use domain adapters:

CEOS source -> Fundamental Intelligence contracts
LUNA source -> Market/Quant/Risk/Execution contracts
Both -> Decision Engine

## Production rule

No code path should switch existing execution behavior solely because the unified contracts exist.
The contracts are an integration layer until each upstream source has been verified.