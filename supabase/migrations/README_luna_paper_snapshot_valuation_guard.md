# LUNA paper valuation guard — staging validation plan

Status: draft only. Do not apply to production until this checklist passes.

## Safety contract
- This migration only blocks writing a paper equity snapshot if any open position lacks a recent explicitly verified TOPTRADER_REALTIME bid/ask book.
- Maximum quote age is currently hard-coded at 60 seconds; align this with the approved execution quote-age policy before rollout.
- It does not replace the primary fix in `luna_run_live_paper_cycle`: that function must stop using `coalesce(t.last, p.avg_price)`, stop writing snapshots from stale bars, and return explicit valuation completeness / missing symbols.
- Explicit verification is read from `raw.data_quality = "verified"` or `raw.verified = true`. Confirm the ingestion contract actually writes one of these keys. If not, the guard intentionally rejects all quotes until the contract is corrected.

## Staging regression cases
Run each case against an isolated Supabase branch, never production:

1. Fresh verified quote for every open position: snapshot insert succeeds.
2. Quote older than 60 seconds: insert rejected with `LUNA_VALUATION_INCOMPLETE` and symbol listed in DETAIL.
3. Missing quote for one position: insert rejected and the missing symbol is reported.
4. Partial coverage: all but one symbol fresh; insert rejected.
5. Future timestamp more than one second ahead: insert rejected.
6. Null/zero bid, null ask, or ask < bid: insert rejected.
7. Wrong source or no explicit verified marker: insert rejected.
8. Zero open positions: insert allowed, subject to the primary cycle function's separate cash/equity accounting tests.
9. Update of an existing snapshot is subject to the same guard.
10. Verify a rejected insert leaves no snapshot row and does not update peak equity or drawdown.
11. Compare TypeScript and SQL valuation outputs on identical fixtures; verify cash + marked market value, realized/unrealized P&L, fees and slippage reconcile to the cent.

## Rollout gate
- Confirm schema and source-quality JSON contract.
- Replace the primary cycle function in a separate reviewed migration after capturing its exact current definition and writing a rollback script.
- Run all regression cases in staging.
- Confirm no historical/stale snapshot is displayed as current in API/UI.
- Keep paper-only mode, live-trading disarmed, and gateway kill switch enabled.
- Production rollout requires a reviewed diff, backup/rollback plan, and an observed healthy feed; current evidence says feed freshness is absent.
