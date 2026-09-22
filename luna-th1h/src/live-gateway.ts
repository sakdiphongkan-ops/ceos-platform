import {config} from "./config.js";
import type {Side} from "./types.js";

export interface LiveBrokerOrder{
  client_order_id:string;
  broker_order_id:string;
  symbol:string;
  side:Side;
  qty:number;
  price:number;
  submitted_at_ms:number;
  broker_native_submitted_at_ms:number|null;
  ack_kind:"broker_native"|"gateway_response";
  raw:unknown;
}

function headers(){
  return {
    "Content-Type":"application/json",
    "x-luna-gateway":config.liveGatewayKey
  };
}

function ensureConfigured(){
  if(config.executionMode!=="live") throw new Error("LIVE_EXECUTION_NOT_SELECTED");
  if(!config.liveGatewayUrl) throw new Error("LUNA_LIVE_GATEWAY_URL_NOT_CONFIGURED");
  if(!config.liveGatewayKey) throw new Error("LUNA_LIVE_GATEWAY_KEY_NOT_CONFIGURED");
}

export interface LiveOpenOrder{
  order_id:string;
  symbol:string;
  side:string;
  status:string;
  volume:number|null;
  matched_volume:number|null;
}

export async function liveOpenOrders():Promise<LiveOpenOrder[]>{
  ensureConfigured();
  const res=await fetch(`${config.liveGatewayUrl}/open-orders`,{
    headers:headers(),
    signal:AbortSignal.timeout(5000)
  });
  const body=await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(`GATEWAY_OPEN_ORDERS_HTTP_${res.status}: ${JSON.stringify(body)}`);
  if(!body?.ok || !Array.isArray(body.open_orders)){
    throw new Error(`GATEWAY_OPEN_ORDERS_BAD_RESPONSE: ${JSON.stringify(body)}`);
  }
  return body.open_orders.map((x:any)=>({
    order_id:String(x.order_id??""),
    symbol:String(x.symbol??""),
    side:String(x.side??""),
    status:String(x.status??"UNKNOWN"),
    volume:x.volume==null?null:Number(x.volume),
    matched_volume:x.matched_volume==null?null:Number(x.matched_volume)
  }));
}


export interface LiveAccountState {
  as_of:string;
  cash:number;
  equity_value:number;
  positions:Array<{
    symbol:string;
    qty:number;
    avg_price:number;
    market_price:number|null;
    market_value:number|null;
    unrealized_pnl:number|null;
    realized_pnl:number|null;
  }>;
  unparsed_symbols:string[];
}

export async function liveAccountState():Promise<LiveAccountState>{
  ensureConfigured();
  const res=await fetch(`${config.liveGatewayUrl}/account-state`,{
    headers:headers(),
    signal:AbortSignal.timeout(5000)
  });
  const body=await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(`GATEWAY_ACCOUNT_STATE_HTTP_${res.status}: ${JSON.stringify(body)}`);
  if(
    !body?.ok
    || !Number.isFinite(Number(body.cash))
    || !Number.isFinite(Number(body.equity_value))
    || Number(body.equity_value)<Number(body.cash)
    || !Array.isArray(body.positions)
    || !Array.isArray(body.unparsed_symbols)
  ){
    throw new Error(`GATEWAY_ACCOUNT_STATE_BAD_RESPONSE: ${JSON.stringify(body)}`);
  }
  const positions=body.positions.map((x:any)=>({
    symbol:String(x.symbol),
    qty:Number(x.qty),
    avg_price:Number(x.avg_price),
    market_price:x.market_price==null?null:Number(x.market_price),
    market_value:x.market_value==null?null:Number(x.market_value),
    unrealized_pnl:x.unrealized_pnl==null?null:Number(x.unrealized_pnl),
    realized_pnl:x.realized_pnl==null?null:Number(x.realized_pnl)
  }));
  if(positions.some((x:any)=>
    !x.symbol
    || !Number.isFinite(x.qty)
    || x.qty<=0
    || !Number.isFinite(x.avg_price)
    || x.avg_price<=0
  )){
    throw new Error("GATEWAY_ACCOUNT_STATE_INVALID_POSITION");
  }
  return {
    as_of:String(body.as_of ?? new Date().toISOString()),
    cash:Number(body.cash),
    equity_value:Number(body.equity_value),
    positions,
    unparsed_symbols:body.unparsed_symbols.map((x:any)=>String(x))
  };
}


export async function liveGatewayHealth(){
  ensureConfigured();
  const res=await fetch(`${config.liveGatewayUrl}/health`,{headers:headers()});
  const body=await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(`GATEWAY_HEALTH_HTTP_${res.status}: ${JSON.stringify(body)}`);
  return body as {ok:boolean;live_armed:boolean;provider:string};
}

export async function liveGatewayDiagnostics(){
  ensureConfigured();
  const res=await fetch(`${config.liveGatewayUrl}/diagnostics`,{headers:headers()});
  const body=await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(`GATEWAY_DIAGNOSTICS_HTTP_${res.status}: ${JSON.stringify(body)}`);
  return body;
}

export async function placeLiveOrder(order:{
  clientOrderId:string;
  symbol:string;
  side:Side;
  qty:number;
  price:number;
  reason:string;
}):Promise<LiveBrokerOrder>{
  ensureConfigured();
  const res=await fetch(`${config.liveGatewayUrl}/place`,{
    method:"POST",
    headers:headers(),
    body:JSON.stringify({
      client_order_id:order.clientOrderId,
      symbol:order.symbol,
      side:order.side,
      volume:order.qty,
      price:order.price,
      reason:order.reason
    })
  });
  const body=await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(`GATEWAY_PLACE_HTTP_${res.status}: ${JSON.stringify(body)}`);
  if(!body?.broker_order_id) throw new Error(`GATEWAY_PLACE_NO_BROKER_ORDER_ID: ${JSON.stringify(body)}`);

  return {
    client_order_id:order.clientOrderId,
    broker_order_id:String(body.broker_order_id),
    symbol:order.symbol,
    side:order.side,
    qty:order.qty,
    price:order.price,
    submitted_at_ms:Number(body.submitted_at_ms ?? Date.now()),
    broker_native_submitted_at_ms:body.broker_native_submitted_at_ms==null?null:Number(body.broker_native_submitted_at_ms),
    ack_kind:body.ack_kind==="broker_native"?"broker_native":"gateway_response",
    raw:body.raw
  };
}

export interface LiveReconciliationOrder {
  client_order_id:string;
  broker_order_id?:string|null;
  status:string;
  filled_qty?:number;
  avg_fill_price?:number|null;
  fee?:number|null;
  updated_at_ms?:number;
  raw?:unknown;
}

export async function reconcileLiveOrders(clientOrderIds:string[]):Promise<LiveReconciliationOrder[]>{
  ensureConfigured();
  if(clientOrderIds.length===0) return [];
  const res=await fetch(`${config.liveGatewayUrl}/reconcile`,{
    method:"POST",
    headers:headers(),
    body:JSON.stringify({client_order_ids:clientOrderIds})
  });
  const body=await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(`GATEWAY_RECONCILE_HTTP_${res.status}: ${JSON.stringify(body)}`);
  if(!Array.isArray(body?.orders)) throw new Error(`GATEWAY_RECONCILE_BAD_RESPONSE: ${JSON.stringify(body)}`);
  return body.orders as LiveReconciliationOrder[];
}
