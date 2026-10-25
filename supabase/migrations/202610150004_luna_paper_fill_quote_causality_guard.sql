-- Prevent hindsight fills when a paper-cycle processes a bar late.
-- A candidate execution tick must occur within its intended next-bar window AND
-- at/after the order's own created_at; otherwise the quote predates the simulated
-- order submission and would introduce look-ahead into paper results.
--
-- Patch the already-installed canonical function definition rather than copying
-- a second divergent 23 KB function body into this repository. The exact source
-- snippets are required; abort instead of applying an uncertain text rewrite.
DO $migration$
DECLARE
  v_definition text;
  v_old_expiry text;
  v_new_expiry text;
  v_old_fill text;
  v_new_fill text;
BEGIN
  v_definition := pg_get_functiondef(
    'public.luna_run_live_paper_cycle(text,text,numeric,numeric,numeric)'::regprocedure
  );

  v_old_expiry :=
      '        and mt.symbol=o.symbol' || chr(10) ||
      '        and mt.source=''TOPTRADER_REALTIME''' || chr(10) ||
      '        and mt.ts >= o.fill_bar_end - interval ''15 minutes''';
  v_new_expiry :=
      '        and mt.symbol=o.symbol' || chr(10) ||
      '        and mt.source=''TOPTRADER_REALTIME''' || chr(10) ||
      '        and mt.ts >= o.created_at' || chr(10) ||
      '        and mt.ts >= o.fill_bar_end - interval ''15 minutes''';

  v_old_fill :=
      '      and mt.symbol=v_order.symbol' || chr(10) ||
      '      and mt.source=''TOPTRADER_REALTIME''' || chr(10) ||
      '      and mt.ts >= v_order.fill_bar_end - interval ''15 minutes''';
  v_new_fill :=
      '      and mt.symbol=v_order.symbol' || chr(10) ||
      '      and mt.source=''TOPTRADER_REALTIME''' || chr(10) ||
      '      and mt.ts >= v_order.created_at' || chr(10) ||
      '      and mt.ts >= v_order.fill_bar_end - interval ''15 minutes''';

  IF strpos(v_definition, 'mt.ts >= o.created_at') = 0 THEN
    IF strpos(v_definition, v_old_expiry) = 0 THEN
      RAISE EXCEPTION 'LUNA_PAPER_CAUSALITY_PATCH_ABORTED: expiry source clause did not match';
    END IF;
    v_definition := replace(v_definition, v_old_expiry, v_new_expiry);
  END IF;

  IF strpos(v_definition, 'mt.ts >= v_order.created_at') = 0 THEN
    IF strpos(v_definition, v_old_fill) = 0 THEN
      RAISE EXCEPTION 'LUNA_PAPER_CAUSALITY_PATCH_ABORTED: fill source clause did not match';
    END IF;
    v_definition := replace(v_definition, v_old_fill, v_new_fill);
  END IF;

  IF strpos(v_definition, 'mt.ts >= o.created_at') = 0
     OR strpos(v_definition, 'mt.ts >= v_order.created_at') = 0 THEN
    RAISE EXCEPTION 'LUNA_PAPER_CAUSALITY_PATCH_ABORTED: post-condition failed';
  END IF;

  EXECUTE v_definition;
END
$migration$;
