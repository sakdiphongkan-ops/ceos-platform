# LUNA Production Deploy Trigger

This commit is an explicit production-deploy request for the exact Git SHA represented by this commit.

The deployment workflow is gated by:
- primary LUNA typecheck/regression CI
- CEOS Platform build
- LUNA_MODE=paper / LIVE_TRADING_ARMED=false
- source-revision pinning on worker and gateway
- deployment status verification
