-- LUNA formula robustness audit v1
-- Reproducible against public.luna_formula_tournament_v2.
-- Gate: TEST and RECENT_OOS must remain positive at 20/40/60 bps,
-- and the minimum positive-month fraction across those windows must be >= 50%.

WITH x AS (
  SELECT
    variant_code,
    MAX(total_return) FILTER (WHERE window_name='TEST' AND cost_bps=20) AS test20,
    MAX(total_return) FILTER (WHERE window_name='TEST' AND cost_bps=60) AS test60,
    MAX(total_return) FILTER (WHERE window_name='RECENT_OOS' AND cost_bps=20) AS oos20,
    MAX(total_return) FILTER (WHERE window_name='RECENT_OOS' AND cost_bps=60) AS oos60,
    MAX(total_return) FILTER (WHERE window_name='VALIDATION' AND cost_bps=20) AS val20,
    MAX(total_return) FILTER (WHERE window_name='VALIDATION' AND cost_bps=60) AS val60,
    MIN(positive_month_pct) FILTER (WHERE window_name IN ('TEST','RECENT_OOS')) AS min_pos_pct,
    MIN(max_drawdown) FILTER (WHERE window_name IN ('TEST','RECENT_OOS')) AS worst_dd
  FROM public.luna_formula_tournament_v2
  GROUP BY variant_code
)
SELECT *
FROM x
WHERE LEAST(test20,test60,oos20,oos60) > 0
  AND min_pos_pct >= 0.50
ORDER BY LEAST(test60,oos60) DESC, variant_code;

-- Exact persisted M1 baseline:
SELECT
  COUNT(*) AS months,
  MIN(month_end) AS min_month,
  MAX(month_end) AS max_month,
  EXP(AVG(LN(1+net_return)))-1 AS geometric_monthly_return,
  EXP(SUM(LN(1+net_return)))-1 AS cumulative_return,
  AVG((net_return>0)::int) AS positive_month_pct,
  MIN(net_return) AS min_monthly_return,
  MAX(net_return) AS max_monthly_return,
  AVG(turnover) AS average_turnover,
  SUM(transaction_cost) AS total_transaction_cost
FROM public.luna_strategy_portfolio_monthly
WHERE strategy_version='luna-m1s0k20rev-v1';
