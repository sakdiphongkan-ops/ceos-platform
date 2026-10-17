import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SECRET_KEYS = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
const SERVICE_KEY = SECRET_KEYS["default"] ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const STRATEGY = "luna-th1h-v1.4.0-15m-riskgated";
const MAX_BATCH = 100;
const RATE_LIMIT = 480;
const headers = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store, no-cache, must-revalidate",
  "Access-Control-Allow-Origin": "https://luna.floot.app",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "authorization,apikey,content-type,x-luna-agent",
  "X-Content-Type-Options": "nosniff",
  "Vary": "Origin",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers });
}
function bangkokDate() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
function safeString(value: unknown, max = 200) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
function numeric(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function positiveOrNull(value: unknown): number | null {
  const n = numeric(value);
  return n !== null && n > 0 ? n : null;
}
function dateValue(value: unknown): Date | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}
function validSymbol(value: unknown): string | null {
  const symbol = safeString(value, 24).toUpperCase();
  return /^[A-Z0-9&._-]{1,24}$/.test(symbol) ? symbol : null;
}
function validUuid(value: unknown): string | null {
  const id = safeString(value, 64);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ? id : null;
}
async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function authorized(req: Request) {
  const token = req.headers.get("x-luna-agent") ?? "";
  if (!token) return false;
  const hash = await sha256(token);
  const { data, error } = await db.from("luna_agent_credentials")
    .select("credential_id")
    .eq("sha256_hash", hash)
    .eq("enabled", true)
    .eq("credential_scope", "general")
    .limit(1);
  return !error && !!data?.length;
}
async function rateAllowed(req: Request) {
  const hash = await sha256(req.headers.get("x-luna-agent") ?? "");
  const rate = await db.rpc("luna_security_rate_limit", {
    p_bucket_key: "worker-observer:" + hash,
    p_limit: RATE_LIMIT,
    p_window_seconds: 60,
  });
  if (rate.error) return { ok: false, status: 503, error: "SECURITY_RATE_LIMIT_UNAVAILABLE" };
  if (rate.data?.allowed === false) return { ok: false, status: 429, error: "SECURITY_RATE_LIMITED" };
  return { ok: true, status: 200, error: "" };
}
async function findCurrentPaperSession() {
  const { data, error } = await db.from("luna_sessions")
    .select("id,session_date,mode,strategy_version,initial_capital,started_at,status,runtime_owner")
    .eq("session_date", bangkokDate())
    .eq("mode", "paper")
    .eq("strategy_version", STRATEGY)
    .eq("status", "OPEN")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error("SESSION_LOOKUP_FAILED:" + error.message);
  return data;
}
async function validateOpenPaperSessions(ids: string[]) {
  const unique = [...new Set(ids.map(validUuid).filter((x): x is string => !!x))];
  if (!unique.length) return new Set<string>();
  const { data, error } = await db.from("luna_sessions")
    .select("id")
    .in("id", unique)
    .eq("session_date", bangkokDate())
    .eq("mode", "paper")
    .eq("strategy_version", STRATEGY)
    .eq("status", "OPEN");
  if (error) throw new Error("SESSION_VALIDATION_FAILED:" + error.message);
  return new Set((data ?? []).map((r: any) => String(r.id)));
}
async function writeAudit(body: Record<string, any>, defaultType = "LUNA_WORKER_AUDIT") {
  const eventType = safeString(body.event_type ?? defaultType, 120).toUpperCase();
  const sessionId = body.session_id ? validUuid(body.session_id) : null;
  if (body.session_id && !sessionId) throw new Error("INVALID_SESSION_ID");
  const payload = body.payload && typeof body.payload === "object" ? body.payload : {};
  const serialized = JSON.stringify(payload);
  if (serialized.length > 32000) throw new Error("AUDIT_PAYLOAD_TOO_LARGE");
  const ts = dateValue(body.ts) ?? new Date();
  const strategyVersion = safeString(body.strategy_version, 120) || STRATEGY;
  const hash = safeString(body.hash, 128) || null;
  if (sessionId) {
    const { data, error } = await db.from("luna_sessions").select("id").eq("id", sessionId).maybeSingle();
    if (error) throw new Error("AUDIT_SESSION_LOOKUP_FAILED");
    if (!data) throw new Error("AUDIT_SESSION_NOT_FOUND");
  }
  const { error } = await db.from("luna_audit_events").insert({
    session_id: sessionId, ts: ts.toISOString(), event_type: eventType,
    strategy_version: strategyVersion, payload, hash,
  });
  if (error) throw new Error("AUDIT_WRITE_FAILED:" + error.message);
  return { ok: true, event_type: eventType, execution_eligible: false };
}
function normalizeQuote(item: any, sessionId: string, date: string) {
  const q = item?.quote && typeof item.quote === "object" ? item.quote : {};
  const symbol = validSymbol(q.symbol);
  const providerTimestamp = dateValue(q.sourceTs ?? q.source_ts);
  const sourceDate = providerTimestamp ?? dateValue(q.ts);
  if (!symbol || !sourceDate) return { row: null, reason: "INVALID_SYMBOL_OR_TIMESTAMP" };
  const nowMs = Date.now();
  if (sourceDate.getTime() > nowMs + 30_000) return { row: null, reason: "FUTURE_TIMESTAMP" };
  const bid = positiveOrNull(q.bid);
  const ask = positiveOrNull(q.ask);
  const last = positiveOrNull(q.last);
  if (bid === null && ask === null && last === null) return { row: null, reason: "NO_PRICE" };
  const bidSizeN = positiveOrNull(q.bidSize ?? q.bid_size);
  const askSizeN = positiveOrNull(q.askSize ?? q.ask_size);
  const spreadOK = bid !== null && ask !== null && ask >= bid;
  const bookShape = spreadOK && bidSizeN !== null && askSizeN !== null;
  const providerSource = safeString(q.source, 120) || "UNKNOWN_PROVIDER";
  const explicitQuality = safeString(q.dataQuality ?? q.data_quality, 100);
  const ageMs = Math.max(0, nowMs - sourceDate.getTime());
  const freshnessLabel = ageMs <= 2_000 ? "FRESH_AT_RECEIVE" : ageMs <= 15_000 ? "DELAYED_AT_RECEIVE" : "STALE_AT_RECEIVE";
  const qualityLabel = providerTimestamp
    ? (bookShape ? freshnessLabel + "_BOOK_SHAPE_UNVERIFIED" : freshnessLabel + "_PRICE_ONLY")
    : "SOURCE_TIMESTAMP_MISSING_" + (bookShape ? "BOOK_SHAPE_UNVERIFIED" : "PRICE_ONLY");
  return {
    row: {
      symbol, as_of_date: date, session_id: sessionId,
      quote_ts: sourceDate.toISOString(), received_at: new Date().toISOString(),
      bid, ask, last,
      bid_size: bidSizeN === null ? null : Math.floor(bidSizeN),
      ask_size: askSizeN === null ? null : Math.floor(askSizeN),
      provider_source: providerSource,
      data_quality: explicitQuality || qualityLabel,
      raw: { quote: q, observation_only: true, source_timestamp: sourceDate.toISOString(), provider_timestamp_present: !!providerTimestamp, received_age_ms: ageMs, book_shape_valid: !!bookShape },
      execution_eligible: false,
    },
    reason: "",
  };
}
function normalizeSignal(item: any, date: string) {
  const s = item?.signal && typeof item.signal === "object" ? item.signal : {};
  const symbol = validSymbol(s.symbol);
  const ts = dateValue(s.ts);
  if (!symbol || !ts) return { row: null, reason: "INVALID_SIGNAL_FIELDS" };
  const action = safeString(s.action, 24).toUpperCase() || "HOLD";
  return {
    row: {
      strategy_version: safeString(s.strategyVersion ?? s.strategy_version, 120) || STRATEGY,
      symbol, as_of_date: date, session_id: typeof item.session_id === "string" ? item.session_id : null,
      signal_ts: ts.toISOString(), received_at: new Date().toISOString(),
      action, trace_id: safeString(s.trace_id, 120) || null,
      signal: s, execution_eligible: false,
    },
    reason: "",
  };
}
async function telemetryBatch(items: any[]) {
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_BATCH) {
    return json({ ok: false, error: "TELEMETRY_BATCH_SIZE_MUST_BE_1_TO_100" }, 400);
  }
  const ticks = items.filter((x) => x?.action === "tick");
  const signals = items.filter((x) => x?.action === "signal");
  const other = items.length - ticks.length - signals.length;
  const date = bangkokDate();
  const sessionIds = items.map((x) => String(x?.session_id ?? "")).filter(Boolean);
  const validSessions = await validateOpenPaperSessions(sessionIds);
  const quoteRows: any[] = [];
  const signalRows: any[] = [];
  let rejected = other;
  const reasons: Record<string, number> = {};
  const reject = (reason: string) => { rejected++; reasons[reason] = (reasons[reason] ?? 0) + 1; };
  for (const item of ticks) {
    const sessionId = String(item?.session_id ?? "");
    if (!validSessions.has(sessionId)) { reject("SESSION_NOT_OPEN_PAPER"); continue; }
    const out = normalizeQuote(item, sessionId, date);
    if (!out.row) { reject(out.reason); continue; }
    quoteRows.push(out.row);
  }
  for (const item of signals) {
    const sessionId = String(item?.session_id ?? "");
    if (!validSessions.has(sessionId)) { reject("SESSION_NOT_OPEN_PAPER"); continue; }
    const out = normalizeSignal(item, date);
    if (!out.row) { reject(out.reason); continue; }
    signalRows.push(out.row);
  }
  if (quoteRows.length) {
    const { error } = await db.from("luna_worker_quote_cache").upsert(quoteRows, { onConflict: "symbol" });
    if (error) throw new Error("QUOTE_CACHE_UPSERT_FAILED:" + error.message);
  }
  if (signalRows.length) {
    const { error } = await db.from("luna_worker_signal_cache").upsert(signalRows, { onConflict: "strategy_version,symbol" });
    if (error) throw new Error("SIGNAL_CACHE_UPSERT_FAILED:" + error.message);
  }
  return json({
    ok: true, status: "OBSERVE_ONLY",
    batch_size: items.length,
    quote_rows_seen: ticks.length,
    quote_rows_upserted: quoteRows.length,
    signal_rows_seen: signals.length,
    signal_rows_upserted: signalRows.length,
    rejected_items: rejected,
    rejection_reasons: reasons,
    execution_eligible: false,
    orders_created: 0,
    live_orders_created: false,
  });
}
async function health() {
  const [quotes, signals, recent] = await Promise.all([
    db.from("luna_worker_quote_cache").select("symbol", { count: "exact", head: true }),
    db.from("luna_worker_signal_cache").select("symbol", { count: "exact", head: true }),
    db.from("luna_worker_quote_cache").select("symbol,quote_ts,received_at,provider_source,data_quality,bid,ask,bid_size,ask_size,execution_eligible")
      .order("received_at", { ascending: false }).limit(25),
  ]);
  if (quotes.error || signals.error || recent.error) throw new Error("WORKER_HEALTH_QUERY_FAILED");
  const now = Date.now();
  const freshProviderTimestamp = (recent.data ?? []).filter((r: any) => {
    const t = Date.parse(String(r.quote_ts ?? ""));
    return r.raw?.provider_timestamp_present === true && Number.isFinite(t) && now - t >= 0 && now - t <= 2_000;
  }).length;
  const missingProviderTimestamp = (recent.data ?? []).filter((r: any) => r.raw?.provider_timestamp_present !== true).length;
  const bookShape = (recent.data ?? []).filter((r: any) =>
    Number(r.bid) > 0 && Number(r.ask) >= Number(r.bid) && Number(r.bid_size) > 0 && Number(r.ask_size) > 0
  ).length;
  return {
    ok: true, status: "OBSERVE_ONLY",
    date: bangkokDate(),
    quote_cache_symbols: quotes.count ?? 0,
    signal_cache_symbols: signals.count ?? 0,
    sampled_latest_rows: (recent.data ?? []).length,
    fresh_provider_timestamps_in_sample: freshProviderTimestamp,
    missing_provider_timestamp_in_sample: missingProviderTimestamp,
    book_shape_valid_in_sample: bookShape,
    execution_eligible: false,
    note: "Worker cache is observational only; it is never an execution authority.",
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  try {
    if (!(await authorized(req))) return json({ ok: false, error: "UNAUTHORIZED_LUNA_AGENT" }, 401);
    const rate = await rateAllowed(req);
    if (!rate.ok) return json({ ok: false, error: rate.error }, rate.status);
    if (req.method === "GET") {
      const url = new URL(req.url);
      if (url.searchParams.get("view") !== "health") return json({ ok: false, error: "VIEW_NOT_AVAILABLE" }, 404);
      return json(await health());
    }
    if (req.method !== "POST") return json({ ok: false, error: "POST_REQUIRED" }, 405);
    const body = await req.json().catch(() => null) as Record<string, any> | null;
    if (!body || typeof body !== "object") return json({ ok: false, error: "INVALID_JSON_BODY" }, 400);
    const action = safeString(body.action, 80).toLowerCase();
    const today = bangkokDate();

    if (action === "start_session") {
      const s = body.session && typeof body.session === "object" ? body.session : {};
      if (safeString(s.mode, 20).toLowerCase() !== "paper") {
        return json({ ok: false, error: "WORKER_API_PAPER_ONLY" }, 423);
      }
      if (safeString(s.strategy_version, 120) !== STRATEGY || safeString(s.session_date, 10) !== today) {
        return json({ ok: false, error: "STRATEGY_OR_SESSION_DATE_NOT_ALLOWED", required_strategy: STRATEGY, date: today }, 409);
      }
      const { data: binding, error: bindingError } = await db.from("luna_strategy_bindings")
        .select("strategy_version,enabled,execution_mode")
        .eq("strategy_version", STRATEGY).eq("enabled", true)
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (bindingError || !binding) return json({ ok: false, error: "STRATEGY_BINDING_NOT_ENABLED" }, 409);
      const existing = await findCurrentPaperSession();
      if (existing) return json({ ok: true, reused: true, session: existing, execution_eligible: false });
      const capital = Math.max(1, Math.min(100_000_000, numeric(s.initial_capital) ?? 30000));
      const { data: session, error } = await db.from("luna_sessions").insert({
        session_date: today, mode: "paper", strategy_version: STRATEGY,
        initial_capital: capital,
        status: "OPEN",
        runtime_owner: safeString(body.runtime_owner, 120) || "luna-worker-observe-only",
      }).select("id,session_date,mode,strategy_version,initial_capital,started_at,status,runtime_owner").single();
      if (error) {
        const again = await findCurrentPaperSession();
        if (again) return json({ ok: true, reused: true, session: again, execution_eligible: false });
        throw new Error("WORKER_SESSION_CREATE_FAILED:" + error.message);
      }
      return json({ ok: true, reused: false, session, execution_eligible: false });
    }

    if (action === "validate_session") {
      const sessionId = safeString(body.session_id, 64);
      const { data, error } = await db.from("luna_sessions").select("id,session_date,mode,strategy_version,status")
        .eq("id", sessionId).maybeSingle();
      if (error) throw new Error("SESSION_VALIDATE_QUERY_FAILED");
      const valid = !!data && data.session_date === today && data.mode === "paper" &&
        data.strategy_version === STRATEGY && data.status === "OPEN";
      if (!valid) return json({ ok: false, error: "SESSION_NOT_OPEN_PAPER", execution_blocked: true }, 409);
      return json({ ok: true, valid: true, execution_eligible: false, observe_only: true });
    }

    if (action === "telemetry_batch") {
      return await telemetryBatch(Array.isArray(body.items) ? body.items : []);
    }

    if (action === "audit") return json(await writeAudit(body));

    if (action === "signal") {
      return await telemetryBatch([{ action: "signal", session_id: body.session_id, signal: body.signal }]);
    }

    if (action === "snapshot") {
      const auditBody = {
        session_id: body.session_id,
        ts: body.ts,
        event_type: "WORKER_OBSERVE_ONLY_PORTFOLIO_SNAPSHOT",
        strategy_version: STRATEGY,
        payload: { observer_only: true, portfolio: body.portfolio ?? null, stored_as_portfolio: false, execution_eligible: false },
      };
      await writeAudit(auditBody);
      return json({ ok: true, stored_as: "audit_only", execution_eligible: false, orders_created: 0 });
    }

    if (action === "get_execution_control") {
      const { data, error } = await db.from("luna_execution_controls")
        .select("execution_mode,armed,kill_switch,max_daily_loss,max_order_notional,max_orders_per_minute,max_daily_turnover")
        .eq("id", true).maybeSingle();
      if (error) throw new Error("EXECUTION_CONTROL_QUERY_FAILED");
      return json({
        ok: true,
        control: {
          execution_mode: "paper", armed: false, kill_switch: true, observe_only: true,
          max_daily_loss: numeric(data?.max_daily_loss) ?? 5000,
          max_order_notional: numeric(data?.max_order_notional) ?? 50000,
          max_orders_per_minute: numeric(data?.max_orders_per_minute) ?? 2,
          max_daily_turnover: numeric(data?.max_daily_turnover) ?? 0,
        },
        authority: { live_orders_allowed: false, paper_orders_allowed_by_worker: false },
      });
    }

    if (action === "recent_15m_bars_batch") {
      const symbols = [...new Set((Array.isArray(body.symbols) ? body.symbols : []).map(validSymbol).filter(Boolean) as string[])].slice(0, 50);
      if (!symbols.length) return json({ ok: true, bars_by_symbol: {}, execution_eligible: false });
      const limit = Math.max(1, Math.min(80, Math.floor(numeric(body.limit) ?? 80)));
      const session = await findCurrentPaperSession();
      if (!session) return json({ ok: true, bars_by_symbol: {}, execution_eligible: false });
      const { data, error } = await db.from("luna_shadow_15m_bars")
        .select("symbol,bar_end,close,verified_book_tick_count")
        .eq("session_id", session.id)
        .in("symbol", symbols)
        .gt("verified_book_tick_count", 0)
        .lte("bar_end", new Date().toISOString())
        .order("bar_end", { ascending: false })
        .limit(Math.min(1000, symbols.length * limit));
      if (error) throw new Error("RECENT_BARS_QUERY_FAILED:" + error.message);
      const grouped: Record<string, any[]> = {};
      for (const sym of symbols) grouped[sym] = [];
      for (const row of data ?? []) {
        const key = String(row.symbol).toUpperCase();
        if (!grouped[key]) continue;
        if (grouped[key].length < limit) grouped[key].push({ close: row.close, ts: row.bar_end });
      }
      for (const sym of symbols) grouped[sym].reverse();
      return json({ ok: true, bars_by_symbol: grouped, execution_eligible: false });
    }

    if (action === "m1_l2_overlay") {
      return json({ ok: false, error: "M1_L2_OVERLAY_DISABLED_FOR_WORKER_RESEARCH", rows: [], execution_eligible: false }, 409);
    }

    if (action === "end_session") {
      return json({ ok: true, ended: false, status: "SESSION_LIFECYCLE_OWNED_BY_LUNA_CONTROL_PLANE", execution_eligible: false });
    }

    if (action === "record_fill" || action === "record_broker_event" || action === "create_order" || action === "submit_order") {
      return json({ ok: false, error: "WORKER_API_OBSERVE_ONLY_ORDER_ACTION_BLOCKED", live_orders_created: false }, 423);
    }

    return json({ ok: false, error: "UNKNOWN_OR_DISALLOWED_ACTION", action }, 400);
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});