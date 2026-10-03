"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowLeft, CreditCard, LogOut, ShieldCheck, UserCircle } from "lucide-react";
import { createClient } from "../../../lib/supabase/client";

type Account = {
  email: string | null;
  plan_code: string;
  subscription_status: string;
  current_period_end: string | null;
};

export default function AccountPage() {
  const [account, setAccount] = useState<Account | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/luna2/me", { cache: "no-store" });
      if (response.status === 401) {
        window.location.assign("/luna/login?next=/luna/account");
        return;
      }
      const data = await response.json();
      if (!response.ok || !data.account) throw new Error("Unable to load account");
      setAccount(data.account);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load account");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    window.location.assign("/luna");
  }

  return (
    <main className="mx-auto max-w-5xl px-5 py-10 sm:px-8">
      <Link href="/luna" className="inline-flex items-center gap-2 text-xs text-[#777970]">
        <ArrowLeft size={14} /> Control Room
      </Link>

      <div className="mt-8 flex flex-wrap items-end justify-between gap-5">
        <div>
          <div className="text-xs font-semibold tracking-[.25em] text-[#777970]">ACCOUNT</div>
          <h1 className="mt-3 text-3xl font-medium">Account & Billing</h1>
          <p className="mt-3 text-sm text-[#66685f]">Identity, subscription and LUNA access.</p>
        </div>
        <button onClick={signOut} className="inline-flex items-center gap-2 rounded-2xl border border-[#d8d8d0] bg-white px-4 py-2.5 text-sm">
          <LogOut size={15} /> Sign out
        </button>
      </div>

      {error && <div role="alert" className="mt-6 rounded-2xl border border-[#efd4d0] bg-[#fff7f5] px-4 py-3 text-sm text-[#8a3f35]">{error}</div>}

      <section className="mt-8 rounded-3xl border border-[#deded6] bg-white p-6">
        <div className="flex items-start gap-4">
          <UserCircle size={21} />
          <div>
            <h2 className="font-medium">Signed-in identity</h2>
            <p className="mt-1 text-sm text-[#777970]">{loading ? "Loading…" : account?.email ?? "—"}</p>
          </div>
        </div>
        <div className="mt-6 grid gap-4 sm:grid-cols-3">
          <div className="rounded-2xl bg-[#f7f7f4] p-5"><div className="text-xs text-[#777970]">Plan</div><div className="mt-2 font-medium">{account?.plan_code ?? "—"}</div></div>
          <div className="rounded-2xl bg-[#f7f7f4] p-5"><div className="text-xs text-[#777970]">Subscription</div><div className="mt-2 font-medium">{account?.subscription_status ?? "—"}</div></div>
          <div className="rounded-2xl bg-[#f7f7f4] p-5"><div className="text-xs text-[#777970]">Live money</div><div className="mt-2 font-medium">LOCKED</div></div>
        </div>
      </section>

      <section className="mt-5 rounded-3xl border border-[#deded6] bg-white p-6">
        <div className="flex items-center gap-3"><ShieldCheck size={19}/><h2 className="font-medium">Access boundary</h2></div>
        <p className="mt-3 text-sm leading-6 text-[#777970]">
          Account identity is handled by Supabase Auth. Commercial access is resolved server-side through a security-definer access function; existing RLS on commercial tables remains intact. Signing in does not grant live-money execution.
        </p>
      </section>

      <section className="mt-5 rounded-3xl border border-[#deded6] bg-white p-6">
        <div className="flex items-center gap-3"><CreditCard size={19}/><h2 className="font-medium">Billing provider</h2></div>
        <p className="mt-3 text-sm leading-6 text-[#777970]">Checkout is still provider-neutral. Xendit can be wired into this boundary without changing the trading engine.</p>
        <Link href="/luna/pricing" className="mt-5 inline-block rounded-2xl border border-[#d8d8d0] px-4 py-2.5 text-sm">View plans</Link>
      </section>
    </main>
  );
}
