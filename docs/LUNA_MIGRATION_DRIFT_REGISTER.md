# LUNA Supabase migration drift register

**Audit date:** 2026-11-04  
**Repository head checked:** 6adc2f3dfad92d849a056af8b01d69b8895d16c6  
**Supabase project:** wigzicwgcsrhdummrbjx

## Observed state

- Supabase migration history reports 333 applied migration records; the latest applied version is 20261031015251 (luna_dashboard_hot_path_indexes_20261031).
- The repository tree contains 9 SQL files under the canonical supabase/migrations directory.
- Only 2 of those 9 files match a version and migration name in the live Supabase migration history exactly.
- The repository also contains separate legacy SQL files under migrations/ and luna-th1h/migrations/. Those are not a substitute for a complete supabase/migrations history.
- The latest tracked canonical Supabase migration artifact is dated 2026-10-28, while the live migration history contains later changes through 2026-10-31.

This is migration-source drift, not evidence that the current database is broken. The production schema and its migration history are live; the checked-in source artifacts do not provide a complete, reproducible migration chain.

## Do not do this

- Do not fabricate 331 historical SQL files from migration names.
- Do not re-run old schema changes simply to make filenames line up.
- Do not change production RLS, grants, scheduler functions or tables to silence a migration warning.
- Do not assume a schema dump can reproduce data, secret values, cron commands, auth users or provider state.

## Recovery plan

1. Freeze ad-hoc schema changes. Every future schema change must be created as a reviewed, timestamped SQL migration in supabase/migrations.
2. Create an isolated Supabase development branch/project and capture a schema-only baseline with a trusted Supabase CLI/pg_dump connection supplied through the secure secret manager. Exclude data, credentials, auth identities and secret contents.
3. Compare the baseline with the live schema and explicitly inventory tables, views, functions, triggers, policies, grants, indexes, extensions, publications and cron jobs.
4. For every migration-table record that lacks a checked-in source file, mark it as historical/unrecoverable unless its original SQL can be retrieved from an authoritative backup or CI artifact. Do not reconstruct by guesswork.
5. Establish a new baseline migration for fresh environments only after validating it against an isolated database and documenting any manual/provider-managed objects.
6. Add CI checks that validate migration naming, SQL lint/type checks and schema diff against the isolated baseline.
7. Keep production changes gated by review and rollback instructions.

## Release gate

A frontend-only change may proceed after normal tests. Any database or Edge Function schema change remains blocked until its exact migration is checked in, verified against an isolated database, and reviewed for RLS/grants and rollback safety. LUNA paper-only and live-execution locks must not be modified by schema recovery work.
