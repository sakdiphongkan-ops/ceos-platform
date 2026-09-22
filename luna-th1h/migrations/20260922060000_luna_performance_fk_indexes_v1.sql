create index if not exists idx_luna_commercial_audit_strategy_version on public.luna_commercial_audit(strategy_version);
create index if not exists idx_luna_live_experiment_daily_session_id on public.luna_live_experiment_daily(session_id);
create index if not exists idx_luna_live_experiment_events_session_id on public.luna_live_experiment_events(session_id);
create index if not exists idx_luna_live_experiments_strategy_version on public.luna_live_experiments(strategy_version);
create index if not exists idx_luna_subscriptions_plan_code on public.luna_subscriptions(plan_code);
create index if not exists idx_luna_usage_events_subscription_id on public.luna_usage_events(subscription_id);
