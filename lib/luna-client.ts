import {
  BANGKOK_TZ,
  LUNA_API,
  LUNA_PUBLIC_MARKET_STREAM,
  LUNA_STRATEGY,
} from "./luna-runtime";

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
  close?: number | null;
  ema5?: number | null;
  ema20?: number | null;
  momentum_1?: number | null;
  bar_count?: number | null;
  candidate_action: string;
  verified_book: boolean | null;
  feed_verified: boolean | null;
  execution_blocked: boolean | null;
  reason?: string | null;
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
    verified_book_symbols?: number;
    verified_book_coverage_pct?: number;
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
  generated_at: string;
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
    const response = await fetch(input, {
      ...init,
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
  const [feed, runtime] = await Promise.all([
    fetchJson<LunaFeed>(
      buildLunaApiUrl("feed", {
        limit: 100,
        strategy: LUNA_STRATEGY,
        as_of: asOf,
      }),
    ),
    fetchJson<RuntimeStatus>(
      buildLunaApiUrl("runtime_status", {
        strategy: LUNA_STRATEGY,
        as_of: asOf,
      }),
    ).catch((error) => ({
      ok: false,
      error: { message: error instanceof Error ? error.message : "Runtime API unavailable" },
    })),
  ]);

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
  type ShadowApiPayload = {
    ok?: boolean;
    generated_at?: string;
    strategy_version?: string;
    status?: string;
    signal_state?: {
      status?: string;
      buy_candidates_today?: number;
      sell_candidates_today?: number;
      verified_book_candidates_today?: number;
      latest_bar_end?: string | null;
    } | null;
    decision_audit?: Array<Record<string, unknown>>;
    latest_bar_end?: string | null;
    market_feed?: {
      status?: string;
      latest_source?: string | null;
      latest_age_ms?: number | null;
      verified_book_symbols?: number;
      verified_book_coverage_pct?: number;
      verified_book_coverage_ready?: boolean;
    } | null;
    universe_coverage?: { active_universe?: number } | null;
    error?: { message?: string };
  };
  type ReadinessPayload = {
    ok?: boolean;
    status?: string;
    blockers?: string[];
    generated_at?: string;
    error?: { message?: string };
  };

  // The deployed API returns flat signal_state/decision_audit fields. Normalize that
  // real response to the nested UI contract rather than treating the valid payload
  // as an empty shadow object.
  const [raw, readiness] = await Promise.all([
    fetchJson<ShadowApiPayload>(
      buildLunaApiUrl("shadow_status", { strategy: LUNA_STRATEGY, as_of: asOf }),
    ),
    fetchJson<ReadinessPayload>(
      buildLunaApiUrl("latest_control", { strategy: LUNA_STRATEGY }),
    ).catch((error) => ({
      ok: false,
      status: "READINESS_UNAVAILABLE",
      blockers: [error instanceof Error ? error.message : "EXECUTION_READINESS_UNAVAILABLE"],
    })),
  ]);

  if (raw.ok !== true) {
    return { ok: false, generated_at: raw.generated_at, error: raw.error ?? { message: "SHADOW_STATUS_UNAVAILABLE" } };
  }

  const signalState = raw.signal_state ?? {};
  const marketFeed = raw.market_feed ?? {};
  const coverage = raw.universe_coverage ?? {};
  const readinessBlockers = Array.isArray(readiness.blockers) ? readiness.blockers : [];
  const ordersAllowed = readiness.ok === true && readiness.status === "READY_FOR_PAPER_ONLY" && readinessBlockers.length === 0;
  const blockers = ordersAllowed ? [] : (readinessBlockers.length ? readinessBlockers : ["EXECUTION_READINESS_UNAVAILABLE"]);
  const decisions: ShadowDecision[] = (Array.isArray(raw.decision_audit) ? raw.decision_audit : []).map((row) => ({
    symbol: String(row.symbol ?? ""),
    bar_end: String(row.bar_end ?? raw.latest_bar_end ?? ""),
    candidate_action: String(row.candidate_action ?? "UNKNOWN"),
    verified_book: typeof row.verified_book === "boolean" ? row.verified_book : null,
    feed_verified: typeof row.feed_verified === "boolean" ? row.feed_verified : null,
    execution_blocked: typeof row.execution_blocked === "boolean" ? row.execution_blocked : null,
    reason: typeof row.reason === "string" ? row.reason : null,
  })).filter((row) => row.symbol.length > 0);

  return {
    ok: true,
    generated_at: raw.generated_at,
    shadow: {
      state: ordersAllowed ? "READY_FOR_PAPER_ONLY" : String(readiness.status ?? raw.status ?? signalState.status ?? "BLOCKED"),
      strategy_version: raw.strategy_version ?? LUNA_STRATEGY,
      latest_bar_end: raw.latest_bar_end ?? signalState.latest_bar_end ?? decisions[0]?.bar_end ?? null,
      eligible_symbols: typeof coverage.active_universe === "number" ? coverage.active_universe : undefined,
      buy_candidates: typeof signalState.buy_candidates_today === "number" ? signalState.buy_candidates_today : 0,
      sell_candidates: typeof signalState.sell_candidates_today === "number" ? signalState.sell_candidates_today : 0,
      orders_allowed: ordersAllowed,
      blockers,
      latest_source: marketFeed.latest_source ?? null,
      verified_book_symbols: typeof marketFeed.verified_book_symbols === "number" ? marketFeed.verified_book_symbols : undefined,
      verified_book_coverage_pct: typeof marketFeed.verified_book_coverage_pct === "number" ? marketFeed.verified_book_coverage_pct : undefined,
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
