-- LUNA point-in-time availability and daily OHLC eligibility view v1
-- Preserve raw source timestamps; derive conservative post-close availability for Yahoo daily bars.
begin;

create or replace view public.luna_research_prices_pit_v1
with (security_invoker=true)
as
select
  id,dataset_id,date,symbol,market,open,high,low,close,adj_close,volume,amount,
  available_at as source_available_at,
  case
    when source::text='YAHOO_FINANCE_CHART:1d'
      then ((date + time '17:05:00') at time zone 'Asia/Bangkok')
    else available_at
  end as available_at,
  case
    when source::text='YAHOO_FINANCE_CHART:1d'
      then ((date + time '17:05:00') at time zone 'Asia/Bangkok')
    else available_at
  end as research_available_at,
  source,
  source_seq,
  (open>0 and high>0 and low>0 and close>0
    and high>=low and high>=greatest(open,close) and low<=least(open,close)) as ohlc_valid,
  (adj_close is not null and adj_close>0) as adj_close_valid,
  (open>0 and high>0 and low>0 and close>0
    and high>=low and high>=greatest(open,close) and low<=least(open,close)
    and volume is not null and volume>0 and amount is not null and amount>=0) as bar_eligible,
  (adj_close is not null and adj_close>0
    and case when source::text='YAHOO_FINANCE_CHART:1d'
      then ((date + time '17:05:00') at time zone 'Asia/Bangkok')
      else available_at end is not null) as close_return_eligible,
  case when source::text='YAHOO_FINANCE_CHART:1d'
    then 'THAI_DAILY_BAR_AFTER_CLOSE_17:05_ASIA_BANGKOK'
    else 'SOURCE_AVAILABLE_AT_UNVERIFIED' end as availability_policy,
  jsonb_build_object(
    'null_ohlc',open is null or high is null or low is null or close is null,
    'inconsistent_ohlc',open is not null and high is not null and low is not null and close is not null
      and not (high>=low and high>=greatest(open,close) and low<=least(open,close)),
    'invalid_adj_close',adj_close is null or adj_close<=0,
    'invalid_volume',volume is null or volume<0,
    'invalid_amount',amount is null or amount<0,
    'availability_rebased',source::text='YAHOO_FINANCE_CHART:1d'
  ) as data_quality_flags
from public.luna_research_prices;

revoke all on public.luna_research_prices_pit_v1 from public,anon,authenticated;
grant select on public.luna_research_prices_pit_v1 to service_role;

commit;
