-- LUNA live fill RPC security hardening
-- The Edge Function calls this RPC with the service_role connection only.
revoke execute on function public.luna_record_fill_v2(
  uuid,text,text,text,text,bigint,bigint,bigint,numeric,numeric,numeric,numeric,timestamptz,text,text,text
) from public, anon, authenticated;

grant execute on function public.luna_record_fill_v2(
  uuid,text,text,text,text,bigint,bigint,bigint,numeric,numeric,numeric,numeric,timestamptz,text,text,text
) to service_role;
