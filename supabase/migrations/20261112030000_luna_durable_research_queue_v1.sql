-- LUNA durable research queue v1
-- Service-only control plane. Does not touch market execution or active strategy state.
begin;

create table if not exists public.luna_research_jobs (
  id uuid primary key default gen_random_uuid(),
  job_type text not null,
  status text not null default 'QUEUED'
    check (status in ('QUEUED','RUNNING','RETRY','SUCCEEDED','DEAD_LETTER','CANCELLED')),
  priority integer not null default 0,
  scheduled_at timestamptz not null default now(),
  available_at timestamptz not null default now(),
  lease_owner text,
  lease_expires_at timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 20),
  checkpoint jsonb not null default '{}'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  input_watermark timestamptz,
  idempotency_key text not null unique,
  result jsonb,
  error jsonb,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists luna_research_jobs_claim_idx
  on public.luna_research_jobs(status, priority desc, available_at, scheduled_at);
create index if not exists luna_research_jobs_lease_idx
  on public.luna_research_jobs(lease_expires_at)
  where status='RUNNING';

create table if not exists public.luna_research_worker_heartbeats (
  worker_id text primary key,
  worker_version text not null,
  status text not null default 'ONLINE',
  last_seen_at timestamptz not null default now(),
  current_job_id uuid references public.luna_research_jobs(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb
);

alter table public.luna_research_jobs enable row level security;
alter table public.luna_research_worker_heartbeats enable row level security;

drop policy if exists luna_research_jobs_service_role_all on public.luna_research_jobs;
create policy luna_research_jobs_service_role_all on public.luna_research_jobs
  as permissive for all to service_role using (true) with check (true);
drop policy if exists luna_research_worker_heartbeats_service_role_all on public.luna_research_worker_heartbeats;
create policy luna_research_worker_heartbeats_service_role_all on public.luna_research_worker_heartbeats
  as permissive for all to service_role using (true) with check (true);

revoke all on public.luna_research_jobs from public, anon, authenticated;
revoke all on public.luna_research_worker_heartbeats from public, anon, authenticated;
grant select, insert, update, delete on public.luna_research_jobs to service_role;
grant select, insert, update, delete on public.luna_research_worker_heartbeats to service_role;

create or replace function public.luna_claim_research_job(
  p_worker_id text,
  p_lease_seconds integer default 120
) returns setof public.luna_research_jobs
language plpgsql
security definer
set search_path=public
as $$
begin
  if p_worker_id is null or length(trim(p_worker_id))=0 then
    raise exception 'worker_id_required';
  end if;
  if p_lease_seconds < 30 or p_lease_seconds > 3600 then
    raise exception 'invalid_lease_seconds';
  end if;

  return query
  with candidate as (
    select id
    from public.luna_research_jobs
    where (
      (status in ('QUEUED','RETRY') and available_at <= now() and scheduled_at <= now())
      or (status='RUNNING' and lease_expires_at < now())
    )
    order by priority desc, scheduled_at asc, created_at asc
    for update skip locked
    limit 1
  )
  update public.luna_research_jobs j
  set status='RUNNING',
      lease_owner=p_worker_id,
      lease_expires_at=now()+make_interval(secs=>p_lease_seconds),
      attempts=j.attempts+1,
      started_at=coalesce(j.started_at,now()),
      updated_at=now()
  from candidate c
  where j.id=c.id
  returning j.*;
end;
$$;

create or replace function public.luna_complete_research_job(
  p_job_id uuid,
  p_worker_id text,
  p_result jsonb default '{}'::jsonb
) returns boolean
language plpgsql
security definer
set search_path=public
as $$
declare v_count integer;
begin
  update public.luna_research_jobs
  set status='SUCCEEDED', result=coalesce(p_result,'{}'::jsonb),
      error=null, lease_owner=null, lease_expires_at=null,
      finished_at=now(), updated_at=now()
  where id=p_job_id and status='RUNNING' and lease_owner=p_worker_id;
  get diagnostics v_count=row_count;
  return v_count=1;
end;
$$;

create or replace function public.luna_fail_research_job(
  p_job_id uuid,
  p_worker_id text,
  p_error jsonb default '{}'::jsonb
) returns text
language plpgsql
security definer
set search_path=public
as $$
declare v_status text;
begin
  update public.luna_research_jobs
  set status=case when attempts >= max_attempts then 'DEAD_LETTER' else 'RETRY' end,
      error=coalesce(p_error,'{}'::jsonb),
      available_at=case when attempts >= max_attempts then available_at
        else now()+make_interval(secs=>least(3600,15*(2^least(attempts,8))::integer)) end,
      lease_owner=null, lease_expires_at=null,
      finished_at=case when attempts >= max_attempts then now() else null end,
      updated_at=now()
  where id=p_job_id and status='RUNNING' and lease_owner=p_worker_id
  returning status into v_status;
  return coalesce(v_status,'LEASE_LOST');
end;
$$;

revoke all on function public.luna_claim_research_job(text,integer) from public, anon, authenticated;
revoke all on function public.luna_complete_research_job(uuid,text,jsonb) from public, anon, authenticated;
revoke all on function public.luna_fail_research_job(uuid,text,jsonb) from public, anon, authenticated;
grant execute on function public.luna_claim_research_job(text,integer) to service_role;
grant execute on function public.luna_complete_research_job(uuid,text,jsonb) to service_role;
grant execute on function public.luna_fail_research_job(uuid,text,jsonb) to service_role;

-- Database-native scheduler: independent of browser, Railway, or a Node process.
create or replace function public.luna_research_worker_tick()
returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $
declare
  v_now timestamptz := now();
  v_local timestamp := now() at time zone 'Asia/Bangkok';
  v_bucket bigint;
  v_job public.luna_research_jobs%rowtype;
  v_result jsonb;
  v_status text;
  v_processed integer := 0;
  v_ids jsonb := '[]'::jsonb;
  v_worker text := 'supabase-cron-research-worker';
  v_slot text;
  i integer;
begin
  -- 15-minute health pulse; idempotency prevents duplicate work on retries.
  v_bucket := floor(extract(epoch from v_now)/900)::bigint;
  insert into public.luna_research_jobs(job_type,status,priority,scheduled_at,available_at,idempotency_key,payload,max_attempts)
  values ('RESEARCH_HEALTH_AUDIT','QUEUED',100,v_now,v_now,'health:'||v_bucket,jsonb_build_object('bucket',v_bucket),5)
  on conflict(idempotency_key) do nothing;

  -- Dataset inventory checkpoints in Bangkok local time.
  v_slot := case
    when v_local::time >= time '07:05' and v_local::time < time '07:10' then 'morning'
    when v_local::time >= time '12:35' and v_local::time < time '12:40' then 'midday'
    when v_local::time >= time '16:45' and v_local::time < time '16:50' then 'close'
    when v_local::time >= time '20:00' and v_local::time < time '20:05' then 'night'
    else null end;
  if v_slot is not null then
    insert into public.luna_research_jobs(job_type,status,priority,scheduled_at,available_at,idempotency_key,payload,max_attempts)
    values ('DATASET_INVENTORY_AUDIT','QUEUED',50,v_now,v_now,
      'dataset:'||to_char(v_local,'YYYY-MM-DD')||':'||v_slot,
      jsonb_build_object('window',v_slot,'local_date',to_char(v_local,'YYYY-MM-DD')),5)
    on conflict(idempotency_key) do nothing;
  end if;

  -- Keep operational queue history bounded without deleting research runs or artifacts.
  if v_local::time >= time '00:00' and v_local::time < time '00:05' then
    delete from public.luna_research_jobs
    where status='SUCCEEDED' and finished_at < v_now-interval '90 days';
    delete from public.luna_research_jobs
    where status='DEAD_LETTER' and finished_at < v_now-interval '180 days';
  end if;

  for i in 1..5 loop
    select * into v_job
    from public.luna_claim_research_job(v_worker,120);
    if v_job.id is null then exit; end if;

    insert into public.luna_research_worker_heartbeats(worker_id,worker_version,status,last_seen_at,current_job_id,metadata)
    values(v_worker,'luna-db-research-worker-v1','BUSY',v_now,v_job.id,
      jsonb_build_object('scheduler','pg_cron','timezone','Asia/Bangkok'))
    on conflict(worker_id) do update set
      worker_version=excluded.worker_version,status='BUSY',
      last_seen_at=excluded.last_seen_at,current_job_id=excluded.current_job_id,
      metadata=excluded.metadata;

    if v_job.job_type='RESEARCH_HEALTH_AUDIT' then
      select jsonb_build_object(
        'kind',v_job.job_type,
        'observed_at',v_now,
        'queue',jsonb_build_object(
          'queued',(select count(*) from public.luna_research_jobs where status='QUEUED'),
          'running',(select count(*) from public.luna_research_jobs where status='RUNNING'),
          'retry',(select count(*) from public.luna_research_jobs where status='RETRY'),
          'dead_letter',(select count(*) from public.luna_research_jobs where status='DEAD_LETTER'),
          'succeeded',(select count(*) from public.luna_research_jobs where status='SUCCEEDED')
        ),
        'research',jsonb_build_object(
          'datasets',(select count(*) from public.luna_research_datasets),
          'backtest_runs',(select count(*) from public.luna_backtest_runs)
        ),
        'worker_version','luna-db-research-worker-v1',
        'source_of_truth','Supabase/Postgres'
      ) into v_result;
    elsif v_job.job_type='DATASET_INVENTORY_AUDIT' then
      select jsonb_build_object(
        'kind',v_job.job_type,
        'observed_at',v_now,
        'datasets',(select count(*) from public.luna_research_datasets),
        'missing_manifest_fields',(
          select count(*) from public.luna_research_datasets
          where name is null or source is null or checksum_sha256 is null
        ),
        'latest_dataset',(
          select jsonb_build_object('name',name,'source',source,'created_at',created_at,
            'checksum_sha256',checksum_sha256)
          from public.luna_research_datasets order by created_at desc limit 1
        ),
        'window',v_job.payload->>'window',
        'local_date',v_job.payload->>'local_date',
        'worker_version','luna-db-research-worker-v1'
      ) into v_result;
    else
      v_status := public.luna_fail_research_job(v_job.id,v_worker,
        jsonb_build_object('message','NO_HANDLER_REGISTERED:'||v_job.job_type,'at',v_now));
      v_ids := v_ids || jsonb_build_array(jsonb_build_object('id',v_job.id,'status',v_status));
      continue;
    end if;

    if public.luna_complete_research_job(v_job.id,v_worker,v_result) then
      v_processed := v_processed+1;
      v_ids := v_ids || jsonb_build_array(jsonb_build_object('id',v_job.id,'status','SUCCEEDED','type',v_job.job_type));
    else
      v_ids := v_ids || jsonb_build_array(jsonb_build_object('id',v_job.id,'status','LEASE_LOST'));
    end if;
  end loop;

  insert into public.luna_research_worker_heartbeats(worker_id,worker_version,status,last_seen_at,current_job_id,metadata)
  values(v_worker,'luna-db-research-worker-v1','ONLINE',v_now,null,
    jsonb_build_object('scheduler','pg_cron','timezone','Asia/Bangkok','processed_last_tick',v_processed))
  on conflict(worker_id) do update set
    worker_version=excluded.worker_version,status='ONLINE',
    last_seen_at=excluded.last_seen_at,current_job_id=null,metadata=excluded.metadata;

  return jsonb_build_object('ok',true,'worker_id',v_worker,'processed',v_processed,'jobs',v_ids,'observed_at',v_now);
end;
$;

revoke all on function public.luna_research_worker_tick() from public, anon, authenticated;
grant execute on function public.luna_research_worker_tick() to service_role;

-- Replace only this named job; unrelated LUNA schedules remain untouched.
do $
declare v_job_id bigint;
begin
  select jobid into v_job_id from cron.job where jobname='luna-research-worker-tick-every-5-minutes' limit 1;
  if v_job_id is not null then perform cron.unschedule(v_job_id); end if;
  perform cron.schedule('luna-research-worker-tick-every-5-minutes','*/5 * * * *',
    'select public.luna_research_worker_tick();');
end;
$;

commit;
