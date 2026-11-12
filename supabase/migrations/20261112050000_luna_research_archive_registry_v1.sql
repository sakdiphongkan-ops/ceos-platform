-- LUNA immutable research archive registry v1
begin;

create table if not exists public.luna_research_archives (
  id uuid primary key default gen_random_uuid(),
  dataset_id uuid not null references public.luna_research_datasets(id),
  object_key text not null unique,
  manifest_key text not null unique,
  source_sha256 text not null,
  row_count bigint not null check(row_count>0),
  object_size_bytes bigint not null check(object_size_bytes>0),
  status text not null default 'UPLOADED'
    check(status in ('UPLOADED','VERIFIED','RESTORE_VERIFIED','FAILED')),
  uploaded_at timestamptz not null default now(),
  verified_at timestamptz,
  restore_verified_at timestamptz,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists luna_research_archives_dataset_uploaded_idx
  on public.luna_research_archives(dataset_id,uploaded_at desc);

alter table public.luna_research_archives enable row level security;
drop policy if exists luna_research_archives_service_role_all on public.luna_research_archives;
create policy luna_research_archives_service_role_all on public.luna_research_archives
  as permissive for all to service_role using(true) with check(true);
revoke all on public.luna_research_archives from public,anon,authenticated;
grant select,insert,update,delete on public.luna_research_archives to service_role;

commit;
