"use client";

import { useMemo, useState } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  ChevronDown,
  CircleDot,
  Clock3,
  Filter,
  History,
  Layers3,
  RefreshCw,
  Search,
  ShieldCheck,
  WalletCards,
  X,
} from "lucide-react";

type Position = {
  symbol: string;
  name: string;
  qty: number;
  avgCost: number;
  last: number;
  dayChange: number;
  realized: number;
  signal: "BUY" | "SELL" | "HOLD";
  signalReason: string;
};

type Trade = {
  time: string;
  symbol: string;
  side: "BUY" | "SELL";
  qty: number;
  price: number;
  value: number;
  status: "FILLED" | "PARTIAL" | "REJECTED";
  strategy: string;
  reason: string;
};

const positions: Position[] = [
  { symbol: "PTT", name: "PTT PCL", qty: 12000, avgCost: 32.4, last: 33.1, dayChange: 1.12, realized: 0, signal: "BUY", signalReason: "Momentum + liquidity confirmation" },
  { symbol: "ADVANC", name: "Advanced Info Service", qty: 1200, avgCost: 285, last: 291, dayChange: 0.86, realized: 0, signal: "HOLD", signalReason: "Trend intact; no new entry edge" },
  { symbol: "WHAUP", name: "WHA Utilities & Power", qty: 15000, avgCost: 4.15, last: 4.28, dayChange: 1.67, realized: 0, signal: "BUY", signalReason: "Relative strength + volume expansion" },
  { symbol: "NER", name: "North East Rubber", qty: 4000, avgCost: 5.9, last: 6.05, dayChange: -0.33, realized: 0, signal: "SELL", signalReason: "Intraday weakness below exit threshold" },
];

const trades: Trade[] = [
  { time: "09:42:11", symbol: "PTT", side: "BUY", qty: 5000, price: 32.2, value: 161000, status: "FILLED", strategy: "TH1H-v1.3", reason: "Breakout confirmation" },
  { time: "10:14:32", symbol: "ADVANC", side: "BUY", qty: 1200, price: 285, value: 342000, status: "FILLED", strategy: "TH1H-v1.3", reason: "Relative strength" },
  { time: "11:03:18", symbol: "PTT", side: "SELL", qty: 2000, price: 33, value: 66000, status: "FILLED", strategy: "TH1H-v1.3", reason: "Partial risk reduction" },
  { time: "13:22:41", symbol: "NER", side: "SELL", qty: 4000, price: 6.05, value: 24200, status: "FILLED", strategy: "TH1H-v1.3", reason: "Exit signal" },
];

const closedPositions = [
  { symbol: "CPALL", entry: 58.2, exit: 57.4, qty: 3000, pnl: -2400, duration: "38m" },
  { symbol: "KBANK", entry: 168, exit: 171.5, qty: 1500, pnl: 5250, duration: "1h 12m" },
  { symbol: "BDMS", entry: 22.9, exit: 23.35, qty: 5000, pnl: 2250, duration: "54m" },
];

const money = (n: number) =>
  new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

const signed = (n: number) => `${n >= 0 ? "+" : "-"}฿${money(Math.abs(n))}`;

export default function LunaPortfolioPage() {
  const [tab, setTab] = useState<"holdings" | "trades" | "closed">("holdings");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Position | null>(positions[0]);
  const [live, setLive] = useState(false);

  const filteredPositions = useMemo(
    () => positions.filter((p) => `${p.symbol} ${p.name}`.toLowerCase().includes(query.toLowerCase())),
    [query]
  );

  const totalMarket = positions.reduce((s, p) => s + p.qty * p.last, 0);
  const totalCost = positions.reduce((s, p) => s + p.qty * p.avgCost, 0);
  const unrealized = totalMarket - totalCost;
  const cash = 1000000 - totalCost + 90000;
  const equity = cash + totalMarket;
  const exposure = (totalMarket / equity) * 100;

  return (
    <main className="luna-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">L</div>
          <div>
            <div className="eyebrow">LUNA-TH1H</div>
            <h1>Portfolio</h1>
          </div>
        </div>
        <div className="top-actions">
          <div className="market-status"><CircleDot size={11} /> SET / PAPER</div>
          <button className="icon-button" title="Refresh"><RefreshCw size={17} /></button>
          <div className="session-chip"><Clock3 size={14} /> 18 Sep 2026 · 13:29 ICT</div>
        </div>
      </header>

      <div className="page">
        <section className="hero-row">
          <div>
            <div className="eyebrow">INTRADAY CONTROL · LIVE PORTFOLIO</div>
            <h2>What LUNA owns right now</h2>
            <p>Holdings, executions, realized P&amp;L and risk exposure in one auditable view.</p>
          </div>
          <div className="safe-badge"><ShieldCheck size={15} /> PAPER / SAFE</div>
        </section>

        <section className="summary-grid">
          <Metric label="Total Equity" value={`฿${money(equity)}`} sub="+2.47% today" positive />
          <Metric label="Market Value" value={`฿${money(totalMarket)}`} sub={`${exposure.toFixed(1)}% exposure`} />
          <Metric label="Cash" value={`฿${money(cash)}`} sub="Available cash" />
          <Metric label="Unrealized P&L" value={signed(unrealized)} sub={`${((unrealized / totalCost) * 100).toFixed(2)}% on cost`} positive={unrealized >= 0} />
          <Metric label="Realized P&L" value="+฿5,100.00" sub="Closed positions" positive />
          <Metric label="Fees + Slippage" value="-฿1,284.00" sub="Execution cost" />
        </section>

        <section className="content-grid">
          <div className="main-card">
            <div className="card-head">
              <div>
                <div className="card-title">Portfolio positions</div>
                <div className="card-subtitle">{positions.length} open positions · max 20% / symbol</div>
              </div>
              <div className="toolbar">
                <div className="search-box"><Search size={15} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search symbol" /></div>
                <button className="filter-button"><Filter size={15} /> Filter <ChevronDown size={13} /></button>
              </div>
            </div>

            <div className="tabs">
              <button className={tab === "holdings" ? "active" : ""} onClick={() => setTab("holdings")}>Holdings <span>{positions.length}</span></button>
              <button className={tab === "trades" ? "active" : ""} onClick={() => setTab("trades")}>Today's Trades <span>{trades.length}</span></button>
              <button className={tab === "closed" ? "active" : ""} onClick={() => setTab("closed")}>Closed Positions <span>{closedPositions.length}</span></button>
            </div>

            {tab === "holdings" && (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>SYMBOL</th><th>QTY</th><th>AVG COST</th><th>LAST</th><th>MARKET VALUE</th><th>DAY P&amp;L</th><th>WEIGHT</th><th>SIGNAL</th></tr></thead>
                  <tbody>
                    {filteredPositions.map((p) => {
                      const value = p.qty * p.last;
                      const weight = (value / equity) * 100;
                      const pnl = p.qty * (p.last - p.avgCost);
                      return (
                        <tr key={p.symbol} className={selected?.symbol === p.symbol ? "selected-row" : ""} onClick={() => setSelected(p)}>
                          <td><div className="symbol-cell"><strong>{p.symbol}</strong><span>{p.name}</span></div></td>
                          <td>{money(p.qty).replace(".00", "")}</td>
                          <td>฿{p.avgCost.toFixed(2)}</td>
                          <td><strong>฿{p.last.toFixed(2)}</strong></td>
                          <td>฿{money(value)}</td>
                          <td className={pnl >= 0 ? "positive" : "negative"}>{signed(pnl)}</td>
                          <td><div className="weight-cell"><span>{weight.toFixed(1)}%</span><i><b style={{width: `${Math.min(weight / 20 * 100, 100)}%`}} /></i></div></td>
                          <td><SignalBadge signal={p.signal} /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {tab === "trades" && (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>TIME</th><th>SYMBOL</th><th>SIDE</th><th>QTY</th><th>PRICE</th><th>VALUE</th><th>STATUS</th><th>STRATEGY</th></tr></thead>
                  <tbody>
                    {trades.map((t) => (
                      <tr key={`${t.time}-${t.symbol}`}>
                        <td className="muted">{t.time}</td><td><strong>{t.symbol}</strong></td>
                        <td><SideBadge side={t.side} /></td><td>{money(t.qty).replace(".00", "")}</td><td>฿{t.price.toFixed(2)}</td><td>฿{money(t.value)}</td>
                        <td><StatusBadge status={t.status} /></td><td className="muted">{t.strategy}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {tab === "closed" && (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>SYMBOL</th><th>ENTRY</th><th>EXIT</th><th>QTY</th><th>REALIZED P&amp;L</th><th>HOLD TIME</th></tr></thead>
                  <tbody>
                    {closedPositions.map((p) => (
                      <tr key={p.symbol}><td><strong>{p.symbol}</strong></td><td>฿{p.entry.toFixed(2)}</td><td>฿{p.exit.toFixed(2)}</td><td>{money(p.qty).replace(".00", "")}</td><td className={p.pnl >= 0 ? "positive" : "negative"}>{signed(p.pnl)}</td><td className="muted">{p.duration}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <aside className="side-card">
            {selected ? (
              <>
                <div className="detail-head">
                  <div><div className="detail-symbol">{selected.symbol}</div><div className="muted">{selected.name}</div></div>
                  <button className="close-button" onClick={() => setSelected(null)}><X size={15} /></button>
                </div>
                <div className="price-block"><div>฿{selected.last.toFixed(2)}</div><span className="positive"><ArrowUpRight size={14} /> {selected.dayChange.toFixed(2)}%</span></div>

                <div className="detail-grid">
                  <Detail label="Position" value={`${money(selected.qty).replace(".00", "")} shares`} />
                  <Detail label="Avg Cost" value={`฿${selected.avgCost.toFixed(2)}`} />
                  <Detail label="Market Value" value={`฿${money(selected.qty * selected.last)}`} />
                  <Detail label="Unrealized P&L" value={signed(selected.qty * (selected.last - selected.avgCost))} positive={selected.last >= selected.avgCost} />
                  <Detail label="Portfolio Weight" value={`${((selected.qty * selected.last / equity) * 100).toFixed(1)}%`} />
                  <Detail label="Risk Limit" value="20.0%" />
                </div>

                <div className="section-label">CURRENT SIGNAL</div>
                <div className="signal-panel"><SignalBadge signal={selected.signal} large /><p>{selected.signalReason}</p></div>

                <div className="section-label">EXECUTION TIMELINE</div>
                <div className="timeline">
                  {trades.filter((t) => t.symbol === selected.symbol).map((t) => (
                    <div className="timeline-item" key={t.time}><div className={`timeline-dot ${t.side.toLowerCase()}`} /><div><strong>{t.side} {money(t.qty).replace(".00", "")} @ ฿{t.price.toFixed(2)}</strong><span>{t.time} · {t.reason}</span></div></div>
                  ))}
                  <div className="timeline-item future"><div className="timeline-dot" /><div><strong>Position currently open</strong><span>Marked at latest executable price</span></div></div>
                </div>

                <div className="audit-strip"><Layers3 size={15} /><span>Execution → Position → Snapshot → Audit event</span></div>
              </>
            ) : <div className="empty-detail">Select a position to inspect it.</div>}
          </aside>
        </section>

        <section className="bottom-grid">
          <div className="mini-card"><div className="mini-title"><BarChart3 size={16} /> Exposure by position</div><div className="bars">{positions.map(p => <div className="bar-row" key={p.symbol}><span>{p.symbol}</span><i><b style={{width: `${Math.min((p.qty * p.last / equity) * 5, 100)}%`}} /></i><strong>{((p.qty * p.last / equity) * 100).toFixed(1)}%</strong></div>)}</div></div>
          <div className="mini-card"><div className="mini-title"><History size={16} /> Session controls</div><div className="control-list"><div><span>Strategy</span><strong>TH1H-v1.3</strong></div><div><span>Initial capital</span><strong>฿1,000,000</strong></div><div><span>Gross exposure</span><strong>{exposure.toFixed(1)}% / 100%</strong></div><div><span>End of day</span><strong>FORCE CLOSE</strong></div></div><button className={`live-toggle ${live ? "on" : ""}`} onClick={() => setLive(!live)}>{live ? "Live feed connected" : "Connect live feed"}<CircleDot size={13} /></button></div>
          <div className="mini-card"><div className="mini-title"><WalletCards size={16} /> Audit integrity</div><div className="audit-score"><strong>READY</strong><span>Every fill can be reconciled to an order, signal and portfolio snapshot.</span></div><div className="hash-line">hash chain · enabled</div></div>
        </section>
      </div>

      <style jsx>{`
        .luna-shell{min-height:100vh;background:#07100c;color:#edf7f1;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
        .topbar{height:70px;border-bottom:1px solid #173126;background:#08130e;display:flex;align-items:center;justify-content:space-between;padding:0 28px;position:sticky;top:0;z-index:20}
        .brand{display:flex;align-items:center;gap:11px}.brand-mark{width:31px;height:31px;border:1px solid #2d6a50;border-radius:9px;display:grid;place-items:center;font-weight:800;color:#a7f3d0}.eyebrow{font-size:10px;letter-spacing:2.2px;color:#77b99a;font-weight:700}.brand h1{font-size:18px;margin:2px 0 0}.top-actions{display:flex;gap:10px;align-items:center}.market-status,.session-chip,.safe-badge{border:1px solid #244735;background:#0c1b14;border-radius:999px;padding:7px 11px;font-size:11px;color:#9bd3b5;display:flex;align-items:center;gap:7px}.market-status svg{color:#54d18b}.icon-button,.close-button{background:#0c1b14;border:1px solid #244735;color:#a8c8b7;border-radius:9px;width:34px;height:34px;display:grid;place-items:center}.page{max-width:1480px;margin:0 auto;padding:30px 28px 44px}.hero-row{display:flex;justify-content:space-between;align-items:end;margin-bottom:24px}.hero-row h2{font-size:30px;letter-spacing:-.7px;margin:7px 0 5px}.hero-row p{color:#88a998;margin:0;font-size:13px}.safe-badge{color:#8be6ae;border-color:#2d6548}.summary-grid{display:grid;grid-template-columns:repeat(6,1fr);gap:10px;margin-bottom:18px}.metric{background:#0b1913;border:1px solid #183629;border-radius:13px;padding:15px 16px;min-height:89px}.metric-label{font-size:10px;text-transform:uppercase;letter-spacing:1.1px;color:#739a88}.metric-value{font-size:19px;font-weight:750;margin:9px 0 4px;letter-spacing:-.2px}.metric-sub{font-size:10px;color:#759384}.metric-sub.positive,.positive{color:#5cdb92}.negative{color:#f08383}.content-grid{display:grid;grid-template-columns:minmax(0,1fr) 350px;gap:14px;align-items:start}.main-card,.side-card,.mini-card{background:#0a1711;border:1px solid #183629;border-radius:14px;overflow:hidden}.card-head{padding:18px 19px 14px;display:flex;justify-content:space-between;gap:16px;align-items:center}.card-title{font-size:15px;font-weight:750}.card-subtitle{font-size:11px;color:#719184;margin-top:4px}.toolbar{display:flex;gap:8px}.search-box{display:flex;align-items:center;gap:7px;border:1px solid #244435;background:#07110c;border-radius:8px;padding:0 10px;color:#658b79}.search-box input{width:145px;background:transparent;border:0;outline:0;color:#dcebe3;font-size:11px;padding:8px 0}.filter-button{border:1px solid #244435;background:#0d1e16;color:#9ab9aa;border-radius:8px;font-size:11px;padding:0 10px;display:flex;gap:6px;align-items:center}.tabs{display:flex;border-top:1px solid #142b20;border-bottom:1px solid #183629;padding:0 19px}.tabs button{background:transparent;border:0;color:#6f9181;font-size:11px;padding:13px 15px 11px 0;margin-right:18px;border-bottom:2px solid transparent;cursor:pointer}.tabs button.active{color:#d8eee2;border-color:#67d89a}.tabs span{margin-left:5px;background:#142a20;padding:2px 5px;border-radius:4px;color:#82a894;font-size:9px}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;min-width:850px}th{font-size:9px;letter-spacing:1px;color:#638373;text-align:right;padding:11px 14px;border-bottom:1px solid #142b20;font-weight:700}th:first-child,td:first-child{text-align:left;padding-left:19px}td{padding:13px 14px;border-bottom:1px solid #11271d;text-align:right;font-size:11px;color:#b7cdc1;white-space:nowrap}tbody tr{cursor:pointer;transition:.12s}tbody tr:hover,tbody tr.selected-row{background:#0e2018}.symbol-cell{display:flex;flex-direction:column;gap:3px}.symbol-cell strong{font-size:12px;color:#edf7f1}.symbol-cell span{font-size:9px;color:#678979}.weight-cell{display:flex;flex-direction:column;gap:4px;align-items:flex-end}.weight-cell i{display:block;width:52px;height:3px;background:#173126;border-radius:9px;overflow:hidden}.weight-cell b{display:block;height:100%;background:#55c98a;border-radius:9px}.side-card{padding:20px;min-height:500px}.detail-head{display:flex;justify-content:space-between}.detail-symbol{font-size:23px;font-weight:800;letter-spacing:-.4px}.price-block{display:flex;align-items:end;gap:9px;margin:15px 0 19px}.price-block>div{font-size:28px;font-weight:800}.price-block span{font-size:11px;padding-bottom:4px;display:flex;align-items:center}.close-button{display:none}.detail-grid{display:grid;grid-template-columns:1fr 1fr;border-top:1px solid #183629;border-bottom:1px solid #183629}.detail-item{padding:11px 0}.detail-item:nth-child(odd){padding-right:12px}.detail-item:nth-child(even){padding-left:12px;border-left:1px solid #183629}.detail-label{font-size:9px;text-transform:uppercase;letter-spacing:.7px;color:#668878}.detail-value{font-size:12px;margin-top:4px;color:#d5e7dd;font-weight:650}.section-label{font-size:9px;letter-spacing:1.1px;color:#648575;margin:18px 0 8px}.signal-panel{border:1px solid #1e4935;background:#0c1c15;border-radius:9px;padding:11px}.signal-panel p{font-size:10px;color:#87a998;line-height:1.45;margin:8px 0 0}.signal-badge,.side-badge,.status-badge{display:inline-flex;align-items:center;gap:5px;border-radius:5px;padding:4px 6px;font-size:9px;font-weight:800;letter-spacing:.5px}.signal-badge.buy,.side-badge.buy{color:#63df98;background:#0d2a1c}.signal-badge.sell,.side-badge.sell{color:#f28b8b;background:#2a1515}.signal-badge.hold{color:#e5c56f;background:#2a2313}.signal-badge.large{font-size:10px;padding:5px 7px}.status-badge.filled{color:#83dca7;background:#10281b}.status-badge.partial{color:#e2c875;background:#2a2515}.status-badge.rejected{color:#f28b8b;background:#2a1515}.timeline{display:flex;flex-direction:column;gap:12px}.timeline-item{display:flex;gap:9px}.timeline-dot{width:7px;height:7px;border-radius:50%;margin-top:4px;background:#456b58;flex:none}.timeline-dot.buy{background:#55d993}.timeline-dot.sell{background:#ef7c7c}.timeline-item strong{font-size:10px;display:block}.timeline-item span{font-size:9px;color:#6d8e7e;display:block;margin-top:2px}.audit-strip{display:flex;gap:7px;align-items:center;margin-top:19px;padding:9px;background:#09140f;border:1px solid #173126;border-radius:8px;color:#6f9682;font-size:9px}.bottom-grid{display:grid;grid-template-columns:1.2fr 1fr 1fr;gap:14px;margin-top:14px}.mini-card{padding:17px}.mini-title{display:flex;align-items:center;gap:7px;font-size:12px;font-weight:700;margin-bottom:15px}.mini-title svg{color:#76d69c}.bars{display:flex;flex-direction:column;gap:10px}.bar-row{display:grid;grid-template-columns:55px 1fr 43px;gap:8px;align-items:center;font-size:10px;color:#8eab9d}.bar-row i{height:5px;background:#162d22;border-radius:10px;overflow:hidden}.bar-row b{height:100%;display:block;background:#4cbb81}.bar-row strong{text-align:right;font-size:10px;color:#b9d2c5}.control-list{display:flex;flex-direction:column;gap:9px}.control-list div{display:flex;justify-content:space-between;font-size:10px}.control-list span{color:#6c8d7d}.control-list strong{color:#b9d0c4}.live-toggle{width:100%;margin-top:15px;border:1px solid #2a6146;background:#0c1f16;color:#8eddb0;border-radius:8px;padding:8px;font-size:10px;display:flex;justify-content:space-between;align-items:center;cursor:pointer}.live-toggle.on{background:#12301f}.audit-score{display:flex;flex-direction:column;gap:6px}.audit-score strong{color:#64d996;font-size:16px}.audit-score span{color:#79998a;font-size:10px;line-height:1.5}.hash-line{margin-top:15px;padding-top:10px;border-top:1px solid #183629;color:#5d7e6e;font-size:9px;letter-spacing:.6px}.muted{color:#6d8c7d}.empty-detail{height:450px;display:grid;place-items:center;color:#6c8c7c;font-size:12px}
        @media(max-width:1100px){.summary-grid{grid-template-columns:repeat(3,1fr)}.content-grid{grid-template-columns:1fr}.side-card{order:-1}.bottom-grid{grid-template-columns:1fr 1fr}.top-actions .session-chip{display:none}}
        @media(max-width:700px){.topbar{padding:0 15px}.page{padding:22px 14px}.hero-row{align-items:start;gap:12px}.hero-row h2{font-size:24px}.summary-grid{grid-template-columns:repeat(2,1fr)}.bottom-grid{grid-template-columns:1fr}.toolbar{display:none}.brand h1{font-size:16px}.safe-badge{font-size:9px}}
      `}
      </style>
    </main>
  );
}

function Metric({ label, value, sub, positive }: { label: string; value: string; sub: string; positive?: boolean }) {
  return <div className="metric"><div className="metric-label">{label}</div><div className="metric-value">{value}</div><div className={`metric-sub ${positive ? "positive" : ""}`}>{sub}</div></div>;
}

function Detail({ label, value, positive }: { label: string; value: string; positive?: boolean }) {
  return <div className="detail-item"><div className="detail-label">{label}</div><div className={`detail-value ${positive ? "positive" : ""}`}>{value}</div></div>;
}

function SignalBadge({ signal, large }: { signal: Position["signal"]; large?: boolean }) {
  const Icon = signal === "BUY" ? ArrowUpRight : signal === "SELL" ? ArrowDownRight : CircleDot;
  return <span className={`signal-badge ${signal.toLowerCase()} ${large ? "large" : ""}`}><Icon size={large ? 13 : 11} />{signal}</span>;
}

function SideBadge({ side }: { side: Trade["side"] }) {
  const Icon = side === "BUY" ? ArrowUpRight : ArrowDownRight;
  return <span className={`side-badge ${side.toLowerCase()}`}><Icon size={11} />{side}</span>;
}

function StatusBadge({ status }: { status: Trade["status"] }) {
  return <span className={`status-badge ${status.toLowerCase()}`}>{status}</span>;
}
