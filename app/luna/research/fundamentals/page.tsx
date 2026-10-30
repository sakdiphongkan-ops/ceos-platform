import Link from "next/link";
import { AlertTriangle, ArrowLeft, Database, ShieldCheck } from "lucide-react";

export default function FundamentalResearchPage() {
  return (
    <main className="mx-auto max-w-5xl px-5 py-10 sm:px-8">
      <Link href="/luna/research" className="inline-flex items-center gap-2 text-xs text-[#777970]"><ArrowLeft size={14}/> Research workspaces</Link>
      <div className="mt-8">
        <div className="text-xs font-semibold tracking-[.25em] text-[#777970]">RESEARCH / FUNDAMENTALS</div>
        <h1 className="mt-3 text-3xl font-medium">Fundamental Intelligence</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-[#66685f]">Issuer financial statements, valuation evidence and company-level source records.</p>
      </div>
      <section className="mt-8 rounded-3xl border border-[#e4d9bd] bg-white p-6">
        <div className="flex items-start gap-3">
          <AlertTriangle size={20} className="mt-0.5 shrink-0 text-[#947442]"/>
          <div>
            <h2 className="font-medium">Fundamental source not connected to this workspace</h2>
            <p className="mt-2 text-sm leading-6 text-[#777970]">
              No issuer financial-statement dataset or source-verification response is exposed to this page at present.
              Therefore no EPS, revenue, debt, fair value or valuation multiples are displayed or estimated here.
            </p>
          </div>
        </div>
      </section>
      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <div className="rounded-3xl border border-[#deded6] bg-white p-5"><Database size={18}/><div className="mt-3 text-xs text-[#777970]">DATA CONNECTION</div><div className="mt-1 font-medium">NOT AVAILABLE</div><p className="mt-2 text-sm text-[#777970]">A verified SET / SEC / company filing source is required before this workspace can calculate fundamentals.</p></div>
        <div className="rounded-3xl border border-[#deded6] bg-white p-5"><ShieldCheck size={18}/><div className="mt-3 text-xs text-[#777970]">VALUATION STATUS</div><div className="mt-1 font-medium">NOT CALCULATED</div><p className="mt-2 text-sm text-[#777970]">Fair value and margin of safety remain blank until supported source observations are available.</p></div>
      </div>
      <Link href="/luna/research" className="mt-7 inline-flex rounded-2xl border border-[#d8d8d0] bg-white px-4 py-2.5 text-sm">Back to Research</Link>
    </main>
  );
}
