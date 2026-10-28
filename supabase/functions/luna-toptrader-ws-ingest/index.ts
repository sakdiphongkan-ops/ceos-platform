import { createClient } from "npm:@supabase/supabase-js@2";
import {
  emptyWsChunkMetrics,
  normalizeSubscriptionMode,
  summarizeWsChunk,
  classifyTickBookMismatch,
  type SubscriptionMode,
} from "./coverage-diagnostics.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const SOURCE = "TOPTRADER_REALTIME";
const WS_BASE = "wss://ws.toptrader.co.th/market";
const CHUNK_SIZE = 128;
// Give subscribed streams a little more time to emit tick/book event pairs while
// keeping the invocation below the scheduler's 15-second HTTP timeout. This changes
// sampling duration only: provider timestamps, age/skew limits, price parity and sizes
// remain fail-closed.
const LISTEN_MS = 7_000;
const MAX_TICK_AGE_MS = 60_000;
const MAX_BOOK_AGE_MS = 60_000;
const MAX_PAIR_SKEW_MS = 25_000;

const headers = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "https://luna.floot.app",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-luna-scheduler",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers });

function marketClock(d = new Date()) {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Bangkok",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (k: string) => p.find(x => x.type === k)?.value ?? "";
  return { weekday: get("weekday"), hour: Number(get("hour")), minute: Number(get("minute")), second: Number(get("second")) };
}
function tradeDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}
function toDate(value: unknown): Date | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  const d = Number.isFinite(n) ? new Date(n > 1e12 ? n : n * 1000) : new Date(String(value));
  return Number.isFinite(d.getTime()) ? d : null;
}
function numberOf(v: unknown): number | null {
  const n = Number(v);
  return v == null || v === "" || !Number.isFinite(n) ? null : n;
}
function rowsOf(raw: any): any[] {
  const x = raw?.answer ?? raw?.data ?? raw;
  if (Array.isArray(x)) return x;
  if (x && typeof x === "object") {
    if (Array.isArray(x.answer)) return x.answer;
    if (Array.isArray(x.data)) return x.data;
    if (x.symbol || x.type || x.data?.symbol) return [x];
  }
  return [];
}
function bestBook(book: any) {
  const levels = Array.isArray(book?.book) ? book.book : [];
  const bids: Array<{price:number;size:number}> = [];
  const asks: Array<{price:number;size:number}> = [];
  for (const level of levels) {
    const price = numberOf(level?.price), size = numberOf(level?.volume);
    if (price == null || price <= 0 || size == null || size <= 0) continue;
    const side = String(level?.type ?? "").toLowerCase();
    if (side === "buy" || side === "bid") bids.push({price, size:Math.floor(size)});
    if (side === "sell" || side === "ask") asks.push({price, size:Math.floor(size)});
  }
  bids.sort((a,b)=>b.price-a.price);
  asks.sort((a,b)=>a.price-b.price);
  return { bids, asks, bid:bids[0]?.price ?? null, ask:asks[0]?.price ?? null,
    bidSize:bids[0]?.size ?? null, askSize:asks[0]?.size ?? null };
}
async function authorized(req: Request) {
  const token = req.headers.get("x-luna-scheduler") ?? "";
  if (!token) return false;
  const result = await supabase.rpc("luna_validate_scheduler_token", { p_token: token });
  return !result.error && result.data === true;
}
async function inMarketWindow() {
  const p = marketClock();
  if (!(["Mon","Tue","Wed","Thu","Fri"].includes(p.weekday))) return false;
  const m = p.hour * 60 + p.minute + p.second/60;
  if (!((m >= 595 && m < 750) || (m >= 835 && m < 990))) return false;
  const day = await supabase.rpc("luna_is_set_trading_day", { p_trade_date: tradeDate() });
  return !day.error && day.data === true;
}
type TickEvent = { ts:Date; bid:number; ask:number; last:number; isTrade:boolean|null; raw:any };
type BookEvent = { ts:Date; best:ReturnType<typeof bestBook>; raw:any };
async function collectChunk(
  symbols: string[],
  listenMs: number,
  subscriptionMode: SubscriptionMode = "both",
) {
  const latestTicks = new Map<string, TickEvent>();
  const latestBooks = new Map<string, BookEvent>();
  const errors: string[] = [];
  const metrics = emptyWsChunkMetrics();
  let opened = false, subscribeSent = false, frameCount = 0;
  await new Promise<void>((resolve) => {
    let finished = false;
    let socket: WebSocket | null = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      try { socket?.close(); } catch { /* no-op */ }
      resolve();
    };
    const timer = setTimeout(finish, listenMs);
    try {
      const uri = subscriptionMode === "message"
        ? WS_BASE
        : WS_BASE + "?symbols=" + encodeURIComponent(symbols.join(","));
      socket = new WebSocket(uri);
      socket.onopen = () => {
        opened = true;
        // Probe-only modes isolate documented query subscription from explicit subscribe messages.
        // Scheduled ingestion keeps "both" until the diagnostic comparison justifies a change.
        if (subscriptionMode !== "query") {
          try {
            socket?.send(JSON.stringify({ action: "subscribe", symbols }));
            subscribeSent = true;
          } catch (e) {
            if (errors.length < 3) errors.push("SUBSCRIBE_SEND_FAILED:" + String(e).slice(0, 120));
          }
        }
      };
      socket.onmessage = (event) => {
        frameCount++;
        try {
          const parsed = JSON.parse(String(event.data));
          const frames = Array.isArray(parsed) ? parsed : [parsed];
          for (const frame of frames) {
            const type = String(frame?.type ?? "").toLowerCase();
            if (type === "tick") metrics.tickFrames++;
            else if (type === "book") metrics.bookFrames++;
            else metrics.otherTypeFrames++;

            const data = frame?.data ?? frame;
            const symbol = String(data?.symbol ?? frame?.symbol ?? "").toUpperCase();
            if (!symbol) {
              metrics.framesWithoutSymbol++;
              continue;
            }
            if (!symbols.includes(symbol)) {
              metrics.framesOutsideRequestedSymbols++;
              continue;
            }

            const ts = toDate(data?.datetime);
            if (!ts) {
              metrics.missingOrInvalidTimestampFrames++;
              continue;
            }
            if (ts.getTime() > Date.now()+2_000) {
              metrics.futureTimestampFrames++;
              continue;
            }

            if (type === "tick") {
              const bid = numberOf(data?.bid), ask = numberOf(data?.ask), last = numberOf(data?.last);
              if (bid == null || ask == null || last == null || bid<=0 || ask<bid || last<=0) {
                metrics.invalidTickFrames++;
                continue;
              }
              metrics.validTickFrames++;
              const prev = latestTicks.get(symbol);
              if (!prev || ts.getTime() >= prev.ts.getTime()) {
                latestTicks.set(symbol, {ts,bid,ask,last,isTrade:typeof data?.isTrade==="boolean"?data.isTrade:null,raw:data});
              } else {
                metrics.olderTickFramesIgnored++;
              }
            } else if (type === "book") {
              const b = bestBook(data);
              if (b.bid == null || b.ask == null || b.bidSize == null || b.askSize == null || b.bid>b.ask) {
                metrics.invalidBookFrames++;
                continue;
              }
              metrics.validBookFrames++;
              const prev = latestBooks.get(symbol);
              if (!prev || ts.getTime() >= prev.ts.getTime()) latestBooks.set(symbol,{ts,best:b,raw:data});
              else metrics.olderBookFramesIgnored++;
            }
          }
        } catch {
          metrics.parseErrors++;
          if (errors.length < 3) errors.push("NON_JSON_FRAME");
        }
      };
      socket.onerror = () => { if (errors.length < 3) errors.push("WEBSOCKET_ERROR"); clearTimeout(timer); finish(); };
      socket.onclose = () => { if (!finished) { clearTimeout(timer); finish(); } };
    } catch (e) {
      if (errors.length < 3) errors.push("CONNECT_EXCEPTION:"+String(e).slice(0,120));
      clearTimeout(timer); finish();
    }
  });
  return {opened, subscribeSent, frameCount, latestTicks, latestBooks, errors, metrics};
}
async function sha256(value:string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map(b=>b.toString(16).padStart(2,"0")).join("");
}
async function runProbeOnly(input: unknown[], requestedMode: unknown = "both") {
  const symbols = [...new Set(input.map(x=>String(x).trim().toUpperCase()).filter(x=>/^[A-Z0-9._&-]{1,20}$/.test(x)))].slice(0,10);
  if(!symbols.length) throw new Error("EMPTY_SYMBOL_LIST");
  const subscriptionMode = normalizeSubscriptionMode(requestedMode);
  const c = await collectChunk(symbols, 3_000, subscriptionMode);
  return {
    ok:true,status:c.opened?"PROBE_CONNECTED":"PROBE_CONNECTION_FAILED",
    no_database_writes:true,no_orders_created:true,live_execution_allowed:false,source:"TOPTRADER_PUBLIC_WEBSOCKET",
    requested_symbols:symbols,subscription_mode:subscriptionMode,
    query_subscription_used:subscriptionMode!=="message",
    opened:c.opened,explicit_subscribe_sent:c.subscribeSent,frame_messages:c.frameCount,
    frame_metrics:c.metrics,
    tick_symbols:[...c.latestTicks.keys()],book_symbols:[...c.latestBooks.keys()],errors:c.errors,
    note:"Diagnostic only. No-event results do not prove a symbol is unsupported and never authorize execution."
  };
}

Deno.serve(async (req: Request) => {
  if(req.method==="OPTIONS") return json({ok:true});
  if(req.method!=="POST") return json({ok:false,error:"METHOD_NOT_ALLOWED"},405);
  if(!(await authorized(req))) return json({ok:false,error:"UNAUTHORIZED_SCHEDULER"},401);
  const body = await req.json().catch(()=>({}));
  try {
    if(body?.probe_only===true) return json(await runProbeOnly(
      Array.isArray(body.symbols)?body.symbols:["PTT","KBANK","AOT","ADVANC"],
      body.subscription_mode
    ));

    if(!(await inMarketWindow())) return json({
      ok:true,status:"OUTSIDE_MARKET_WINDOW",source:"TOPTRADER_PUBLIC_WEBSOCKET",
      no_database_writes:true,no_orders_created:true,generated_at:new Date().toISOString()
    });
    const maintenance = await supabase.rpc("luna_ensure_intraday_session_open",{p_trade_date:tradeDate()});
    if(maintenance.error) return json({ok:false,status:"SESSION_MAINTENANCE_FAILED",error:maintenance.error.message},503);
    if(!maintenance.data?.session_id) return json({ok:true,status:"NO_OPEN_SESSION",no_database_writes:true,no_orders_created:true});

    const uni = await supabase.from("luna_universe").select("symbol").eq("is_active",true).order("symbol").limit(1000);
    if(uni.error) return json({ok:false,status:"UNIVERSE_QUERY_FAILED",error:uni.error.message},503);
    const symbols = [...new Set((uni.data??[]).map((r:any)=>String(r.symbol??"").trim().toUpperCase()).filter((s:string)=>/^[A-Z0-9._&-]{1,20}$/.test(s)))];
    if(!symbols.length) return json({ok:false,status:"EMPTY_ACTIVE_UNIVERSE"},503);

    const chunks:string[][]=[];
    for(let i=0;i<symbols.length;i+=CHUNK_SIZE) chunks.push(symbols.slice(i,i+CHUNK_SIZE));
    const collected = await Promise.all(chunks.map(chunk=>collectChunk(chunk,LISTEN_MS,"both")));
    const chunkDiagnostics = collected.map((c,index)=>summarizeWsChunk({
      chunkIndex:index+1,
      requestedSymbols:chunks[index],
      subscriptionMode:"both",
      opened:c.opened,
      explicitSubscribeSent:c.subscribeSent,
      frameMessages:c.frameCount,
      tickSymbols:c.latestTicks.size,
      bookSymbols:c.latestBooks.size,
      metrics:c.metrics,
      errors:c.errors,
    }));
    const tickMap = new Map<string,TickEvent>(), bookMap = new Map<string,BookEvent>();
    const errors:string[]=[];
    let frames=0, opened=0, subscribed=0;
    for(const c of collected){
      if(c.opened) opened++;
      if(c.subscribeSent) subscribed++;
      frames+=c.frameCount;
      errors.push(...c.errors);
      for(const [s,t] of c.latestTicks){const p=tickMap.get(s);if(!p||t.ts>p.ts)tickMap.set(s,t);}
      for(const [s,b] of c.latestBooks){const p=bookMap.get(s);if(!p||b.ts>p.ts)bookMap.set(s,b);}
    }
    const now=Date.now();
    const valid:any[]=[];
    let stale=0, mismatch=0, pairMissing=0;
    const mismatchReasonCounts: Record<string, number> = {};
    const mismatchDiagnostics: Array<{
      symbol:string;
      reasons:string[];
      tick_age_ms:number;
      book_age_ms:number;
      event_pair_skew_ms:number;
      bid_diff_abs:number|null;
      ask_diff_abs:number|null;
    }> = [];
    for(const symbol of symbols){
      const t=tickMap.get(symbol), b=bookMap.get(symbol);
      if(!t||!b){pairMissing++;continue;}
      const tickAge=now-t.ts.getTime(), bookAge=now-b.ts.getTime(), skew=Math.abs(t.ts.getTime()-b.ts.getTime());
      if(tickAge < -2_000 || tickAge > MAX_TICK_AGE_MS || bookAge < -2_000 || bookAge > MAX_BOOK_AGE_MS || skew > MAX_PAIR_SKEW_MS){stale++;continue;}
      const mismatchClass = classifyTickBookMismatch({
        tickBid:t.bid,
        tickAsk:t.ask,
        bookBid:b.best.bid,
        bookAsk:b.best.ask,
        bidSize:b.best.bidSize,
        askSize:b.best.askSize,
        tolerance:0.000001,
      });
      if(mismatchClass){
        mismatch++;
        for(const reason of mismatchClass.reasons){
          mismatchReasonCounts[reason]=(mismatchReasonCounts[reason]??0)+1;
        }
        if(mismatchDiagnostics.length<20){
          mismatchDiagnostics.push({
            symbol,
            reasons:mismatchClass.reasons,
            tick_age_ms:Math.round(tickAge),
            book_age_ms:Math.round(bookAge),
            event_pair_skew_ms:Math.round(skew),
            bid_diff_abs:mismatchClass.bidDiffAbs===null?null:Number(mismatchClass.bidDiffAbs.toPrecision(8)),
            ask_diff_abs:mismatchClass.askDiffAbs===null?null:Number(mismatchClass.askDiffAbs.toPrecision(8)),
          });
        }
        continue;
      }
      const snapshotTs=Math.min(t.ts.getTime(),b.ts.getTime());
      valid.push({
        symbol,ts:new Date(snapshotTs).toISOString(),bid:t.bid,ask:t.ask,last:t.last,
        bid_size:b.best.bidSize,ask_size:b.best.askSize,
        raw:{
          provider:"TOPTRADER_PUBLIC_WEBSOCKET",
          tick_event_ts:t.ts.toISOString(),
          trade_datetime:t.isTrade===true?t.ts.toISOString():null,
          quote_datetime:t.isTrade===false?t.ts.toISOString():null,
          book_event_ts:b.ts.toISOString(),
          tick_age_ms:Math.round(tickAge),book_age_ms:Math.round(bookAge),
          event_pair_skew_ms:Math.round(skew),tick_is_trade:t.isTrade,
          top_bids:b.best.bids.slice(0,2),top_asks:b.best.asks.slice(0,2)
        }
      });
    }
    const accepted:any[]=[], rejected:any[]=[];
    for(let i=0;i<valid.length;i+=100){
      const rows=valid.slice(i,i+100);
      const feedTs=new Date(Math.min(...rows.map(r=>Date.parse(r.ts)))).toISOString();
      const payloadHash=await sha256(JSON.stringify(rows));
      const ingest=await supabase.rpc("luna_ingest_verified_market_batch",{
        p_source:SOURCE,p_feed_ts:feedTs,p_payload_hash:payloadHash,p_book_complete:true,p_rows:rows
      });
      if(ingest.error){rejected.push({count:rows.length,reason:"RPC_ERROR:"+ingest.error.message.slice(0,150)});}
      else if(ingest.data?.accepted===true){accepted.push({count:rows.length,batch_id:ingest.data.batch_id,idempotent:ingest.data.idempotent===true});}
      else rejected.push({count:rows.length,reason:ingest.data?.reject_reason??"UNKNOWN_REJECTION"});
    }
    return json({
      ok:accepted.length>0,
      status:accepted.length>0?"INGESTED_VERIFIED_TOPTRADER_WS":(valid.length===0?"NO_FRESH_MATCHED_WS_BOOK":"INGEST_REJECTED"),
      source:SOURCE,mode:"paper_only",live_orders_created:false,paper_orders_created:false,
      symbols_requested:symbols.length,listen_window_ms:LISTEN_MS,websocket_connections:chunks.length,websocket_connections_opened:opened,
      websocket_connections_subscribe_sent:subscribed,
      frames_received:frames,tick_symbols:tickMap.size,book_symbols:bookMap.size,
      valid_two_sided_matches:valid.length,missing_tick_or_book:pairMissing,stale_pairs:stale,mismatch_pairs:mismatch,
      mismatch_reason_counts:mismatchReasonCounts,
      mismatch_diagnostics:mismatchDiagnostics,
      mismatch_diagnostics_truncated:mismatch>mismatchDiagnostics.length,
      chunk_diagnostics:chunkDiagnostics,
      accepted_batches:accepted,rejected_batches:rejected,errors:errors.slice(0,8),generated_at:new Date().toISOString()
    });
  } catch(e) {
    return json({ok:false,status:"WS_INGEST_FAILED",no_orders_created:true,error:e instanceof Error?e.message:String(e),generated_at:new Date().toISOString()},500);
  }
});