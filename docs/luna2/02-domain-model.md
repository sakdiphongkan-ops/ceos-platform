# LUNA 2.0 Unified Domain Model

## Core entities

### Identity
- Organization
- User
- Role
- Permission
- Entitlement
- Subscription

### Market
- Instrument
- Venue
- MarketBar
- Quote
- CorporateAction
- MarketRegime
- DataSource
- DataSnapshot

### Fundamental
- Company
- FinancialStatement
- Filing
- IRDocument
- ValuationModel
- ValuationScenario
- ValuationResult
- MarginOfSafety

### Quant
- Factor
- Formula
- Strategy
- StrategyVersion
- Experiment
- BacktestRun
- OOSRun
- HoldoutRun
- WalkForwardRun
- RobustnessRun
- ResearchEvidence

### Decision
- Decision
- DecisionEvidence
- RiskAssessment
- Portfolio
- Position
- Allocation
- Order
- Fill
- ExecutionObservation
- Outcome

### Platform
- AuditEvent
- ModelVersion
- AgentRun
- AgentPermission
- UsageEvent
- BillingEvent

## Evidence relationship

All decision-relevant objects must be traceable:

DataSnapshot
→ Factor/Valuation
→ Formula/Model
→ ResearchRun
→ StrategyVersion
→ Decision
→ RiskAssessment
→ Order
→ Fill
→ Outcome

## Immutability rules

Research evidence, decision records and execution observations are append-oriented.

A new strategy revision creates a new StrategyVersion.

Historical outcomes must never be rewritten to make a strategy look better.

## Decision decomposition

A decision is not one score.

It is the structured combination of:

- Value
- Quality
- Market
- Risk
- Portfolio fit
- Execution feasibility

The system may calculate composite views, but the underlying evidence remains visible.

## Custom strategy safety

A custom strategy may not be promoted to paper/live merely because its historical backtest is attractive.

Minimum promotion chain:

DRAFT → RESEARCH → VALIDATED → PAPER → PROMOTED → LIVE

Each transition requires explicit evidence gates.
