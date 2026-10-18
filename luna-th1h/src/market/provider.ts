import type {Quote} from "../types.js";
import {mockQuotes} from "./mock.js";
import {setMarketplaceQuotes} from "./set-marketplace.js";

export function boundedPositiveNumber(value:unknown,fallback:number,minimum:number,maximum:number):number{
  if(typeof value==="string" && value.trim()==="") return fallback;
  const parsed=Number(value);
  return Number.isFinite(parsed) && parsed>=minimum && parsed<=maximum ? parsed : fallback;
}

const PUBLIC_FALLBACK_MAX_QUOTE_AGE_MS=Math.max(
  5_000,
  boundedPositiveNumber(process.env.LUNA_PUBLIC_FALLBACK_MAX_QUOTE_AGE_MS,8_000,1,60_000)
);

const NORMALIZATION_REJECTIONS:Record<string,number>={
  missing_fields:0,
  no_price:0,
  unverified_book:0,
  invalid_timestamp:0,
  future_timestamp:0,
  stale:0,
  invalid_price:0,
  invalid_book:0,
};

function nullableFiniteNumber(value:unknown):number|null{
  if(value===null || value===undefined || (typeof value==="string" && value.trim()==="")) return null;
  const n=Number(value);
  return Number.isFinite(n)?n:null;
}

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

export function normalizeGatewayQuote(raw:any, maxQuoteAgeMs:number, requireVerifiedBook:boolean, priceOnlyFallback:boolean, paperMode:boolean, liveTradingArmed:boolean, nowMs:number=Date.now()):Quote|null{
  if(!raw?.symbol || !raw?.ts){
    NORMALIZATION_REJECTIONS.missing_fields++;
    return null;
  }
  const q:Quote = {
    symbol:String(raw.symbol),
    ts:String(raw.ts),
    sourceTs: raw.source_ts ? String(raw.source_ts) : undefined,
    bid:nullableFiniteNumber(raw.bid),
    ask:nullableFiniteNumber(raw.ask),
    last:nullableFiniteNumber(raw.last),
    bidSize:nullableFiniteNumber(raw.bid_size),
    askSize:nullableFiniteNumber(raw.ask_size),
    bidLevels:Array.isArray(raw.bid_levels)?raw.bid_levels.map((x:any)=>({price:Number(x.price),size:Number(x.size)})).filter((x:any)=>Number.isFinite(x.price)&&x.price>0&&Number.isFinite(x.size)&&x.size>0):undefined,
    askLevels:Array.isArray(raw.ask_levels)?raw.ask_levels.map((x:any)=>({price:Number(x.price),size:Number(x.size)})).filter((x:any)=>Number.isFinite(x.price)&&x.price>0&&Number.isFinite(x.size)&&x.size>0):undefined,
    depthComplete:raw.depth_complete===true || raw.depthComplete===true,
    source:String(raw.source ?? "unknown-market-data"),
    dataQuality:raw.data_quality ? String(raw.data_quality) : undefined
  };
  const sourceName=String(q.source??"").toLowerCase();
  const allowPublicPriceOnly =
    priceOnlyFallback
    && paperMode
    && !liveTradingArmed
    && sourceName.includes("tradingview-public-screener");

  // A last price must be strictly positive. For normal feeds, validate any
  // supplied top-of-book fields even when callers disable the verified-book gate.
  // Public price-only fallback intentionally discards book fields below.
  if(q.last!==null && q.last<=0){
    NORMALIZATION_REJECTIONS.invalid_price++;
    return null;
  }
  if(!allowPublicPriceOnly){
    if((q.bid!==null && q.bid<=0) || (q.ask!==null && q.ask<=0)){
      NORMALIZATION_REJECTIONS.invalid_price++;
      return null;
    }
    if(q.bid!==null && q.ask!==null && q.ask<q.bid){
      NORMALIZATION_REJECTIONS.invalid_book++;
      return null;
    }
    if((q.bidSize!==null && q.bidSize<=0) || (q.askSize!==null && q.askSize<=0)){
      NORMALIZATION_REJECTIONS.invalid_book++;
      return null;
    }
  }

  if(q.last===null && q.bid===null && q.ask===null){
    NORMALIZATION_REJECTIONS.no_price++;
    return null;
  }

  if(allowPublicPriceOnly){
    q.bid=null;
    q.ask=null;
    q.bidSize=null;
    q.askSize=null;
    q.bidLevels=undefined;
    q.askLevels=undefined;
  }

  if(requireVerifiedBook){
    const quality=String(q.dataQuality??"").trim().toLowerCase().replace(/[\s-]+/g,"_");
    const verifiedQuality=["verified","verified_book","book_verified","verified_execution_book"].includes(quality);
    const explicitlyUnverified=quality.includes("unverified") || quality==="not_verified" || quality.startsWith("not_");
    const explicitVerification =
      raw?.verified_book===true
      || raw?.verifiedBook===true
      || raw?.verified===true
      || verifiedQuality
      // The authenticated Settrade realtime stream is an approved source;
      // TopTrader/public snapshots require explicit book-parity verification.
      || sourceName.startsWith("settrade-open-api-realtime");
    const verifiedBook =
      typeof q.bid==="number" && Number.isFinite(q.bid) && q.bid>0
      && typeof q.ask==="number" && Number.isFinite(q.ask) && q.ask>0
      && q.ask>=q.bid
      && typeof q.bidSize==="number" && Number.isFinite(q.bidSize) && q.bidSize>0
      && typeof q.askSize==="number" && Number.isFinite(q.askSize) && q.askSize>0
      && explicitVerification
      && !explicitlyUnverified;
    if(!verifiedBook && !allowPublicPriceOnly){
      NORMALIZATION_REJECTIONS.unverified_book++;
      return null;
    }
  }

  const quoteTsMs=Date.parse(q.ts);
  if(!Number.isFinite(quoteTsMs) || quoteTsMs>nowMs+30_000){
    NORMALIZATION_REJECTIONS.invalid_timestamp++;
    return null;
  }
  const freshnessTs=q.sourceTs ?? q.ts;
  const parsedTs=Date.parse(freshnessTs);
  if(!Number.isFinite(parsedTs)){
    NORMALIZATION_REJECTIONS.invalid_timestamp++;
    return null;
  }
  const quoteAgeMs=nowMs-parsedTs;
  if(quoteAgeMs<0){
    NORMALIZATION_REJECTIONS.future_timestamp++;
    return null;
  }
  if(quoteAgeMs>(allowPublicPriceOnly ? PUBLIC_FALLBACK_MAX_QUOTE_AGE_MS : maxQuoteAgeMs)){
    NORMALIZATION_REJECTIONS.stale++;
    return null;
  }
  return q;
}

export function shouldEmitQuote(previous:Map<string,string>,q:Quote):boolean{
  const signature=JSON.stringify([
    q.ts,q.sourceTs??null,q.bid,q.ask,q.last,q.bidSize,q.askSize,
    q.bidLevels??null,q.askLevels??null,q.depthComplete??null,
    q.source,q.dataQuality??null
  ]);
  if(previous.get(q.symbol)===signature) return false;
  previous.set(q.symbol,signature);
  return true;
}

async function fetchGatewaySnapshot(url:string,key:string,timeoutMs:number){
  const res = await fetch(`${url}/quotes`,{
    headers:{"x-luna-gateway":key,"accept":"application/json"},
    cache:"no-store",
    signal:AbortSignal.timeout(timeoutMs)
  });
  const body = await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(`HTTP_${res.status}: ${JSON.stringify(body)}`);
  return body;
}

async function* gatewayWebSocketMessages(streamUrl:string,key:string):AsyncGenerator<any>{
  const WS = globalThis.WebSocket;
  if(typeof WS!=="function") throw new Error("NODE_WEBSOCKET_UNAVAILABLE");

  while(true){
    const ws = new WS(streamUrl);
    const messages:string[]=[];
    let waiter:((value:string)=>void)|null=null;
    let waiterReject:((reason?:unknown)=>void)|null=null;
    let streamError:Error|null=null;
    let opened=false;
    let resolveOpen:(value?:void)=>void=()=>{};
    let rejectOpen:(reason?:unknown)=>void=()=>{};
    const openPromise=new Promise<void>((resolve,reject)=>{
      resolveOpen=resolve;
      rejectOpen=reject;
    });

    const nextMessage=(timeoutMs=5000)=>new Promise<string>((resolve,reject)=>{
      if(messages.length>0){
        resolve(messages.shift()!);
        return;
      }
      if(streamError){
        reject(streamError);
        return;
      }
      let settled=false;
      const timer=setTimeout(()=>{
        if(settled) return;
        settled=true;
        waiter=null;
        waiterReject=null;
        reject(new Error("LUNA_GATEWAY_WEBSOCKET_MESSAGE_TIMEOUT"));
      },timeoutMs);
      const wrappedResolve=(value:string)=>{
        if(settled) return;
        settled=true;
        clearTimeout(timer);
        waiter=null;
        waiterReject=null;
        resolve(value);
      };
      const wrappedReject=(reason?:unknown)=>{
        if(settled) return;
        settled=true;
        clearTimeout(timer);
        waiter=null;
        waiterReject=null;
        reject(reason);
      };
      waiter=wrappedResolve;
      waiterReject=wrappedReject;
    });

    ws.onopen=()=>{
      try{
        ws.send(JSON.stringify({type:"auth",key}));
        opened=true;
        resolveOpen();
      }catch(err){
        streamError=err instanceof Error?err:new Error(String(err));
        rejectOpen(streamError);
        waiterReject?.(streamError);
      }
    };
    ws.onmessage=(event)=>{
      let textData:string;
      if(typeof event.data==="string") textData=event.data;
      else if(event.data instanceof ArrayBuffer) textData=new TextDecoder().decode(event.data);
      else textData=String(event.data);
      if(waiter){
        const resolve=waiter;
        waiter=null;
        waiterReject=null;
        resolve(textData);
      }else{
        messages.push(textData);
      }
    };
    ws.onerror=()=>{
      const err=new Error("LUNA_GATEWAY_WEBSOCKET_ERROR");
      if(!opened) rejectOpen(err);
      streamError=err;
      waiterReject?.(err);
      waiter=null;
      waiterReject=null;
    };
    ws.onclose=()=>{
      if(!streamError) streamError=new Error("LUNA_GATEWAY_WEBSOCKET_CLOSED");
      waiterReject?.(streamError);
      waiter=null;
      waiterReject=null;
    };

    try{
      // Give the gateway enough time for a cold/restarted deployment, but do not
      // let a dead socket stall the trading loop indefinitely.
      await Promise.race([
        openPromise,
        new Promise<never>((_,reject)=>setTimeout(
          ()=>reject(new Error("LUNA_GATEWAY_WEBSOCKET_OPEN_TIMEOUT")),
          5000
        ))
      ]);

      while(true){
        const textData=await nextMessage(5000);
        const payload=JSON.parse(textData);
        if(payload?.type==="snapshot" && Array.isArray(payload.quotes)){
          for(const raw of payload.quotes) yield raw;
        }else if(payload?.type==="quote" && payload.quote){
          yield payload.quote;
        }
      }
    }finally{
      try{ws.close()}catch{}
    }
  }
}

async function* settradeGatewayQuotes():AsyncGenerator<Quote>{
  const url = process.env.LUNA_MARKET_GATEWAY_URL ?? "";
  const key = process.env.LUNA_MARKET_GATEWAY_KEY ?? "";
  const pollMs = boundedPositiveNumber(process.env.LUNA_MARKET_GATEWAY_POLL_MS,100,50,60_000);
  const timeoutMs = boundedPositiveNumber(process.env.LUNA_MARKET_GATEWAY_TIMEOUT_MS,750,200,60_000);
  const streamEnabled=String(process.env.LUNA_MARKET_GATEWAY_STREAM_ENABLED ?? "true").toLowerCase()==="true";
  const configuredStreamUrl=String(process.env.LUNA_MARKET_GATEWAY_STREAM_URL ?? "").trim();
  const streamUrl = configuredStreamUrl || url.replace(/^http:/i,"ws:").replace(/^https:/i,"wss:")+"/quotes/stream";
  if(!url || !key) throw new Error("LUNA_MARKET_GATEWAY_URL and LUNA_MARKET_GATEWAY_KEY are required.");

  const previous = new Map<string,string>();
  let lastGatewayCount=-1;
  let emptyBackoffMs=Math.max(500,Math.min(5000,pollMs));
  const requireVerifiedBook=String(process.env.LUNA_REQUIRE_VERIFIED_BOOK ?? "true").toLowerCase()==="true";
  const paperMode=String(process.env.LUNA_MODE ?? "paper").toLowerCase()==="paper";
  const liveTradingArmed=String(process.env.LIVE_TRADING_ARMED ?? "false").toLowerCase()==="true";
  const priceOnlyFallback=String(
    process.env.LUNA_PRICE_ONLY_FALLBACK
      ?? (paperMode && !liveTradingArmed ? "true" : "false")
  ).toLowerCase()==="true";
  const maxQuoteAgeMs=boundedPositiveNumber(process.env.LUNA_MAX_QUOTE_AGE_MS,2_000,1,60_000);
  let acceptedCount=0;
  let rejectedCount=0;
  let lastDiagnosticsAt=0;
  let nextStreamRetryAt=0;

  while(true){
    if(streamEnabled && Date.now()>=nextStreamRetryAt){
      try{
        console.log(JSON.stringify({
          event:"LUNA_GATEWAY_STREAM_CONNECT",
          stream_url:streamUrl,
          mode:"websocket"
        }));
        for await(const raw of gatewayWebSocketMessages(streamUrl,key)){
          const q=normalizeGatewayQuote(
            raw,
            maxQuoteAgeMs,
            requireVerifiedBook,
            priceOnlyFallback,
            paperMode,
            liveTradingArmed
          );
          if(!q) continue;
          if(!shouldEmitQuote(previous,q)) continue;
          yield q;
        }
      }catch(err){
        console.error(JSON.stringify({
          event:"LUNA_GATEWAY_STREAM_FAILED",
          error:String(err),
          stream_url:streamUrl,
          fallback:"http_poll"
        }));
        nextStreamRetryAt=Date.now()+15000;
      }
    }

    const cycleStarted=Date.now();
    let body:any = {};
    let ok=false;

    try{
      body=await fetchGatewaySnapshot(url,key,timeoutMs);
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
      let q:Quote|null=null;
      try{
        q=normalizeGatewayQuote(
          raw,
          maxQuoteAgeMs,
          requireVerifiedBook,
          priceOnlyFallback,
          paperMode,
          liveTradingArmed
        );
      }catch(error){
        rejectedCount++;
        console.error(JSON.stringify({
          event:"LUNA_GATEWAY_NORMALIZATION_ERROR",
          error:String(error),
          raw_symbol:raw?.symbol??null,
          raw_source:raw?.source??null
        }));
        continue;
      }
      if(!q){
        rejectedCount++;
        continue;
      }
      acceptedCount++;
      if(!shouldEmitQuote(previous,q)) continue;
      yield q;
    }
    if(Date.now()-lastDiagnosticsAt>=10_000){
      lastDiagnosticsAt=Date.now();
      console.log(JSON.stringify({
        event:"LUNA_GATEWAY_NORMALIZATION_DIAGNOSTIC",
        gateway_quote_count:quotes.length,
        accepted_count:acceptedCount,
        rejected_count:rejectedCount,
        sample_source:quotes.find((x:any)=>x?.source)?.source ?? null,
        public_fallback_allowed:priceOnlyFallback && paperMode && !liveTradingArmed,
        public_fallback_max_age_ms:PUBLIC_FALLBACK_MAX_QUOTE_AGE_MS,
        max_quote_age_ms:maxQuoteAgeMs,
        rejection_reasons:{...NORMALIZATION_REJECTIONS}
      }));
    }

    const elapsed=Date.now()-cycleStarted;
    const delay = quotes.length===0
      ? Math.max(emptyBackoffMs, pollMs-elapsed)
      : Math.max(0,pollMs-elapsed);
    await new Promise(r=>setTimeout(r,delay));
    if(quotes.length===0) emptyBackoffMs=Math.min(5000,Math.max(emptyBackoffMs*2,pollMs));
  }
}

