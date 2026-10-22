import Link from "next/link";
import { BarChart3, Bot, FlaskConical, LayoutDashboard, ShieldCheck, WalletCards, UserCircle } from "lucide-react";

export default function LunaLayout({ children }: { children: React.ReactNode }) {
  const nav = [
    ["Dashboard","/luna",LayoutDashboard],["Research","/luna/research",FlaskConical],
    ["Portfolio","/luna/portfolio",WalletCards],["Risk","/luna/risk",ShieldCheck],
    ["Agents","/luna/agents",Bot],["Pricing","/luna/pricing",BarChart3],
  ] as const;
  return <div className="luna-app-shell">
    <header className="luna-global-header">
      <div className="luna-global-header-inner">
        <Link href="/luna" className="luna-global-brand">LUNA</Link>
        <div className="luna-global-nav-scroll">
          <nav className="luna-global-nav" aria-label="Main navigation">
            {nav.map(([label,href,Icon])=><Link key={href} href={href} className="luna-global-nav-link"><Icon size={15}/><span>{label}</span></Link>)}
          </nav>
          <Link href="/luna/account" aria-label="Account" className="luna-global-account"><UserCircle size={18}/></Link>
        </div>
      </div>
    </header>
    {children}
  </div>;
}
