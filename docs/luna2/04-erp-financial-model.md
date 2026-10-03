# LUNA 2.0 ERP & Financial Model

## ERP modules

### Finance
Revenue, subscriptions, AR/AP, cash, P&L, budget, forecast.

### Sales
Leads, accounts, opportunities, subscriptions, enterprise contracts.

### Product
Roadmap, feature ownership, releases, incidents, product analytics.

### Operations
Data vendors, cloud, AI compute, infrastructure, service health.

### Research
Strategies, experiments, evidence, model versions and research costs.

### Risk
Market risk, model risk, operational risk, security and compliance controls.

### People
Roles, ownership, access and performance.

## Financial control tower

CEO should be able to see:

Revenue → Gross Margin → Operating Cost → Cash → Runway → Growth → Product → Risk

## Cost attribution

Every material infrastructure cost should be allocatable to:
- product
- organization/customer
- feature
- data vendor
- AI workload
- compute workload

This is required to calculate true contribution margin.

## Commercial ledger

Entitlements are separate from billing events:

Subscription
→ Plan
→ Entitlements
→ Usage
→ BillingEvent
→ Revenue recognition

## Enterprise model

Enterprise accounts should support:
- organization
- seats
- roles
- workspaces
- approval rules
- API quotas
- data entitlements
- audit access
- annual contract

## Financial guardrails

Do not introduce unlimited research/AI/backtest usage without usage economics.

Compute-heavy capabilities should be quota/usage metered or commercially bounded.
