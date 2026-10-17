-- LUNA cycle-level valuation fix.
-- Draft migration: do not apply to production until the feed payload contract and tests pass.
-- Replaces the live function definition captured read-only from Supabase on 2026-10-17.
-- Paper-only: no broker integration and no live orders.

CREATE OR REPLACE FUNCTION public.luna_run_live_paper_cycle(p_experiment_code text DEFAULT 'LUNA-PAPER-LIVE-15M-VERIFIED'::text, p_strategy_version text DEFAULT 'luna-th1h-v1.4.0-15m-riskgated'::text, p_initial_capital numeric DEFAULT 30000, p_fee_bps numeric DEFAULT 10, p_slippage_bps numeric DEFAULT 10)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_trade_date date := (now() at time zone 'Asia/Bangkok')::date;
  v_session_id uuid;
  v_latest_bar timestamptz;
  v_prev_bar timestamptz;
  v_signal_count integer := 0;
  v_filled_count integer := 0;
  v_queued_count integer := 0;
  v_cancelled_count integer := 0;
  v_rejected_count integer := 0;
  v_cash numeric;
  v_reserved numeric;
  v_realized numeric;
  v_fees numeric;
  v_peak numeric;
  v_equity numeric;
  v_mv numeric;
  v_dd numeric;
  v_dd_pct numeric;
  v_fill_price numeric;
  v_ref_price numeric;
  v_market_price numeric;
  v_market_ts timestamptz;
  v_unpriced_symbols text[];
  v_fee numeric;
  v_slip numeric;
  v_gross numeric;
  v_total_cost numeric;
  v_qty bigint;
  v_old_qty bigint;
  v_old_cost numeric;
  v_new_qty bigint;
  v_new_cost numeric;
  v_realized_trade numeric;
  v_weight numeric;
  v_conf numeric;
  v_top_conf numeric;
  v_target_notional numeric;
  v_available_cash numeric;
  v_order_reserve numeric;
  v_hash text;
  v_pos record;
  v_order record;
  v_sig record;
begin
  if p_initial_capital <= 0 or p_fee_bps < 0 or p_slippage_bps < 0 then
    raise exception 'INVALID_PAPER_PROTOCOL';
  end if;

  if not pg_try_advisory_xact_lock(hashtext('LUNA-PAPER-LIVE-15M')) then
    return jsonb_build_object('ok',true,'status','BUSY','paper_only',true,'live_orders_created',false);
  end if;

  select s.id
    into v_session_id
  from public.luna_sessions s
  where s.session_date=v_trade_date
    and s.status='OPEN'
    and s.strategy_version=p_strategy_version
  order by s.started_at desc
  limit 1;

  if v_session_id is null then
    select s.id
      into v_session_id
    from public.luna_sessions s
    where s.session_date=v_trade_date
      and s.status='OPEN'
    order by s.started_at desc
    limit 1;
  end if;

  if v_session_id is null then
    -- A successful scheduler cycle outside the market session is an idle heartbeat,
    -- not a trade event. This keeps system liveness observable without creating orders.
    update public.luna_paper_live_runtime
    set last_heartbeat=now(), updated_at=now()
    where experiment_code=p_experiment_code
      and status='RUNNING'
      and paper_only=true;

    return jsonb_build_object(
      'ok',true,
      'status','IDLE_OUTSIDE_MARKET_SESSION',
      'paper_only',true,
      'live_orders_created',false,
      'live_fills_created',false,
      'heartbeat_updated',true
    );
  end if;

  -- Cancel queued paper orders that belong to a previous session; preserve the rows for audit.
  update public.luna_paper_live_orders
  set status='CANCELLED', reason='STALE_SESSION_ROLLOVER', updated_at=now()
  where experiment_code=p_experiment_code
    and status='QUEUED'
    and session_id is distinct from v_session_id;

  insert into public.luna_paper_live_runtime(
    experiment_code,strategy_version,session_id,initial_capital,cash,reserved_cash,
    realized_pnl,fees,peak_equity,last_heartbeat,status,paper_only,fill_model,fee_bps,slippage_bps
  )
  values(
    p_experiment_code,p_strategy_version,v_session_id,p_initial_capital,p_initial_capital,0,
    0,0,p_initial_capital,now(),'RUNNING',true,'NEXT_BAR_BID_ASK',p_fee_bps,p_slippage_bps
  )
  on conflict(experiment_code) do nothing;

  select cash,reserved_cash,realized_pnl,fees,peak_equity,last_signal_bar_end
    into v_cash,v_reserved,v_realized,v_fees,v_peak,v_prev_bar
  from public.luna_paper_live_runtime
  where experiment_code=p_experiment_code
  for update;

  -- Recompute reservation from queued orders in the active session so stale reservations cannot block a new day.
  select coalesce(sum(reserved_cash),0)
    into v_reserved
  from public.luna_paper_live_orders
  where experiment_code=p_experiment_code
    and status='QUEUED'
    and session_id=v_session_id;

  if not exists (
    select 1 from public.luna_paper_live_runtime
    where experiment_code=p_experiment_code and paper_only=true and status='RUNNING'
  ) then
    return jsonb_build_object('ok',false,'status','PAPER_RUNTIME_NOT_ARMED','paper_only',true,'live_orders_created',false);
  end if;

  select max(b.bar_end)
    into v_latest_bar
  from public.luna_shadow_15m_bars b
  where b.session_id=v_session_id
    and b.bar_end<=now()
    and b.verified_book_tick_count>0;

  if v_latest_bar is null then
    update public.luna_paper_live_orders
    set status='CANCELLED',reason='NO_VERIFIED_NEXT_BAR_BOOK',reserved_cash=0,updated_at=now()
    where experiment_code=p_experiment_code
      and status='QUEUED'
      and session_id=v_session_id
      and fill_bar_end is not null
      and fill_bar_end<=now();
    get diagnostics v_cancelled_count = row_count;

    select coalesce(sum(reserved_cash),0) into v_reserved
    from public.luna_paper_live_orders
    where experiment_code=p_experiment_code and status='QUEUED' and session_id=v_session_id;

    update public.luna_paper_live_runtime
    set session_id=v_session_id,reserved_cash=v_reserved,last_heartbeat=now(),updated_at=now()
    where experiment_code=p_experiment_code;

    return jsonb_build_object(
      'ok',true,'status','WAITING_VERIFIED_MARKET_DATA','paper_only',true,
      'execution_blocked',true,'cancelled_orders',v_cancelled_count,
      'reserved_cash',v_reserved,'live_orders_created',false,'live_fills_created',false
    );
  end if;

   -- Paper fills are authorized per symbol only when the exact next-bar top-of-book snapshot exists.

  -- Expire paper orders whose intended next-bar timestamp has passed and whose exact candle never arrived.
  -- This releases reserved cash during feed outages without ever filling at a later bar.
  update public.luna_paper_live_orders o
  set status='CANCELLED', reason='NO_VERIFIED_NEXT_BAR_BOOK', reserved_cash=0, updated_at=now()
  where o.experiment_code=p_experiment_code
    and o.status='QUEUED'
    and o.session_id=v_session_id
    and o.fill_bar_end is not null
    and o.fill_bar_end <= now()
    and not exists (
      select 1 from public.luna_market_ticks mt
      where mt.session_id=o.session_id
        and mt.symbol=o.symbol
        and mt.source='TOPTRADER_REALTIME'
        and mt.ts >= o.created_at
        and mt.ts >= o.fill_bar_end - interval '15 minutes'
        and mt.ts < o.fill_bar_end
        and mt.bid>0 and mt.ask>=mt.bid and mt.ask>0 and mt.last>0
        and mt.bid_size>0 and mt.ask_size>0
    );
  GET DIAGNOSTICS v_cancelled_count = ROW_COUNT;

  select coalesce(sum(reserved_cash),0) into v_reserved
  from public.luna_paper_live_orders
  where experiment_code=p_experiment_code and status='QUEUED' and session_id=v_session_id;

  -- First fill all queued orders whose next bar is now known.
  for v_order in
    select *
    from public.luna_paper_live_orders
    where experiment_code=p_experiment_code
      and status='QUEUED'
      and fill_bar_end <= v_latest_bar
    order by fill_bar_end, created_at, symbol
  loop
    select
      case when v_order.side='BUY' then mt.ask else mt.bid end,
      mt.ts
    into v_market_price, v_market_ts
    from public.luna_market_ticks mt
    where mt.session_id=v_session_id
      and mt.symbol=v_order.symbol
      and mt.source='TOPTRADER_REALTIME'
      and mt.ts >= v_order.created_at
      and mt.ts >= v_order.fill_bar_end - interval '15 minutes'
      and mt.ts < v_order.fill_bar_end
      and mt.bid>0 and mt.ask>=mt.bid and mt.ask>0 and mt.last>0
      and mt.bid_size>0 and mt.ask_size>0
    order by mt.ts asc
    limit 1;

    if v_market_price is null then
      update public.luna_paper_live_orders
      set status='CANCELLED',reason='NO_VERIFIED_NEXT_BAR_BOOK',reserved_cash=0,updated_at=now()
      where id=v_order.id and status='QUEUED';
      v_reserved := greatest(v_reserved - coalesce(v_order.reserved_cash,0),0);
      v_cancelled_count := v_cancelled_count + 1;
      continue;
    end if;

    select coalesce(sum(qty_requested),0) into v_qty
    from public.luna_paper_live_orders
    where experiment_code=p_experiment_code
      and symbol=v_order.symbol
      and status='QUEUED'
      and side=v_order.side
      and id <> v_order.id;

    if v_order.side='BUY' then
      v_fill_price := v_market_price * (1 + p_slippage_bps/10000.0);
      v_gross := v_order.qty_requested * v_fill_price;
      v_fee := v_gross * p_fee_bps/10000.0;
      v_slip := v_order.qty_requested * (v_fill_price-v_market_price);
      v_total_cost := v_gross + v_fee;
      v_reserved := greatest(v_reserved - v_order.reserved_cash,0);

      if v_total_cost > v_cash then
        update public.luna_paper_live_orders
        set status='REJECTED',
            qty_filled=0,
            reference_price=v_ref_price,
            reason='INSUFFICIENT_CASH_AT_FILL',
            updated_at=now()
        where id=v_order.id;
        v_rejected_count := v_rejected_count + 1;
        continue;
      end if;

      v_cash := v_cash - v_total_cost;
      v_fees := v_fees + v_fee;

      select coalesce(qty,0),coalesce(cost_basis,0)
        into v_old_qty,v_old_cost
      from public.luna_paper_live_positions
      where experiment_code=p_experiment_code and symbol=v_order.symbol
      for update;

      v_old_qty := coalesce(v_old_qty,0);
      v_old_cost := coalesce(v_old_cost,0);
      v_new_qty := v_old_qty + v_order.qty_requested;
      v_new_cost := v_old_cost + v_total_cost;

      insert into public.luna_paper_live_positions(experiment_code,symbol,qty,avg_price,cost_basis,realized_pnl,updated_at)
      values(p_experiment_code,v_order.symbol,v_new_qty,v_new_cost/nullif(v_new_qty,0),v_new_cost,0,now())
      on conflict(experiment_code,symbol) do update set
        qty=excluded.qty,avg_price=excluded.avg_price,cost_basis=excluded.cost_basis,updated_at=now();

      insert into public.luna_paper_trade_ledger(
        experiment_code,strategy_version,session_id,bar_end,symbol,side,qty,fill_price,
        gross_notional,estimated_fee,estimated_slippage,total_cost,realized_pnl,
        position_qty_after,cash_after,fill_model,confidence,decision_hash,execution_quote_ts
      )
      values(
        p_experiment_code,p_strategy_version,v_session_id,v_order.fill_bar_end,v_order.symbol,'BUY',
        v_order.qty_requested,v_fill_price,v_gross,v_fee,v_slip,v_total_cost,0,
        v_new_qty,v_cash,'NEXT_BAR_BID_ASK',v_order.confidence,v_order.decision_hash,v_market_ts
      )
      on conflict do nothing;

      update public.luna_paper_live_orders
      set status='FILLED',qty_filled=qty_requested,reference_price=v_market_price,execution_quote_ts=v_market_ts,fill_price=v_fill_price,
          gross_notional=v_gross,estimated_fee=v_fee,estimated_slippage=v_slip,total_cost=v_total_cost,
          filled_at=now(),updated_at=now()
      where id=v_order.id;
      v_filled_count := v_filled_count + 1;

    else
      select coalesce(qty,0),coalesce(cost_basis,0),coalesce(avg_price,0)
        into v_old_qty,v_old_cost,v_ref_price
      from public.luna_paper_live_positions
      where experiment_code=p_experiment_code and symbol=v_order.symbol
      for update;

      v_old_qty := coalesce(v_old_qty,0);
      v_old_cost := coalesce(v_old_cost,0);

      if v_old_qty <= 0 then
        update public.luna_paper_live_orders
        set status='REJECTED',reason='NO_POSITION_AT_FILL',reference_price=v_ref_price,updated_at=now()
        where id=v_order.id;
        v_rejected_count := v_rejected_count + 1;
        continue;
      end if;

      v_qty := least(v_order.qty_requested,v_old_qty);
      v_fill_price := v_market_price * (1 - p_slippage_bps/10000.0);
      v_gross := v_qty * v_fill_price;
      v_fee := v_gross * p_fee_bps/10000.0;
      v_slip := v_qty * (v_market_price-v_fill_price);
      v_realized_trade := (v_gross-v_fee) - (v_old_cost * (v_qty::numeric/nullif(v_old_qty,0)));
      v_cash := v_cash + v_gross - v_fee;
      v_realized := v_realized + v_realized_trade;
      v_fees := v_fees + v_fee;
      v_new_qty := v_old_qty - v_qty;
      v_new_cost := case when v_new_qty>0 then v_old_cost * (v_new_qty::numeric/nullif(v_old_qty,0)) else 0 end;
      v_total_cost := v_gross-v_fee;

      insert into public.luna_paper_live_positions(experiment_code,symbol,qty,avg_price,cost_basis,realized_pnl,updated_at)
      values(p_experiment_code,v_order.symbol,v_new_qty,case when v_new_qty>0 then v_new_cost/v_new_qty else 0 end,v_new_cost,v_realized_trade,now())
      on conflict(experiment_code,symbol) do update set
        qty=excluded.qty,avg_price=excluded.avg_price,cost_basis=excluded.cost_basis,
        realized_pnl=public.luna_paper_live_positions.realized_pnl+excluded.realized_pnl,updated_at=now();

      insert into public.luna_paper_trade_ledger(
        experiment_code,strategy_version,session_id,bar_end,symbol,side,qty,fill_price,
        gross_notional,estimated_fee,estimated_slippage,total_cost,realized_pnl,
        position_qty_after,cash_after,fill_model,confidence,decision_hash,execution_quote_ts
      )
      values(
        p_experiment_code,p_strategy_version,v_session_id,v_order.fill_bar_end,v_order.symbol,'SELL',
        v_qty,v_fill_price,v_gross,v_fee,v_slip,v_total_cost,v_realized_trade,
        v_new_qty,v_cash,'NEXT_BAR_BID_ASK',v_order.confidence,v_order.decision_hash,v_market_ts
      )
      on conflict do nothing;

      update public.luna_paper_live_orders
      set status='FILLED',qty_filled=v_qty,reference_price=v_market_price,execution_quote_ts=v_market_ts,fill_price=v_fill_price,
          gross_notional=v_gross,estimated_fee=v_fee,estimated_slippage=v_slip,total_cost=v_total_cost,
          filled_at=now(),updated_at=now()
      where id=v_order.id;
      v_filled_count := v_filled_count + 1;
    end if;
  end loop;

  -- Only create new paper orders once for a newly materialized signal bar.
  if v_prev_bar is null or v_latest_bar > v_prev_bar then
    select coalesce(sum(abs(coalesce(momentum_1,0))) filter (where candidate_action='BUY_CANDIDATE'),0)
      into v_top_conf
    from (
      select momentum_1,
             candidate_action,
             row_number() over(order by abs(coalesce(momentum_1,0)) desc, symbol) as rn
      from public.luna_shadow_15m_decisions
      where session_id=v_session_id
        and strategy_version=p_strategy_version
        and bar_end=v_latest_bar
        and candidate_action='BUY_CANDIDATE'
        and feed_verified is true
        and verified_book is true
        and execution_blocked is false
        and close>0
    ) x
    where rn<=10;

    if v_top_conf>0 then
      for v_sig in
        select *
        from (
          select d.*,
                 greatest(abs(coalesce(d.momentum_1,0)),0.0000001) as confidence,
                 row_number() over(order by greatest(abs(coalesce(d.momentum_1,0)),0.0000001) desc,d.symbol) as buy_rank
          from public.luna_shadow_15m_decisions d
          where d.session_id=v_session_id
            and d.strategy_version=p_strategy_version
            and d.bar_end=v_latest_bar
            and d.candidate_action='BUY_CANDIDATE'
            and d.feed_verified is true
            and d.verified_book is true
            and d.execution_blocked is false
            and d.close>0
        ) x
        where buy_rank<=10
        order by buy_rank
      loop
        if exists(
          select 1 from public.luna_paper_live_orders
          where experiment_code=p_experiment_code
            and signal_bar_end=v_latest_bar
            and symbol=v_sig.symbol
            and side='BUY'
        ) then
          continue;
        end if;

        if exists(
          select 1 from public.luna_paper_live_orders
          where experiment_code=p_experiment_code
            and symbol=v_sig.symbol
            and side='BUY'
            and status='QUEUED'
        ) then
          continue;
        end if;

        v_conf := greatest(abs(coalesce(v_sig.momentum_1,0)),0.0000001);
        v_weight := v_conf/nullif(v_top_conf,0);
        v_available_cash := greatest(v_cash-v_reserved,0);
        v_target_notional := v_available_cash*v_weight;

        select coalesce(qty,0) into v_old_qty
        from public.luna_paper_live_positions
        where experiment_code=p_experiment_code and symbol=v_sig.symbol;
        v_old_qty := coalesce(v_old_qty,0);

        v_qty := floor(greatest(v_target_notional-v_old_qty*v_sig.close,0)/v_sig.close/100)*100;
        v_order_reserve := v_qty*v_sig.close*(1+(p_fee_bps+p_slippage_bps)/10000.0);

        if v_qty>0 and v_order_reserve<=v_available_cash then
          v_hash := md5(p_strategy_version||'|'||v_latest_bar::text||'|'||v_sig.symbol||'|BUY');
          insert into public.luna_paper_live_orders(
            experiment_code,strategy_version,session_id,signal_bar_end,fill_bar_end,symbol,side,
            qty_requested,status,reference_price,reserved_cash,confidence,decision_hash,reason
          )
          values(
            p_experiment_code,p_strategy_version,v_session_id,v_latest_bar,v_latest_bar+interval '15 minutes',
            v_sig.symbol,'BUY',v_qty,'QUEUED',v_sig.close,v_order_reserve,v_conf,v_hash,
            'PAPER_SIGNAL_NEXT_BAR_BID_ASK'
          )
          on conflict do nothing;
          v_reserved := v_reserved + v_order_reserve;
          v_queued_count := v_queued_count + 1;
        end if;
      end loop;
    end if;

    -- Exit existing paper positions on SELL candidates.
    for v_sig in
      select d.*
      from public.luna_shadow_15m_decisions d
      join public.luna_paper_live_positions p
        on p.experiment_code=p_experiment_code and p.symbol=d.symbol and p.qty>0
      where d.session_id=v_session_id
        and d.strategy_version=p_strategy_version
        and d.bar_end=v_latest_bar
        and d.candidate_action='SELL_CANDIDATE'
        and d.feed_verified is true
        and d.verified_book is true
        and d.execution_blocked is false
        and d.close>0
      order by d.symbol
    loop
      if exists(
        select 1 from public.luna_paper_live_orders
        where experiment_code=p_experiment_code
          and signal_bar_end=v_latest_bar
          and symbol=v_sig.symbol
          and side='SELL'
      ) then
        continue;
      end if;

      if exists(
        select 1 from public.luna_paper_live_orders
        where experiment_code=p_experiment_code
          and symbol=v_sig.symbol
          and side='SELL'
          and status='QUEUED'
      ) then
        continue;
      end if;

      select qty into v_qty
      from public.luna_paper_live_positions
      where experiment_code=p_experiment_code and symbol=v_sig.symbol;

      if coalesce(v_qty,0)>0 then
        v_hash := md5(p_strategy_version||'|'||v_latest_bar::text||'|'||v_sig.symbol||'|SELL');
        insert into public.luna_paper_live_orders(
          experiment_code,strategy_version,session_id,signal_bar_end,fill_bar_end,symbol,side,
          qty_requested,status,reference_price,reserved_cash,confidence,decision_hash,reason
        )
        values(
          p_experiment_code,p_strategy_version,v_session_id,v_latest_bar,v_latest_bar+interval '15 minutes',
          v_sig.symbol,'SELL',v_qty,'QUEUED',v_sig.close,0,
          greatest(abs(coalesce(v_sig.momentum_1,0)),0.0000001),v_hash,'PAPER_EXIT_NEXT_BAR_BID_ASK'
        )
        on conflict do nothing;
        v_queued_count := v_queued_count + 1;
      end if;
    end loop;

    select count(*) into v_signal_count
    from public.luna_shadow_15m_decisions
    where session_id=v_session_id and strategy_version=p_strategy_version
      and bar_end=v_latest_bar and candidate_action in ('BUY_CANDIDATE','SELL_CANDIDATE');

    v_prev_bar := v_latest_bar;
  end if;

  -- Remove zero-quantity rows so the UI cannot report ghost positions after a full exit.
  delete from public.luna_paper_live_positions where experiment_code=p_experiment_code and qty<=0;

  -- Fail closed: never value a held position at average cost or with stale/unverified quotes.
  select array_agg(p.symbol order by p.symbol)
    into v_unpriced_symbols
  from public.luna_paper_live_positions p
  where p.experiment_code=p_experiment_code
    and p.qty>0
    and not exists (
      select 1
      from public.luna_market_ticks mt
      where mt.session_id=v_session_id
        and upper(mt.symbol)=upper(p.symbol)
        and mt.source='TOPTRADER_REALTIME'
        and mt.ts <= now() + interval '1 second'
        and mt.ts >= now() - interval '60 seconds'
        and mt.bid>0 and mt.ask>=mt.bid and mt.ask>0
        and mt.bid_size>0 and mt.ask_size>0
        and (
          lower(coalesce(mt.raw->>'data_quality',''))='verified'
          or lower(coalesce(mt.raw->>'verified',''))='true'
        )
    );

  if coalesce(cardinality(v_unpriced_symbols),0)>0 then
    -- Persist ledger balances/heartbeat, but do not update peak equity or write a
    -- snapshot whose valuation is incomplete. Keep the previous verified valuation intact.
    update public.luna_paper_live_runtime
    set session_id=v_session_id,cash=v_cash,reserved_cash=v_reserved,realized_pnl=v_realized,fees=v_fees,
        last_signal_bar_end=v_prev_bar,last_heartbeat=now(),updated_at=now()
    where experiment_code=p_experiment_code;

    return jsonb_build_object(
      'ok',true,
      'status','VALUATION_INCOMPLETE',
      'paper_only',true,
      'valuation_ready',false,
      'unpriced_symbols',to_jsonb(v_unpriced_symbols),
      'max_quote_age_seconds',60,
      'snapshot_written',false,
      'peak_equity_updated',false,
      'current_equity',null,
      'cash',round(v_cash,3),
      'reserved_cash',round(v_reserved,3),
      'live_orders_created',false,
      'live_fills_created',false
    );
  end if;

  -- Liquidation-side mark uses the latest eligible bid per held symbol, not avg_price.
  select coalesce(sum(p.qty*t.bid),0)
    into v_mv
  from public.luna_paper_live_positions p
  join lateral (
    select mt.bid
    from public.luna_market_ticks mt
    where mt.session_id=v_session_id
      and upper(mt.symbol)=upper(p.symbol)
      and mt.source='TOPTRADER_REALTIME'
      and mt.ts <= now() + interval '1 second'
      and mt.ts >= now() - interval '60 seconds'
      and mt.bid>0 and mt.ask>=mt.bid and mt.ask>0
      and mt.bid_size>0 and mt.ask_size>0
      and (
        lower(coalesce(mt.raw->>'data_quality',''))='verified'
        or lower(coalesce(mt.raw->>'verified',''))='true'
      )
    order by mt.ts desc
    limit 1
  ) t on true
  where p.experiment_code=p_experiment_code
    and p.qty>0;

  v_equity := v_cash + v_mv;
  v_peak := greatest(v_peak,v_equity);
  v_dd := greatest(v_peak-v_equity,0);
  v_dd_pct := case when v_peak>0 then v_dd/v_peak*100 else 0 end;

  -- Timestamp valuation at calculation time, not at the possibly old signal bar.
  insert into public.luna_paper_equity_snapshots(
    experiment_code,strategy_version,session_id,ts,cash,market_value,equity,
    realized_pnl,unrealized_pnl,fees,drawdown_thb,drawdown_pct
  )
  values(
    p_experiment_code,p_strategy_version,v_session_id,now(),v_cash,v_mv,v_equity,
    v_realized,v_mv-coalesce((select sum(cost_basis) from public.luna_paper_live_positions where experiment_code=p_experiment_code),0),
    v_fees,v_dd,v_dd_pct
  )
  on conflict(experiment_code,strategy_version,ts) do update set
    session_id=excluded.session_id,cash=excluded.cash,market_value=excluded.market_value,equity=excluded.equity,
    realized_pnl=excluded.realized_pnl,unrealized_pnl=excluded.unrealized_pnl,fees=excluded.fees,
    drawdown_thb=excluded.drawdown_thb,drawdown_pct=excluded.drawdown_pct;

  update public.luna_paper_live_runtime
  set session_id=v_session_id,cash=v_cash,reserved_cash=v_reserved,realized_pnl=v_realized,fees=v_fees,
      peak_equity=v_peak,fill_model='NEXT_BAR_BID_ASK',last_signal_bar_end=v_prev_bar,last_heartbeat=now(),updated_at=now()
  where experiment_code=p_experiment_code;

  return jsonb_build_object(
    'ok',true,
    'status','RUNNING',
    'paper_only',true,
    'live_orders_created',false,
    'live_fills_created',false,
    'experiment_code',p_experiment_code,
    'strategy_version',p_strategy_version,
    'session_id',v_session_id,
    'latest_bar',v_latest_bar,
    'signals_on_bar',v_signal_count,
    'queued_orders',v_queued_count,
    'filled_orders',v_filled_count,
    'rejected_orders',v_rejected_count,
    'cancelled_orders',v_cancelled_count,
    'current_equity',round(v_equity,3),
    'cash',round(v_cash,3),
    'reserved_cash',round(v_reserved,3),
    'market_value',round(v_mv,3),
    'realized_pnl',round(v_realized,3),
    'unrealized_pnl',round(v_mv-coalesce((select sum(cost_basis) from public.luna_paper_live_positions where experiment_code=p_experiment_code),0),3),
    'fees',round(v_fees,3),
    'max_drawdown_thb',round(v_dd,3),
    'max_drawdown_pct',round(v_dd_pct,6),
    'fill_model','NEXT_BAR_BID_ASK',
    'fee_bps',p_fee_bps,
    'slippage_bps',p_slippage_bps
  );
end;
$function$;

COMMENT ON FUNCTION public.luna_run_live_paper_cycle(text,text,numeric,numeric,numeric) IS
  'Paper-only cycle. Fail-closed mark-to-market: every open position requires a <=60s TOPTRADER_REALTIME quote with valid bid/ask/sizes and explicit verified marker in raw JSON. Returns VALUATION_INCOMPLETE without snapshot/peak-equity updates if any held symbol is unpriced.';
