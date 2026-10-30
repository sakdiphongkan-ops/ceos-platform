"use client";

import Link from "next/link";
import { ArrowRight, BookOpen, Database, FlaskConical, ShieldCheck } from "lucide-react";

const workspaces = [
  {
    title: "Fundamental Intelligence",
    description: "Issuer financials, valuation inputs and source evidence. Missing source data is shown as unavailable rather than estimated.",
    href: "/luna/research/fundamentals",
    label: "Source status",
    value: "SOURCE CONNECTION REQUIRED",
    icon: Database,
  },
  {
    title: "Quant Lab",
    description: "Inspect the current formula tournament, costs, signal counts and net results from the live research endpoint.",
    href: "/luna/research/quant",
    label: "Research endpoint",
    value: "LIVE API",
    icon: FlaskConical,
  },
  {
    title: "Evidence & Audit",
    description: "Review backend-returned decision traces, source verification flags and readiness blockers.",
    href: "/luna/research/evidence",
    label: "Evidence endpoint",
    value: "BACKEND TRACE",
    icon: ShieldCheck,
  },
] as const;

export default function ResearchPage() {
  return (
    <main className="mx-auto max-w-7xl px-5 py-10 sm:px-8">
      <div className="mb-10">
        <div className="text-xs font-semibold tracking-[.25em] text-[#777970]">RESEARCH</div>
        <h1 className="mt-3 text-3xl font-medium">Research Intelligence</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-[#66685f]">
          A single workspace for fundamentals, quantitative research and traceable evidence.
          Every destination reports its actual data availability.
        </p>
      </div>
      <div className="grid gap-5 md:grid-cols-3">
        {workspaces.map(({title,description,href,label,value,icon:Icon}) => (
          <Link href={href} key={href} className="group flex min-h-[260px] flex-col rounded-3xl border border-[#deded6] bg-white p-6 transition hover:-translate-y-0.5 hover:border-[#b9bcb0]">
            <div className="flex items-center justify-between">
              <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[#f2f2ed]"><Icon size={18}/></span>
              <ArrowRight size={16} className="text-[#777970] transition group-hover:translate-x-1"/>
            </div>
            <h2 className="mt-6 text-lg font-medium">{title}</h2>
            <p className="mt-3 text-sm leading-6 text-[#777970]">{description}</p>
            <div className="mt-auto border-t border-[#ecece5] pt-4">
              <div className="text-[10px] font-semibold tracking-[.16em] text-[#85877f]">{label}</div>
              <div className="mt-1 text-xs font-medium text-[#565a50]">{value}</div>
              <div className="mt-3 text-xs font-medium">Open workspace →</div>
            </div>
          </Link>
        ))}
      </div>
      <div className="mt-8 flex items-start gap-3 rounded-3xl border border-[#deded6] bg-white p-5">
        <BookOpen size={18} className="mt-0.5 shrink-0 text-[#6f7567]"/>
        <p className="text-sm leading-6 text-[#66685f]">
          Research outputs are not orders. Results must pass out-of-sample validation, trading-cost
          checks and independent risk gates before they can be considered for paper execution.
        </p>
      </div>
    </main>
  );
}
