-- Fix a time-of-check bug in 15m shadow decision materialization.
-- A signal must be judged against the verified order-book data in its completed bar,
-- not against the global heartbeat freshness at the later time when the cron happens
-- to rematerialize that same bar. The paper execution cycle still requires an exact,
-- verified next-bar bid/ask snapshot before it can fill an order.
CREATE OR REPLACE FUNCTION public.luna_materialize_15m_shadow_decisions(
  p_session_id uuid,
  p_strategy_version text,
  p_bar_end timestamp with time zone
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_inserted integer:=0;
  v_buy integer:=0;
  v_sell integer:=0;
  v_history_bars integer:=0;
  v_feed_verified boolean:=false;
begin
  -- Historical-bar scope: this intentionally does not use "now() - max_staleness".
  -- Current feed freshness is an execution concern handled by the exact next-bar fill
  -- gate in luna_run_live_paper_cycle. A historical signal may not be overwritten to
  -- NO_VERIFIED_MARKET_FEED simply because the feed is stale several minutes later.
  select exists (
    select 1
    from public.luna_shadow_15m_bars b
    join public.luna_verified_market_sources s
      on upper(s.source_code)=upper(b.source)
    where b.session_id=p_session_id
      and b.bar_end=p_bar_end
      and b.verified_book_tick_count>0
      and upper(b.source) in (
        'SETTRADE',
        'SETTRADE_REALTIME',
        'SETTRADE-REALTIME',
        'TOPTRADER_REALTIME'
      )
      and s.configured is true
      and s.enabled is true
      and s.execution_grade is true
      and s.book_grade is true
  )
  into v_feed_verified;

  with recursive ordered as (
    select
      b.symbol,b.bar_end,b.close,b.verified_book_tick_count,
      count(*) over(partition by b.symbol) as bar_count,
      lag(b.close) over(partition by b.symbol order by b.bar_end) as prev_close,
      row_number() over(partition by b.symbol order by b.bar_end) as rn
    from public.luna_shadow_15m_bars b
    join public.luna_sessions s on s.id=b.session_id
    where b.bar_end<=p_bar_end
      and b.bar_end>=p_bar_end-interval '10 days'
      and s.session_date<=p_bar_end::date
      and b.source in ('tradingview-public-screener','set.or.th','TOPTRADER_REALTIME')
  ),
  ema as (
    select symbol,bar_end,close,prev_close,bar_count,rn,verified_book_tick_count,
           close::numeric as ema5,close::numeric as ema20
    from ordered where rn=1
    union all
    select n.symbol,n.bar_end,n.close,n.prev_close,n.bar_count,n.rn,n.verified_book_tick_count,
           (n.close*(2.0/6.0)+p.ema5*(1.0-2.0/6.0))::numeric,
           (n.close*(2.0/21.0)+p.ema20*(1.0-2.0/21.0))::numeric
    from ema p join ordered n on n.symbol=p.symbol and n.rn=p.rn+1
  ),
  latest as (
    select distinct on(symbol)
      e.symbol,e.bar_end,e.close,e.ema5,e.ema20,e.prev_close,e.bar_count,
      (e.verified_book_tick_count>0) as verified_book
    from ema e
    where e.bar_end=p_bar_end
    order by symbol,e.bar_end desc
  ),
  prepared as (
    select l.*,
      case
        when l.bar_count>=20 and l.close>l.ema20 and l.ema5>l.ema20 and l.prev_close is not null and l.close>l.prev_close then 'BUY_CANDIDATE'
        when l.bar_count>=20 and l.close<l.ema20 and l.ema5<l.ema20 and l.prev_close is not null and l.close<l.prev_close then 'SELL_CANDIDATE'
        else 'NO_ACTION'
      end as candidate_action
    from latest l
  )
  insert into public.luna_shadow_15m_decisions(
    session_id,strategy_version,bar_end,symbol,close,ema5,ema20,momentum_1,
    bar_count,candidate_action,verified_book,feed_verified,execution_blocked,reason
  )
  select
    p_session_id,p_strategy_version,p.bar_end,p.symbol,p.close,p.ema5,p.ema20,
    case when p.prev_close is null or p.prev_close=0 then null else p.close/p.prev_close-1 end,
    p.bar_count,p.candidate_action,p.verified_book,v_feed_verified,
    not (p.verified_book and v_feed_verified),
    case
      when not v_feed_verified then 'NO_VERIFIED_MARKET_FEED'
      when not p.verified_book then 'NO_VERIFIED_EXECUTION_BOOK'
      else 'VERIFIED_EXECUTION_READY'
    end
  from prepared p
  where p.candidate_action<>'NO_ACTION'
  on conflict(session_id,strategy_version,bar_end,symbol) do update set
    close=excluded.close,ema5=excluded.ema5,ema20=excluded.ema20,momentum_1=excluded.momentum_1,
    bar_count=excluded.bar_count,candidate_action=excluded.candidate_action,
    verified_book=excluded.verified_book,feed_verified=excluded.feed_verified,
    execution_blocked=excluded.execution_blocked,reason=excluded.reason,created_at=now();

  get diagnostics v_inserted=row_count;

  select count(*) into v_history_bars
  from public.luna_shadow_15m_bars b
  join public.luna_sessions s on s.id=b.session_id
  where b.symbol in (
    select symbol from public.luna_shadow_15m_decisions
    where session_id=p_session_id and bar_end=p_bar_end and strategy_version=p_strategy_version
  )
  and b.bar_end<=p_bar_end
  and b.bar_end>=p_bar_end-interval '10 days'
  and s.session_date<=p_bar_end::date;

  select count(*) filter(where candidate_action='BUY_CANDIDATE'),
         count(*) filter(where candidate_action='SELL_CANDIDATE')
  into v_buy,v_sell
  from public.luna_shadow_15m_decisions
  where session_id=p_session_id and strategy_version=p_strategy_version and bar_end=p_bar_end;

  return jsonb_build_object(
    'ok',true,'inserted',v_inserted,'buy_candidates',v_buy,'sell_candidates',v_sell,
    'orders_created',false,'signals_created',false,'history_lookback_days',10,
    'history_seeded_across_sessions',true,'history_bars',v_history_bars,
    'feed_verification_scope','COMPLETED_BAR',
    'current_feed_freshness_gate','EXACT_NEXT_BAR_FILL'
  );
end;
$function$;
