-- Manual, read-only regression check for migration
-- 20261017100000_luna_enterprise_health_paper_counts.sql.
-- Run only after applying that migration in a disposable/staging database.
-- This selects the latest day with a real paper order/ledger event, avoiding a
-- false-positive test caused by a quiet current date. This script performs SELECTs only.

WITH paper_activity AS (
  SELECT strategy_version, created_at
  FROM public.luna_paper_live_orders
  UNION ALL
  SELECT strategy_version, created_at
  FROM public.luna_paper_trade_ledger
),
latest_paper_day AS (
  SELECT
    strategy_version,
    created_at::date AS as_of_date,
    max(created_at) AS latest_event_at
  FROM paper_activity
  GROUP BY strategy_version, created_at::date
  ORDER BY max(created_at) DESC
  LIMIT 1
),
expected AS (
  SELECT
    s.strategy_version,
    s.as_of_date,
    (SELECT count(*)
       FROM public.luna_paper_live_orders o
      WHERE o.strategy_version = s.strategy_version
        AND o.created_at::date = s.as_of_date) AS paper_orders,
    (SELECT count(*)
       FROM public.luna_paper_trade_ledger l
      WHERE l.strategy_version = s.strategy_version
        AND l.created_at::date = s.as_of_date) AS paper_fills,
    (SELECT count(*)
       FROM public.luna_orders o
      WHERE o.created_at::date = s.as_of_date) AS legacy_orders,
    (SELECT count(*)
       FROM public.luna_fills f
      WHERE f.ts::date = s.as_of_date) AS legacy_fills
  FROM latest_paper_day s
),
observed AS (
  SELECT
    e.*,
    public.luna_enterprise_health(e.strategy_version, e.as_of_date) AS health
  FROM expected e
)
SELECT
  strategy_version,
  as_of_date,
  paper_orders AS expected_paper_orders,
  paper_fills AS expected_paper_fills,
  legacy_orders AS expected_legacy_orders,
  legacy_fills AS expected_legacy_fills,
  health #>> '{execution_plane,counts_source}' AS counts_source,
  health #>> '{execution_plane,counts_source}' = 'PAPER_RUNTIME_AND_LEDGER'
    AS paper_count_source_selected,
  (health #>> '{execution_plane,orders}')::bigint = paper_orders
    AS paper_order_count_matches,
  (health #>> '{execution_plane,fills}')::bigint = paper_fills
    AS paper_fill_count_matches,
  (health #>> '{execution_plane,legacy_table_counts,orders}')::bigint = legacy_orders
    AS legacy_order_count_preserved,
  (health #>> '{execution_plane,legacy_table_counts,fills}')::bigint = legacy_fills
    AS legacy_fill_count_preserved,
  health #>> '{execution_plane,controls,execution_mode}' AS execution_mode,
  (health #>> '{execution_plane,controls,armed}')::boolean AS armed,
  (health #>> '{gates,live_execution_ready}')::boolean AS live_execution_ready
FROM observed;
