-- LUNA research policy overlap cleanup v1
-- Keep authenticated's existing broad read policy and scope the public dataset policy to anon only.

drop policy if exists luna_research_prices_public_dataset_read on public.luna_research_prices;

create policy luna_research_prices_public_dataset_read
  on public.luna_research_prices
  for select
  to anon
  using (
    dataset_id = '1af83c59-a56f-461f-b03e-f3d04e67e384'::uuid
    and date >= date '2021-09-01'
    and date <= date '2026-08-31'
  );