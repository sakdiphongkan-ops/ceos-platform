import { NextResponse } from "next/server";
import { getLunaUser } from "../../../../lib/luna2/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_INTERVALS = new Set(["1m", "3m", "5m", "10m", "15m", "30m", "60m", "120m", "240m", "1d", "1w", "1M"]);
// Keep this set synchronized with the selectable symbols in MarketHistoryPanel. Expand only after confirming the subscribed/licensed universe.
const ALLOWED_SYMBOLS = new Set(["PTT", "ADVANC", "AOT", "CPALL", "BDMS", "KBANK", "SCB", "DELTA", "GULF", "KTB"]);
const DEFAULT_LIMIT = 96;
const MAX_LIMIT = 500;
const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 30;
const MAX_RATE_ENTRIES = 10_000;
const rateState = new Map<string, { startedAt: number; count: number }>();

type Candle = {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
};

function responseError(error: string, status: number, extraHeaders: Record<string, string> = {}) {
  return NextResponse.json(
    { ok: false, error },
    { status, headers: { "Cache-Control": "private, no-store", ...extraHeaders } },
  );
}

function checkRate(userId: string): boolean {
  const now = Date.now();
  const current = rateState.get(userId);
  if (!current || now - current.startedAt >= WINDOW_MS) {
    if (rateState.size >= MAX_RATE_ENTRIES) {
      for (const [key, value] of rateState) {
        if (now - value.startedAt >= WINDOW_MS) rateState.delete(key);
        if (rateState.size < MAX_RATE_ENTRIES) break;
      }
    }
    if (rateState.size >= MAX_RATE_ENTRIES) return false;
    rateState.set(userId, { startedAt: now, count: 1 });
    return true;
  }
  current.count += 1;
  return current.count <= MAX_REQUESTS_PER_WINDOW;
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function timestamp(value: unknown): string | null {
  if (typeof value === "number" || (typeof value === "string" && /^\d{10,13}$/.test(value))) {
    const numeric = Number(value);
    const ms = numeric < 100_000_000_000 ? numeric * 1000 : numeric;
    const date = new Date(ms);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function firstValue(row: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null) return row[key];
  }
  return undefined;
}

function findRows(value: unknown, depth = 0): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object" || depth > 4) return null;
  const object = value as Record<string, unknown>;
  for (const key of ["candlesticks", "candles", "bars", "ohlcv", "data", "results", "result", "items", "records"]) {
    const candidate = object[key];
    if (Array.isArray(candidate)) return candidate;
    const nested = findRows(candidate, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function normalizeCandle(value: unknown): Candle | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const ts = timestamp(firstValue(row, ["timestamp", "timeStamp", "datetime", "dateTime", "time", "date", "ts", "t"]));
  const open = finiteNumber(firstValue(row, ["open", "openPrice", "open_price", "o", "Open"]));
  const high = finiteNumber(firstValue(row, ["high", "highPrice", "high_price", "h", "High"]));
  const low = finiteNumber(firstValue(row, ["low", "lowPrice", "low_price", "l", "Low"]));
  const close = finiteNumber(firstValue(row, ["close", "closePrice", "close_price", "c", "Close"]));
  const volume = finiteNumber(firstValue(row, ["volume", "totalVolume", "total_volume", "v", "Volume"]));

  if (!ts || open === null || high === null || low === null || close === null) return null;
  if (open <= 0 || high <= 0 || low <= 0 || close <= 0) return null;
  if (high < Math.max(open, close, low) || low > Math.min(open, close, high)) return null;
  if (volume !== null && volume < 0) return null;
  return { timestamp: ts, open, high, low, close, volume };
}

export async function GET(request: Request) {
  let user: Awaited<ReturnType<typeof getLunaUser>>;
  try {
    user = await getLunaUser();
  } catch {
    return responseError("AUTH_BACKEND_NOT_CONFIGURED", 503);
  }
  if (!user) return responseError("AUTHENTICATION_REQUIRED", 401);
  if (!checkRate(user.id)) return responseError("RATE_LIMITED", 429, { "Retry-After": "60" });

  const requestUrl = new URL(request.url);
  const symbol = (requestUrl.searchParams.get("symbol") ?? "").trim().toUpperCase();
  const interval = requestUrl.searchParams.get("interval") ?? "15m";
  const rawLimit = Number(requestUrl.searchParams.get("limit") ?? DEFAULT_LIMIT);

  if (!/^[A-Z0-9]{2,12}$/.test(symbol)) return responseError("INVALID_SYMBOL", 400);
  if (!ALLOWED_SYMBOLS.has(symbol)) return responseError("SYMBOL_NOT_ALLOWED", 403);
  if (!ALLOWED_INTERVALS.has(interval)) return responseError("INVALID_INTERVAL", 400);
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > MAX_LIMIT) {
    return responseError("INVALID_LIMIT", 400);
  }

  const gatewayUrl = process.env.LUNA_GATEWAY_URL?.trim().replace(/\/$/, "");
  const gatewayKey = process.env.LUNA_GATEWAY_KEY?.trim();
  if (!gatewayUrl || !gatewayKey) return responseError("MARKET_HISTORY_NOT_CONFIGURED", 503);

  let upstream: Response;
  try {
    const target = new URL(`${gatewayUrl}/historical-candles/${encodeURIComponent(symbol)}`);
    target.searchParams.set("interval", interval);
    target.searchParams.set("limit", String(rawLimit));
    target.searchParams.set("normalized", "true");
    upstream = await fetch(target, {
      method: "GET",
      headers: { "x-luna-gateway": gatewayKey, accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    return responseError("MARKET_HISTORY_UPSTREAM_UNAVAILABLE", 503);
  }

  if (!upstream.ok) return responseError("MARKET_HISTORY_UPSTREAM_UNAVAILABLE", 503);
  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = await upstream.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return responseError("MARKET_HISTORY_INVALID_RESPONSE", 502);
    }
    payload = parsed as Record<string, unknown>;
  } catch {
    return responseError("MARKET_HISTORY_INVALID_RESPONSE", 502);
  }

  if (payload.ok !== true || payload.source !== "settrade-open-api-historical" || String(payload.symbol ?? "").toUpperCase() !== symbol || String(payload.interval ?? "") !== interval) {
    return responseError("MARKET_HISTORY_SOURCE_UNVERIFIED", 502);
  }

  const rows = findRows(payload.data);
  if (!rows) return responseError("MARKET_HISTORY_OHLC_FORMAT_UNSUPPORTED", 502);
  const byTimestamp = new Map<string, Candle>();
  for (const row of rows) {
    const candle = normalizeCandle(row);
    if (candle) byTimestamp.set(candle.timestamp, candle);
  }
  const candles = [...byTimestamp.values()]
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .slice(-rawLimit);

  if (candles.length === 0) return responseError("MARKET_HISTORY_EMPTY_OR_INVALID", 502);

  return NextResponse.json(
    {
      ok: true,
      source: "settrade-open-api-historical",
      symbol,
      interval,
      ...(typeof payload.fetched_at === "string" && timestamp(payload.fetched_at) !== null
        ? { fetched_at: new Date(timestamp(payload.fetched_at)!).toISOString() }
        : {}),
      bars: candles,
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
