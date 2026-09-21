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
    let body:any = {};
    let ok=false;
    let lastError:unknown=null;

    for(let attempt=1;attempt<=4;attempt++){
      try{
        const res = await fetch(`${url}/quotes`,{
          headers:{"x-luna-gateway":key,"accept":"application/json"},
          cache:"no-store",
          signal:AbortSignal.timeout(5000)
        });
        body = await res.json().catch(()=>({}));
        if(!res.ok) throw new Error(`HTTP_${res.status}: ${JSON.stringify(body)}`);
        ok=true;
        break;
      }catch(err){
        lastError=err;
        console.error(JSON.stringify({
          event:"LUNA_GATEWAY_FETCH_RETRY",
          attempt,
          error:String(err)
        }));
        await new Promise(r=>setTimeout(r,Math.min(5000,250*2**(attempt-1))));
      }
    }

    if(!ok){
      console.error(JSON.stringify({
        event:"LUNA_GATEWAY_FETCH_DEGRADED",
        error:String(lastError)
      }));
      await new Promise(r=>setTimeout(r,Math.max(1000,pollMs*4)));
      continue;
    }

    const quotes = Array.isArray(body?.quotes) ? body.quotes as any[] : [];
    if(quotes.length===0){
      console.error(JSON.stringify({
        event:"LUNA_GATEWAY_EMPTY_QUOTES",
        target:Number(body?.target ?? 0),
        collector_started:Boolean(body?.collector_started),
        collector_error:body?.collector_error ?? null
      }));
    }

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
        source:String(raw.source ?? "unknown-market-data"),
        dataQuality:raw.data_quality ? String(raw.data_quality) : undefined
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
