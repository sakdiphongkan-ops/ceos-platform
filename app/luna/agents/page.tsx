import Link from "next/link";
const agents=[
["CIO / Orchestrator","Coordinates research, decision and portfolio workflows.","L3 · PREPARE"],
["Research Agent","Collects and structures evidence without inventing market data.","L2 · PROPOSE"],
["Fundamental Agent","Uses CEOS financial intelligence and valuation evidence.","L2 · PROPOSE"],
["Quant Agent","Runs formula research with leakage controls and OOS/Holdout validation.","L2 · PROPOSE"],
["Risk Agent","Evaluates exposure and execution blockers independently.","L3 · PREPARE"],
["Portfolio Agent","Translates approved decisions into portfolio context.","L3 · PREPARE"],
["Governance Agent","Maintains audit trails, permissions and policy boundaries.","L3 · PREPARE"],
];
export default function AgentsPage(){return <main className="mx-auto max-w-7xl px-5 py-10 sm:px-8"><div className="text-xs font-semibold tracking-[.25em] text-[#777970]">AGENTS</div><h1 className="mt-3 text-3xl font-medium">LUNA Agent Workspace</h1><p className="mt-3 max-w-3xl text-sm leading-6 text-[#66685f]">Specialized agents work inside explicit permission boundaries. They prepare and explain actions; live-money execution is not enabled.</p><div className="mt-9 grid gap-5 md:grid-cols-2 xl:grid-cols-3">{agents.map(([name,desc,perm])=><section key={name} className="rounded-3xl border border-[#deded6] bg-white p-6"><div className="flex items-start justify-between gap-3"><h2 className="font-medium">{name}</h2><span className="rounded-full bg-[#f0f0eb] px-2.5 py-1 text-[10px]">{perm}</span></div><p className="mt-4 text-sm leading-6 text-[#777970]">{desc}</p><Link href="/luna/research" className="mt-7 inline-block text-xs font-medium">Open workflow →</Link></section>)}</div></main>}