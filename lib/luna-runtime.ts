export type UiMarketPhase =
  | "PRE_OPEN"
  | "ACTIVE"
  | "BREAK"
  | "REDUCE_ONLY"
  | "FORCE_CLOSE"
  | "CLOSED";

export type RuntimeState = "ACTIVE" | "STANDBY" | "DEGRADED" | "OFFLINE";

export const LUNA_API =
  process.env.NEXT_PUBLIC_LUNA_API_URL ??
  "https://wigzicwgcsrhdummrbjx.supabase.co/functions/v1/luna-api";

export const LUNA_PUBLIC_MARKET_STREAM =
  process.env.NEXT_PUBLIC_LUNA_PUBLIC_MARKET_STREAM_URL ??
  "wss://luna-execution-gateway-production.up.railway.app/quotes/public-stream";

export const LUNA_STRATEGY = "luna-th1h-v1.4.0-15m-riskgated";
export const TIMEFRAME = "15m";
export const BANGKOK_TZ = "Asia/Bangkok";

const BANGKOK_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: BANGKOK_TZ,
  weekday: "short",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

export type BangkokParts = {
  weekday: string;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

export function bangkokParts(date: Date): BangkokParts {
  const parts = BANGKOK_FORMATTER.formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";

  return {
    weekday: value("weekday"),
    year: Number(value("year")),
    month: Number(value("month")),
    day: Number(value("day")),
    hour: Number(value("hour")),
    minute: Number(value("minute")),
    second: Number(value("second")),
  };
}

export function bangkokDate(date: Date): string {
  const parts = bangkokParts(date);
  return [
    parts.year,
    String(parts.month).padStart(2, "0"),
    String(parts.day).padStart(2, "0"),
  ].join("-");
}

export function bangkokClock(date: Date): string {
  const parts = bangkokParts(date);
  return [
    String(parts.hour).padStart(2, "0"),
    String(parts.minute).padStart(2, "0"),
    String(parts.second).padStart(2, "0"),
  ].join(":");
}

/**
 * UI-only market phase mirror. Execution authority remains backend-controlled.
 */
export function uiMarketPhase(date: Date): UiMarketPhase {
  const parts = bangkokParts(date);

  if (parts.weekday === "Sat" || parts.weekday === "Sun") {
    return "CLOSED";
  }

  const minutes = parts.hour * 60 + parts.minute;

  if (minutes < 600) return "PRE_OPEN";
  if (minutes < 750) return "ACTIVE";
  if (minutes < 840) return "BREAK";
  if (minutes < 980) return "ACTIVE";
  if (minutes < 985) return "REDUCE_ONLY";
  if (minutes < 990) return "FORCE_CLOSE";
  return "CLOSED";
}

export function marketPhaseLabel(phase: UiMarketPhase): string {
  return {
    PRE_OPEN: "PRE-OPEN",
    ACTIVE: "MARKET OPEN",
    BREAK: "MIDDAY BREAK",
    REDUCE_ONLY: "REDUCE ONLY",
    FORCE_CLOSE: "FORCE CLOSE",
    CLOSED: "MARKET CLOSED",
  }[phase];
}

export function marketPhaseHint(phase: UiMarketPhase): string {
  return {
    PRE_OPEN: "Entry locked until 10:00",
    ACTIVE: "New entries enabled",
    BREAK: "Entry locked · afternoon pre-open",
    REDUCE_ONLY: "BUY locked · SELL allowed",
    FORCE_CLOSE: "Closing positions only",
    CLOSED: "No new execution",
  }[phase];
}

export function isRealtimeFresh(timestampMs: number | null, maxAgeMs = 5_000): boolean {
  return timestampMs != null && Date.now() - timestampMs <= maxAgeMs;
}
