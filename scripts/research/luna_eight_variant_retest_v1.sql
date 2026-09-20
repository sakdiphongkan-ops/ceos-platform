-- LUNA 8-variant exact retest v1
-- Frozen variants; no selection/optimization is performed.
-- Signal:
--   Lx_S0_REV = trailing x-month return ending at current month, select LOW tail.
--   L2_S1_REV = 2-month lookback with 1-month skip: lag1 / lag2 - 1.
-- Portfolio: equal weight, Top/Bottom K by signal, monthly rebalance.
-- Forward return: next observation ONLY if it is exactly the next calendar month.
-- Costs: 20/45/60 bps per turnover unit, turnover = 1 - overlap/K; first portfolio turnover=1.
-- Holdout: last 12 AVAILABLE portfolio-return observations (not calendar labels).
-- 7% hurdle is geometric monthly return >= 0.07; it is NOT a count of months >=7%.

WITH src AS (
  SELECT symbol, month_end, adj_close::numeric AS px,
    lead(month_end) OVER(PARTITION BY symbol ORDER BY month_end) AS next_month,
    lead(adj_close::numeric) OVER(PARTITION BY symbol ORDER BY month_end) AS next_px,
    lag(adj_close::numeric,1) OVER(PARTITION BY symbol ORDER BY month_end) AS lag1,
    lag(adj_close::numeric,2) OVER(PARTITION BY symbol ORDER BY month_end) AS lag2,
    lag(adj_close::numeric,3) OVER(PARTITION BY symbol ORDER BY month_end) AS lag3,
    lag(adj_close::numeric,4) OVER(PARTITION BY symbol ORDER BY month_end) AS lag4,
    lag(adj_close::numeric,6) OVER(PARTITION BY symbol ORDER BY month_end) AS lag6
  FROM public.luna_research_monthly_price_factors
  WHERE month_end BETWEEN DATE '2021-09-01' AND DATE '2026-08-01'
),
defs AS (
  SELECT * FROM (VALUES
    ('L1_S0_REV_K20',20),
    ('L2_S0_REV_K20',20),
    ('L4_S0_REV_K20',20),
    ('L3_S0_REV_K10',10),
    ('L3_S0_REV_K50',50),
    ('L2_S1_REV_K5',5),
    ('L6_S0_REV_K20',20),
    ('L1_S0_REV_K50',50)
  ) v(code,k)
),
r0 AS (
  SELECT s.*, d.code, d.k,
    CASE d.code
      WHEN 'L1_S0_REV_K20' THEN s.px/s.lag1-1
      WHEN 'L2_S0_REV_K20' THEN s.px/s.lag2-1
      WHEN 'L4_S0_REV_K20' THEN s.px/s.lag4-1
      WHEN 'L3_S0_REV_K10' THEN s.px/s.lag3-1
      WHEN 'L3_S0_REV_K50' THEN s.px/s.lag3-1
      WHEN 'L2_S1_REV_K5'  THEN s.lag1/s.lag2-1
      WHEN 'L6_S0_REV_K20' THEN s.px/s.lag6-1
      WHEN 'L1_S0_REV_K50' THEN s.px/s.lag1-1
    END AS signal_ret,
    CASE
      WHEN s.next_month = s.month_end + INTERVAL '1 month'
      THEN s.next_px/s.px-1
    END AS fwd1
  FROM src s CROSS JOIN defs d
),
ranked AS (
  SELECT *,
    row_number() OVER(
      PARTITION BY code, month_end
      ORDER BY signal_ret ASC NULLS LAST, symbol
    ) AS rn
  FROM r0
  WHERE signal_ret IS NOT NULL AND fwd1 IS NOT NULL
),
selected AS (
  SELECT * FROM ranked WHERE rn <= k
),
portfolio AS (
  SELECT code, month_end, k, avg(fwd1) AS gross_return,
         array_agg(symbol ORDER BY symbol) AS symbols
  FROM selected
  GROUP BY code, month_end, k
),
portfolio2 AS (
  SELECT *,
    lag(symbols) OVER(PARTITION BY code ORDER BY month_end) AS prev_symbols
  FROM portfolio
),
monthly AS (
  SELECT code, month_end, k, gross_return,
    CASE
      WHEN prev_symbols IS NULL THEN 1.0
      ELSE 1.0 -
        (SELECT count(*)
         FROM unnest(symbols) a(sym)
         WHERE a.sym = ANY(prev_symbols))::numeric / k
    END AS turnover
  FROM portfolio2
),
costed AS (
  SELECT m.*, b.bps,
         m.gross_return - m.turnover*b.bps/10000.0 AS net_return
  FROM monthly m
  CROSS JOIN (VALUES (20),(45),(60)) b(bps)
),
ordered AS (
  SELECT *,
         row_number() OVER(PARTITION BY code,bps ORDER BY month_end DESC) AS last_rn
  FROM costed
),
full_stats AS (
  SELECT code,bps,'FULL' AS period,count(*) AS months,
    min(month_end) AS start_month,max(month_end) AS end_month,
    exp(avg(ln(1+net_return)))-1 AS geometric_monthly_return,
    exp(sum(ln(1+net_return)))-1 AS cumulative_return,
    pow(exp(avg(ln(1+net_return))),12)-1 AS annualized_cagr,
    avg((net_return>0)::int) AS positive_month_pct,
    (exp(avg(ln(1+net_return)))-1 >= 0.07) AS hurdle_7pct_pass,
    count(*) FILTER(WHERE net_return>=0.07) AS months_ge_7pct,
    min(net_return) AS min_monthly_return,
    max(net_return) AS max_monthly_return,
    avg(turnover) AS average_turnover,
    sum(turnover*bps/10000.0) AS total_transaction_cost
  FROM ordered
  GROUP BY code,bps
),
holdout_stats AS (
  SELECT code,bps,'HOLDOUT_LAST_12_AVAILABLE' AS period,count(*) AS months,
    min(month_end) AS start_month,max(month_end) AS end_month,
    exp(avg(ln(1+net_return)))-1 AS geometric_monthly_return,
    exp(sum(ln(1+net_return)))-1 AS cumulative_return,
    pow(exp(avg(ln(1+net_return))),12)-1 AS annualized_cagr,
    avg((net_return>0)::int) AS positive_month_pct,
    (exp(avg(ln(1+net_return)))-1 >= 0.07) AS hurdle_7pct_pass,
    count(*) FILTER(WHERE net_return>=0.07) AS months_ge_7pct,
    min(net_return) AS min_monthly_return,
    max(net_return) AS max_monthly_return,
    avg(turnover) AS average_turnover,
    sum(turnover*bps/10000.0) AS total_transaction_cost
  FROM ordered
  WHERE last_rn <= 12
  GROUP BY code,bps
)
SELECT * FROM (
  SELECT * FROM full_stats
  UNION ALL
  SELECT * FROM holdout_stats
) x
ORDER BY code,bps,period;
