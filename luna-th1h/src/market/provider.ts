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
  const pollMs = Math.max(50,Number(process.env.LUNA_MARKET_GATEWAY_POLL_MS ?? 100));
  const timeoutMs = Math.max(200,Number(process.env.LUNA_MARKET_GATEWAY_TIMEOUT_MS ?? 750));
  if(!url || !key) throw new Error("LUNA_MARKET_GATEWAY_URL and LUNA_MARKET_GATEWAY_KEY are required.");

  const previous = new Map<string,string>();
  let lastGatewayCount=-1;
  let emptyBackoffMs=Math.max(500,Math.min(5000,pollMs));
  const requireVerifiedBook=String(process.env.LUNA_REQUIRE_VERIFIED_BOOK ?? "true").toLowerCase()==="true";
  const priceOnlyFallback=String(process.env.LUNA_PRICE_ONLY_FALLBACK ?? "false").toLowerCase()==="true";
  const paperMode=String(process.env.LUNA_MODE ?? "paper").toLowerCase()==="paper";
  const liveTradingArmed=String(process.env.LIVE_TRADING_ARMED ?? "false").toLowerCase()==="true";
  const publicFallbackMaxQuoteAgeMs=Math.max(1000,Number(process.env.LUNA_PUBLIC_FALLBACK_MAX_QUOTE_AGE_MS ?? 6500));

  while(true){
    const cycleStarted=Date.now();
    let body:any = {};
    let ok=false;

    try{
      const res = await fetch(`${url}/quotes`,{
        headers:{"x-luna-gateway":key,"accept":"application/json"},
        cache:"no-store",
        signal:AbortSignal.timeout(timeoutMs)
      });
      body = await res.json().catch(()=>({}));
      if(!res.ok) throw new Error(`HTTP_${res.status}: ${JSON.stringify(body)}`);
      ok=true;
    }catch(err){
      console.error(JSON.stringify({
        event:"LUNA_GATEWAY_FETCH_FAILED",
        error:String(err),
        timeout_ms:timeoutMs,
        poll_ms:pollMs,
        retry_backoff_ms:emptyBackoffMs
      }));
    }

    if(!ok){
      await new Promise(r=>setTimeout(r,emptyBackoffMs));
      emptyBackoffMs=Math.min(5000,Math.max(emptyBackoffMs*2,pollMs));
      continue;
    }

    const quotes = Array.isArray(body?.quotes) ? body.quotes as any[] : [];
    if(quotes.length!==lastGatewayCount){
      console.log(JSON.stringify({
        event:"LUNA_GATEWAY_QUOTES_STATE",
        count:quotes.length,
        target:Number(body?.target ?? 0),
        selected_provider:body?.selected_provider ?? null,
        collector_started:Boolean(body?.collector_started),
        collector_error:body?.collector_error ?? null
      }));
      lastGatewayCount=quotes.length;
    }
    if(quotes.length===0){
      console.warn(JSON.stringify({
        event:"LUNA_GATEWAY_EMPTY_QUOTES",
        target:Number(body?.target ?? 0),
        collector_started:Boolean(body?.collector_started),
        collector_error:body?.collector_error ?? null,
        retry_backoff_ms:emptyBackoffMs
      }));
    }else{
      emptyBackoffMs=Math.max(500,Math.min(5000,pollMs));
    }

    for(const raw of quotes){
      if(!raw?.symbol || !raw?.ts) continue;
      const q:Quote = {
        symbol:String(raw.symbol),
        ts:String(raw.ts),
        sourceTs: raw.source_ts ? String(raw.source_ts) : undefined,
        bid:Number.isFinite(Number(raw.bid))?Number(raw.bid):null,
        ask:Number.isFinite(Number(raw.ask))?Number(raw.ask):null,
        last:Number.isFinite(Number(raw.last))?Number(raw.last):null,
        bidSize:Number.isFinite(Number(raw.bid_size))?Number(raw.bid_size):null,
        askSize:Number.isFinite(Number(raw.ask_size))?Number(raw.ask_size):null,
        bidLevels:Array.isArray(raw.bid_levels)?raw.bid_levels.map((x:any)=>({price:Number(x.price),size:Number(x.size)})).filter((x:any)=>Number.isFinite(x.price)&&x.price>0&&Number.isFinite(x.size)&&x.size>0):undefined,
        askLevels:Array.isArray(raw.ask_levels)?raw.ask_levels.map((x:any)=>({price:Number(x.price),size:Number(x.size)})).filter((x:any)=>Number.isFinite(x.price)&&x.price>0&&Number.isFinite(x.size)&&x.size>0):undefined,
        source:String(raw.source ?? "unknown-market-data"),
        dataQuality:raw.data_quality ? String(raw.data_quality) : undefined
      };
      if(q.last===null && q.bid===null && q.ask===null) continue;
      const sourceName=String(q.source??"").toLowerCase();
      const allowPublicPriceOnly =
        priceOnlyFallback
        && paperMode
        && !liveTradingArmed
        && sourceName.includes("tradingview-public-screener")
        && q.bid===null
        && q.ask===null;
      if(requireVerifiedBook){
        const verifiedBook =
          Number.isFinite(Number(q.bid))
          && Number.isFinite(Number(q.ask))
          && Number(q.bid)>0
          && Number(q.ask)>=Number(q.bid)
          && Number(q.bidSize)>0
          && Number(q.askSize)>0
          && !String(q.dataQuality??"").toLowerCase().includes("unverified");
        if(!verifiedBook && !allowPublicPriceOnly) continue;
      }
      const freshnessTs=q.sourceTs ?? q.ts;
      const parsedTs=Date.parse(freshnessTs);
      if(!Number.isFinite(parsedTs)) continue;
      const quoteAgeMs=Date.now()-parsedTs;
      if(quoteAgeMs<0) continue;
      const maxQuoteAgeMs=allowPublicPriceOnly
        ? publicFallbackMaxQuoteAgeMs
        : Number(process.env.LUNA_MAX_QUOTE_AGE_MS ?? 3000);
      if(quoteAgeMs>maxQuoteAgeMs) continue;
      const sig=JSON.stringify([q.ts,q.bid,q.ask,q.last,q.bidSize,q.askSize]);
      if(previous.get(q.symbol)===sig) continue;
      previous.set(q.symbol,sig);
      yield q;
    }

    const elapsed=Date.now()-cycleStarted;
    const delay = quotes.length===0
      ? Math.max(emptyBackoffMs, pollMs-elapsed)
      : Math.max(0,pollMs-elapsed);
    await new Promise(r=>setTimeout(r,delay));
    if(quotes.length===0) emptyBackoffMs=Math.min(5000,Math.max(emptyBackoffMs*2,pollMs));
  }
}
