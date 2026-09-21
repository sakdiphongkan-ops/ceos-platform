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
