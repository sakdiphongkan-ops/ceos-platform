-- LUNA enterprise health: report paper-engine orders/fills from the paper ledger.
-- Safe scope: function replacement only. This migration does not alter execution controls,
-- create orders/fills, change RLS/policies, or enable broker execution.
--
-- Why: the previous health function counted only legacy luna_orders/luna_fills.
-- The active 15-minute paper engine writes to luna_paper_live_orders and
-- luna_paper_trade_ledger, so health output could report 0 orders/fills despite
-- real paper-ledger rows. Preserve both sets of counts for audit and select the
-- count source using whether this strategy has a paper runtime record.

CREATE OR REPLACE FUNCTION public.luna_enterprise_health(
  p_strategy_version text,
  p_as_of_date date
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_universe bigint := 0;
  v_price_rows bigint := 0;
  v_feature_rows bigint := 0;
  v_pit_rows bigint := 0;
  v_pit_prod_rows bigint := 0;
  v_fast_state bigint := 0;
  v_fast_cache bigint := 0;
  v_final_rows bigint := 0;
  v_ceos_rows bigint := 0;
  v_ceos_prod_rows bigint := 0;
  v_ticks bigint := 0;
  v_signals bigint := 0;
  v_orders bigint := 0;
  v_fills bigint := 0;
  v_legacy_orders bigint := 0;
  v_legacy_fills bigint := 0;
  v_paper_orders bigint := 0;
  v_paper_fills bigint := 0;
  v_has_paper_runtime boolean := false;
  v_execution_counts_source text := 'LEGACY_TABLES';
  v_last_tick timestamptz := null;
  v_last_quote timestamptz := null;
  v_security jsonb := '{}'::jsonb;
  v_execution jsonb := '{}'::jsonb;
  v_readiness jsonb := '{}'::jsonb;
  v_recovery jsonb := '{}'::jsonb;
  v_release jsonb := '{}'::jsonb;
  v_verified jsonb := '{}'::jsonb;
  v_research_ready boolean := false;
BEGIN
  SELECT count(*) INTO v_universe
  FROM public.luna_universe
  WHERE is_active = true;

  SELECT count(*) INTO v_price_rows
  FROM public.luna_research_prices;

  SELECT count(*) INTO v_feature_rows
  FROM public.luna_research_features;

  SELECT count(*) INTO v_pit_rows
  FROM public.luna_production_pit_features
  WHERE strategy_version = p_strategy_version
    AND as_of_date = p_as_of_date
    AND is_pit_valid = true;

  SELECT count(*) INTO v_pit_prod_rows
  FROM public.luna_production_pit_features
  WHERE strategy_version = p_strategy_version
    AND as_of_date = p_as_of_date
    AND is_pit_valid = true
    AND is_production_feed = true;

  SELECT count(*) INTO v_fast_state
  FROM public.luna_fast_live_state
  WHERE strategy_version = p_strategy_version
    AND as_of_date = p_as_of_date;

  SELECT count(*) INTO v_fast_cache
  FROM public.luna_fast_signal_cache
  WHERE strategy_version = p_strategy_version
    AND as_of_date = p_as_of_date;

  SELECT count(*) INTO v_final_rows
  FROM public.luna_final_decisions
  WHERE strategy_version = p_strategy_version
    AND as_of_date = p_as_of_date;

  SELECT count(*) INTO v_ceos_rows
  FROM public.luna_ceos_screen_inputs
  WHERE as_of_date = p_as_of_date;

  SELECT count(*) INTO v_ceos_prod_rows
  FROM public.luna_ceos_screen_inputs
  WHERE as_of_date = p_as_of_date
    AND coalesce((reason->>'production_feed')::boolean, false) = true;

  SELECT count(*), max(ts) INTO v_ticks, v_last_tick
  FROM public.luna_market_ticks
  WHERE ts::date = p_as_of_date;

  SELECT count(*) INTO v_signals
  FROM public.luna_signals
  WHERE ts::date = p_as_of_date;

  -- Retain legacy counts for reconciliation and backward compatibility.
  SELECT count(*) INTO v_legacy_orders
  FROM public.luna_orders
  WHERE created_at::date = p_as_of_date;

  SELECT count(*) INTO v_legacy_fills
  FROM public.luna_fills
  WHERE ts::date = p_as_of_date;

  -- Paper ledger is keyed by strategy_version and records each simulated fill.
  SELECT EXISTS (
    SELECT 1
    FROM public.luna_paper_live_runtime r
    WHERE r.strategy_version = p_strategy_version
      AND r.paper_only = true
  ) INTO v_has_paper_runtime;

  SELECT count(*) INTO v_paper_orders
  FROM public.luna_paper_live_orders
  WHERE strategy_version = p_strategy_version
    AND created_at::date = p_as_of_date;

  SELECT count(*) INTO v_paper_fills
  FROM public.luna_paper_trade_ledger
  WHERE strategy_version = p_strategy_version
    AND created_at::date = p_as_of_date;

  IF v_has_paper_runtime THEN
    v_orders := v_paper_orders;
    v_fills := v_paper_fills;
    v_execution_counts_source := 'PAPER_RUNTIME_AND_LEDGER';
  ELSE
    v_orders := v_legacy_orders;
    v_fills := v_legacy_fills;
  END IF;

  SELECT max(last_quote_ts) INTO v_last_quote
  FROM public.luna_fast_live_state
  WHERE strategy_version = p_strategy_version
    AND as_of_date = p_as_of_date;

  v_verified := private.luna_verified_market_data_status(
    p_strategy_version,
    p_as_of_date
  );

  v_research_ready := v_universe >= 900
    AND v_price_rows > 100000
    AND v_fast_cache > 0;

  SELECT jsonb_build_object(
    'incident_lock', incident_lock,
    'broker_execution_enabled', broker_execution_enabled,
    'production_security_gate_passed', production_security_gate_passed,
    'ransomware_recovery_verified', ransomware_recovery_verified,
    'updated_at', updated_at
  )
  INTO v_security
  FROM public.luna_security_controls
  WHERE id = true;

  SELECT jsonb_build_object(
    'execution_mode', execution_mode,
    'armed', armed,
    'kill_switch', kill_switch,
    'max_daily_loss', max_daily_loss,
    'max_daily_turnover', max_daily_turnover,
    'max_order_notional', max_order_notional,
    'max_orders_per_minute', max_orders_per_minute,
    'updated_at', updated_at
  )
  INTO v_execution
  FROM public.luna_execution_controls
  WHERE id = true;

  SELECT public.luna_get_strategy_readiness(
    p_strategy_version,
    p_as_of_date
  ) INTO v_readiness;

  SELECT jsonb_build_object(
    'status', rd.status,
    'verified', rd.verified,
    'completed_at', rd.completed_at,
    'recovery_point', rd.recovery_point,
    'restore_scope', rd.restore_scope,
    'evidence_ref', rd.evidence_ref
  )
  INTO v_recovery
  FROM public.luna_recovery_drills rd
  ORDER BY rd.created_at DESC
  LIMIT 1;

  SELECT jsonb_build_object(
    'release_label', lm.release_label,
    'qa_status', lm.qa_status,
    'security_advisor_status', lm.security_advisor_status,
    'created_at', lm.created_at
  )
  INTO v_release
  FROM public.luna_release_manifests lm
  ORDER BY lm.created_at DESC
  LIMIT 1;

  RETURN jsonb_build_object(
    'generated_at', now(),
    'strategy_version', p_strategy_version,
    'as_of_date', p_as_of_date,
    'data_plane', jsonb_build_object(
      'active_universe', v_universe,
      'research_price_rows', v_price_rows,
      'research_feature_rows', v_feature_rows,
      'research_data_ready', v_research_ready,
      'pit_feature_rows', v_pit_rows,
      'pit_production_rows', v_pit_prod_rows,
      'fast_live_state_rows', v_fast_state,
      'fast_signal_cache_rows', v_fast_cache,
      'market_tick_rows', v_ticks,
      'latest_market_tick', v_last_tick,
      'latest_strategy_quote', v_last_quote,
      'verified_market_data', v_verified
    ),
    'decision_plane', jsonb_build_object(
      'final_rows', v_final_rows,
      'ceos_rows', v_ceos_rows,
      'ceos_production_rows', v_ceos_prod_rows,
      'signals', v_signals
    ),
    'execution_plane', jsonb_build_object(
      'orders', v_orders,
      'fills', v_fills,
      'counts_source', v_execution_counts_source,
      'paper_engine_counts', jsonb_build_object(
        'orders', v_paper_orders,
        'fills', v_paper_fills
      ),
      'legacy_table_counts', jsonb_build_object(
        'orders', v_legacy_orders,
        'fills', v_legacy_fills
      ),
      'controls', v_execution
    ),
    'security', v_security,
    'recovery', coalesce(v_recovery, '{}'::jsonb),
    'release', coalesce(v_release, '{}'::jsonb),
    'gates', jsonb_build_object(
      'research_data_ready', v_research_ready,
      'data_ready', v_research_ready
        AND coalesce((v_verified->>'verified_execution_data')::boolean, false)
        AND coalesce((v_verified->>'verified_book_data')::boolean, false),
      'verified_market_data_ready', coalesce((v_verified->>'verified_execution_data')::boolean, false),
      'verified_book_ready', coalesce((v_verified->>'verified_book_data')::boolean, false),
      'forecast_ready', (v_fast_cache > 0 OR v_final_rows > 0),
      'pit_feature_layer_ready', (v_pit_rows > 0),
      'production_pit_ready', (v_pit_prod_rows > 0),
      'decision_ready', (v_final_rows > 0),
      'paper_execution_ready', coalesce((v_readiness->>'paper_execution_permitted')::boolean, false),
      'live_execution_ready', false,
      'security_ready', coalesce((v_security->>'production_security_gate_passed')::boolean, false)
        AND NOT coalesce((v_security->>'incident_lock')::boolean, true),
      'recovery_ready', coalesce((v_recovery->>'verified')::boolean, false)
        AND coalesce((v_recovery->>'status') = 'PASSED', false),
      'external_backup_recovery_verified', coalesce((v_security->>'ransomware_recovery_verified')::boolean, false)
    ),
    'release_label', v_release->>'release_label'
  );
END;
$function$;
