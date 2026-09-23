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

function normalizeGatewayQuote(raw:any, maxQuoteAgeMs:number, requireVerifiedBook:boolean, priceOnlyFallback:boolean, paperMode:boolean, liveTradingArmed:boolean):Quote|null{
  if(!raw?.symbol || !raw?.ts) return null;
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
  if(q.last===null && q.bid===null && q.ask===null) return null;

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
    if(!verifiedBook && !allowPublicPriceOnly) return null;
  }

  const freshnessTs=q.sourceTs ?? q.ts;
  const parsedTs=Date.parse(freshnessTs);
  if(!Number.isFinite(parsedTs)) return null;
  const quoteAgeMs=Date.now()-parsedTs;
  if(quoteAgeMs<0 || quoteAgeMs>(allowPublicPriceOnly ? Math.max(1000,maxQuoteAgeMs) : maxQuoteAgeMs)) return null;
  return q;
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
  const pollMs = Math.max(50,Number(process.env.LUNA_MARKET_GATEWAY_POLL_MS ?? 100));
  const timeoutMs = Math.max(200,Number(process.env.LUNA_MARKET_GATEWAY_TIMEOUT_MS ?? 750));
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
  const maxQuoteAgeMs=Number(process.env.LUNA_MAX_QUOTE_AGE_MS ?? 3000);
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
          const sig=JSON.stringify([q.ts,q.bid,q.ask,q.last,q.bidSize,q.askSize]);
          if(previous.get(q.symbol)===sig) continue;
          previous.set(q.symbol,sig);
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
      const q=normalizeGatewayQuote(
        raw,
        maxQuoteAgeMs,
        requireVerifiedBook,
        priceOnlyFallback,
        paperMode,
        liveTradingArmed
      );
      if(!q) continue;
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

