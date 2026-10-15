-- Repair escaped newline sequences in the live LUNA paper-cycle function.
-- The bad sequences were literal backslash+n characters inside SQL comment lines,
-- which caused the zero-quantity-position cleanup statement to be commented out.
-- This migration does not change the fill model, quote validation, fee/slippage
-- assumptions, paper-only constraints, or any live-trading gate.
DO $repair$
DECLARE
  v_oid regprocedure := to_regprocedure(
    'public.luna_run_live_paper_cycle(text,text,numeric,numeric,numeric)'
  );
  v_definition text;
  v_before integer;
  v_after integer;
BEGIN
  IF v_oid IS NULL THEN
    RAISE NOTICE 'LUNA paper-cycle function is not installed yet; repair skipped.';
  ELSE
    SELECT pg_get_functiondef(v_oid) INTO v_definition;

    v_before := (
      length(v_definition)
      - length(replace(v_definition, chr(92) || 'n', ''))
    ) / 2;

    IF v_before NOT IN (0, 5) THEN
      RAISE EXCEPTION
        'Unexpected escaped-newline count in LUNA paper cycle: % (expected 0 or 5)',
        v_before;
    END IF;

    IF v_before = 5 THEN
      v_definition := replace(v_definition, chr(92) || 'n', chr(10));
      EXECUTE v_definition;
    END IF;

    SELECT (
      length(prosrc)
      - length(replace(prosrc, chr(92) || 'n', ''))
    ) / 2
    INTO v_after
    FROM pg_proc
    WHERE oid = v_oid;

    IF v_after <> 0 THEN
      RAISE EXCEPTION
        'Escaped newline sequences remain in LUNA paper cycle: %',
        v_after;
    END IF;
  END IF;
END;
$repair$;
