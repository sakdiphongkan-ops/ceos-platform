import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const cors = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "https://luna.floot.app",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-luna-scheduler",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: cors });

const SOURCE = "TOPTRADER_REALTIME";
const MAX_QUOTE_AGE_MS = 50_000;
const MAX_BOOK_AGE_MS = 30_000;
// TopTrader documents book.datetime as market-observation time; generatedAt is only API response creation time. Missing market timestamps fail closed.
const API = "https://api.toptrader.co.th/v1/market";

function localParts(d = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Bangkok",
    weekday: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(d);
  const get = (name: string) => parts.find(p => p.type === name)?.value ?? "";
  return { weekday: get("weekday"), hour: Number(get("hour")), minute: Number(get("minute")), second: Number(get("second")) };
}
async function inMarketWindow() {
  const p = localParts();
  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(p.weekday);
  const m = p.hour * 60 + p.minute + p.second / 60;
  const intradayWindow = weekday && ((m >= 600 && m < 750) || (m >= 840 && m < 990));
  if (!intradayWindow) return false;
  const calendar = await supabase.rpc("luna_is_set_trading_day", { p_trade_date: tradeDate() });
  return !calendar.error && calendar.data === true;
}
function tradeDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}
function num(v: unknown): number | null {
  const n = Number(v);
  return v == null || v === "" || !Number.isFinite(n) ? null : n;
}
function toDate(v: unknown): Date | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  const d = Number.isFinite(n) && n > 1_000_000_000
    ? new Date(n * 1000)
    : new Date(String(v));
  return Number.isFinite(d.getTime()) ? d : null;
}
function rowsOf(raw: any): any[] {
  const x = raw?.answer ?? raw?.data ?? raw;
  if (Array.isArray(x)) return x;
  if (x && typeof x === "object") {
    if (Array.isArray(x.answer)) return x.answer;
    if (Array.isArray(x.data)) return x.data;
    if (x.symbol || x.book || x.bid != null || x.last != null) return [x];
  }
  return [];
}
async function getJson(url: string) {
  // TopTrader intermittently returns HTTP 502/503 for otherwise valid batches.
  // Retry transient HTTP responses once; never relax quote/book timestamps or matching checks.
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, {
      headers: { "accept": "application/json", "user-agent": "LUNA-paper-market-data/1.0" },
      signal: AbortSignal.timeout(8_000),
    });
    const body = await res.text();
    if (!res.ok) {
      if (attempt === 0 && [429, 502, 503, 504].includes(res.status)) {
        await new Promise((resolve) => setTimeout(resolve, 180));
        continue;
      }
      throw new Error("TOPTRADER_HTTP_" + res.status);
    }
    let parsed: any;
    try { parsed = JSON.parse(body); } catch { throw new Error("TOPTRADER_INVALID_JSON"); }
    if (parsed?.status && String(parsed.status).toLowerCase() !== "ok") throw new Error("TOPTRADER_STATUS_" + String(parsed.status));
    return parsed;
  }
  throw new Error("TOPTRADER_TRANSIENT_RETRY_EXHAUSTED");
}
function bestBook(record: any) {
  const levels = Array.isArray(record?.book) ? record.book : [];
  let bid: number | null = null, ask: number | null = null;
  let bidSize: number | null = null, askSize: number | null = null;
  const bids: any[] = [], asks: any[] = [];
  for (const level of levels) {
    const price = num(level?.price), size = num(level?.volume);
    if (price == null || price <= 0) continue;
    const side = String(level?.type ?? "").toLowerCase();
    if (side === "buy" || side === "bid") {
      bids.push({ price, size: size == null ? null : Math.floor(size) });
      if (bid == null || price > bid) { bid = price; bidSize = size == null ? null : Math.floor(size); }
    } else if (side === "sell" || side === "ask") {
      asks.push({ price, size: size == null ? null : Math.floor(size) });
      if (ask == null || price < ask) { ask = price; askSize = size == null ? null : Math.floor(size); }
    }
  }
  bids.sort((a,b) => b.price - a.price);
  asks.sort((a,b) => a.price - b.price);
  return { bid, ask, bidSize, askSize, topBids: bids.slice(0, 2), topAsks: asks.slice(0, 2) };
}
async function getOneSymbol(symbol: string) {
  const [tickRaw, bookRaw] = await Promise.all([
    getJson(API + "/tick?symbol=" + encodeURIComponent(symbol)),
    getJson(API + "/book?symbol=" + encodeURIComponent(symbol)),
  ]);
  const tick = rowsOf(tickRaw).find(r => String(r?.symbol ?? "").toUpperCase() === symbol)
    ?? rowsOf(tickRaw)[0];
  const book = rowsOf(bookRaw).find(r => String(r?.symbol ?? "").toUpperCase() === symbol)
    ?? rowsOf(bookRaw)[0];
  if (!tick || !book) throw new Error("TOPTRADER_EMPTY_QUOTE_OR_BOOK");
  const ts = toDate(tick.datetime);
  const bookObservation = toDate(book.datetime);
  const apiGeneratedAt = toDate(book.generatedAt);
  const b = bestBook(book);
  const bid = num(tick.bid), ask = num(tick.ask), last = num(tick.last);
  const now = Date.now();
  const quoteAgeMs = ts ? now - ts.getTime() : Number.POSITIVE_INFINITY;
  const bookAgeMs = bookObservation ? now - bookObservation.getTime() : Number.POSITIVE_INFINITY;
  const matches = bid != null && ask != null && b.bid != null && b.ask != null
    && Math.abs(bid - b.bid) < 0.000001 && Math.abs(ask - b.ask) < 0.000001;
  const valid = ts != null && bookObservation != null
    && quoteAgeMs >= -30_000
    && bookAgeMs >= -30_000 && bookAgeMs <= MAX_BOOK_AGE_MS
    && bid != null && ask != null && last != null
    && bid > 0 && ask > 0 && last > 0 && bid <= ask
    && b.bid != null && b.ask != null && b.bid <= b.ask && matches
    && b.bidSize != null && b.askSize != null && b.bidSize > 0 && b.askSize > 0;
  return {
    symbol, valid, quoteAgeMs: Number.isFinite(quoteAgeMs) ? Math.round(quoteAgeMs) : null,
    bookAgeMs: Number.isFinite(bookAgeMs) ? Math.round(bookAgeMs) : null,
    ts, bookObservation, apiGeneratedAt, bid, ask, last, bidSize: b.bidSize, askSize: b.askSize,
    topBids: b.topBids, topAsks: b.topAsks, matches,
    tickRaw: { datetime: tick.datetime ?? null, isTrade: tick.isTrade ?? null },
  };
}
async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}
async function authorized(req: Request) {
  const token = req.headers.get("x-luna-scheduler") ?? "";
  if (!token) return false;
  const result = await supabase.rpc("luna_validate_scheduler_token", { p_token: token });
  return !result.error && result.data === true;
}
async function probe(symbol = "PTT") {
  const s = symbol.toUpperCase();
  const x = await getOneSymbol(s);
  const marketWindowOpen = await inMarketWindow();
  return {
    ok: true, status: "PROBE_ONLY", no_database_writes: true, source: SOURCE,
    symbol: s, market_window_open: marketWindowOpen,
    tick_observation_timestamp: x.ts?.toISOString() ?? null,
    last_trade_timestamp: x.tickRaw.isTrade === true ? (x.ts?.toISOString() ?? null) : null,
    market_snapshot_timestamp: x.bookObservation?.toISOString() ?? null,
    api_snapshot_generated_at: x.apiGeneratedAt?.toISOString() ?? null,
    tick_observation_age_ms: x.quoteAgeMs, last_trade_age_ms: x.quoteAgeMs, book_age_ms: x.bookAgeMs,
    tick_observation_fresh: x.quoteAgeMs != null && x.quoteAgeMs >= -30_000 && x.quoteAgeMs <= MAX_QUOTE_AGE_MS,
    last_trade_fresh: x.tickRaw.isTrade === true && x.quoteAgeMs != null && x.quoteAgeMs >= -30_000 && x.quoteAgeMs <= MAX_QUOTE_AGE_MS,
    book_fresh: x.bookObservation != null && x.bookAgeMs >= -30_000 && x.bookAgeMs <= MAX_BOOK_AGE_MS,
    quote_bid_ask_match_depth: x.matches, bid_ask_present: x.bid != null && x.ask != null,
    has_two_sided_depth: x.bidSize != null && x.askSize != null && x.bidSize > 0 && x.askSize > 0,
    fresh_book_now: x.bookObservation != null && x.bookAgeMs >= -30_000 && x.bookAgeMs <= MAX_BOOK_AGE_MS && x.matches && x.bidSize != null && x.askSize != null && x.bidSize > 0 && x.askSize > 0,
    execution_snapshot_valid: x.valid,
    would_be_executable_during_market_window: x.valid && marketWindowOpen,
    note: "Probe checks actual provider data only; it never inserts ticks, creates orders, or relaxes the gate.",
  };
}
async function probeBatch(input: string[]) {
  const symbols = [...new Set(input.map(s => String(s).trim().toUpperCase()).filter(Boolean))].slice(0, 50);
  if (!symbols.length) throw new Error("PROBE_EMPTY_SYMBOL_LIST");
  const [tickRaw, bookRaw] = await Promise.all([
    getJson(API + "/tick?symbol=" + encodeURIComponent(symbols.join(","))),
    getJson(API + "/book?symbol=" + encodeURIComponent(symbols.join(","))),
  ]);
  const tickMap = new Map<string, any>();
  const bookMap = new Map<string, any>();
  for (const q of rowsOf(tickRaw)) if (q?.symbol) tickMap.set(String(q.symbol).toUpperCase(), q);
  for (const b of rowsOf(bookRaw)) if (b?.symbol) bookMap.set(String(b.symbol).toUpperCase(), b);
  let freshBooks = 0, matchingBooks = 0, freshTickObservations = 0, freshLastTrades = 0, twoSidedDepth = 0;
  const tickSymbols: string[] = [], bookSymbols: string[] = [], bookMatchedSymbols: string[] = [];
  const now = Date.now();
  for (const symbol of symbols) {
    const q = tickMap.get(symbol), book = bookMap.get(symbol);
    if (q) tickSymbols.push(symbol);
    if (book) bookSymbols.push(symbol);
    if (!q || !book) continue;
    const qts = toDate(q.datetime);
    const bts = toDate(book.datetime);
    const qAge = qts ? now-qts.getTime() : Number.POSITIVE_INFINITY;
    const bAge = bts ? now-bts.getTime() : Number.POSITIVE_INFINITY;
    const depth = bestBook(book);
    const bid = num(q.bid), ask = num(q.ask);
    const match = bid != null && ask != null && depth.bid != null && depth.ask != null
      && Math.abs(bid-depth.bid)<0.000001 && Math.abs(ask-depth.ask)<0.000001
      && bid>0 && ask>=bid;
    if (match) { matchingBooks++; bookMatchedSymbols.push(symbol); }
    if (qts != null && qAge >= -30_000 && bts != null && bAge >= -30_000 && bAge <= MAX_BOOK_AGE_MS && match) freshBooks++;
    if (qts != null && qAge >= -30_000 && qAge <= MAX_QUOTE_AGE_MS) freshTickObservations++;
    if (q?.isTrade === true && qts != null && qAge >= -30_000 && qAge <= MAX_QUOTE_AGE_MS) freshLastTrades++;
    if (depth.bidSize!=null && depth.askSize!=null && depth.bidSize>0 && depth.askSize>0) twoSidedDepth++;
  }
  const marketWindowOpen = await inMarketWindow();
  return {
    ok: true, status: "PROBE_ONLY", no_database_writes: true, source: SOURCE,
    market_window_open: marketWindowOpen, requested_symbols: symbols.length,
    tick_symbols_returned: tickSymbols.length, book_symbols_returned: bookSymbols.length,
    bid_ask_matches_best_depth: matchingBooks, fresh_matching_books: freshBooks,
    fresh_tick_observations: freshTickObservations, fresh_last_trade_quotes: freshLastTrades, two_sided_depth_symbols: twoSidedDepth,
    matching_symbols: bookMatchedSymbols.slice(0, 20),
    missing_tick_symbols: symbols.filter(s=>!tickMap.has(s)).slice(0, 20),
    missing_book_symbols: symbols.filter(s=>!bookMap.has(s)).slice(0, 20),
    note: "Batch probe checks real provider responses; it never inserts ticks, creates orders, or relaxes the gate."
  };
}
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  try {
    if (!(await authorized(req))) return json({ ok: false, error: "UNAUTHORIZED_SCHEDULER" }, 401);
    const body = await req.json().catch(() => ({}));
    if (body?.probe === true) {
      try {
        const result = Array.isArray(body.symbols)
          ? await probeBatch(body.symbols.map((s: unknown) => String(s)))
          : await probe(String(body.symbol ?? "PTT"));
        return json(result);
      } catch (e) {
        return json({ ok: false, status: "PROBE_FAILED", no_database_writes: true,
          error: e instanceof Error ? e.message : String(e), generated_at: new Date().toISOString() }, 502);
      }
    }
    if (!(await inMarketWindow())) return json({
      ok: true, status: "OUTSIDE_MARKET_WINDOW", no_orders_created: true,
      no_ticks_ingested: true, generated_at: new Date().toISOString(),
    });
    const priorityOnly = body?.priority_only === true;
    // The full-universe job is staggered at minute 1, 6, 11, ...; skip targeted
    // polling during that minute so the two REST workloads never intentionally overlap.
    if (priorityOnly && localParts().minute % 5 === 1) return json({
      ok: true, status: "PRIORITY_INGEST_SKIPPED_FOR_FULL_SWEEP",
      no_database_writes: true, paper_only: true, generated_at: new Date().toISOString(),
    });
    const maintenance = await supabase.rpc("luna_ensure_intraday_session_open", { p_trade_date: tradeDate() });
    if (maintenance.error) return json({ ok: false, error: "SESSION_MAINTENANCE_FAILED" }, 500);
    if (!maintenance.data?.session_id) return json({
      ok: true, status: "NO_OPEN_SESSION", no_orders_created: true, maintenance: maintenance.data,
    });

    const uni = await supabase.from("luna_universe").select("symbol").eq("is_active", true).order("symbol");
    if (uni.error) throw new Error("UNIVERSE_QUERY_FAILED");
    const symbols = [...new Set((uni.data ?? []).map((x: any) => String(x.symbol ?? "").trim().toUpperCase()).filter(Boolean))];
    if (!symbols.length) return json({ ok: false, error: "EMPTY_ACTIVE_UNIVERSE" }, 503);

    const priorityQueryErrors: string[] = [];
    const queuedResult = await supabase.from("luna_paper_live_orders")
      .select("symbol,fill_bar_end")
      .eq("experiment_code", "LUNA-PAPER-LIVE-15M-VERIFIED")
      .eq("session_id", maintenance.data.session_id)
      .eq("status", "QUEUED")
      .gt("fill_bar_end", new Date().toISOString())
      .order("fill_bar_end", { ascending: true })
      .limit(15);
    if (queuedResult.error) priorityQueryErrors.push("queued_orders:" + queuedResult.error.message);

    const candidateResult = await supabase.from("luna_shadow_15m_decisions")
      .select("symbol,bar_end,candidate_action,momentum_1,feed_verified,verified_book,execution_blocked")
      .eq("session_id", maintenance.data.session_id)
      .eq("strategy_version", "luna-th1h-v1.4.0-15m-riskgated")
      .in("candidate_action", ["BUY_CANDIDATE", "SELL_CANDIDATE"])
      .eq("feed_verified", true)
      .eq("verified_book", true)
      .eq("execution_blocked", false)
      .order("bar_end", { ascending: false })
      .limit(100);
    if (candidateResult.error) priorityQueryErrors.push("verified_candidates:" + candidateResult.error.message);

    const decisionRows = candidateResult.data ?? [];
    const latestCandidateBar = decisionRows[0]?.bar_end ?? null;
    const latestCandidates = latestCandidateBar
      ? decisionRows.filter((r: any) => r.bar_end === latestCandidateBar)
      : [];
    const ranked = (rows: any[]) => rows.sort((a: any, b: any) =>
      Math.abs(num(b.momentum_1) ?? 0) - Math.abs(num(a.momentum_1) ?? 0) ||
      String(a.symbol).localeCompare(String(b.symbol))
    );
    const signalSymbols = [
      ...ranked(latestCandidates.filter((r: any) => r.candidate_action === "BUY_CANDIDATE")).slice(0, 10),
      ...ranked(latestCandidates.filter((r: any) => r.candidate_action === "SELL_CANDIDATE")).slice(0, 10),
    ].map((r: any) => String(r.symbol ?? "").trim().toUpperCase()).filter(Boolean);
    const activeSet = new Set(symbols);
    const prioritySymbols = [...new Set([
      ...(queuedResult.data ?? []).map((r: any) => String(r.symbol ?? "").trim().toUpperCase()),
      ...signalSymbols,
    ])].filter((symbol) => activeSet.has(symbol)).slice(0, 30);
    const prioritySet = new Set(prioritySymbols);

    // Prioritise active paper orders and verified candidates using smaller, sequential
    // batches so one oversized bulk response cannot starve symbols that need an exact
    // next-bar quote. Remaining symbols still use the existing 50-symbol bulk pass.
    const chunks: string[][] = [];
    for (let i = 0; i < prioritySymbols.length; i += 5) chunks.push(prioritySymbols.slice(i, i + 5));
    const priorityChunkCount = chunks.length;
    const remainingSymbols = priorityOnly ? [] : symbols.filter((symbol) => !prioritySet.has(symbol));
    for (let i = 0; i < remainingSymbols.length; i += 50) chunks.push(remainingSymbols.slice(i, i + 50));
    const validRows: any[] = [];
    const errors: string[] = [];
    let quoteRows = 0, bookRows = 0, mismatchRows = 0, staleRows = 0, staleTickRows = 0;
    for (let i = 0; i < chunks.length;) {
      const groupSize = i < priorityChunkCount ? 1 : 4;
      const group = chunks.slice(i, i + groupSize);
      const resultGroup = await Promise.all(group.map(async (chunk) => {
        const quotes = new Map<string, any>();
        const books = new Map<string, any>();
        try {
          const qs = await getJson(API + "/tick?symbol=" + encodeURIComponent(chunk.join(",")));
          for (const r of rowsOf(qs)) if (r?.symbol) quotes.set(String(r.symbol).toUpperCase(), r);
        } catch (e) { errors.push("tick:" + (e instanceof Error ? e.message : String(e))); }
        try {
          const bs = await getJson(API + "/book?symbol=" + encodeURIComponent(chunk.join(",")));
          for (const r of rowsOf(bs)) if (r?.symbol) books.set(String(r.symbol).toUpperCase(), r);
        } catch (e) { errors.push("book:" + (e instanceof Error ? e.message : String(e))); }
        const rows: any[] = [];
        for (const symbol of chunk) {
          const q = quotes.get(symbol), bk = books.get(symbol);
          if (q) quoteRows++;
          if (bk) bookRows++;
          if (!q || !bk) continue;
          const ts = toDate(q.datetime);
          const bookObservation = toDate(bk.datetime);
          const apiGeneratedAt = toDate(bk.generatedAt);
          const quoteAgeMs = ts ? Date.now() - ts.getTime() : Number.POSITIVE_INFINITY;
          const bookAgeMs = bookObservation ? Date.now() - bookObservation.getTime() : Number.POSITIVE_INFINITY;
          const depth = bestBook(bk);
          const bid = num(q.bid), ask = num(q.ask), last = num(q.last);
          const matches = bid != null && ask != null && depth.bid != null && depth.ask != null
            && Math.abs(bid - depth.bid) < 0.000001 && Math.abs(ask - depth.ask) < 0.000001;
          if (!matches) mismatchRows++;
          if (bookAgeMs > MAX_BOOK_AGE_MS || bookAgeMs < -30_000) staleRows++;
          if (quoteAgeMs > MAX_QUOTE_AGE_MS) staleTickRows++;
          const valid = ts != null && bookObservation != null
            && quoteAgeMs >= -30_000
            && bookAgeMs >= -30_000 && bookAgeMs <= MAX_BOOK_AGE_MS
            && bid != null && ask != null && last != null
            && bid > 0 && ask > 0 && last > 0 && bid <= ask
            && depth.bid != null && depth.ask != null && depth.bid <= depth.ask && matches
            && depth.bidSize != null && depth.askSize != null && depth.bidSize > 0 && depth.askSize > 0;
          if (!valid) continue;
          rows.push({
            symbol, ts: bookObservation.toISOString(), bid, ask, last,
            bid_size: depth.bidSize, ask_size: depth.askSize,
            raw: {
              provider: "TOPTRADER_PUBLIC_REST", tick_observation_datetime: ts.toISOString(),
              quote_datetime: q.isTrade === false ? ts.toISOString() : null,
              trade_datetime: q.isTrade === true ? ts.toISOString() : null,
              tick_observation_age_ms: Math.round(quoteAgeMs),
              book_observation_ts: bookObservation.toISOString(),
              snapshot_ts: bookObservation.toISOString(),
              book_api_generated_at: apiGeneratedAt?.toISOString() ?? null,
              tick_is_trade: q.isTrade ?? null,
              top_bids: depth.topBids, top_asks: depth.topAsks,
            },
          });
        }
        return rows;
      }));
      for (const rows of resultGroup) validRows.push(...rows);
      i += groupSize;
    }

    const unique = new Map<string, any>();
    for (const row of validRows) {
      if (!unique.has(row.symbol) || Date.parse(row.ts) > Date.parse(unique.get(row.symbol).ts)) unique.set(row.symbol, row);
    }
    const accepted: any[] = [];
    const rejected: any[] = [];
    const allRows = [...unique.values()];
    for (let i = 0; i < allRows.length; i += 100) {
      const batch = allRows.slice(i, i + 100);
      if (!batch.length) continue;
      const feedTs = new Date(Math.min(...batch.map(r => Date.parse(r.ts)))).toISOString();
      const payloadHash = await sha256(JSON.stringify(batch));
      const rpc = await supabase.rpc("luna_ingest_verified_market_batch", {
        p_source: SOURCE, p_feed_ts: feedTs, p_payload_hash: payloadHash,
        p_book_complete: true, p_rows: batch,
      });
      if (rpc.error) {
        rejected.push({ count: batch.length, reason: "RPC_ERROR" });
        continue;
      }
      if (rpc.data?.accepted === true) accepted.push({ count: batch.length, idempotent: rpc.data?.idempotent === true });
      else rejected.push({ count: batch.length, reason: rpc.data?.reject_reason ?? "UNKNOWN_REJECTION" });
    }
    return json({
      ok: accepted.length > 0, status: accepted.length > 0 ? "INGESTED_VERIFIED_TOPTRADER" : "NO_FRESH_MATCHED_BOOK",
      source: SOURCE, market_window_open: true, active_symbols: symbols.length,
      symbols_with_quote: quoteRows, symbols_with_book: bookRows, valid_two_sided_matches: allRows.length,
      accepted_batches: accepted, rejected_batches: rejected, mismatch_rows: mismatchRows, stale_rows: staleRows, stale_tick_observation_rows: staleTickRows,
      upstream_error_count: errors.length, upstream_errors: errors.slice(0, 8),
      priority_symbols_requested: prioritySymbols.length,
      priority_query_errors: priorityQueryErrors,
      priority_chunk_size: 5,
      priority_only_mode: priorityOnly,
      universe_sweep_skipped: priorityOnly,
      generated_at: new Date().toISOString(), paper_only: true, live_orders_created: false,
    });
  } catch (e) {
    return json({ ok: false, status: "INGEST_FAILED", error: e instanceof Error ? e.message : String(e), generated_at: new Date().toISOString() }, 500);
  }
});