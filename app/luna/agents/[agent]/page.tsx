import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowRight, ShieldCheck } from "lucide-react";

const definitions: Record<string,{name:string;permission:string;description:string;responsibilities:string[];workspace:string;workspaceLabel:string}> = {
  cio:{name:"CIO / Orchestrator",permission:"L3 · PREPARE",description:"Coordinates the research, decision, portfolio and governance workspaces. This role coordinates information and preparation; it is not a broker or order authority.",responsibilities:["Bring research, risk and portfolio evidence into one review","Track the status and blockers returned by connected services","Prepare a decision record for human review"],workspace:"/luna",workspaceLabel:"Open Control Room"},
  research:{name:"Research Agent",permission:"L2 · PROPOSE",description:"Organizes evidence and research traces returned by connected sources. It must not fill missing observations with inferred facts.",responsibilities:["Review backend-returned decision traces","Identify source and evidence gaps","Keep research candidates separate from execution orders"],workspace:"/luna/research/evidence",workspaceLabel:"Open Evidence & Audit"},
  fundamental:{name:"Fundamental Agent",permission:"L2 · PROPOSE",description:"Reviews issuer financial statements and valuation evidence only when a verified fundamentals source is connected.",responsibilities:["Require dated issuer financial statements","Show the origin and period of each metric","Withhold fair value when core evidence is absent"],workspace:"/luna/research/fundamentals",workspaceLabel:"Open Fundamental Intelligence"},
  quant:{name:"Quant Agent",permission:"L2 · PROPOSE",description:"Reviews quantitative studies, backtest assumptions, costs and validation splits. A backtest result is research evidence, not a trading instruction.",responsibilities:["Review reported strategy metrics and universe coverage","Check stated costs and research limitations","Keep OOS and Holdout requirements explicit"],workspace:"/luna/research/quant",workspaceLabel:"Open Quant Lab"},
  risk:{name:"Risk Agent",permission:"L3 · PREPARE",description:"Reviews the independent blockers and risk boundaries required before any paper execution decision.",responsibilities:["Inspect returned readiness blockers","Distinguish market-open timing from feed verification","Keep live-money execution locked"],workspace:"/luna/risk",workspaceLabel:"Open Risk Control"},
  portfolio:{name:"Portfolio Agent",permission:"L3 · PREPARE",description:"Interprets verified portfolio positions, snapshots and exposure data returned by the existing API.",responsibilities:["Use verified portfolio snapshots and marks only","Keep missing prices and P&L blank","Connect position details to the execution history returned by the backend"],workspace:"/luna/portfolio",workspaceLabel:"Open Portfolio Intelligence"},
  governance:{name:"Governance Agent",permission:"L3 · PREPARE",description:"Maintains the evidence and permission boundaries around research and portfolio workflows.",responsibilities:["Require attributable source and timestamps","Keep audit records separate from candidate reasoning","Prevent a UI state from being mistaken for execution approval"],workspace:"/luna/research/evidence",workspaceLabel:"Open Evidence & Audit"},
};

export default async function AgentDetailPage({params}:{params:Promise<{agent:string}>}) {
  const {agent:slug}=await params;
  const agent=definitions[slug];
  if(!agent) notFound();
  return (
    <main className="mx-auto max-w-4xl px-5 py-10 sm:px-8">
      <Link href="/luna/agents" className="inline-flex items-center gap-2 text-xs text-[#777970]"><ArrowLeft size={14}/> Agent catalog</Link>
      <div className="mt-8 text-xs font-semibold tracking-[.25em] text-[#777970]">AGENT ROLE / {slug.toUpperCase()}</div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3"><h1 className="text-3xl font-medium">{agent.name}</h1><span className="rounded-full bg-[#f0f0eb] px-3 py-2 text-xs">{agent.permission}</span></div>
      <p className="mt-4 max-w-3xl text-sm leading-6 text-[#66685f]">{agent.description}</p>
      <section className="mt-8 rounded-3xl border border-[#deded6] bg-white p-6"><div className="font-medium">Responsibilities & boundaries</div><ul className="mt-4 space-y-3">{agent.responsibilities.map(item=><li key={item} className="flex gap-3 text-sm leading-6 text-[#66685f]"><span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[#73796a]"/>{item}</li>)}</ul></section>
      <section className="mt-5 rounded-3xl border border-[#deded6] bg-white p-6"><div className="flex items-start gap-3"><ShieldCheck size={18} className="mt-0.5 shrink-0"/><div><div className="font-medium">Current execution boundary</div><p className="mt-2 text-sm leading-6 text-[#777970]">This page is a role definition and workspace entry point. It does not launch a model run, create an order or grant execution permission. No autonomous-agent run is claimed by this UI.</p></div></div></section>
      <Link href={agent.workspace} className="mt-7 inline-flex items-center gap-2 rounded-2xl bg-[#171817] px-5 py-3 text-sm text-white">{agent.workspaceLabel}<ArrowRight size={15}/></Link>
    </main>
  );
}
