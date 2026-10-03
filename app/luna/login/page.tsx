"use client";

import { FormEvent, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, LockKeyhole, Mail, ShieldCheck } from "lucide-react";
import { createClient } from "../../../lib/supabase/client";

export default function LunaLoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const next = useMemo(() => {
    if (typeof window === "undefined") return "/luna";
    const value = new URLSearchParams(window.location.search).get("next");
    return value?.startsWith("/") ? value : "/luna";
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");

    try {
      const supabase = createClient();
      const result = mode === "signin"
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password });

      if (result.error) throw result.error;

      if (mode === "signup" && !result.data.session) {
        setMessage("สมัครสำเร็จ — กรุณาตรวจสอบอีเมลเพื่อยืนยันบัญชีก่อนเข้าสู่ระบบ");
        return;
      }

      window.location.assign(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Authentication failed");
    } finally {
      setBusy(false);
    }
  }

  async function signInWithGoogle() {
    setBusy(true);
    setError("");
    try {
      const supabase = createClient();
      const { error: authError } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: window.location.origin + "/auth/callback?next=" + encodeURIComponent(next),
        },
      });
      if (authError) throw authError;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Google sign-in is unavailable");
      setBusy(false);
    }
  }

  return (
    <main className="min-h-[calc(100vh-4rem)] min-h-[calc(100dvh-4rem)] bg-[#f7f7f4] px-5 py-12 sm:px-8">
      <div className="mx-auto max-w-md">
        <Link href="/luna" className="inline-flex items-center gap-2 text-xs text-[#777970]">
          <ArrowLeft size={14} /> Back to LUNA
        </Link>

        <section className="mt-8 rounded-[28px] border border-[#deded6] bg-white p-7 shadow-[0_18px_60px_rgba(30,30,20,.06)]">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#f1f1eb]">
            <LockKeyhole size={20} />
          </div>
          <div className="mt-6 text-[11px] font-semibold tracking-[.24em] text-[#777970]">LUNA ACCOUNT</div>
          <h1 className="mt-2 text-3xl font-medium tracking-tight">
            {mode === "signin" ? "Welcome back." : "Create your account."}
          </h1>
          <p className="mt-3 text-sm leading-6 text-[#66685f]">
            Secure account access for your LUNA workspace. Trading remains paper-only and live money stays locked.
          </p>

          <form onSubmit={submit} className="mt-7 space-y-4">
            <label className="block">
              <span className="mb-2 block text-xs font-medium text-[#55574f]">Email</span>
              <span className="flex items-center gap-2 rounded-2xl border border-[#dcdcd4] bg-[#fafaf7] px-4">
                <Mail size={16} className="text-[#85877f]" />
                <input required type="email" value={email} onChange={(e)=>setEmail(e.target.value)}
                  className="h-12 w-full bg-transparent text-[16px] outline-none sm:text-sm" autoComplete="email" />
              </span>
            </label>

            <label className="block">
              <span className="mb-2 block text-xs font-medium text-[#55574f]">Password</span>
              <input required minLength={6} type="password" value={password} onChange={(e)=>setPassword(e.target.value)}
                className="h-12 w-full rounded-2xl border border-[#dcdcd4] bg-[#fafaf7] px-4 text-[16px] outline-none focus:border-[#9b9d93] sm:text-sm"
                autoComplete={mode === "signin" ? "current-password" : "new-password"} />
            </label>

            {error && <div role="alert" className="rounded-2xl border border-[#efd4d0] bg-[#fff7f5] px-4 py-3 text-sm text-[#8a3f35]">{error}</div>}
            {message && <div role="status" className="rounded-2xl border border-[#dfe5cf] bg-[#f8faef] px-4 py-3 text-sm text-[#56633a]">{message}</div>}

            <button disabled={busy} className="h-12 w-full rounded-2xl bg-[#171817] text-sm font-medium text-white disabled:opacity-50">
              {busy ? "กำลังดำเนินการ…" : mode === "signin" ? "Sign in" : "Create account"}
            </button>
          </form>

          <div className="my-5 flex items-center gap-3 text-[11px] text-[#999a93]">
            <span className="h-px flex-1 bg-[#e8e8e1]" /> OR <span className="h-px flex-1 bg-[#e8e8e1]" />
          </div>

          <button onClick={signInWithGoogle} disabled={busy}
            className="h-12 w-full rounded-2xl border border-[#d8d8d0] bg-white text-sm font-medium disabled:opacity-50">
            Continue with Google
          </button>

          <button onClick={()=>{setMode(mode === "signin" ? "signup" : "signin");setError("");setMessage("");}}
            className="mt-5 w-full text-xs text-[#66685f] underline underline-offset-4">
            {mode === "signin" ? "Create a new LUNA account" : "I already have an account"}
          </button>

          <div className="mt-7 flex items-start gap-3 border-t border-[#ecece5] pt-5">
            <ShieldCheck size={17} className="mt-0.5 shrink-0 text-[#6b725b]" />
            <p className="text-[11px] leading-5 text-[#777970]">
              Authentication is separated from trading execution. No live-money permission is granted by signing in.
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
