import Link from "next/link";
import { BarChart3, Bot, FlaskConical, LayoutDashboard, ShieldCheck, WalletCards, UserCircle } from "lucide-react";

export default function LunaLayout({ children }: { children: React.ReactNode }) {
  const nav = [
    ["Dashboard","/luna",LayoutDashboard],["Research","/luna/research",FlaskConical],
    ["Portfolio","/luna/portfolio",WalletCards],["Risk","/luna/risk",ShieldCheck],
    ["Agents","/luna/agents",Bot],["Pricing","/luna/pricing",BarChart3],
  ] as const;
  return <div className="min-h-screen bg-[#f7f7f4] text-[#171817]">
    <header className="sticky top-0 z-40 border-b border-[#e4e4dc] bg-[#f7f7f4]/95 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-[1600px] items-center justify-between px-5 sm:px-8">
        <Link href="/luna" className="text-sm font-semibold tracking-[0.28em]">LUNA</Link>
        <div className="flex items-center gap-1 overflow-x-auto">
          <nav className="flex items-center gap-1">{nav.map(([label,href,Icon])=><Link key={href} href={href} className="flex shrink-0 items-center gap-2 rounded-xl px-3 py-2 text-xs text-[#66685f] hover:bg-white hover:text-[#171817]"><Icon size={15}/>{label}</Link>)}</nav>
          <Link href="/luna/account" aria-label="Account" className="ml-2 rounded-xl p-2 text-[#66685f] hover:bg-white hover:text-[#171817]"><UserCircle size={18}/></Link>
        </div>
      </div>
    </header>
    {children}
  </div>;
}