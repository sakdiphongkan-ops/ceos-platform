"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Activity, AlertTriangle, ArrowDownRight, ArrowUpRight, Clock3, RefreshCw,
  ShieldCheck, Wallet, Waves, FlaskConical, LockKeyhole, CircleCheck,
} from "lucide-react";
import { fetchPortfolioState, type LunaFeed } from "../../../lib/luna-client";
import { LUNA_STRATEGY } from "../../../lib/luna-runtime";
import MarketHistoryPanel from "../market-history-panel";
import styles from "./unified.module.css";

type Payload = LunaFeed & Record<string, any>;

const hasNumericValue = (value: unknown) =>
  value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));

const money = (value: unknown) => {
  if (!hasNumericValue(value)) return "—";
  return Number(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
};
const count = (value: unknown) => {
  if (!hasNumericValue(value)) return "—";
  return Number(value).toLocaleString("en-US");
};
const localTime = (value: unknown) => {
  if (!value || !Number.isFinite(Date.parse(String(value)))) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok", day: "2-digit", month: "short",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).format(new Date(String(value)));
};
const ageLabel = (value: unknown) => {
  if (!hasNumericValue(value)) return "Unknown age";
  const n = Number(value);
  if (n < 0) return "Unknown age";
  if (n < 1000) return `${Math.round(n)} ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(1)} sec`;
  if (n < 3_600_000) return `${(n / 60_000).toFixed(1)} min`;
  if (n < 86_400_000) return `${(n / 3_600_000).toFixed(1)} hr`;
  return `${(n / 86_400_000).toFixed(1)} days`;
};

export default function LunaUnifiedPrototypePage() {
  const [feed, setFeed] = useState<Payload | null>(null);
  const [runtime, setRuntime] = useState<Record<string, any> | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError("");
    try {
      const asOf = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit",
      }).format(new Date());
      const result = await fetchPortfolioState(asOf);
      setFeed(result.feed as Payload);
      setRuntime(result.runtime as Record<string, any>);
      setUpdatedAt(new Date().toISOString());
    } catch (e) {
      setError(e instanceof Error ? e.message : "LUNA API request failed");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const portfolio = feed?.portfolio ?? runtime?.portfolio ?? null;
  const paper = feed?.paper_live ?? runtime?.paper_live ?? runtime?.runtime_status ?? null;
  const readiness = feed?.system_readiness ?? runtime?.system_readiness ?? null;
  const market = feed?.market_feed ?? runtime?.market_feed ?? null;
  const positions = Array.isArray(feed?.positions) ? feed.positions : [];
  const orders = Array.isArray(feed?.orders) ? feed.orders : [];
  const signals = Array.isArray(feed?.signals) ? feed.signals : [];
  const decisions = Array.isArray(feed?.decision_audit) ? feed.decision_audit : [];
  const blockers = Array.isArray(readiness?.blockers) ? readiness.blockers : [];
  const marketField = Array.isArray(feed?.market_field) ? feed.market_field : [];
  const verifiedMarkBySymbol = new Map<string, any>(
    marketField
      .filter((row: any) => {
        const quoteTs = Date.parse(String(row.last_quote_ts ?? ""));
        const ageMs = Date.now() - quoteTs;
        return row.verified === true
          && hasNumericValue(row.bid)
          && Number.isFinite(quoteTs)
          && ageMs >= -30_000
          && ageMs <= 60_000;
      })
      .map((row: any) => [String(row.symbol ?? "").toUpperCase(), row]),
  );
  const runtimeStatus = String(paper?.status ?? "STATUS UNKNOWN").replaceAll("_", " ");
  const readinessStatus = String(readiness?.status ?? "UNKNOWN").replaceAll("_", " ");
  const headlineStatus = readiness?.status === "BLOCKED" || readiness?.status === "FAIL"
    ? readinessStatus
    : runtimeStatus;
  const isVerified = readiness?.status === "READY_FOR_PAPER_ONLY" && market?.verified_realtime === true;
  const isBlocked = readiness?.status === "BLOCKED" || readiness?.status === "FAIL";
  const feedStatus = String(market?.status ?? "NO CURRENT SNAPSHOT").replaceAll("_", " ");

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <div className={styles.brandMark}>L</div>
          <div><div className={styles.eyebrow}>LUNA / MISSION CONTROL</div><h1>Unified Control Room</h1></div>
        </div>
        <div className={styles.headerActions}>
          <span className={styles.readOnly}><LockKeyhole size={13}/> READ-ONLY PROTOTYPE</span>
          <button className={styles.refresh} onClick={() => void refresh()} disabled={refreshing} type="button">
            <RefreshCw size={15} className={refreshing ? styles.spin : ""}/>{refreshing ? "Refreshing" : "Refresh"}
          </button>
        </div>
      </header>

      <section className={styles.hero}>
        <div>
          <div className={styles.eyebrow}>SYSTEM OVERVIEW · {LUNA_STRATEGY}</div>
          <h2>Research with evidence.<br/><span>Execution with guardrails.</span></h2>
          <p>One view across market data, paper portfolio, research decisions and safety gates. Existing LUNA services and tables remain the source of truth.</p>
          <div className={styles.chips}>
            <span className={styles.locked}><ShieldCheck size={14}/> PAPER ONLY</span>
            <span className={styles.locked}><LockKeyhole size={14}/> LIVE BROKER LOCKED</span>
            <span className={styles.neutral}><Clock3 size={14}/> Updated {localTime(updatedAt)}</span>
          </div>
        </div>
        <div className={styles.statusPanel}>
          <div className={styles.statusTop}><span className={styles.eyebrow}>SYSTEM STATUS</span><span className={`${styles.dot} ${isVerified ? styles.green : isBlocked ? styles.red : styles.amber}`}/></div>
          <strong>{headlineStatus}</strong>
          <span className={styles.muted}>Paper runtime: {runtimeStatus} · readiness is evaluated separately</span>
          <div className={styles.statusDivider}/>
          <div className={styles.statusRow}><span>Market feed</span><b>{feedStatus}</b></div>
          <div className={styles.statusRow}><span>Latest quote age</span><b>{ageLabel(market?.latest_age_ms)}</b></div>
          <div className={styles.statusRow}><span>Source</span><b>{market?.latest_source ?? "—"}</b></div>
        </div>
      </section>

      {error && <div className={styles.error} role="alert"><AlertTriangle size={17}/><div><b>Could not refresh LUNA data</b><span>{error}. Last successful response, if any, is retained on screen.</span></div></div>}

      <section className={styles.section}>
        <div className={styles.sectionHead}><div><div className={styles.eyebrow}>01 / MARKET FIELD</div><h3>Market data, without invented candles</h3></div><span className={styles.sectionMeta}>{marketField.length ? `${marketField.length} market rows returned` : "No current market rows reported"}</span></div>
        <MarketHistoryPanel />
        <div className={styles.marketRows}>
          {marketField.slice(0, 8).map((row: any, i: number) => (
            <div className={styles.marketRow} key={String(row.symbol ?? i)}>
              <div>
                <b>{row.symbol ?? "—"}</b>
                <span>{row.source ?? "Source not reported"} · {row.verified === true ? "verified book" : "display only / unverified"}</span>
              </div>
              <strong>{!hasNumericValue(row.last ?? row.current_price) ? "—" : "฿" + money(row.last ?? row.current_price)}</strong>
              <span>{localTime(row.last_quote_ts ?? row.ts ?? row.source_ts)}</span>
              <span className={row.verified === true && hasNumericValue(row.bid) && hasNumericValue(row.ask) ? styles.goodText : styles.muted}>
                {hasNumericValue(row.bid) && hasNumericValue(row.ask) ? `Bid ${money(row.bid)} / Ask ${money(row.ask)}` : "Bid/ask unavailable"}
              </span>
            </div>
          ))}
          {!marketField.length && <div className={styles.empty}><Waves size={18}/><div><b>No current market snapshot in this response</b><span>The UI will not substitute old or sample prices. Verify the source feed before using signals.</span></div></div>}
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHead}><div><div className={styles.eyebrow}>02 / PAPER PORTFOLIO</div><h3>Capital, exposure and order history</h3></div><span className={styles.sectionMeta}>Read-only · no order controls</span></div>
        <div className={styles.metrics}>
          <Metric icon={<Wallet size={17}/>} label="Available cash" value={portfolio?.available_cash == null ? "—" : "฿" + money(portfolio.available_cash)} detail={portfolio?.data_status ?? "Source not reported"}/>
          <Metric icon={<Activity size={17}/>} label="Market value" value={portfolio?.market_value == null ? "—" : "฿" + money(portfolio.market_value)} detail={portfolio?.valuation_status ?? "Valuation not reported"}/>
          <Metric icon={<ArrowUpRight size={17}/>} label="Realized P/L" value={portfolio?.realized_pnl == null ? "—" : "฿" + money(portfolio.realized_pnl)} detail="Paper ledger value"/>
          <Metric icon={<FlaskConical size={17}/>} label="Paper orders" value={count(feed?.counts?.paper_live_orders_total ?? paper?.orders_total ?? orders.length)} detail={`${positions.length} positions returned`}/>
        </div>
        <div className={styles.tableWrap}>
          <div className={styles.tableTitle}><b>Open positions</b><span>{positions.length} returned by API</span></div>
          {positions.length ? <table><thead><tr><th>Symbol</th><th>Qty</th><th>Avg cost</th><th>Verified bid mark</th><th>Realized P/L</th></tr></thead><tbody>
            {positions.slice(0, 10).map((p: any, i: number) => {
              const mark = verifiedMarkBySymbol.get(String(p.symbol ?? "").toUpperCase());
              return <tr key={String(p.symbol ?? i)}>
                <td><b>{p.symbol ?? "—"}</b></td>
                <td>{count(p.qty)}</td>
                <td>{p.avg_price == null && p.avgCost == null ? "—" : "฿" + money(p.avg_price ?? p.avgCost)}</td>
                <td>{mark ? "฿" + money(mark.bid) : "—"}</td>
                <td className={Number(p.realized_pnl ?? p.realized ?? 0) >= 0 ? styles.goodText : styles.badText}>฿{money(p.realized_pnl ?? p.realized)}</td>
              </tr>;
            })}
          </tbody></table> : <div className={styles.empty}>No open positions were returned by the current API response.</div>}
        </div>
        <div className={styles.tableWrap}>
          <div className={styles.tableTitle}><b>Latest paper orders</b><span>{orders.length} returned by API</span></div>
          {orders.length ? <table><thead><tr><th>Time</th><th>Symbol</th><th>Side</th><th>Qty filled</th><th>Status</th><th>Reason</th></tr></thead><tbody>
            {orders.slice(0, 8).map((o: any, i: number) => <tr key={String(o.id ?? i)}><td>{localTime(o.filled_at ?? o.created_at)}</td><td><b>{o.symbol ?? "—"}</b></td><td className={o.side === "BUY" ? styles.goodText : styles.badText}>{o.side ?? "—"}</td><td>{count(o.qty_filled ?? o.filled_qty ?? 0)}</td><td>{o.status ?? "—"}</td><td>{o.reason ?? "—"}</td></tr>)}
          </tbody></table> : <div className={styles.empty}>No paper orders returned. This is not interpreted as proof that the engine is healthy.</div>}
        </div>
      </section>

      <section className={styles.bottomGrid}>
        <div className={styles.section}>
          <div className={styles.sectionHead}><div><div className={styles.eyebrow}>03 / DECISION STREAM</div><h3>Signals and audit trail</h3></div></div>
          <div className={styles.tableWrap}>
            <div className={styles.tableTitle}><b>Latest signals</b><span>{signals.length} returned</span></div>
            {signals.length ? signals.slice(0, 6).map((s: any, i: number) => <div className={styles.eventRow} key={String(s.id ?? i)}><span className={styles.eventTime}>{localTime(s.ts ?? s.created_at)}</span><b>{s.symbol ?? "—"}</b><span className={String(s.action).includes("BUY") ? styles.goodText : String(s.action).includes("SELL") ? styles.badText : ""}>{s.action ?? "—"}</span><span className={styles.eventReason}>{s.reason ?? "Reason not returned"}</span></div>) : <div className={styles.empty}>No signals returned by the current API response.</div>}
          </div>
          <div className={styles.tableWrap}>
            <div className={styles.tableTitle}><b>Decision audit</b><span>{decisions.length} returned</span></div>
            {decisions.length ? decisions.slice(0, 6).map((d: any, i: number) => <div className={styles.eventRow} key={String(d.symbol ?? i)}><span className={styles.eventTime}>{localTime(d.bar_end)}</span><b>{d.symbol ?? "—"}</b><span>{d.candidate_action ?? "—"}</span><span className={d.execution_blocked ? styles.badText : styles.goodText}>{d.execution_blocked ? "BLOCKED" : "NOT BLOCKED"}</span></div>) : <div className={styles.empty}>No decision audit rows returned.</div>}
          </div>
        </div>

        <div className={styles.section}>
          <div className={styles.sectionHead}><div><div className={styles.eyebrow}>04 / SAFETY GATES</div><h3>Readiness before action</h3></div></div>
          <div className={styles.gateBanner}><ShieldCheck size={19}/><div><b>{readiness?.status ?? "READINESS UNKNOWN"}</b><span>UI-only view. Execution authority remains backend-controlled.</span></div></div>
          <div className={styles.gateRow}><span>Execution mode</span><b>{feed?.execution_control?.execution_mode ?? "—"}</b></div>
          <div className={styles.gateRow}><span>Execution armed</span><b>{feed?.execution_control?.armed === true ? "YES" : feed?.execution_control?.armed === false ? "NO" : "UNKNOWN"}</b></div>
          <div className={styles.gateRow}><span>Kill switch</span><b>{feed?.execution_control?.kill_switch === true ? "ON" : feed?.execution_control?.kill_switch === false ? "OFF" : "UNKNOWN"}</b></div>
          <div className={styles.gateRow}><span>Paper only flag</span><b>{paper?.paper_only === true ? "CONFIRMED" : paper?.paper_only === false ? "NOT CONFIRMED" : "UNKNOWN"}</b></div>
          <div className={styles.gateRow}><span>Live execution permitted</span><b className={styles.badText}>{readiness?.live_execution_permitted === true ? "API REPORTS ENABLED — INVESTIGATE" : readiness?.live_execution_permitted === false ? "NO" : "UNKNOWN"}</b></div>
          <div className={styles.blockersTitle}><AlertTriangle size={15}/> Current blockers</div>
          {blockers.length ? blockers.map((b: any, i: number) => <div className={styles.blocker} key={String(b) + i}>{String(b).replaceAll("_", " ")}</div>) : <div className={styles.empty}><CircleCheck size={16}/> No blocker list returned; this does not itself certify readiness.</div>}
          <div className={styles.disclaimer}>LIVE BROKER LOCKED is a design-level guardrail in this prototype. No broker action is implemented here. Do not enable live trading based on this page.</div>
        </div>
      </section>

      <footer className={styles.footer}><span>LUNA · Unified UI prototype</span><span>Source: existing LUNA API / Supabase · no seeded market values</span><span>API generated {localTime(feed?.generated_at)}</span></footer>
      {loading && !feed && <div className={styles.loading} role="status">Connecting to existing LUNA API…</div>}
    </main>
  );
}

function Metric({icon,label,value,detail}:{icon:React.ReactNode;label:string;value:string;detail:string}) {
  return <div className={styles.metric}><div className={styles.metricIcon}>{icon}</div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}
