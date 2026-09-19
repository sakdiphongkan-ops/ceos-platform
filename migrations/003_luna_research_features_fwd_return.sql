-- Keep the canonical 1M-search input contract aligned with the DB representation.
alter table public.luna_research_features
  add column if not exists fwd_return numeric;
