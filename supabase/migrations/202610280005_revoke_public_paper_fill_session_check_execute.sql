-- The session check is an internal safety helper. It is called by the
-- SECURITY DEFINER paper-cycle function and must not be callable directly
-- through PostgREST by PUBLIC, anon, or authenticated roles.
BEGIN;

REVOKE EXECUTE ON FUNCTION public.luna_paper_fill_bar_is_in_market_session(timestamp with time zone) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.luna_paper_fill_bar_is_in_market_session(timestamp with time zone) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.luna_paper_fill_bar_is_in_market_session(timestamp with time zone) TO service_role;

COMMIT;
