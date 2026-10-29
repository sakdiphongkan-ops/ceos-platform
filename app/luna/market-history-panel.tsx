"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, BarChart3, RefreshCw } from "lucide-react";
import Link from "next/link";
import { fetchMarketBars, type LunaHistoricalBar } from "../../lib/luna-client";

const SYMBOLS = ["PTT", "ADVANC", "AOT", "CPALL", "BDMS", "KBANK", "SCB", "DELTA", "GULF", "KTB"] as const;
const INTERVALS = [
  { value: "1m", label: "1m" },
  { value: "5m", label: "5m" },
  { value: "15m", label: "15m" },
  { value: "60m", label: "1h" },
] as const;

type Interval = (typeof INTERVALS)[number]["value"];

function errorText(code: string | undefined): string {
  switch (code) {
    case "AUTHENTICATION_REQUIRED":
      return "Sign in or create a LUNA account to load source-verified historical bars from the authorized SETTRADE gateway. New accounts must confirm their email first.";
    case "MARKET_HISTORY_NOT_CONFIGURED":
      return "The historical SETTRADE gateway is not configured in this environment.";
    case "MARKET_HISTORY_UPSTREAM_UNAVAILABLE":
      return "SETTRADE historical data is temporarily unavailable.";
    case "MARKET_HISTORY_SOURCE_UNVERIFIED":
      return "The source or symbol returned by the historical API could not be verified.";
    case "MARKET_HISTORY_EMPTY_OR_INVALID":
      return "The historical API returned no valid OHLC bars. No chart has been fabricated.";
    case "MARKET_HISTORY_OHLC_FORMAT_UNSUPPORTED":
      return "The upstream candle format is not recognized yet. The data was withheld rather than guessed.";
    case "RATE_LIMITED":
      return "Chart requests are temporarily rate-limited. Please retry in a moment.";
    case "AUTH_BACKEND_NOT_CONFIGURED":
      return "Account authentication is not configured in this environment.";
    default:
      return code ? `Historical data unavailable (${code}).` : "Unable to retrieve verified historical bars.";
  }
}

function formatTime(value: string, withDate = false): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    ...(withDate ? { day: "2-digit", month: "short" } : {}),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

function money(value: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function ageLabel(ageMs: number | null): string {
  if (ageMs === null || !Number.isFinite(ageMs) || ageMs < 0) return "Unknown";
  if (ageMs < 60_000) return `${Math.round(ageMs / 1000)} sec`;
  if (ageMs < 3_600_000) return `${(ageMs / 60_000).toFixed(1)} min`;
  if (ageMs < 86_400_000) return `${(ageMs / 3_600_000).toFixed(1)} hr`;
  return `${(ageMs / 86_400_000).toFixed(1)} days`;
}

export default function MarketHistoryPanel() {
  const [symbol, setSymbol] = useState<string>("PTT");
  const [interval, setInterval] = useState<Interval>("15m");
  const [bars, setBars] = useState<LunaHistoricalBar[]>([]);
  const [source, setSource] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const requestSequence = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestSequence.current;
    setLoading(true);
    setError(null);
    try {
      const result = await fetchMarketBars(symbol, interval, 96);
      // Symbol/timeframe can change before an older response completes. Only the newest
      // request may update state, otherwise PTT data could appear under another symbol.
      if (requestId !== requestSequence.current) return;

      if (!result.ok || result.source !== "settrade-open-api-historical" || result.symbol !== symbol || result.interval !== interval || !Array.isArray(result.bars) || result.bars.length === 0) {
        setBars([]);
        setSource(null);
        setFetchedAt(null);
        setError(errorText(result.error ?? (result.source !== "settrade-open-api-historical" ? "MARKET_HISTORY_SOURCE_UNVERIFIED" : "MARKET_HISTORY_EMPTY_OR_INVALID")));
        return;
      }
      const normalized = result.bars.filter((bar) =>
        typeof bar.timestamp === "string"
        && Number.isFinite(Date.parse(bar.timestamp))
        && [bar.open, bar.high, bar.low, bar.close].every((price) => Number.isFinite(price) && price > 0)
        && bar.high >= Math.max(bar.open, bar.close, bar.low)
        && bar.low <= Math.min(bar.open, bar.close, bar.high)
      );
      if (normalized.length === 0) {
        setBars([]);
        setSource(null);
        setFetchedAt(null);
        setError(errorText("MARKET_HISTORY_EMPTY_OR_INVALID"));
        return;
      }
      setBars(normalized);
      setSource(result.source);
      setFetchedAt(result.fetched_at ?? null);
    } catch {
      if (requestId !== requestSequence.current) return;
      setBars([]);
      setSource(null);
      setFetchedAt(null);
      setError(errorText(undefined));
    } finally {
      if (requestId === requestSequence.current) setLoading(false);
    }
  }, [interval, symbol]);

  useEffect(() => {
    void load();
    return () => {
      // Invalidate any in-flight request when symbol/timeframe changes or panel unmounts.
      requestSequence.current += 1;
    };
  }, [load, retryToken]);

  useEffect(() => {
    if (!source || error) return;
    const timer = window.setInterval(() => { void load(); }, 60_000);
    return () => window.clearInterval(timer);
  }, [error, load, source]);

  const latest = bars[bars.length - 1];
  const latestTimestampMs = latest ? Date.parse(latest.timestamp) : NaN;
  const latestBarAgeMs = latest && Number.isFinite(latestTimestampMs)
    ? Math.max(0, Date.now() - latestTimestampMs)
    : null;
  const previous = bars.length > 1 ? bars[bars.length - 2] : undefined;
  const change = latest && previous ? latest.close - previous.close : null;
  const changePct = latest && previous && previous.close > 0 ? (latest.close / previous.close - 1) * 100 : null;
  const chartBars = useMemo(() => bars.slice(-72), [bars]);

  return (
    <section className="market-history-card" aria-labelledby="luna-market-history-title">
      <div className="market-history-head">
        <div>
          <div className="market-history-kicker"><BarChart3 size={14}/> MARKET REFERENCE · HISTORICAL OHLC</div>
          <h3 id="luna-market-history-title">{symbol} · SET</h3>
          <p>Source-verified historical candles from the authorized SETTRADE gateway. This panel never synthesizes missing candles.</p>
        </div>
        <div className={"market-history-connection " + (source ? "connected" : "unavailable")}>
          <span className="market-history-dot" />{source ? "SOURCE VERIFIED · HISTORICAL" : loading ? "LOADING SOURCE" : "DATA UNAVAILABLE"}
        </div>
      </div>

      <div className="market-history-toolbar">
        <label className="market-history-symbol">
          <span>Symbol</span>
          <select value={symbol} onChange={(event) => setSymbol(event.target.value)} aria-label="Select Thai equity symbol">
            {SYMBOLS.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        <div className="market-history-intervals" role="group" aria-label="Candle timeframe">
          {INTERVALS.map((item) => (
            <button key={item.value} type="button" className={interval === item.value ? "active" : ""} onClick={() => setInterval(item.value)}>
              {item.label}
            </button>
          ))}
        </div>
        <button className="market-history-refresh" type="button" onClick={() => setRetryToken((value) => value + 1)} disabled={loading} aria-label="Refresh historical candles">
          <RefreshCw size={14}/><span>{loading ? "Loading" : "Refresh"}</span>
        </button>
      </div>

      {error ? (
        <div className="market-history-empty" role="status">
          <AlertTriangle size={18}/>
          <div>
            <strong>Verified candles not available</strong>
            <span>{error}</span>
            {error === errorText("AUTHENTICATION_REQUIRED") && (
              <div className="mt-3 flex flex-wrap gap-2">
                <Link
                  href={"/luna/login?next=" + encodeURIComponent("/luna")}
                  className="inline-flex min-h-10 w-fit items-center justify-center rounded-xl border border-[#d8d8d0] bg-white px-4 text-sm font-medium text-[#33362f] transition hover:bg-[#f7f7f4] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#616d62]"
                >
                  Sign in to LUNA
                </Link>
                <Link
                  href={"/luna/login?mode=signup&next=" + encodeURIComponent("/luna")}
                  className="inline-flex min-h-10 w-fit items-center justify-center rounded-xl border border-[#d8d8d0] bg-[#f7f7f4] px-4 text-sm font-medium text-[#33362f] transition hover:bg-[#efefe8] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#616d62]"
                >
                  Create a LUNA account
                </Link>
              </div>
            )}
          </div>
          <button type="button" onClick={() => setRetryToken((value) => value + 1)} disabled={loading}>Retry</button>
        </div>
      ) : (
        <>
          <div className="market-history-stats">
            <div><span>Latest historical close</span><strong>{latest ? "฿" + money(latest.close) : loading ? "Loading…" : "—"}</strong></div>
            <div><span>{interval} bar change</span><strong className={change === null ? "" : change >= 0 ? "positive" : "negative"}>{change === null ? "—" : `${change >= 0 ? "+" : "−"}฿${money(Math.abs(change))}`}</strong></div>
            <div><span>Change</span><strong className={changePct === null ? "" : changePct >= 0 ? "positive" : "negative"}>{changePct === null ? "—" : `${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%`}</strong></div>
            <div><span>Latest bar</span><strong>{latest ? formatTime(latest.timestamp, true) : "—"}</strong></div>
          </div>
          <div className="market-history-chart">
            {chartBars.length > 0 ? <CandlestickChart bars={chartBars} symbol={symbol} interval={interval}/> : <div className="market-history-chart-loading">{loading ? "Loading historical candles…" : "No verified OHLC bars"}</div>}
          </div>
        </>
      )}

      <div className="market-history-footer">
        <span>Timeframe <strong>{interval === "60m" ? "1h" : interval}</strong> · Asia/Bangkok</span>
        <span>Source <strong>{source ?? "—"}</strong></span>
        <span>Fetched <strong>{fetchedAt ? formatTime(fetchedAt, true) : "—"}</strong></span>
        <span>Last bar age <strong>{ageLabel(latestBarAgeMs)}</strong></span>
        <span>{bars.length ? `${bars.length} validated bars` : "No validated bars"}</span>
      </div>
    </section>
  );
}

function CandlestickChart({bars, symbol, interval}:{bars:LunaHistoricalBar[];symbol:string;interval:Interval}) {
  const width = 900;
  const height = 270;
  const left = 12;
  const right = 12;
  const top = 14;
  const bottom = 30;
  const values = bars.flatMap((bar) => [bar.high, bar.low]);
  const maxPrice = Math.max(...values);
  const minPrice = Math.min(...values);
  const span = maxPrice - minPrice || Math.max(maxPrice * 0.005, 0.01);
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const slot = plotWidth / Math.max(bars.length, 1);
  const candleWidth = Math.max(2, Math.min(9, slot * 0.58));
  const y = (price: number) => top + ((maxPrice - price) / span) * plotHeight;
  const labelIndexes = Array.from(new Set([0, Math.floor((bars.length - 1) / 2), bars.length - 1]));

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-label={`${symbol} ${interval} SET historical candlestick chart, ${bars.length} verified bars`} preserveAspectRatio="none">
      {[0, 1, 2, 3].map((index) => {
        const gy = top + (plotHeight * index) / 3;
        const price = maxPrice - (span * index) / 3;
        return <g key={index}><line x1={left} y1={gy} x2={width - right} y2={gy} stroke="#e4e2da" strokeWidth="1"/><text x={width - right - 2} y={gy - 3} textAnchor="end" fill="#566156" fontSize="10">{money(price)}</text></g>;
      })}
      {bars.map((bar, index) => {
        const x = left + slot * index + slot / 2;
        const up = bar.close >= bar.open;
        const color = up ? "#527354" : "#9a4942";
        const bodyTop = Math.min(y(bar.open), y(bar.close));
        const bodyHeight = Math.max(1, Math.abs(y(bar.open) - y(bar.close)));
        return <g key={bar.timestamp}>
          <line x1={x} y1={y(bar.high)} x2={x} y2={y(bar.low)} stroke={color} strokeWidth="1.2"/>
          <rect x={x - candleWidth / 2} y={bodyTop} width={candleWidth} height={bodyHeight} fill={color} rx=".5"/>
        </g>;
      })}
      {labelIndexes.map((index) => {
        const x = left + slot * index + slot / 2;
        return <text key={bars[index].timestamp} x={x} y={height - 8} textAnchor={index === 0 ? "start" : index === bars.length - 1 ? "end" : "middle"} fill="#566156" fontSize="10">{formatTime(bars[index].timestamp)}</text>;
      })}
    </svg>
  );
}
