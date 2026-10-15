import {
  BANGKOK_TZ,
  LUNA_API,
  LUNA_PUBLIC_MARKET_STREAM,
  LUNA_STRATEGY,
} from "./luna-runtime";
import { createClient as createSupabaseBrowserClient } from "./supabase/client";

export type RuntimeStatus = {
  ok?: boolean;
  generated_at?: string;
  runtime?: {
    state?: string;
    system_state?: string;
    session?: {
      id?: string;
      session_date?: string;
      mode?: string;
      strategy_version?: string;
      status?: string;
    };
    strategy_version?: string;
    latest_source?: string | null;
    latest_age_ms?: number | null;
    latest_tick_ts?: string | null;
    ticks_10s?: number;
    ticks_30s?: number;
    ticks_2m?: number;
    symbols_30s?: number;
    bid_ask_ticks_30s?: number;
  };
  error?: { message?: string };
};

export type ShadowDecision = {
  symbol: string;
  bar_end: string;
  close?: number;
  ema5?: number;
  ema20?: number;
  momentum_1?: number;
  bar_count?: number;
  candidate_action: string;
  verified_book: boolean;
  feed_verified: boolean;
  execution_blocked: boolean;
  reason: string;
};

export type ShadowStatus = {
  ok?: boolean;
  generated_at?: string;
  shadow?: {
    state?: string;
    strategy_version?: string;
    latest_bar_end?: string | null;
    eligible_symbols?: number;
    buy_candidates?: number;
    sell_candidates?: number;
    orders_allowed?: boolean;
    blockers?: string[];
    latest_source?: string | null;
    verified_latest_bar_symbols?: number;
    decisions?: ShadowDecision[];
  };
  error?: { message?: string };
};

export type LunaHistoricalBar = {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
};

export type LunaMarketBarsResult = {
  ok: boolean;
  source?: string;
  symbol?: string;
  interval?: string;
  fetched_at?: string;
  bars?: LunaHistoricalBar[];
  error?: string;
};

export type RealtimeQuote = {
  symbol: string;
  ts?: string;
  source_ts?: string | null;
  bid?: number | null;
  ask?: number | null;
  last?: number | null;
  bid_size?: number | null;
  ask_size?: number | null;
  source?: string | null;
};

export type FeedSession = {
  id?: string;
  session_date?: string;
  status?: string;
  created_at?: string;
  started_at?: string;
  mode?: string;
  strategy_version?: string;
  initial_capital?: number;
};

export type LunaFeed = {
  ok?: boolean;
  public_safe?: boolean;
  partial_data?: boolean;
  generated_at: string;
  as_of_date?: string;
  strategy_version?: string;
  system_readiness?: {
    status?: string;
    paper_only?: boolean;
    real_money_execution_enabled?: boolean;
    current_session_open?: boolean;
    runtime_heartbeat_fresh?: boolean;
    market_feed_verified_for_execution?: boolean;
    stale_queued_orders?: number;
    blockers?: string[];
  };
  universe_coverage?: {
    active_universe?: number;
    active_set?: number;
    active_mai?: number;
    verified_book_symbols?: number;
  };
  paper_live?: {
    status?: string;
    runtime_fresh?: boolean;
    heartbeat_age_ms?: number | null;
    last_heartbeat?: string | null;
    last_signal_bar_end?: string | null;
    session_id?: string | null;
    initial_capital?: number | null;
    cash?: number | null;
    reserved_cash?: number | null;
    available_cash?: number | null;
    realized_pnl?: number | null;
    fees?: number | null;
    paper_only?: boolean;
    fill_model?: string;
    orders_total?: number | null;
    orders_returned?: number;
    positions_returned?: number;
  } | null;
  signal_state?: {
    status?: string;
    candidate_decisions_today?: number;
    buy_candidates_today?: number;
    sell_candidates_today?: number;
    blocked_candidates_today?: number;
    verified_book_candidates_today?: number;
    latest_bar_end?: string | null;
  };
  decision_audit?: Array<{
    symbol: string;
    bar_end: string;
    candidate_action: string;
    execution_blocked: boolean;
    feed_verified: boolean;
    verified_book: boolean;
    reason?: string | null;
  }>;
  portfolio?: {
    cash?: number | null;
    reserved_cash?: number | null;
    available_cash?: number | null;
    market_value?: number | null;
    gross_exposure?: number | null;
    realized_pnl?: number | null;
    unrealized_pnl?: number | null;
    fees?: number | null;
    as_of?: string | null;
    data_status?: string;
    valuation_status?: string;
  } | null;
  sessions: FeedSession[];
  ticks: Array<Record<string, any>>;
  signals: Array<Record<string, any>>;
  snapshots: Array<Record<string, any>>;
  orders: Array<Record<string, any>>;
  fills: Array<Record<string, any>>;
  positions: Array<Record<string, any>>;
  execution_control: Record<string, any> | null;
  counts: Record<string, any>;
  errors: Array<Record<string, any>>;
  market_feed?: {
    status: string;
    verified_realtime: boolean;
    public_fallback: boolean;
    latest_source?: string | null;
    latest_ts?: string | null;
    latest_age_ms?: number | null;
    sources?: string[];
  };
  latency?: {
    summary?: {
      sample_count: number;
      market_lag_ms?: { p50: number; p95: number; p99: number; max: number };
      analysis_ms?: { p50: number; p95: number; p99: number; max: number };
      queue_wait_ms?: { p50: number; p95: number; p99: number; max: number };
      execution_ms?: { p50: number; p95: number; p99: number; max: number };
      end_to_end_ms?: { p50: number; p95: number; p99: number; max: number };
    };
  };
};

export type ControlRoomState = {
  ok?: boolean;
  generated_at?: string;
  as_of_date?: string;
  system_test?: {
    overall_status?: string;
    checks?: Array<{ name: string; pass: boolean }>;
    summary?: { integrity?: boolean };
  };
  readiness?: {
    month_closed?: boolean;
    execution_mode?: string;
    paper_execution_permitted?: boolean;
    live_execution_permitted?: boolean;
    kill_switch?: boolean;
    armed?: boolean;
    ceos_feed_rows?: number;
    ceos_allowed_rows?: number;
  };
  fast?: { forecast_rank?: Array<Record<string, any>> };
  final?: { summary?: Record<string, any>; rows?: Array<Record<string, any>> };
  paper_audit?: Record<string, any>;
};

export type Tournament100Result = {
  status?: string;
  mode?: string;
  testType?: string;
  period?: { start?: string; end?: string; sessions?: number };
  data?: {
    universe?: string;
    universeCount?: number;
    symbolsReturned?: number;
    symbolsFailed?: number;
    bars15m?: number;
    errors?: string[];
  };
  rules?: Record<string, any>;
  strategiesTested?: number;
  top20?: Array<Record<string, any>>;
  allResults?: Array<Record<string, any>>;
};

export class LunaApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "LunaApiError";
  }
}

const DEFAULT_TIMEOUT_MS = 4_500;
const RESEARCH_TIMEOUT_MS = 25_000;

export async function fetchJson<T>(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers = new Headers(init.headers);
    // The LUNA edge function uses the service role for aggregation. Attach the
    // signed-in user's Supabase JWT only to this exact endpoint, never other URLs.
    if (typeof window !== "undefined") {
      try {
        const requestUrl = input instanceof URL
          ? input
          : new URL(typeof input === "string" ? input : input.url, window.location.origin);
        const apiUrl = new URL(LUNA_API);
        if (requestUrl.origin === apiUrl.origin && requestUrl.pathname === apiUrl.pathname) {
          const { data } = await createSupabaseBrowserClient().auth.getSession();
          if (data.session?.access_token) {
            headers.set("Authorization", `Bearer ${data.session.access_token}`);
          }
        }
      } catch {
        // Never fabricate credentials. The API will fail closed with HTTP 401.
      }
    }

    const response = await fetch(input, {
      ...init,
      headers,
      signal: controller.signal,
      cache: init.cache ?? "no-store",
    });

    if (!response.ok) {
      throw new LunaApiError(
        `HTTP ${response.status} from ${typeof input === "string" ? input : "LUNA API"}`,
        response.status,
      );
    }

    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new LunaApiError("LUNA API request timed out");
    }
    if (error instanceof LunaApiError) throw error;
    throw new LunaApiError(error instanceof Error ? error.message : "LUNA API request failed");
  } finally {
    clearTimeout(timer);
  }
}

export function buildLunaApiUrl(
  view: string,
  params: Record<string, string | number | undefined> = {},
): string {
  const url = new URL(LUNA_API);
  url.searchParams.set("view", view);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  return url.toString();
}

export async function fetchPortfolioState(asOf: string) {
  const feed = await fetchJson<LunaFeed>(
    buildLunaApiUrl("feed", {
      limit: 100,
      strategy: LUNA_STRATEGY,
      as_of: asOf,
    }),
  );

  const heartbeatAge = feed.paper_live?.heartbeat_age_ms;
  const runtimeFresh = feed.paper_live?.runtime_fresh === true
    && typeof heartbeatAge === "number"
    && Number.isFinite(heartbeatAge)
    && heartbeatAge >= 0;
  const runtime: RuntimeStatus = {
    ok: feed.ok !== false,
    generated_at: feed.generated_at,
    runtime: {
      // LIVE here means a fresh paper-engine heartbeat, never live-money execution.
      state: runtimeFresh ? "LIVE" : feed.system_readiness?.current_session_open ? "DEGRADED" : "NO_OPEN_SESSION",
      system_state: runtimeFresh ? "PAPER_RUNTIME_FRESH" : feed.system_readiness?.status ?? "UNKNOWN",
      session: feed.sessions?.[0] ?? undefined,
      strategy_version: feed.strategy_version,
      latest_source: feed.market_feed?.latest_source ?? null,
      latest_age_ms: heartbeatAge ?? feed.market_feed?.latest_age_ms ?? null,
      latest_tick_ts: feed.paper_live?.last_heartbeat ?? feed.market_feed?.latest_quote_ts ?? null,
    },
  };

  return { feed, runtime };
}

export async function fetchMarketBars(
  symbol: string,
  interval: "1m" | "5m" | "15m" | "60m" = "15m",
  limit = 96,
): Promise<LunaMarketBarsResult> {
  const params = new URLSearchParams({
    symbol: symbol.trim().toUpperCase(),
    interval,
    limit: String(limit),
  });
  const response = await fetch(`/api/luna/market-bars?${params.toString()}`, {
    method: "GET",
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  const payload = await response.json().catch(() => null);
  if (!payload || typeof payload !== "object") {
    throw new LunaApiError("Market history returned an invalid response", response.status);
  }
  return payload as LunaMarketBarsResult;
}

export async function fetchShadowStatus(asOf: string): Promise<ShadowStatus> {
  const feed = await fetchJson<LunaFeed>(
    buildLunaApiUrl("feed", {
      strategy: LUNA_STRATEGY,
      as_of: asOf,
    }),
  );
  const blockers = [...(feed.system_readiness?.blockers ?? [])];
  if (feed.partial_data && blockers.length === 0) blockers.push("PARTIAL_DATA");
  const decisions: ShadowDecision[] = (feed.decision_audit ?? []).map((decision) => {
    const rawAction = String(decision.candidate_action ?? "UNKNOWN").toUpperCase();
    const action = rawAction.startsWith("BUY") ? "BUY"
      : rawAction.startsWith("SELL") ? "SELL"
      : rawAction === "HOLD" ? "HOLD"
      : "UNKNOWN";
    return {
      symbol: String(decision.symbol ?? ""),
      bar_end: String(decision.bar_end ?? ""),
      candidate_action: action,
      verified_book: decision.verified_book === true,
      feed_verified: decision.feed_verified === true,
      execution_blocked: decision.execution_blocked !== false,
      reason: String(decision.reason ?? "No decision explanation was recorded by the backend."),
    };
  }).filter((decision) => decision.symbol && decision.bar_end);

  return {
    ok: feed.ok,
    generated_at: feed.generated_at,
    shadow: {
      state: feed.signal_state?.status ?? "UNKNOWN",
      strategy_version: feed.strategy_version ?? LUNA_STRATEGY,
      latest_bar_end: feed.signal_state?.latest_bar_end ?? null,
      eligible_symbols: feed.universe_coverage?.active_universe ?? 0,
      buy_candidates: feed.signal_state?.buy_candidates_today ?? 0,
      sell_candidates: feed.signal_state?.sell_candidates_today ?? 0,
      orders_allowed: feed.system_readiness?.status === "READY_FOR_PAPER_ONLY"
        && feed.paper_live?.runtime_fresh === true,
      blockers,
      latest_source: feed.market_feed?.latest_source ?? null,
      verified_latest_bar_symbols: feed.signal_state?.verified_book_candidates_today ?? 0,
      decisions,
    },
  };
}

export async function fetchControlRoom(strategy = LUNA_STRATEGY): Promise<ControlRoomState> {
  return fetchJson<ControlRoomState>(
    buildLunaApiUrl("latest_control", { strategy }),
  );
}

export async function fetchTournament100(
  mode: string,
  universe = "full",
): Promise<Tournament100Result> {
  const response = await fetchJson<Tournament100Result>(
    `/api/backtest/tournament100?mode=${encodeURIComponent(mode)}&universe=${encodeURIComponent(universe)}`,
    {},
    RESEARCH_TIMEOUT_MS,
  );

  return response;
}

type RealtimeStreamOptions = {
  url?: string;
  onQuotes: (quotes: Record<string, RealtimeQuote>) => void;
  onTick: () => void;
  onConnectionChange: (connected: boolean) => void;
};

export function connectRealtimeMarketStream({
  url = LUNA_PUBLIC_MARKET_STREAM,
  onQuotes,
  onTick,
  onConnectionChange,
}: RealtimeStreamOptions): () => void {
  let socket: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryMs = 1_000;
  let stopped = false;

  const scheduleReconnect = () => {
    if (stopped) return;
    retryTimer = setTimeout(connect, retryMs);
    retryMs = Math.min(15_000, retryMs * 2);
  };

  const connect = () => {
    if (stopped) return;

    try {
      socket = new WebSocket(url);
    } catch {
      onConnectionChange(false);
      scheduleReconnect();
      return;
    }

    socket.onopen = () => {
      retryMs = 1_000;
      onConnectionChange(false);
    };

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as {
          type?: string;
          quotes?: RealtimeQuote[];
          quote?: RealtimeQuote;
        };

        if (message.type === "snapshot" && Array.isArray(message.quotes)) {
          const next: Record<string, RealtimeQuote> = {};
          for (const quote of message.quotes) {
            if (quote?.symbol) next[quote.symbol] = quote;
          }
          if (message.quotes.length) onTick();
          onQuotes(next);
          return;
        }

        if (message.type === "quote" && message.quote?.symbol) {
          onTick();
          onQuotes({ [message.quote.symbol]: message.quote });
        }
      } catch {
        // Ignore malformed public-stream frames; HTTP remains the source of record.
      }
    };

    socket.onclose = () => {
      onConnectionChange(false);
      scheduleReconnect();
    };

    socket.onerror = () => {
      onConnectionChange(false);
    };
  };

  connect();

  return () => {
    stopped = true;
    if (retryTimer) clearTimeout(retryTimer);
    socket?.close();
  };
}

// Kept as a single exported value so client code has one source of truth.
export const CLIENT_DEFAULTS = {
  apiTimeZone: BANGKOK_TZ,
  refreshMs: 5_000,
  shadowRefreshMs: 15_000,
  timeoutMs: DEFAULT_TIMEOUT_MS,
};
