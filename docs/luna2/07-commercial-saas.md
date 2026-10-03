# LUNA 2.0 Commercial Layer

## Live database state

The LUNA Supabase project already contains the commercial architecture:

- `luna_customers`
- `luna_customer_memberships`
- `luna_plans`
- `luna_plan_entitlements`
- `luna_subscriptions`
- `luna_usage_events`
- `luna_commercial_audit`

All seven tables have RLS enabled.

## Current catalog

| Plan | Monthly THB | Primary capability |
|---|---:|---|
| FREE | 0 | Basic market + portfolio |
| INVESTOR | 590 | Realtime + portfolio + research summary |
| PRO | 1,990 | Advanced risk + paper trading |
| QUANT | 4,990 | Formula Lab + research validation + paper trading |
| ENTERPRISE | Custom | API + audit + governance |

These are product-design defaults, not promises of performance or investment returns.

## Billing boundary

The database stores provider-neutral subscription fields:
- provider
- provider_customer_id
- provider_subscription_id
- current period
- cancellation state

No live payment provider is hard-coded into the decision engine.

## Entitlement boundary

`lib/luna2/commercial.ts` is the application-level authorization contract.

The correct request path is:

Customer identity -> active subscription -> plan -> entitlement -> usage limit -> feature execution

A UI check alone is never sufficient.

## Usage metering

Usage events are stored separately from subscription state so billing and usage reconciliation can be audited.

## Safety

Commercial access does not grant live-money execution.
Paper trading remains a separate capability and live execution remains governed by the existing execution controls and approval gates.