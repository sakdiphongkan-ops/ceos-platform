"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, RefreshCw, AlertTriangle } from "lucide-react";
import { fetchTournament100, type Tournament100Result } from "../../../../lib/luna-client";

const fmt = (value: unknown) => value == null || value === "" || !Number.isFinite(Number(value)) ? "—" : Number(value).toFixed(2);

export default function QuantResearchPage() {
  const [data,setData] = useState<Tournament100Result | null>(null);
  const [loading,setLoading] = useState(true);
  const [error,setError] = useState("");
  const [showAll,setShowAll] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await fetchTournament100("signal","full");
      setData(result);
      setShowAll(false);
    } catch (e) {
      setData(null);
      setError(e instanceof Error ? e.message : "Unable to load formula research results");
    } finally {
      setLoading(false);
    }
  },[]);

  useEffect(() => { void load(); },[load]);

  const rows = useMemo(() => showAll ? (data?.allResults ?? []) : (data?.top20 ?? []),[data,showAll]);

  return (
    <main className="mx-auto max-w-7xl px-5 py-10 sm:px-8">
      <Link href="/luna/research" className="inline-flex items-center gap-2 text-xs text-[#777970]"><ArrowLeft size={14}/> Research workspaces</Link>
      <div className="mt-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-xs font-semibold tracking-[.25em] text-[#777970]">RESEARCH / QUANT LAB</div>
          <h1 className="mt-3 text-3xl font-medium">Formula Research</h1>
          <p className="mt-3 text-sm leading-6 text-[#66685f]">Results from the existing backtest API; costs and data coverage are shown from the response.</p>
        </div>
        <button onClick={() => void load()} disabled={loading} className="inline-flex items-center gap-2 rounded-2xl border border-[#d8d8d0] bg-white px-4 py-2.5 text-sm disabled:opacity-50">
          <RefreshCw size={15}/>{loading ? "Loading…" : "Refresh results"}
        </button>
      </div>

      {error && <div role="alert" className="mt-6 flex items-start gap-3 rounded-2xl border border-[#efd4d0] bg-[#fff7f5] p-4 text-sm text-[#8a3f35]"><AlertTriangle size={17}/><div className="flex-1">{error}</div><button className="underline" onClick={() => void load()}>Retry</button></div>}
      {loading && !data && !error && <div role="status" className="mt-6 rounded-2xl border border-[#deded6] bg-white p-6 text-sm text-[#777970]">Loading backtest results from the research API…</div>}
      {!loading && !data && !error && <div className="mt-6 rounded-2xl border border-[#deded6] bg-white p-6 text-sm text-[#777970]">No research result returned by the API.</div>}

      {data && (
        <>
          <div className="mt-7 rounded-3xl border border-[#e4d9bd] bg-white p-5">
            <div className="text-xs font-semibold tracking-[.14em] text-[#777970]">UNIVERSE COVERAGE · {data.data?.coverageStatus ?? "NOT REPORTED"}</div>
            <p className="mt-2 text-sm leading-6 text-[#66685f]">{data.data?.coverageMessage ?? "The API did not return a coverage statement. Treat this sample scope as unverified."}</p>
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Metric label="Strategies tested" value={String(data.strategiesTested ?? 0)} detail="Signal study"/>
            <Metric label="Symbols with bars" value={`${data.data?.symbolsReturned ?? 0}/${data.data?.universeCount ?? 0}`} detail={`No bars: ${data.data?.symbolsWithoutBars ?? "not reported"} · failed requests: ${data.data?.symbolsFailed ?? 0}`}/>
            <Metric label="Trading cost" value={`${data.rules?.costModelBps ?? "—"} bps`} detail="Fee + tax + slippage model"/>
            <Metric label="15m bars" value={String(data.data?.bars15m ?? "—")} detail={data.period ? `${data.period.start ?? "—"} → ${data.period.end ?? "—"}` : "Period not returned"}/>
          </div>
          <div className="mt-6 overflow-hidden rounded-3xl border border-[#deded6] bg-white">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#ecece5] p-5">
              <div><h2 className="font-medium">Backtest ranking</h2><p className="mt-1 text-xs text-[#777970]">Net basis points after the stated cost model</p></div>
              <button onClick={() => setShowAll(v=>!v)} className="rounded-xl border border-[#d8d8d0] px-3 py-2 text-xs">{showAll ? "Show top 20" : "Show all results"}</button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-left text-sm">
                <thead className="bg-[#f7f7f4] text-[10px] tracking-[.12em] text-[#777970]"><tr><th className="p-3">#</th><th className="p-3">FAMILY</th><th className="p-3">FORMULA</th><th className="p-3">SIGNALS</th><th className="p-3">WIN %</th><th className="p-3">AVG NET BPS</th><th className="p-3">MEDIAN</th><th className="p-3">PF</th><th className="p-3">TOTAL NET BPS</th></tr></thead>
                <tbody>
                  {rows.length ? rows.map((r:any,i:number)=>(
                    <tr key={`${r.id ?? r.name ?? "row"}-${i}`} className="border-t border-[#eeeeea]">
                      <td className="p-3 text-[#777970]">{i+1}</td><td className="p-3">{r.family ?? "—"}</td><td className="p-3"><strong>{r.name ?? "—"}</strong><div className="text-xs text-[#777970]">{r.source ?? ""}</div></td><td className="p-3">{r.signals ?? "—"}</td><td className="p-3">{fmt(r.winRate)}%</td>
                      <td className={`p-3 ${Number(r.avgNetBps)>=0?"text-[#44684a]":"text-[#9a4942]"}`}>{fmt(r.avgNetBps)}</td><td className="p-3">{fmt(r.medianNetBps)}</td><td className="p-3">{Number(r.profitFactor)>=999?"∞":fmt(r.profitFactor)}</td><td className={`p-3 font-medium ${Number(r.totalNetBps)>=0?"text-[#44684a]":"text-[#9a4942]"}`}>{fmt(r.totalNetBps)}</td>
                    </tr>
                  )) : <tr><td colSpan={9} className="p-8 text-center text-sm text-[#777970]">The API returned no ranking rows.</td></tr>}
                </tbody>
              </table>
            </div>
            <div className="border-t border-[#ecece5] p-4 text-xs text-[#777970]">Showing {rows.length} of {(data.allResults ?? []).length} strategies.</div>
          </div>
          <div className="mt-5 rounded-3xl border border-[#deded6] bg-white p-5 text-sm leading-6 text-[#66685f]">
            <strong className="text-[#171817]">Research validity</strong>
            <p className="mt-2">Entry = completed 15m close → next 15m open · fixed horizon = {data.rules?.fixedHorizonBars ?? "—"} bars. The response identifies this as a research proxy using accessible public market data, not a licensed point-in-time SETSMART dataset. This is not a trade recommendation.</p>
            {!!data.data?.errors?.length && <p className="mt-2 text-[#8a6540]">API data warnings: {data.data.errors.join(" · ")}</p>}
          </div>
        </>
      )}
    </main>
  );
}

function Metric({label,value,detail}:{label:string;value:string;detail:string}) {
  return <div className="rounded-3xl border border-[#deded6] bg-white p-5"><div className="text-xs text-[#777970]">{label}</div><div className="mt-3 text-2xl font-medium">{value}</div><div className="mt-2 text-xs text-[#777970]">{detail}</div></div>;
}
