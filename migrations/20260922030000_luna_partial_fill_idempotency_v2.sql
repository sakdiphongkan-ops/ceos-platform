-- LUNA live partial-fill idempotency v2
-- Durable order/broker identity and cumulative-fill idempotency.

alter table public.luna_orders
  add column if not exists broker_order_id text;

alter table public.luna_fills
  add column if not exists idempotency_key text;

alter table public.luna_fills
  add column if not exists cumulative_filled_qty bigint;

create unique index if not exists luna_orders_broker_order_id_uq
  on public.luna_orders (broker_order_id)
  where broker_order_id is not null;

create unique index if not exists luna_fills_idempotency_key_uq
  on public.luna_fills (idempotency_key)
  where idempotency_key is not null;

create index if not exists luna_fills_order_ts
  on public.luna_fills (order_id, ts);

create or replace function public.luna_record_fill_v2(
  p_session_id uuid,p_client_order_id text,p_broker_order_id text,p_symbol text,p_side text,
  p_qty bigint,p_order_qty bigint,p_cumulative_filled_qty bigint,p_order_price numeric,p_fill_price numeric,
  p_fee numeric,p_slippage numeric,p_ts timestamptz,p_reason text,p_strategy_version text,p_idempotency_key text
) returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_order_id uuid; v_existing_fill_id bigint; v_order_session_id uuid; v_order_symbol text; v_order_side text;
  v_existing_broker_order_id text; v_qty bigint:=0; v_avg numeric:=0; v_cost numeric:=0; v_realized numeric:=0;
  v_existing_filled bigint:=0; v_existing_avg_fill numeric:=null; v_existing_order_qty bigint:=0; v_new_filled bigint:=0;
  v_delta bigint:=0; v_new_qty bigint; v_new_cost numeric; v_new_avg numeric; v_new_avg_fill numeric; v_status text; v_fill_id bigint;
begin
  if coalesce(trim(p_client_order_id),'')='' then raise exception 'INVALID_CLIENT_ORDER_ID'; end if;
  if coalesce(trim(p_idempotency_key),'')='' then raise exception 'INVALID_FILL_IDEMPOTENCY_KEY'; end if;
  if p_qty<=0 then raise exception 'INVALID_QTY'; end if;
  if p_order_qty<=0 then raise exception 'INVALID_ORDER_QTY'; end if;
  if p_cumulative_filled_qty<=0 or p_cumulative_filled_qty>p_order_qty then raise exception 'INVALID_CUMULATIVE_FILLED_QTY'; end if;
  if p_side not in ('BUY','SELL') then raise exception 'INVALID_SIDE'; end if;
  if p_fill_price<=0 then raise exception 'INVALID_FILL_PRICE'; end if;
  if coalesce(p_fee,0)<0 or coalesce(p_slippage,0)<0 then raise exception 'INVALID_COST'; end if;

  select f.id into v_existing_fill_id
  from public.luna_fills f where f.idempotency_key=p_idempotency_key limit 1;

  if v_existing_fill_id is not null then
    select o.id,o.session_id,o.symbol,o.side,o.qty,o.filled_qty,o.avg_fill_price,o.broker_order_id
      into v_order_id,v_order_session_id,v_order_symbol,v_order_side,v_existing_order_qty,v_existing_filled,v_existing_avg_fill,v_existing_broker_order_id
    from public.luna_fills f join public.luna_orders o on o.id=f.order_id where f.id=v_existing_fill_id limit 1;
    select coalesce(pos.qty,0),coalesce(pos.avg_price,0),coalesce(pos.realized_pnl,0)
      into v_qty,v_avg,v_realized from public.luna_positions pos where pos.session_id=p_session_id and pos.symbol=p_symbol;
    return jsonb_build_object('ok',true,'idempotent',true,'order_id',v_order_id,'fill_id',v_existing_fill_id,
      'position_qty',coalesce(v_qty,0),'avg_price',coalesce(v_avg,0),'realized_pnl',coalesce(v_realized,0),
      'filled_qty',coalesce(v_existing_filled,0),'order_status',
      case when coalesce(v_existing_filled,0)=coalesce(v_existing_order_qty,0) then 'FILLED' else 'PARTIALLY_FILLED' end);
  end if;

  select o.id,o.session_id,o.symbol,o.side,o.qty,o.filled_qty,o.avg_fill_price,o.broker_order_id
    into v_order_id,v_order_session_id,v_order_symbol,v_order_side,v_existing_order_qty,v_existing_filled,v_existing_avg_fill,v_existing_broker_order_id
  from public.luna_orders o where o.client_order_id=p_client_order_id limit 1 for update;

  if v_order_id is not null then
    if v_order_session_id is distinct from p_session_id or v_order_symbol<>p_symbol or v_order_side<>p_side then raise exception 'ORDER_IDENTITY_MISMATCH'; end if;
    if v_existing_order_qty<>p_order_qty then raise exception 'ORDER_QTY_MISMATCH'; end if;
    if v_existing_broker_order_id is not null and p_broker_order_id is not null and v_existing_broker_order_id<>p_broker_order_id then raise exception 'BROKER_ORDER_ID_MISMATCH'; end if;
    v_delta:=p_cumulative_filled_qty-coalesce(v_existing_filled,0);
    if v_delta<0 then raise exception 'FILL_CUMULATIVE_REGRESSION'; end if;
    if v_delta=0 then
      select coalesce(pos.qty,0),coalesce(pos.avg_price,0),coalesce(pos.realized_pnl,0)
        into v_qty,v_avg,v_realized from public.luna_positions pos where pos.session_id=p_session_id and pos.symbol=p_symbol;
      return jsonb_build_object('ok',true,'idempotent',true,'order_id',v_order_id,'fill_id',null,
        'position_qty',coalesce(v_qty,0),'avg_price',coalesce(v_avg,0),'realized_pnl',coalesce(v_realized,0),
        'filled_qty',coalesce(v_existing_filled,0),'order_status',
        case when coalesce(v_existing_filled,0)=coalesce(v_existing_order_qty,0) then 'FILLED' else 'PARTIALLY_FILLED' end);
    end if;
    if v_delta<>p_qty then raise exception 'CUMULATIVE_FILL_DELTA_MISMATCH'; end if;
  else
    if p_cumulative_filled_qty<>p_qty then raise exception 'FIRST_FILL_MUST_MATCH_CUMULATIVE_QTY'; end if;

    insert into public.luna_orders(
      session_id,symbol,side,qty,limit_price,status,reason,client_order_id,broker_order_id,filled_qty,avg_fill_price,updated_at
    ) values (
      p_session_id,p_symbol,p_side,p_order_qty,p_order_price,
      case when p_cumulative_filled_qty=p_order_qty then 'FILLED' else 'PARTIALLY_FILLED' end,
      p_reason,p_client_order_id,p_broker_order_id,p_cumulative_filled_qty,p_fill_price,now()
    )
    on conflict (client_order_id) where client_order_id is not null do nothing
    returning id,session_id,symbol,side,qty,filled_qty,avg_fill_price,broker_order_id
      into v_order_id,v_order_session_id,v_order_symbol,v_order_side,v_existing_order_qty,v_existing_filled,v_existing_avg_fill,v_existing_broker_order_id;

    if v_order_id is null then
      select o.id,o.session_id,o.symbol,o.side,o.qty,o.filled_qty,o.avg_fill_price,o.broker_order_id
        into v_order_id,v_order_session_id,v_order_symbol,v_order_side,v_existing_order_qty,v_existing_filled,v_existing_avg_fill,v_existing_broker_order_id
      from public.luna_orders o where o.client_order_id=p_client_order_id limit 1 for update;
      if v_order_id is null then raise exception 'ORDER_CONFLICT_UNRESOLVED'; end if;
      if v_order_session_id is distinct from p_session_id or v_order_symbol<>p_symbol or v_order_side<>p_side or v_existing_order_qty<>p_order_qty then raise exception 'ORDER_IDENTITY_MISMATCH'; end if;
      if v_existing_broker_order_id is not null and p_broker_order_id is not null and v_existing_broker_order_id<>p_broker_order_id then raise exception 'BROKER_ORDER_ID_MISMATCH'; end if;
      v_delta:=p_cumulative_filled_qty-coalesce(v_existing_filled,0);
      if v_delta<0 then raise exception 'FILL_CUMULATIVE_REGRESSION'; end if;
      if v_delta=0 then
        select coalesce(pos.qty,0),coalesce(pos.avg_price,0),coalesce(pos.realized_pnl,0)
          into v_qty,v_avg,v_realized from public.luna_positions pos where pos.session_id=p_session_id and pos.symbol=p_symbol;
        return jsonb_build_object('ok',true,'idempotent',true,'order_id',v_order_id,'fill_id',null,
          'position_qty',coalesce(v_qty,0),'avg_price',coalesce(v_avg,0),'realized_pnl',coalesce(v_realized,0),
          'filled_qty',coalesce(v_existing_filled,0),'order_status',
          case when coalesce(v_existing_filled,0)=coalesce(v_existing_order_qty,0) then 'FILLED' else 'PARTIALLY_FILLED' end);
      end if;
      if v_delta<>p_qty then raise exception 'CUMULATIVE_FILL_DELTA_MISMATCH'; end if;
    else
      v_existing_order_qty:=p_order_qty; v_existing_filled:=0; v_existing_avg_fill:=null;
    end if;
  end if;

  select qty,avg_price,cost_basis,realized_pnl into v_qty,v_avg,v_cost,v_realized
  from public.luna_positions where session_id=p_session_id and symbol=p_symbol for update;
  v_qty:=coalesce(v_qty,0); v_avg:=coalesce(v_avg,0); v_cost:=coalesce(v_cost,0); v_realized:=coalesce(v_realized,0);
  v_new_filled:=p_cumulative_filled_qty;

  if p_side='SELL' and p_qty>v_qty then raise exception 'INSUFFICIENT_POSITION'; end if;

  if p_side='BUY' then
    v_new_qty:=v_qty+p_qty; v_new_cost:=v_cost+(p_fill_price*p_qty)+p_fee; v_new_avg:=v_new_cost/v_new_qty;
  else
    v_new_qty:=v_qty-p_qty; v_realized:=v_realized+((p_fill_price*p_qty)-p_fee-(v_avg*p_qty));
    v_new_cost:=greatest(v_cost-(v_avg*p_qty),0); v_new_avg:=case when v_new_qty>0 then v_new_cost/v_new_qty else 0 end;
  end if;

  v_new_avg_fill:=case when coalesce(v_existing_filled,0)=0 then p_fill_price
    else ((coalesce(v_existing_avg_fill,0)*coalesce(v_existing_filled,0))+(p_fill_price*p_qty))/v_new_filled end;
  v_status:=case when v_new_filled=p_order_qty then 'FILLED' else 'PARTIALLY_FILLED' end;

  update public.luna_orders set broker_order_id=coalesce(public.luna_orders.broker_order_id,p_broker_order_id),
    filled_qty=v_new_filled,avg_fill_price=v_new_avg_fill,status=v_status,reason=coalesce(public.luna_orders.reason,p_reason),updated_at=now()
  where id=v_order_id;

  insert into public.luna_fills(order_id,ts,qty,price,fee,slippage,idempotency_key,cumulative_filled_qty)
  values(v_order_id,p_ts,p_qty,p_fill_price,p_fee,p_slippage,p_idempotency_key,p_cumulative_filled_qty)
  returning id into v_fill_id;

  insert into public.luna_positions(session_id,symbol,qty,avg_price,cost_basis,realized_pnl,updated_at)
  values(p_session_id,p_symbol,v_new_qty,v_new_avg,v_new_cost,v_realized,now())
  on conflict(session_id,symbol) do update set
    qty=excluded.qty,avg_price=excluded.avg_price,cost_basis=excluded.cost_basis,realized_pnl=excluded.realized_pnl,updated_at=now();

  return jsonb_build_object('ok',true,'idempotent',false,'order_id',v_order_id,'fill_id',v_fill_id,
    'position_qty',v_new_qty,'avg_price',v_new_avg,'realized_pnl',v_realized,'fee',p_fee,'slippage',p_slippage,
    'filled_qty',v_new_filled,'order_status',v_status);
end;
$function$;
