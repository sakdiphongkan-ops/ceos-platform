create or replace function public.luna_trigger_toptrader_ws_ingest()
returns bigint
language plpgsql
security definer
set search_path to 'public','private','net'
as $$
declare
  v_secret text;
  v_request_id bigint;
begin
  select secret into v_secret
  from private.luna_scheduler_secrets
  where name='tradingview_ingest';

  if v_secret is null then
    raise exception 'LUNA scheduler secret missing';
  end if;

  select net.http_post(
    'https://wigzicwgcsrhdummrbjx.supabase.co/functions/v1/luna-toptrader-ws-ingest',
    '{}'::jsonb,
    '{}'::jsonb,
    jsonb_build_object('Content-Type','application/json','x-luna-scheduler',v_secret),
    15000
  ) into v_request_id;

  return v_request_id;
end;
$$;

revoke all on function public.luna_trigger_toptrader_ws_ingest() from public, anon, authenticated;
grant execute on function public.luna_trigger_toptrader_ws_ingest() to postgres, service_role;

do $$
begin
  if not exists (select 1 from cron.job where jobname='luna-toptrader-ws-ingest-every-minute') then
    perform cron.schedule(
      'luna-toptrader-ws-ingest-every-minute',
      '* * * * 1-5',
      'select public.luna_trigger_toptrader_ws_ingest();'
    );
  end if;
end;
$$;