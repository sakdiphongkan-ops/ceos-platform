import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SECRET_KEYS = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
const SERVICE_KEY = SECRET_KEYS.default ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const STRATEGY = "luna-th1h-v1.4.0-15m-riskgated";
const PAPER_EXPERIMENT = "LUNA-PAPER-LIVE-15M-VERIFIED";
const DB_TIMEOUT_MS = 3500;
const EXTERNAL_TIMEOUT_MS = 2200;
const CACHE_TTL_MS = 5000;
const STALE_MAX_MS = 60000;

const json = (body: unknown, status = 200, extraHeaders: Record<string,string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
      "Access-Control-Allow-Headers": "authorization,apikey,content-type,x-luna-agent",
      "Vary": "Origin",
      "X-LUNA-API": "runtime-v121-toptrader-answer-parser",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders
    }
  });

const fetchWithTimeout = async (input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = DB_TIMEOUT_MS) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("FETCH_BODY_TIMEOUT")), timeoutMs);
  try {
    // Keep the abort timer active until the complete response body has been received.
    // Previously the timer was cleared as soon as headers arrived, so a stalled body
    // could hold the whole dashboard request open beyond the Vercel proxy timeout.
    const response = await fetch(input, { ...init, signal: controller.signal });
    const noBody = [204, 205, 304].includes(response.status);
    const body = noBody ? null : await response.arrayBuffer();
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  } finally {
    clearTimeout(timer);
  }
};

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  global: { fetch: (input, init) => fetchWithTimeout(input, init, DB_TIMEOUT_MS) }
});

type FeedCache = { at: number; body: any };
let cache: FeedCache | null = null;
let inFlight: Promise<any> | null = null;

let indexCache: { expiresAt: number; payload: any } | null = null;
let indexInFlight: Promise<any> | null = null;

let topTraderCache: { expiresAt: number; payload: any } | null = null;
let topTraderInFlight: Promise<any> | null = null;

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const bkkDate = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(new Date());

const marketOpen = () => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Bangkok",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
  const dow = get("weekday");
  const minutes = Number(get("hour")) * 60 + Number(get("minute"));
  return ["Mon","Tue","Wed","Thu","Fri"].includes(dow) &&
    ((minutes >= 600 && minutes < 750) || (minutes >= 840 && minutes < 990));
};

const fetchTopTrader = async () => {
  const now = Date.now();
  if (topTraderCache && topTraderCache.expiresAt > now) return topTraderCache.payload;
  if (topTraderInFlight) return topTraderInFlight;

  topTraderInFlight = (async () => {
    try {
      const r = await fetchWithTimeout(
        "https://api.toptrader.co.th/v1/market/tick?symbol=PTT%2CADVANC%2CAOT%2CCPALL%2CKBANK%2CSCB%2CBDMS%2CGULF%2CDELTA%2CBBL",
        { headers: { accept: "application/json", "user-agent": "LUNA-TH1H/1.0" } },
        EXTERNAL_TIMEOUT_MS
      );
      if (!r.ok) return { ok: false, quotes: [], source: "TOPTRADER_PUBLIC_REST" };
      const raw = await r.json();
      const rows = Array.isArray(raw) ? raw
        : Array.isArray(raw?.answer) ? raw.answer
        : Array.isArray(raw?.data) ? raw.data
        : Array.isArray(raw?.result) ? raw.result
        : Array.isArray(raw?.results) ? raw.results
        : Array.isArray(raw?.items) ? raw.items : [];
      const toIsoTs = (value: unknown) => {
        const n = Number(value);
        if (Number.isFinite(n) && n > 0) {
          const ms = n > 1e12 ? n : n * 1000;
          return new Date(ms).toISOString();
        }
        if (typeof value === "string" && value.includes("T")) return value;
        return null;
      };
      const quotes = rows.map((x: any) => ({
        symbol: String(x?.symbol ?? "").toUpperCase(),
        last: num(x?.last),
        bid: num(x?.bid),
        ask: num(x?.ask),
        bid_size: num(x?.bid_volume ?? x?.bid_size),
        ask_size: num(x?.ask_volume ?? x?.ask_size),
        source_ts: toIsoTs(x?.datetime)
      })).filter((x: any) => x.symbol && Number.isFinite(x.last) && x.last > 0);
      const latest_ts = quotes.map((x: any) => x.source_ts).filter(Boolean).sort().at(-1) ?? null;
      const payload = {
        ok: true,
        source: "TOPTRADER_PUBLIC_REST",
        execution_grade: false,
        display_grade: true,
        public_fallback: true,
        latest_ts,
        quotes,
        quote_count: quotes.length,
        fetched_at: new Date().toISOString()
      };
      topTraderCache = { expiresAt: Date.now() + 3000, payload };
      return payload;
    } catch (e) {
      return {
        ok: false,
        quotes: [],
        source: "TOPTRADER_PUBLIC_REST",
        reason: e instanceof Error ? e.message : String(e)
      };
    } finally {
      topTraderInFlight = null;
    }
  })();

  return topTraderInFlight;
};

const fetchYahooIndex = async () => {
  try {
    const r = await fetchWithTimeout(
      "https://query1.finance.yahoo.com/v8/finance/chart/%5ESET.BK?interval=15m&range=1d",
      { headers: { accept: "application/json", "user-agent": "LUNA-Mission-Control/1.0" } },
      EXTERNAL_TIMEOUT_MS
    );
    if (!r.ok) return { ok: false, source: "YAHOO_FINANCE" };
    const raw = await r.json();
    const chart = raw?.chart?.result?.[0];
    const timestamps = Array.isArray(chart?.timestamp) ? chart.timestamp : [];
    const q = chart?.indicators?.quote?.[0] ?? {};
    const candles = timestamps.map((t: number, i: number) => ({
      ts: new Date(Number(t) * 1000).toISOString(),
      open: num(q?.open?.[i]),
      high: num(q?.high?.[i]),
      low: num(q?.low?.[i]),
      close: num(q?.close?.[i])
    })).filter((x: any) => {
      const o = Number(x.open), h = Number(x.high), l = Number(x.low), c = Number(x.close);
      return x.ts && Number.isFinite(o) && Number.isFinite(h) &&
        Number.isFinite(l) && Number.isFinite(c) &&
        o > 0 && h > 0 && l > 0 && c > 0 &&
        h >= Math.max(o, c) && l <= Math.min(o, c);
    });
    const meta = chart?.meta ?? {};
    const last = num(meta?.regularMarketPrice);
    const prior = num(meta?.previousClose) ?? num(meta?.chartPreviousClose);
    const change = last != null && prior != null ? last - prior : null;
    const percent_change = change != null && prior ? (change / prior) * 100 : null;
    return {
      ok: true,
      source: "YAHOO_FINANCE",
      execution_grade: false,
      display_grade: true,
      delayed_minutes: 15,
      symbol: "SET",
      prior,
      last,
      change,
      percent_change,
      latest_ts: num(meta?.regularMarketTime) !== null ? new Date(Number(meta.regularMarketTime) * 1000).toISOString() : (candles.at(-1)?.ts ?? null),
      quotations: candles.slice(-240),
      candles: candles.slice(-80),
      fetched_at: new Date().toISOString()
    };
  } catch {
    return { ok: false, source: "YAHOO_FINANCE" };
  }
};

const fetchSetIndex = async () => {
  // Display-only market index uses the same Yahoo Finance 15m series as /api/set_overview.
  // Do not fall back to a different provider: if canonical display data is unavailable, fail closed.
  const now = Date.now();
  const ttl = marketOpen() ? 15000 : 60000;
  if (indexCache && indexCache.expiresAt > now) return indexCache.payload;
  if (indexInFlight) return indexInFlight;

  indexInFlight = (async () => {
    const canonical = await fetchYahooIndex();
    if (canonical.ok) indexCache = { expiresAt: Date.now() + ttl, payload: canonical };
    return canonical;
  })().finally(() => {
    indexInFlight = null;
  });

  return indexInFlight;
};

const publicRate = new Map<string, { at: number; count: number }>();
const allowRequest = (req: Request) => {
  const ip = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const now = Date.now();
  const current = publicRate.get(ip);
  if (!current || now - current.at >= 60000) {
    publicRate.set(ip, { at: now, count: 1 });
    return true;
  }
  current.count += 1;
  return current.count <= 60;
};

async function buildFeed() {
  const targetDate = bkkDate();

  const [
    sessionResult,
    controlResult,
    fastResult,
    signalResult,
    snapshotResult,
    paperRuntimeResult,
    paperOrdersResult,
    paperPositionsResult,
    universeResult,
    indexResult,
    topTraderResult,
    decisionResult,
    verifiedBookResult
  ] = await Promise.allSettled([
    supabase
      .from("luna_sessions")
      .select("id,session_date,mode,strategy_version,status,initial_capital,started_at,ended_at")
      .eq("strategy_version", STRATEGY)
      .eq("session_date", targetDate)
      .eq("status", "OPEN")
      .order("started_at", { ascending: false })
      .limit(1),
    supabase
      .from("luna_execution_controls")
      .select("execution_mode,armed,kill_switch,max_daily_loss,max_daily_turnover,max_order_notional,max_orders_per_minute,updated_at,updated_by")
      .eq("id", true)
      .maybeSingle(),
    supabase
      .from("luna_fast_live_state")
      .select("symbol,current_price,last_quote_ts,source,score")
      .eq("strategy_version", STRATEGY)
      .eq("as_of_date", targetDate)
      .not("current_price", "is", null)
      .order("last_quote_ts", { ascending: false })
      .limit(1000),
    supabase
      .from("luna_signals")
      .select("id,session_id,symbol,ts,action,strategy_version,created_at")
      .eq("strategy_version", STRATEGY)
      .order("ts", { ascending: false })
      .limit(40),
    supabase
      .from("luna_portfolio_snapshots")
      .select("id,session_id,ts,cash,market_value,gross_exposure,realized_pnl,unrealized_pnl,fees")
      .order("ts", { ascending: false })
      .limit(24),
    supabase
      .from("luna_paper_live_runtime")
      .select("experiment_code,strategy_version,session_id,initial_capital,cash,reserved_cash,realized_pnl,fees,peak_equity,last_signal_bar_end,last_heartbeat,status,paper_only,fill_model,started_at,updated_at")
      .eq("experiment_code", PAPER_EXPERIMENT)
      .eq("strategy_version", STRATEGY)
      .order("updated_at", { ascending: false })
      .limit(1),
    supabase
      .from("luna_paper_live_orders")
      .select("id,experiment_code,strategy_version,session_id,signal_bar_end,fill_bar_end,symbol,side,order_type,qty_requested,qty_filled,status,reference_price,fill_price,gross_notional,estimated_fee,estimated_slippage,total_cost,reserved_cash,confidence,reason,created_at,filled_at,updated_at,execution_quote_ts", { count: "exact" })
      .eq("experiment_code", PAPER_EXPERIMENT)
      .eq("strategy_version", STRATEGY)
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("luna_paper_live_positions")
      .select("experiment_code,symbol,qty,avg_price,cost_basis,realized_pnl,updated_at")
      .eq("experiment_code", PAPER_EXPERIMENT)
      .order("updated_at", { ascending: false })
      .limit(1000),
    supabase
      .from("luna_universe")
      .select("symbol,market")
      .eq("is_active", true)
      .limit(1000),
    fetchSetIndex(),
    fetchTopTrader(),
    supabase
      .from("luna_shadow_15m_decisions")
      .select("session_id,symbol,bar_end,candidate_action,feed_verified,verified_book,execution_blocked,reason", { count: "exact" })
      .eq("strategy_version", STRATEGY)
      .order("bar_end", { ascending: false })
      .limit(1000),
    supabase
      .from("luna_market_ticks")
      .select("symbol,ts,bid,ask,last,bid_size,ask_size,source,raw")
      .eq("source", "TOPTRADER_REALTIME")
      .gt("ts", new Date(Date.now() - 60000).toISOString())
      .order("ts", { ascending: false })
      .limit(1000)
  ]);

  const session = sessionResult.status === "fulfilled" ? (sessionResult.value.data?.[0] ?? null) : null;
  const control = controlResult.status === "fulfilled" ? (controlResult.value.data ?? null) : null;
  const fast = fastResult.status === "fulfilled" ? (fastResult.value.data ?? []) : [];
  const rawSignals = signalResult.status === "fulfilled" ? (signalResult.value.data ?? []) : [];
  const rawSnapshots = snapshotResult.status === "fulfilled" ? (snapshotResult.value.data ?? []) : [];
  const paperRuntime = paperRuntimeResult.status === "fulfilled" ? (paperRuntimeResult.value.data?.[0] ?? null) : null;
  const rawPaperOrders = paperOrdersResult.status === "fulfilled" ? (paperOrdersResult.value.data ?? []) : [];
  const rawPaperPositions = paperPositionsResult.status === "fulfilled" ? (paperPositionsResult.value.data ?? []) : [];
  const activeUniverse = universeResult.status === "fulfilled" ? (universeResult.value.data ?? []) : [];
  const rawDecisions = decisionResult.status === "fulfilled" ? (decisionResult.value.data ?? []) : [];
  const rawVerifiedBookTicks = verifiedBookResult.status === "fulfilled"
    ? (verifiedBookResult.value.data ?? [])
    : [];
  const verifiedBySymbol = new Map<string, any>();
  for (const tick of rawVerifiedBookTicks) {
    const symbol = String(tick.symbol ?? "").toUpperCase();
    const ts = Date.parse(tick.ts ?? "");
    const bid = num(tick.bid), ask = num(tick.ask), last = num(tick.last);
    const bidSize = num(tick.bid_size), askSize = num(tick.ask_size);
    const ageMs = Number.isFinite(ts) ? Date.now() - ts : Infinity;
    const raw = tick.raw && typeof tick.raw === "object" ? tick.raw : {};
    const topBids = Array.isArray(raw.top_bids) ? raw.top_bids : [];
    const topAsks = Array.isArray(raw.top_asks) ? raw.top_asks : [];
    const parity = topBids.length > 0 && topAsks.length > 0
      && num(topBids[0]?.price) === bid && num(topAsks[0]?.price) === ask;
    if (!symbol || !Number.isFinite(ts) || ageMs < -30000 || ageMs > 60000
      || bid == null || ask == null || last == null || bid <= 0 || ask < bid || last <= 0
      || bidSize == null || askSize == null || bidSize <= 0 || askSize <= 0
      || raw.provider !== "TOPTRADER_PUBLIC_REST" || !parity) continue;
    if (!verifiedBySymbol.has(symbol)) {
      verifiedBySymbol.set(symbol, {
        symbol, current_price: bid, last_quote_ts: tick.ts, source: "TOPTRADER_REALTIME",
        bid, ask, last, bid_size: bidSize, ask_size: askSize,
        score: null, verified: true, raw
      });
    }
  }
  const verifiedBookField = [...verifiedBySymbol.values()];
  const sessionDecisions = session
    ? rawDecisions.filter((d: any) => d.session_id === session.id)
    : [];
  const latestDecisionBar = sessionDecisions[0]?.bar_end ?? null;
  const latestBarDecisions = latestDecisionBar
    ? sessionDecisions.filter((d: any) => d.bar_end === latestDecisionBar)
    : [];
  const blockedDecisionCount = latestBarDecisions.filter((d: any) => d.execution_blocked === true).length;
  const verifiedBookDecisionCount = latestBarDecisions.filter((d: any) =>
    d.feed_verified === true && d.verified_book === true && d.execution_blocked === false
  ).length;
  const paperOrdersForRuntime = paperRuntime?.session_id
    ? rawPaperOrders.filter((o: any) => o.session_id === paperRuntime.session_id)
    : rawPaperOrders;
  const signals = session ? rawSignals.filter((s:any) => s.session_id === session.id) : [];
  const snapshots = session ? rawSnapshots.filter((s:any) => s.session_id === session.id) : [];
  const marketIndex = indexResult.status === "fulfilled" ? indexResult.value : null;
  if (marketIndex?.latest_ts) {
    const indexAgeMs = Math.max(0, Date.now() - Date.parse(marketIndex.latest_ts));
    marketIndex.age_ms = Number.isFinite(indexAgeMs) ? indexAgeMs : null;
    marketIndex.freshness_status = indexAgeMs <= 20 * 60 * 1000
      ? "DELAYED_RECENT"
      : (marketOpen() ? "STALE_DURING_MARKET_WINDOW" : "LAST_BAR_OUTSIDE_MARKET_WINDOW");
    marketIndex.execution_grade = false;
    marketIndex.display_grade = true;
  }
  const retainedDecisionRows = decisionResult.status === "fulfilled"
    ? (decisionResult.value.count ?? rawDecisions.length)
    : null;
  const topTrader = topTraderResult.status === "fulfilled" ? topTraderResult.value : null;

  const fastLatestTs = fast
    .map((x:any) => x.last_quote_ts)
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;
  const fastAgeMs = fastLatestTs ? Math.max(0, Date.now() - Date.parse(fastLatestTs)) : Infinity;
  const fastIsFresh = fast.length > 0 && fastAgeMs <= 60000;

  const fallbackMarketField = fastIsFresh
    ? fast.map((x: any) => ({
        symbol: String(x.symbol).toUpperCase(),
        current_price: Number(x.current_price),
        last_quote_ts: x.last_quote_ts ?? null,
        source: x.source ?? null,
        score: x.score ?? null,
        verified: false
      })).filter((x: any) => Number.isFinite(x.current_price))
    : (topTrader?.quotes ?? []).map((x: any) => ({
        symbol: String(x.symbol).toUpperCase(),
        current_price: Number(x.last),
        last_quote_ts: x.source_ts ?? null,
        source: "TOPTRADER_PUBLIC_REST",
        verified: false
      })).filter((x:any) => Number.isFinite(Number(x.current_price)));
  const verifiedSymbolsSet = new Set(verifiedBookField.map((x: any) => x.symbol));
  const valuationMarketField = [
    ...verifiedBookField,
    ...fallbackMarketField.filter((x: any) => !verifiedSymbolsSet.has(String(x.symbol).toUpperCase()))
  ];

  const marketField = valuationMarketField.slice(0, 24);
  const latestQuoteTs = valuationMarketField.map((x: any) => x.last_quote_ts).filter(Boolean).sort().at(-1) ?? null;
  const latestAge = latestQuoteTs ? Math.max(0, Date.now() - Date.parse(latestQuoteTs)) : null;
  const latestVerifiedQuoteTs = verifiedBookField.map((x: any) => x.last_quote_ts).filter(Boolean).sort().at(-1) ?? null;
  const latestVerifiedBookAgeMs = latestVerifiedQuoteTs ? Math.max(0, Date.now() - Date.parse(latestVerifiedQuoteTs)) : null;
  const activeUniverseMap = new Map(activeUniverse.map((x: any) => [String(x.symbol).toUpperCase(), String(x.market ?? "").toUpperCase()]));
  const liveQuoteRows = valuationMarketField.filter((x: any) => {
    const ts = x.last_quote_ts ? Date.parse(x.last_quote_ts) : NaN;
    return Number.isFinite(Number(x.current_price)) && Number(x.current_price) > 0 && Number.isFinite(ts) && Date.now() - ts >= 0 && Date.now() - ts <= 15 * 60 * 1000;
  });
  const liveQuoteSymbols = new Set(liveQuoteRows.map((x: any) => String(x.symbol).toUpperCase()));
  const activeSet = [...activeUniverseMap.entries()].filter(([, market]) => market === "SET").map(([symbol]) => symbol);
  const activeMai = [...activeUniverseMap.entries()].filter(([, market]) => market === "MAI").map(([symbol]) => symbol);

  const runtimeHeartbeat = paperRuntime?.last_heartbeat ?? paperRuntime?.updated_at ?? null;
  const parsedHeartbeat = runtimeHeartbeat ? Date.parse(runtimeHeartbeat) : NaN;
  const runtimeHeartbeatAgeMs = Number.isFinite(parsedHeartbeat) ? Math.max(0, Date.now() - parsedHeartbeat) : null;
  const paperRuntimeFresh = runtimeHeartbeatAgeMs !== null && runtimeHeartbeatAgeMs <= 90000;
  const paperRuntimeDisplayStatus = paperRuntime
    ? (paperRuntimeFresh ? String(paperRuntime.status ?? "UNKNOWN").toUpperCase() : "STALE_HEARTBEAT")
    : "NO_RUNTIME";

  const paperOrderRows = paperOrdersForRuntime.slice(0, 24).map((o: any) => {
    const dbStatus = String(o.status ?? "UNKNOWN").toUpperCase();
    const timeValue = o.updated_at ?? o.created_at;
    const parsedOrderTime = timeValue ? Date.parse(timeValue) : NaN;
    const orderAgeMs = Number.isFinite(parsedOrderTime) ? Math.max(0, Date.now() - parsedOrderTime) : null;
    const staleQueued = dbStatus === "QUEUED" && (orderAgeMs === null || orderAgeMs > 90000 || !paperRuntimeFresh);
    return {
      ...o,
      qty: Number(o.qty_requested ?? 0),
      filled_qty: Number(o.qty_filled ?? 0),
      avg_fill_price: o.fill_price ?? null,
      database_status: dbStatus,
      status: staleQueued ? "STALE_QUEUED" : dbStatus,
      stale: staleQueued || !paperRuntimeFresh,
      stale_age_ms: orderAgeMs
    };
  });

  const paperFillRows = paperOrdersForRuntime
    .filter((o: any) => Number(o.qty_filled ?? 0) > 0 && o.fill_price != null)
    .slice(0, 24)
    .map((o: any) => ({
      id: o.id,
      order_id: o.id,
      symbol: o.symbol,
      side: o.side,
      ts: o.filled_at ?? o.updated_at ?? o.created_at,
      qty: Number(o.qty_filled ?? 0),
      price: Number(o.fill_price),
      fee: Number(o.estimated_fee ?? 0),
      slippage: Number(o.estimated_slippage ?? 0),
      status: String(o.status ?? "FILLED").toUpperCase(),
      execution_quote_ts: o.execution_quote_ts ?? null,
      fill_model: "NEXT_BAR_BID_ASK"
    }));

  const safeSignals = signals.slice(0, 40).map((s: any) => ({
    id: s.id,
    symbol: s.symbol,
    ts: s.ts,
    action: s.action,
    reason: null
  }));

  const paperPositionRows = rawPaperPositions.map((p: any) => {
    const q = valuationMarketField.find((x: any) => String(x.symbol).toUpperCase() === String(p.symbol).toUpperCase());
    const qty = Number(p.qty ?? 0);
    const quoteTs = q?.last_quote_ts ?? null;
    const quoteAgeMs = quoteTs ? Math.max(0, Date.now() - Date.parse(quoteTs)) : null;
    const quoteTimestampValid = quoteAgeMs !== null && Number.isFinite(quoteAgeMs);
    const quoteFreshForValuation = quoteTimestampValid && quoteAgeMs <= 60000 && q?.verified === true;
    const lastKnownPrice = q && Number.isFinite(Number(q.current_price)) ? Number(q.current_price) : null;
    const currentPrice = quoteFreshForValuation ? lastKnownPrice : null;
    const marketValue = currentPrice !== null ? qty * currentPrice : null;
    const costBasis = p.cost_basis == null ? null : num(p.cost_basis);
    const unrealizedPnl = marketValue !== null && costBasis !== null ? marketValue - costBasis : null;
    return {
      ...p,
      quantity: qty,
      current_price: currentPrice,
      last_known_price: lastKnownPrice,
      last_quote_ts: quoteTs,
      quote_age_ms: quoteAgeMs,
      quote_source: q?.source ?? null,
      valuation_status: currentPrice !== null ? "VERIFIED_TOPTRADER_BID" : (lastKnownPrice !== null ? "UNVERIFIED_OR_STALE_QUOTE" : "NO_VERIFIED_QUOTE"),
      market_value: marketValue,
      unrealized_pnl: unrealizedPnl
    };
  });
  const openPaperPositions = paperPositionRows.filter((p: any) => Number(p.quantity ?? 0) > 0);
  const positionValuesComplete = openPaperPositions.every((p: any) => p.market_value !== null);
  const positionPnlComplete = openPaperPositions.every((p: any) => p.unrealized_pnl !== null);
  const paperMarketValue = positionValuesComplete
    ? openPaperPositions.reduce((sum: number, p: any) => sum + Number(p.market_value ?? 0), 0)
    : null;
  const paperUnrealizedPnl = positionPnlComplete
    ? openPaperPositions.reduce((sum: number, p: any) => sum + Number(p.unrealized_pnl ?? 0), 0)
    : null;
  const paperOrderTotal = paperOrdersResult.status === "fulfilled"
    ? (paperOrdersResult.value.count ?? rawPaperOrders.length)
    : null;
  const latestSnapshot = snapshots[0] ?? null;
  const signalCounts = {
    emitted_count: safeSignals.length,
    candidate_decisions_today: latestBarDecisions.length,
    buy_candidates_today: latestBarDecisions.filter((x:any) => x.candidate_action === "BUY_CANDIDATE" || x.candidate_action === "BUY").length,
    sell_candidates_today: latestBarDecisions.filter((x:any) => x.candidate_action === "SELL_CANDIDATE" || x.candidate_action === "SELL").length,
    blocked_candidates_today: blockedDecisionCount,
    verified_book_candidates_today: verifiedBookDecisionCount,
    retained_decision_rows: retainedDecisionRows,
    latest_bar_end: latestDecisionBar,
    status: blockedDecisionCount > 0 ? "DECISIONS_BLOCKED_UNVERIFIED_FEED" : (latestBarDecisions.length ? "DECISIONS_PRESENT" : (safeSignals.length ? "SIGNALS_PRESENT" : "NO_CANDIDATES"))
  };

  const dbResultsByName: [string, any][] = [
    ["session", sessionResult], ["execution_control", controlResult], ["fast_live_state", fastResult],
    ["signals", signalResult], ["portfolio_snapshots", snapshotResult], ["paper_runtime", paperRuntimeResult],
    ["paper_orders", paperOrdersResult], ["paper_positions", paperPositionsResult], ["universe", universeResult],
    ["shadow_decisions", decisionResult], ["verified_book_ticks", verifiedBookResult]
  ];
  const hasFailure = (r: any) =>
    r.status === "rejected" || (r.status === "fulfilled" && Boolean(r.value?.error));
  const sourceFailures: { message: string; code: string }[] = dbResultsByName
    .filter(([, r]) => hasFailure(r))
    .map(([name, r]) => ({
      message: r.status === "rejected" ? "SOURCE_TIMEOUT_OR_REJECTED" : "SOURCE_QUERY_FAILED",
      code: name
    }));
  if (indexResult.status === "rejected" || (indexResult.status === "fulfilled" && !indexResult.value?.ok))
    sourceFailures.push({ message: "EXTERNAL_SOURCE_UNAVAILABLE", code: "market_index" });
  if (topTraderResult.status === "rejected" || (topTraderResult.status === "fulfilled" && !topTraderResult.value?.ok))
    sourceFailures.push({ message: "EXTERNAL_SOURCE_UNAVAILABLE", code: "toptrader_display" });
  const partial = sourceFailures.length > 0;

  const verifiedExecutionFeed = verifiedBookField.length > 0;
  const verifiedBookCoveragePct = activeUniverseMap.size > 0
    ? Math.round(verifiedBookField.length / activeUniverseMap.size * 10000) / 100
    : 0;
  const feedCoverageReady = verifiedExecutionFeed && verifiedBookCoveragePct >= 80;
  const readinessBlockers: string[] = [];
  if (!session) readinessBlockers.push("NO_OPEN_SESSION_FOR_TRADE_DATE");
  if (!paperRuntime) readinessBlockers.push("NO_PAPER_RUNTIME");
  else if (!paperRuntimeFresh) readinessBlockers.push("STALE_PAPER_RUNTIME_HEARTBEAT");
  if (!verifiedExecutionFeed) readinessBlockers.push("NO_VERIFIED_EXECUTION_GRADE_MARKET_FEED");
  else if (!feedCoverageReady) readinessBlockers.push("VERIFIED_BOOK_COVERAGE_BELOW_80_PERCENT");
  if (!controlResult || controlResult.status !== "fulfilled" || !controlResult.value?.data)
    readinessBlockers.push("EXECUTION_CONTROL_UNAVAILABLE");
  if (control?.kill_switch) readinessBlockers.push("KILL_SWITCH_ENGAGED");

  return {
    ok: true,
    public_safe: true,
    partial_data: partial || readinessBlockers.length > 0,
    generated_at: new Date().toISOString(),
    strategy_version: STRATEGY,
    as_of_date: targetDate,
    system_readiness: {
      status: readinessBlockers.length ? "BLOCKED" : "READY_FOR_PAPER_ONLY",
      paper_only: true,
      real_money_execution_enabled: false,
      current_session_open: Boolean(session),
      runtime_heartbeat_fresh: paperRuntimeFresh,
      market_feed_verified_for_execution: feedCoverageReady,
      stale_queued_orders: paperOrderRows.filter((o: any) => o.status === "STALE_QUEUED").length,
      blockers: readinessBlockers
    },
    market_index: marketIndex,
    universe_coverage: {
      active_universe: activeUniverseMap.size,
      active_set: activeSet.length,
      active_mai: activeMai.length,
      live_snapshot_symbols: liveQuoteSymbols.size,
      live_snapshot_set: activeSet.filter((symbol: string) => liveQuoteSymbols.has(symbol)).length,
      live_snapshot_mai: activeMai.filter((symbol: string) => liveQuoteSymbols.has(symbol)).length,
      verified_book: feedCoverageReady,
      verified_realtime: verifiedExecutionFeed,
      verified_book_symbols: verifiedBookField.length,
      verified_book_coverage_pct: verifiedBookCoveragePct,
      latest_quote_ts: latestQuoteTs,
      source_quality: verifiedBookField.length > 0
        ? "FRESH_TOPTRADER_ORDER_BOOK"
        : (fastIsFresh ? "UNVERIFIED_FAST_SNAPSHOT" : "PUBLIC_FALLBACK_OR_STALE_FAST_STATE")
    },
    sessions: session ? [{
      id: session.id,
      session_date: session.session_date,
      mode: session.mode,
      strategy_version: session.strategy_version,
      status: session.status,
      initial_capital: Number(session.initial_capital ?? 30000),
      started_at: session.started_at ?? null
    }] : [],
    paper_live: {
      experiment_code: PAPER_EXPERIMENT,
      strategy_version: STRATEGY,
      status: paperRuntimeDisplayStatus,
      reported_status: paperRuntime?.status ?? null,
      runtime_fresh: paperRuntimeFresh,
      heartbeat_age_ms: runtimeHeartbeatAgeMs,
      last_heartbeat: runtimeHeartbeat,
      last_signal_bar_end: paperRuntime?.last_signal_bar_end ?? null,
      session_id: paperRuntime?.session_id ?? null,
      initial_capital: paperRuntime ? Number(paperRuntime.initial_capital ?? 30000) : 30000,
      cash: paperRuntime ? Number(paperRuntime.cash ?? 0) : null,
      reserved_cash: paperRuntime ? Number(paperRuntime.reserved_cash ?? 0) : null,
      available_cash: paperRuntime ? Number(paperRuntime.cash ?? 0) - Number(paperRuntime.reserved_cash ?? 0) : null,
      realized_pnl: paperRuntime ? Number(paperRuntime.realized_pnl ?? 0) : null,
      fees: paperRuntime ? Number(paperRuntime.fees ?? 0) : null,
      paper_only: paperRuntime ? Boolean(paperRuntime.paper_only) : true,
      fill_model: paperRuntime?.fill_model ?? "NEXT_BAR_BID_ASK",
      orders_total: paperOrderTotal,
      orders_returned: paperOrderRows.length,
      positions_returned: paperPositionRows.length,
      data_quality: paperRuntimeFresh ? "RECENT" : "STALE"
    },
    positions: paperPositionRows,
    orders: paperOrderRows,
    fills: paperFillRows,
    signals: safeSignals,
    decision_audit: latestBarDecisions.slice(0, 100).map((d: any) => ({
      symbol: d.symbol,
      bar_end: d.bar_end,
      candidate_action: d.candidate_action,
      execution_blocked: Boolean(d.execution_blocked),
      feed_verified: Boolean(d.feed_verified),
      verified_book: Boolean(d.verified_book),
      reason: d.reason ?? null
    })),
    snapshots: snapshots.slice(0, 24),
    ticks: marketField,
    market_field: marketField,
    signal_state: signalCounts,
    counts: {
      audits: 0,
      fills: paperFillRows.length,
      snapshots: snapshots.length,
      ticks: marketField.length,
      signals: safeSignals.length,
      candidate_decisions: latestBarDecisions.length,
      blocked_candidates: blockedDecisionCount,
      retained_decision_rows: retainedDecisionRows,
      orders: paperOrderRows.length,
      positions: paperPositionRows.length,
      paper_live_orders_total: paperOrderTotal ?? 0
    },
    execution_control: control ? {
      execution_mode: control.execution_mode,
      armed: Boolean(control.armed),
      kill_switch: Boolean(control.kill_switch)
    } : null,
    market_feed: {
      status: feedCoverageReady
        ? "VERIFIED_BOOK_COVERAGE_READY"
        : verifiedExecutionFeed
          ? "VERIFIED_BOOK_PARTIAL_COVERAGE"
          : (marketField.length
            ? (latestAge != null && latestAge <= 30000 ? "UNVERIFIED_RECENT" : "STALE_OR_UNKNOWN")
            : "NO_CURRENT_SNAPSHOT"),
      verified_realtime: verifiedExecutionFeed,
      verified_book_coverage_ready: feedCoverageReady,
      verified_book_symbols: verifiedBookField.length,
      verified_book_coverage_pct: verifiedBookCoveragePct,
      public_fallback: !verifiedExecutionFeed && Boolean(topTrader?.ok),
      latest_source: verifiedExecutionFeed ? "TOPTRADER_REALTIME" : (marketField[0]?.source ?? topTrader?.source ?? null),
      latest_age_ms: verifiedExecutionFeed ? latestVerifiedBookAgeMs : latestAge,
      sources: [...new Set(marketField.map((x:any) => x.source).filter(Boolean))]
    },
    portfolio: paperRuntime ? {
      cash: Number(paperRuntime.cash ?? 0),
      reserved_cash: Number(paperRuntime.reserved_cash ?? 0),
      available_cash: Number(paperRuntime.cash ?? 0) - Number(paperRuntime.reserved_cash ?? 0),
      market_value: paperMarketValue,
      gross_exposure: paperMarketValue,
      realized_pnl: Number(paperRuntime.realized_pnl ?? 0),
      unrealized_pnl: paperUnrealizedPnl,
      fees: Number(paperRuntime.fees ?? 0),
      as_of: runtimeHeartbeat,
      data_status: paperRuntimeFresh ? "RUNTIME_RECENT" : "STALE_RUNTIME",
      valuation_status: positionValuesComplete && positionPnlComplete
        ? (verifiedExecutionFeed ? "COMPLETE_VERIFIED_TOPTRADER_BID_MARKS" : "COMPLETE_NO_OPEN_POSITIONS")
        : "PARTIAL_QUOTES_OR_STALE_QUOTES"
    } : null,
    errors: sourceFailures
  };
}

function projectView(view: string, body: any) {
  const common = {
    ok: body?.ok === true,
    public_safe: body?.public_safe ?? true,
    partial_data: Boolean(body?.partial_data),
    generated_at: body?.generated_at ?? null,
    strategy_version: body?.strategy_version ?? STRATEGY,
    as_of_date: body?.as_of_date ?? null,
  };
  if (view === "runtime_status") {
    return {
      ...common,
      view,
      status: body?.paper_live?.status ?? body?.system_readiness?.status ?? "UNKNOWN",
      runtime_status: body?.paper_live ?? null,
      paper_live: body?.paper_live ?? null,
      system_readiness: body?.system_readiness ?? null,
      portfolio: body?.portfolio ?? null,
      market_feed: body?.market_feed ?? null,
      execution_control: body?.execution_control ?? null,
      counts: body?.counts ?? {},
      orders: body?.orders ?? [],
      fills: body?.fills ?? [],
      positions: body?.positions ?? [],
      errors: body?.errors ?? [],
    };
  }
  if (view === "shadow_status") {
    const decisions = Array.isArray(body?.decision_audit) ? body.decision_audit : [];
    return {
      ...common,
      view,
      status: body?.signal_state?.status ?? (decisions.length ? "DECISIONS_PRESENT" : "NO_CANDIDATES"),
      shadow_status: body?.signal_state ?? null,
      signal_state: body?.signal_state ?? null,
      signals: body?.signals ?? [],
      decision_audit: decisions,
      latest_bar_end: decisions[0]?.bar_end ?? null,
      counts: body?.counts ?? {},
      market_feed: body?.market_feed ?? null,
      universe_coverage: body?.universe_coverage ?? null,
    };
  }
  if (view === "latest_control") {
    return {
      ...common,
      view,
      status: body?.system_readiness?.status ?? "UNKNOWN",
      latest_control: body?.execution_control ?? null,
      execution_control: body?.execution_control ?? null,
      system_readiness: body?.system_readiness ?? null,
      blockers: body?.system_readiness?.blockers ?? [],
      market_feed: body?.market_feed ?? null,
      universe_coverage: body?.universe_coverage ?? null,
      paper_live: body?.paper_live ?? null,
    };
  }
  return body;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  let view = "dashboard";
  try {
    const u = new URL(req.url);
    view = u.searchParams.get("view") || "dashboard";
    const supportedViews = ["dashboard", "feed", "runtime_status", "shadow_status", "latest_control"];
    if (!supportedViews.includes(view)) {
      return json({ ok: false, error: { message: "VIEW_NOT_AVAILABLE", view } }, 404);
    }
    if (!allowRequest(req)) return json({ ok: false, error: { message: "PUBLIC_RATE_LIMITED" } }, 429);

    let body: any;
    let cacheStatus = "fresh";
    const now = Date.now();
    if (cache && now - cache.at < CACHE_TTL_MS) {
      body = cache.body;
      cacheStatus = "hit";
    } else if (inFlight) {
      body = await inFlight;
      cacheStatus = "inflight";
    } else {
      inFlight = buildFeed();
      try {
        body = await inFlight;
        cache = { at: Date.now(), body };
      } finally {
        inFlight = null;
      }
    }
    return json(projectView(view, body), 200, { "X-LUNA-Cache": cacheStatus, "X-LUNA-View": view });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    if (cache && Date.now() - cache.at < STALE_MAX_MS) {
      const staleBody = {
        ...cache.body,
        ok: true,
        partial_data: true,
        stale_fallback: true,
        transport_warning: "UPSTREAM_ERROR",
        served_at: new Date().toISOString()
      };
      return json(projectView(view, staleBody), 200, { "X-LUNA-Cache": "stale-fallback", "X-LUNA-View": view });
    }
    return json({ ok: false, error: { message: reason || "MARKET_API_UNAVAILABLE" }, view }, 504);
  }
});
