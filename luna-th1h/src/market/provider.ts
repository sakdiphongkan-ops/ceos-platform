import type {Quote} from "../types.js";
import {mockQuotes} from "./mock.js";
import {setMarketplaceQuotes} from "./set-marketplace.js";

export function marketQuotes(provider:string):AsyncGenerator<Quote>{
  switch(provider){
    case "mock":
      return mockQuotes();
    case "set-marketplace":
      return setMarketplaceQuotes();
    case "settrade-gateway":
      return settradeGatewayQuotes();
    default:
      throw new Error(`UNKNOWN_MARKET_DATA_PROVIDER: ${provider}`);
  }
}

async function* settradeGatewayQuotes():AsyncGenerator<Quote>{
  const url = process.env.LUNA_MARKET_GATEWAY_URL ?? "";
  const key = process.env.LUNA_MARKET_GATEWAY_KEY ?? "";
  const pollMs = Math.max(250,Number(process.env.LUNA_MARKET_GATEWAY_POLL_MS ?? 500));
  if(!url || !key) throw new Error("LUNA_MARKET_GATEWAY_URL and LUNA_MARKET_GATEWAY_KEY are required.");

  const previous = new Map<string,string>();

  while(true){
    const res = await fetch(`${url}/quotes`,{
      headers:{"x-luna-gateway":key,"accept":"application/json"},
      cache:"no-store"
    });
    const body = await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(`SETTRADE_GATEWAY_HTTP_${res.status}: ${JSON.stringify(body)}`);

    const quotes = Array.isArray(body?.quotes) ? body.quotes as any[] : [];
    for(const raw of quotes){
      if(!raw?.symbol || !raw?.ts) continue;
      const q:Quote = {
        symbol:String(raw.symbol),
        ts:String(raw.ts),
        bid:Number.isFinite(Number(raw.bid))?Number(raw.bid):null,
        ask:Number.isFinite(Number(raw.ask))?Number(raw.ask):null,
        last:Number.isFinite(Number(raw.last))?Number(raw.last):null,
        bidSize:Number.isFinite(Number(raw.bid_size))?Number(raw.bid_size):null,
        askSize:Number.isFinite(Number(raw.ask_size))?Number(raw.ask_size):null,
        source:"settrade-open-api-realtime"
      };
      if(q.last===null && q.bid===null && q.ask===null) continue;
      const sig=JSON.stringify([q.ts,q.bid,q.ask,q.last,q.bidSize,q.askSize]);
      if(previous.get(q.symbol)===sig) continue;
      previous.set(q.symbol,sig);
      yield q;
    }
    await new Promise(r=>setTimeout(r,pollMs));
  }
}
