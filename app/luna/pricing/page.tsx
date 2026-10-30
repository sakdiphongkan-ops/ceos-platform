"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, ShieldCheck, AlertTriangle, RefreshCw } from "lucide-react";
import Link from "next/link";

type Plan={code:string;name:string;monthlyPriceTHB:number|null;billingInterval:string;features:string[]};
type PlansPayload={ok?:boolean;currency?:string;plans?:Plan[];billingProvider?:string;liveMoney?:boolean};
const labels:Record<string,string>={"market.basic":"Market basics","market.realtime":"Realtime market","portfolio.basic":"Portfolio basics","portfolio.full":"Full portfolio","research.summary":"Research summaries","research.advanced":"Advanced research","risk.advanced":"Advanced risk","paper.trading":"Paper trading","formula.lab":"Formula Lab","backtest":"Backtesting","oos.holdout.walkforward":"OOS / Holdout / Walk-forward","enterprise.workspace":"Enterprise workspace","api":"API access","audit.export":"Audit export","governance":"Governance"};
const money=(n:number|null)=>n==null?"Custom":n===0?"Free":`฿${n.toLocaleString("en-US")}/mo`;

export default function LunaPricingPage(){
 const [plans,setPlans]=useState<Plan[]>([]);
 const [loading,setLoading]=useState(true);
 const [error,setError]=useState("");

 const loadPlans=useCallback(async()=>{
  setLoading(true);setError("");
  try{
   const response=await fetch("/api/luna2/plans",{cache:"no-store"});
   if(!response.ok) throw new Error(`Plans API returned HTTP ${response.status}`);
   const data=await response.json() as PlansPayload;
   if(!Array.isArray(data.plans)) throw new Error("Plans API returned an invalid plan list");
   setPlans(data.plans);
  }catch(e){
   setPlans([]);
   setError(e instanceof Error?e.message:"Unable to load LUNA plans");
  }finally{setLoading(false);}
 },[]);

 useEffect(()=>{void loadPlans();},[loadPlans]);

 return <main className="min-h-screen bg-[#f7f7f4] text-[#171817]"><section className="mx-auto max-w-7xl px-5 py-10 sm:px-8 lg:px-12">
  <div className="mb-10 flex flex-wrap items-end justify-between gap-5"><div><div className="text-xs font-semibold tracking-[0.28em] text-[#74766f]">LUNA</div><h1 className="mt-3 text-3xl font-medium tracking-tight sm:text-5xl">Investment intelligence, built as a system.</h1><p className="mt-4 max-w-2xl text-sm leading-6 text-[#66685f] sm:text-base">One platform for market intelligence, fundamentals, quantitative research, risk and paper trading.</p></div><Link href="/luna" className="rounded-full border border-[#d8d8d0] px-5 py-2.5 text-sm">Open Control Room</Link></div>
  <div className="mb-7 flex items-start gap-3 rounded-3xl border border-[#e4d9bd] bg-white p-5"><AlertTriangle size={19} className="mt-0.5 shrink-0 text-[#947442]"/><div><div className="text-sm font-medium">Plan information only · checkout not available</div><p className="mt-1 text-xs leading-5 text-[#777970]">The current API reports a provider-neutral billing configuration. No checkout, subscription change or payment action is connected, so these plans are reference information only.</p></div></div>
  {error&&<div role="alert" className="mb-6 flex items-center gap-3 rounded-2xl border border-[#efd4d0] bg-[#fff7f5] p-4 text-sm text-[#8a3f35]"><AlertTriangle size={17}/><span className="flex-1">{error}</span><button onClick={()=>void loadPlans()} className="inline-flex items-center gap-2 underline"><RefreshCw size={14}/> Retry</button></div>}
  {loading?<div role="status" className="rounded-3xl border border-[#e2e2da] bg-white p-10 text-sm text-[#74766f]">Loading plans…</div>:!plans.length&&!error?<div className="rounded-3xl border border-[#e2e2da] bg-white p-10 text-sm text-[#74766f]">No plans were returned by the API.</div>:<div className="grid gap-5 md:grid-cols-2 xl:grid-cols-5">{plans.map(plan=><article key={plan.code} className="flex min-h-[410px] flex-col rounded-3xl border border-[#deded6] bg-white p-6 shadow-[0_12px_40px_rgba(0,0,0,0.035)]"><div className="flex items-center justify-between"><span className="text-xs font-semibold tracking-[0.18em] text-[#777970]">{plan.code}</span>{plan.code==="PRO"&&<span className="rounded-full bg-[#171817] px-2.5 py-1 text-[10px] text-white">POPULAR</span>}</div><h2 className="mt-5 text-xl font-medium">{plan.name}</h2><div className="mt-3 text-2xl font-semibold">{money(plan.monthlyPriceTHB)}</div><div className="mt-1 text-xs text-[#888a82]">{plan.billingInterval==="custom"?"Tailored commercial terms":"Listed monthly reference price"}</div><div className="my-7 h-px bg-[#ecece6]"/><ul className="space-y-3 text-sm">{plan.features.map(f=><li key={f} className="flex gap-2.5"><Check size={16} className="mt-0.5 shrink-0 text-[#555850]"/><span>{labels[f]??f}</span></li>)}</ul><div className="mt-auto border-t border-[#ecece5] pt-4"><div className="text-xs font-medium text-[#777970]">ACTIVATION UNAVAILABLE</div><div className="mt-1 text-[11px] leading-5 text-[#888a82]">Billing provider is not connected. No payment will be requested.</div></div></article>)}</div>}
  <div className="mt-8 flex flex-col gap-3 rounded-3xl border border-[#deded6] bg-white p-5 sm:flex-row sm:items-center sm:justify-between"><div className="flex gap-3"><ShieldCheck className="mt-0.5 shrink-0" size={19}/><div><div className="text-sm font-medium">Billing is isolated from trading execution.</div><div className="mt-1 text-xs leading-5 text-[#777970]">These prices do not grant any broker permission. Live-money execution remains locked.</div></div></div><span className="text-xs font-medium text-[#777970]">LIVE MONEY: LOCKED</span></div>
 </section></main>;
}
