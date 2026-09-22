begin;

create policy "luna_commercial_audit_service_only" on public.luna_commercial_audit
  for all to public using ((select auth.role()) = 'service_role') with check ((select auth.role()) = 'service_role');

create policy "luna_customers_service_only" on public.luna_customers
  for all to public using ((select auth.role()) = 'service_role') with check ((select auth.role()) = 'service_role');

create policy "luna_factor_candidate_registry_service_only" on public.luna_factor_candidate_registry
  for all to public using ((select auth.role()) = 'service_role') with check ((select auth.role()) = 'service_role');

create policy "luna_feature_flags_service_only" on public.luna_feature_flags
  for all to public using ((select auth.role()) = 'service_role') with check ((select auth.role()) = 'service_role');

create policy "luna_formula_tournament_1000_service_only" on public.luna_formula_tournament_1000
  for all to public using ((select auth.role()) = 'service_role') with check ((select auth.role()) = 'service_role');

create policy "luna_live_experiment_daily_service_only" on public.luna_live_experiment_daily
  for all to public using ((select auth.role()) = 'service_role') with check ((select auth.role()) = 'service_role');

create policy "luna_live_experiment_events_service_only" on public.luna_live_experiment_events
  for all to public using ((select auth.role()) = 'service_role') with check ((select auth.role()) = 'service_role');

create policy "luna_live_experiments_service_only" on public.luna_live_experiments
  for all to public using ((select auth.role()) = 'service_role') with check ((select auth.role()) = 'service_role');

create policy "luna_plan_entitlements_service_only" on public.luna_plan_entitlements
  for all to public using ((select auth.role()) = 'service_role') with check ((select auth.role()) = 'service_role');

create policy "luna_plans_service_only" on public.luna_plans
  for all to public using ((select auth.role()) = 'service_role') with check ((select auth.role()) = 'service_role');

create policy "luna_research_formula_catalog_v2_service_only" on public.luna_research_formula_catalog_v2
  for all to public using ((select auth.role()) = 'service_role') with check ((select auth.role()) = 'service_role');

create policy "luna_research_formula_returns_v2_service_only" on public.luna_research_formula_returns_v2
  for all to public using ((select auth.role()) = 'service_role') with check ((select auth.role()) = 'service_role');

create policy "luna_research_monthly_price_factors_service_only" on public.luna_research_monthly_price_factors
  for all to public using ((select auth.role()) = 'service_role') with check ((select auth.role()) = 'service_role');

create policy "luna_strategy_registry_service_only" on public.luna_strategy_registry
  for all to public using ((select auth.role()) = 'service_role') with check ((select auth.role()) = 'service_role');

create policy "luna_subscriptions_service_only" on public.luna_subscriptions
  for all to public using ((select auth.role()) = 'service_role') with check ((select auth.role()) = 'service_role');

create policy "luna_usage_events_service_only" on public.luna_usage_events
  for all to public using ((select auth.role()) = 'service_role') with check ((select auth.role()) = 'service_role');

drop index if exists public.idx_luna_fills_daily_turnover;

commit;
