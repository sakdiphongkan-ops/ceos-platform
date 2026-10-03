# LUNA 2.0 Implementation Roadmap

## Phase 0 — Architecture Freeze

Lock:
- domain model
- evidence model
- identity/account model
- entitlement model
- audit model
- strategy lifecycle

Exit condition: no new feature is accepted without mapping to the domain model.

## Phase 1 — Unified Core

Integrate CEOS Fundamental Intelligence with LUNA Quant/Market intelligence through shared contracts.

Do not merge code blindly. Refactor behind stable interfaces.

## Phase 2 — Decision Engine

Implement:

VALUE + QUALITY + MARKET + RISK + PORTFOLIO → DECISION

Keep evidence visible and auditable.

## Phase 3 — Research OS

Formula → Backtest → OOS → Holdout → Walk-forward → Robustness → Paper

Keep benchmark/reference engines distinct from custom-formula execution.

## Phase 4 — Commercial Layer

Implement:
- authentication
- organizations
- plans
- subscriptions
- entitlements
- usage metering
- billing events
- trial/upgrade

## Phase 5 — CIO Agent

Implement read/analyze/recommend/prepare workflows first.

## Phase 6 — ERP

Connect finance, sales, product, operations, research and risk.

## Phase 7 — Ecosystem

Open:
- API
- strategy marketplace
- research marketplace
- strategy licensing
- enterprise integrations

## Production gates

No production claim is made until:
1. Build passes.
2. Regression checks pass.
3. Browser/E2E checks pass when available.
4. Data provenance is verified.
5. Research gates remain fail-closed.
6. No approved UI is changed unintentionally.
7. No real-money execution is enabled without explicit governance.

## Immediate execution order

1. Keep current LUNA UI baseline unchanged.
2. Finish LUNA Lab state/accessibility patch when deployment capacity is available.
3. Add the unified domain contracts in code.
4. Map existing CEOS tables/models to the domain model.
5. Identify duplication between CEOS and LUNA services.
6. Build Decision Engine interfaces.
7. Add billing/entitlements before public paid launch.
8. Build CIO Agent on top of verified interfaces.
