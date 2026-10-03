# Xendit Billing Boundary

Xendit is an external payment provider adapter. The LUNA database remains the source of commercial state.

Current Xendit API version: `2026-01-01`.

Subscription lifecycle events handled by the adapter:
- recurring.plan.activated
- recurring.plan.inactivated
- recurring.cycle.created
- recurring.cycle.retrying
- recurring.cycle.succeeded
- recurring.cycle.failed
- recurring.cycle.force_attempt_failed

Security rule:
The webhook endpoint currently acknowledges the event but does not mutate subscription state until a verified webhook secret/signature configuration is provisioned.

Production flow:
customer -> checkout/payment session -> Xendit subscription -> verified webhook -> luna_subscriptions -> entitlement -> usage

Live-money execution remains completely separate from billing.