import Link from "next/link";

const checks=[
["SOURCE","master","PASS"],
["LIVE MONEY","LOCKED","PASS"],
["BILLING","Provider-neutral / not activated","SAFE"],
["AUTH","Not yet connected to production session","PENDING"],
["VERCEL","Awaiting deployment from master","PENDING"],
];

export default function ReleasePage(){return <main className="mx-auto max-w-4xl px-5 py-10 sm:px-8"><div className="text-xs font-semibold tracking-[.25em] text-[#777970]">RELEASE</div><h1 className="mt-3 text-3xl font-medium">LUNA Webapp Readiness</h1><p className="mt-3 text-sm leading-6 text-[#66685f]">A transparent release gate. Nothing is marked live until it has been verified in the deployed environment.</p><div className="mt-8 overflow-hidden rounded-3xl border border-[#deded6] bg-white">{checks.map(([name,value,status])=><div key={name} className="grid grid-cols-[110px_1fr_auto] gap-4 border-b border-[#ecece5] p-5 last:border-0"><span className="text-xs font-semibold tracking-[.12em] text-[#777970]">{name}</span><span className="text-sm">{value}</span><span className="text-xs">{status}</span></div>)}</div><Link href="/luna" className="mt-6 inline-block rounded-2xl bg-[#171817] px-5 py-3 text-sm text-white">Open Control Room</Link></main>}