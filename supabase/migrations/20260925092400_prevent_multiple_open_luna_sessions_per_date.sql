-- Prevent concurrent LUNA sessions for the same trading date.
-- start_session already has a race-recovery path for PostgreSQL error 23505.
-- This index makes the invariant database-enforced, not application-only.
create unique index if not exists luna_one_open_session_per_date
  on public.luna_sessions(session_date)
  where status = 'OPEN';
