"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, RefreshCw, ShieldCheck, AlertTriangle } from "lucide-react";
import { fetchShadowStatus, type ShadowStatus } from "../../../../lib/luna-client";
import { bangkokDate } from "../../../../lib/luna-runtime";

export default function EvidenceResearchPage() {
  const [data,setData] = useState<ShadowStatus | null>(null);
  const [loading,setLoading] = useState(true);
  const [error,setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await fetchShadowStatus(bangkokDate(new Date()));
      if (result.ok !== true) throw new Error(result.error?.message ?? "SHADOW_STATUS_UNAVAILABLE");
      setData(result);
    } catch (e) {
      setData(null);
      setError(e instanceof Error ? e.message : "Unable to load verified decision trace");
    } finally {
      setLoading(false);
    }
  },[]);

  useEffect(() => { void load(); },[load]);

  const shadow = data?.shadow;
  const blockers = shadow?.blockers ?? [];
  const decisions = shadow?.decisions ?? [];

  return (
    <main className="mx-auto max-w-6xl px-5 py-10 sm:px-8">
      <Link href="/luna/research" className="inline-flex items-center gap-2 text-xs text-[#777970]"><ArrowLeft size={14}/> Research workspaces</Link>
      <div className="mt-8 flex flex-wrap items-end justify-between gap-4">
        <div><div className="text-xs font-semibold tracking-[.25em] text-[#777970]">RESEARCH / EVIDENCE</div><h1 className="mt-3 text-3xl font-medium">Evidence & Decision Audit</h1><p className="mt-3 text-sm leading-6 text-[#66685f]">Backend-returned shadow decisions and execution-readiness blockers. This view does not generate missing evidence.</p></div>
        <button onClick={() => void load()} disabled={loading} className="inline-flex items-center gap-2 rounded-2xl border border-[#d8d8d0] bg-white px-4 py-2.5 text-sm disabled:opacity-50"><RefreshCw size={15}/>{loading?"Loading…":"Refresh evidence"}</button>
      </div>
      {error && <div role="alert" className="mt-6 flex items-start gap-3 rounded-2xl border border-[#efd4d0] bg-[#fff7f5] p-4 text-sm text-[#8a3f35]"><AlertTriangle size={17}/><span className="flex-1">{error}</span><button className="underline" onClick={() => void load()}>Retry</button></div>}
      {loading && !data && !error && <div role="status" className="mt-6 rounded-2xl border border-[#deded6] bg-white p-6 text-sm text-[#777970]">Requesting decision evidence from the backend…</div>}
      {!loading && !data && !error && <div className="mt-6 rounded-2xl border border-[#deded6] bg-white p-6 text-sm text-[#777970]">No verified evidence response was returned.</div>}
      {data && (
        <>
          <section className="mt-7 rounded-3xl border border-[#deded6] bg-white p-6">
            <div className="flex flex-wrap items-center justify-between gap-3"><div><div className="text-xs text-[#777970]">SHADOW ENGINE STATE</div><h2 className="mt-2 text-xl font-medium">{shadow?.state ?? "UNKNOWN"}</h2></div><span className="inline-flex items-center gap-2 rounded-full bg-[#f3f3ee] px-3 py-2 text-xs"><ShieldCheck size={14}/>{shadow?.orders_allowed===true?"Readiness says permitted":"Orders not permitted / unknown"}</span></div>
            <div className="mt-4 grid gap-4 sm:grid-cols-3"><Metric label="BUY candidates" value={String(shadow?.buy_candidates ?? "—")}/><Metric label="SELL candidates" value={String(shadow?.sell_candidates ?? "—")}/><Metric label="Verified books" value={shadow?.verified_book_symbols == null?"—":String(shadow.verified_book_symbols)}/></div>
            <div className="mt-4 text-xs text-[#777970]">Generated: {data.generated_at ? new Date(data.generated_at).toLocaleString("en-GB",{timeZone:"Asia/Bangkok"}) : "timestamp not returned"} · Source: {shadow?.latest_source ?? "not reported"}</div>
          </section>
          <section className="mt-5 rounded-3xl border border-[#deded6] bg-white p-6"><h2 className="font-medium">Execution blockers</h2>{blockers.length ? <ul className="mt-3 space-y-2">{blockers.map((b,i)=><li key={b+i} className="rounded-xl bg-[#f8f7f3] px-4 py-3 text-sm">{b.replaceAll("_"," ")}</li>)}</ul> : <p className="mt-3 text-sm text-[#777970]">The backend returned no blocker. This alone is not independent certification of execution readiness.</p>}</section>
          <section className="mt-5 overflow-hidden rounded-3xl border border-[#deded6] bg-white"><div className="border-b border-[#ecece5] p-5"><h2 className="font-medium">Decision trace</h2><p className="mt-1 text-xs text-[#777970]">Only decisions returned by the shadow API are displayed.</p></div>{decisions.length ? <div className="divide-y divide-[#eeeeea]">{decisions.map((d,i)=><article key={d.symbol+"-"+d.bar_end+"-"+i} className="p-5"><div className="flex flex-wrap items-center justify-between gap-3"><strong>{d.symbol}</strong><span className="rounded-full bg-[#f3f3ee] px-3 py-1 text-xs">{d.candidate_action}</span><span className="text-xs text-[#777970]">{d.bar_end && Number.isFinite(Date.parse(d.bar_end)) ? new Date(d.bar_end).toLocaleString("en-GB",{timeZone:"Asia/Bangkok"}) : "bar time not returned"}</span></div><p className="mt-3 text-sm leading-6 text-[#66685f]">{d.reason ?? "The backend did not return a decision explanation."}</p><div className="mt-3 flex flex-wrap gap-2 text-[11px]"><Flag label="Feed" value={d.feed_verified===true?"VERIFIED":d.feed_verified===false?"UNVERIFIED":"UNKNOWN"}/><Flag label="Order book" value={d.verified_book===true?"VERIFIED":d.verified_book===false?"UNVERIFIED":"UNKNOWN"}/><Flag label="Execution" value={d.execution_blocked===true?"BLOCKED":d.execution_blocked===false?"NOT BLOCKED":"UNKNOWN"}/></div></article>)}</div> : <div className="p-6 text-sm text-[#777970]">The backend returned no decision trace records. No explanation or trade signal is fabricated.</div>}</section>
        </>
      )}
    </main>
  );
}

function Metric({label,value}:{label:string;value:string}) { return <div className="rounded-2xl bg-[#f7f7f4] p-4"><div className="text-xs text-[#777970]">{label}</div><div className="mt-2 text-xl font-medium">{value}</div></div>; }
function Flag({label,value}:{label:string;value:string}) { return <span className="rounded-lg border border-[#e2e2da] px-2 py-1 text-[#66685f]">{label}: {value}</span>; }
