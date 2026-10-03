"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowLeft, CreditCard, ShieldCheck } from "lucide-react";

type Plan={code:string;name:string;monthlyPriceTHB:number|null;billingInterval:string;features:string[]};

export default function AccountPage(){
  const [plans,setPlans]=useState<Plan[]>([]);
  useEffect(()=>{fetch("/api/luna2/plans").then(r=>r.json()).then(d=>setPlans(d.plans??[]));},[]);
  const current=plans.find(p=>p.code==="FREE");
  return <main className="mx-auto max-w-5xl px-5 py-10 sm:px-8">
    <Link href="/luna" className="inline-flex items-center gap-2 text-xs text-[#777970]"><ArrowLeft size={14}/>Control Room</Link>
    <div className="mt-8"><div className="text-xs font-semibold tracking-[.25em] text-[#777970]">ACCOUNT</div><h1 className="mt-3 text-3xl font-medium">Account & Billing</h1><p className="mt-3 text-sm text-[#66685f]">Manage your LUNA identity, subscription and access.</p></div>
    <section className="mt-8 rounded-3xl border border-[#deded6] bg-white p-6">
      <div className="flex items-start gap-4"><ShieldCheck size={20}/><div><h2 className="font-medium">Current access</h2><p className="mt-1 text-sm text-[#777970]">{current?.name??"Free"} plan · Paper trading only</p></div></div>
      <div className="mt-6 grid gap-4 sm:grid-cols-2"><div className="rounded-2xl bg-[#f7f7f4] p-5"><div className="text-xs text-[#777970]">Subscription status</div><div className="mt-2 font-medium">ACTIVE · FREE</div></div><div className="rounded-2xl bg-[#f7f7f4] p-5"><div className="text-xs text-[#777970]">Live money</div><div className="mt-2 font-medium">LOCKED</div></div></div>
    </section>
    <section className="mt-5 rounded-3xl border border-[#deded6] bg-white p-6"><div className="flex items-center gap-3"><CreditCard size={19}/><h2 className="font-medium">Billing provider</h2></div><p className="mt-3 text-sm leading-6 text-[#777970]">Payment checkout is not activated yet. LUNA uses a provider-neutral billing boundary so Xendit or another supported provider can be added without changing trading logic.</p><Link href="/luna/pricing" className="mt-5 inline-block rounded-2xl border border-[#d8d8d0] px-4 py-2.5 text-sm">View plans</Link></section>
  </main>;
}