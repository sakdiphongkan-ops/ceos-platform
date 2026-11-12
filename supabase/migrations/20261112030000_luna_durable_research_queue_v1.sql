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

revoke all on public.luna_research_jobs from anon, authenticated;
revoke all on public.luna_research_worker_heartbeats from anon, authenticated;
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

commit;
