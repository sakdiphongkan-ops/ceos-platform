import Link from "next/link";
import { ArrowRight, Bot, ShieldCheck } from "lucide-react";

const agents = [
  {slug:"cio",name:"CIO / Orchestrator",description:"Coordinates research, portfolio context and governance decisions.",permission:"L3 · PREPARE",workspace:"/luna",workspaceLabel:"Control Room"},
  {slug:"research",name:"Research Agent",description:"Organizes source-backed observations and research questions.",permission:"L2 · PROPOSE",workspace:"/luna/research/evidence",workspaceLabel:"Evidence & Audit"},
  {slug:"fundamental",name:"Fundamental Agent",description:"Works with issuer financials and valuation evidence when a verified data connection is available.",permission:"L2 · PROPOSE",workspace:"/luna/research/fundamentals",workspaceLabel:"Fundamental Intelligence"},
  {slug:"quant",name:"Quant Agent",description:"Reviews formula studies, transaction costs and out-of-sample research metrics.",permission:"L2 · PROPOSE",workspace:"/luna/research/quant",workspaceLabel:"Quant Lab"},
  {slug:"risk",name:"Risk Agent",description:"Reviews blockers, exposure boundaries and execution readiness.",permission:"L3 · PREPARE",workspace:"/luna/risk",workspaceLabel:"Risk Control"},
  {slug:"portfolio",name:"Portfolio Agent",description:"Reviews returned positions, portfolio valuation and exposure context.",permission:"L3 · PREPARE",workspace:"/luna/portfolio",workspaceLabel:"Portfolio Intelligence"},
  {slug:"governance",name:"Governance Agent",description:"Reviews auditability, evidence quality and permission boundaries.",permission:"L3 · PREPARE",workspace:"/luna/research/evidence",workspaceLabel:"Evidence & Audit"},
] as const;

export default function AgentsPage() {
  return (
    <main className="mx-auto max-w-7xl px-5 py-10 sm:px-8">
      <div className="text-xs font-semibold tracking-[.25em] text-[#777970]">AGENTS</div>
      <h1 className="mt-3 text-3xl font-medium">LUNA Agent Workspace</h1>
      <p className="mt-3 max-w-3xl text-sm leading-6 text-[#66685f]">Specialized agent roles have explicit permission boundaries. These pages describe each role and link to its relevant workspace; they do not imply that an autonomous agent run or broker action has occurred.</p>
      <div className="mt-9 grid gap-5 md:grid-cols-2 xl:grid-cols-3">
        {agents.map(agent=>(
          <article key={agent.slug} className="flex min-h-[250px] flex-col rounded-3xl border border-[#deded6] bg-white p-6">
            <div className="flex items-start justify-between gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[#f2f2ed]"><Bot size={18}/></span><span className="rounded-full bg-[#f0f0eb] px-2.5 py-1 text-[10px]">{agent.permission}</span></div>
            <h2 className="mt-5 font-medium">{agent.name}</h2>
            <p className="mt-3 text-sm leading-6 text-[#777970]">{agent.description}</p>
            <div className="mt-auto flex items-center justify-between gap-3 border-t border-[#ecece5] pt-4"><Link href={`/luna/agents/${agent.slug}`} className="text-xs font-medium">Role details →</Link><Link href={agent.workspace} className="inline-flex items-center gap-1 text-xs text-[#66685f]">{agent.workspaceLabel}<ArrowRight size={13}/></Link></div>
          </article>
        ))}
      </div>
      <div className="mt-7 flex items-start gap-3 rounded-3xl border border-[#deded6] bg-white p-5"><ShieldCheck size={18} className="mt-0.5 shrink-0"/><p className="text-sm leading-6 text-[#66685f]">No agent in this catalog can authorize live-money execution. Each related workspace reports the data and capabilities it actually receives.</p></div>
    </main>
  );
}
