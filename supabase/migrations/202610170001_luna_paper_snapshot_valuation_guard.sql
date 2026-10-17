-- LUNA paper valuation defense-in-depth guard.
-- Draft migration only: validate in an isolated staging database before rollout.
-- Deliberately fail closed unless each open position has a fresh, valid, explicitly
-- verified TOPTRADER_REALTIME book in the exact snapshot session, including positive sizes. This does NOT replace the cycle function fix.

DO $preflight$
BEGIN
  IF to_regclass('public.luna_paper_live_positions') IS NULL
     OR to_regclass('public.luna_market_ticks') IS NULL
     OR to_regclass('public.luna_paper_equity_snapshots') IS NULL THEN
    RAISE EXCEPTION 'LUNA valuation guard preflight failed: required tables missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='luna_paper_live_positions' AND column_name='experiment_code'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='luna_paper_live_positions' AND column_name='symbol'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='luna_paper_live_positions' AND column_name='qty'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='luna_market_ticks' AND column_name='raw'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='luna_paper_equity_snapshots' AND column_name='experiment_code'
  ) THEN
    RAISE EXCEPTION 'LUNA valuation guard preflight failed: required columns missing';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.luna_guard_paper_equity_snapshot_valuation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $guard$
DECLARE
  v_unpriced_symbols text[];
BEGIN
  SELECT array_agg(p.symbol ORDER BY p.symbol)
    INTO v_unpriced_symbols
  FROM public.luna_paper_live_positions AS p
  WHERE p.experiment_code = NEW.experiment_code
    AND p.qty > 0
    AND NOT EXISTS (
      SELECT 1
      FROM public.luna_market_ticks AS t
      WHERE t.session_id = NEW.session_id
        AND upper(t.symbol) = upper(p.symbol)
        AND t.source = 'TOPTRADER_REALTIME'
        AND t.ts <= now() + interval '1 second'
        AND t.ts >= now() - interval '60 seconds'
        AND t.bid IS NOT NULL AND t.bid > 0
        AND t.ask IS NOT NULL AND t.ask >= t.bid
        AND t.bid_size IS NOT NULL AND t.bid_size > 0
        AND t.ask_size IS NOT NULL AND t.ask_size > 0
        AND (
          lower(coalesce(t.raw->>'data_quality','')) = 'verified'
          OR lower(coalesce(t.raw->>'verified','')) = 'true'
        )
    );

  IF coalesce(cardinality(v_unpriced_symbols), 0) > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'LUNA_VALUATION_INCOMPLETE',
      DETAIL = jsonb_build_object(
        'experiment_code', NEW.experiment_code,
        'unpriced_symbols', to_jsonb(v_unpriced_symbols),
        'max_quote_age_seconds', 60
      )::text;
  END IF;

  RETURN NEW;
END;
$guard$;

DROP TRIGGER IF EXISTS luna_paper_equity_snapshot_valuation_guard
  ON public.luna_paper_equity_snapshots;

CREATE TRIGGER luna_paper_equity_snapshot_valuation_guard
BEFORE INSERT OR UPDATE ON public.luna_paper_equity_snapshots
FOR EACH ROW
EXECUTE FUNCTION public.luna_guard_paper_equity_snapshot_valuation();

COMMENT ON FUNCTION public.luna_guard_paper_equity_snapshot_valuation() IS
  'Fail-closed guard: rejects equity snapshots if any open position lacks a <=60-second valid TOPTRADER_REALTIME book with explicit verified marker. Defense-in-depth only; cycle-level SQL valuation fix and staging regression tests remain required.';
