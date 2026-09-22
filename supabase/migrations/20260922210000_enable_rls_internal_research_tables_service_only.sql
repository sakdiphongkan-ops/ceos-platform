-- Prepared remediation for Supabase security advisor: five internal research/e2e tables
-- Intentionally NOT applied automatically.
-- These tables currently grant privileges only to service_role; the policies below
-- preserve service-only access after RLS is enabled.

begin;

alter table public.luna_e2e_test_runs enable row level security;
alter table public.luna_holding_exit_rules enable row level security;
alter table public.luna_holding_exit_research enable row level security;
alter table public.luna_holding_plans enable row level security;
alter table public.luna_formula_comparison_tests enable row level security;

create policy luna_e2e_test_runs_service_role_all
  on public.luna_e2e_test_runs
  as permissive for all
  to service_role
  using (true)
  with check (true);

create policy luna_holding_exit_rules_service_role_all
  on public.luna_holding_exit_rules
  as permissive for all
  to service_role
  using (true)
  with check (true);

create policy luna_holding_exit_research_service_role_all
  on public.luna_holding_exit_research
  as permissive for all
  to service_role
  using (true)
  with check (true);

create policy luna_holding_plans_service_role_all
  on public.luna_holding_plans
  as permissive for all
  to service_role
  using (true)
  with check (true);

create policy luna_formula_comparison_tests_service_role_all
  on public.luna_formula_comparison_tests
  as permissive for all
  to service_role
  using (true)
  with check (true);

commit;
