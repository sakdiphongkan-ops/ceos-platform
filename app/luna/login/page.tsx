"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, LockKeyhole, Mail, ShieldCheck } from "lucide-react";
import { createClient } from "../../../lib/supabase/client";

function friendlyAuthError(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value ?? "");
  const normalized = message.toLowerCase();

  if (normalized.includes("invalid login credentials") || normalized.includes("invalid_credentials")) {
    return "อีเมลหรือรหัสผ่านไม่ถูกต้อง กรุณาตรวจสอบแล้วลองอีกครั้ง";
  }
  if (normalized.includes("email not confirmed") || normalized.includes("email_not_confirmed")) {
    return "บัญชียังไม่ได้ยืนยันอีเมล กรุณาตรวจสอบอีเมลที่ใช้สมัครก่อนเข้าสู่ระบบ";
  }
  if (normalized.includes("user already registered") || normalized.includes("already registered")) {
    return "อีเมลนี้มีบัญชีแล้ว กรุณาเลือกเข้าสู่ระบบแทนการสร้างบัญชีใหม่";
  }
  if (normalized.includes("password should be at least") || normalized.includes("password is too short")) {
    return "รหัสผ่านสั้นเกินไป กรุณาตรวจสอบข้อกำหนดรหัสผ่านแล้วลองอีกครั้ง";
  }
  if (normalized.includes("too many requests") || normalized.includes("rate limit")) {
    return "มีการลองเข้าสู่ระบบหลายครั้งเกินไป กรุณารอสักครู่แล้วลองใหม่";
  }
  if (normalized.includes("network") || normalized.includes("fetch")) {
    return "เชื่อมต่อระบบเข้าสู่ระบบไม่ได้ชั่วคราว กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองอีกครั้ง";
  }
  return "เข้าสู่ระบบไม่สำเร็จ กรุณาตรวจสอบข้อมูลและลองอีกครั้ง หากยังมีปัญหาให้ติดต่อผู้ดูแลระบบ";
}

function callbackErrorMessage(code: string, detail: string): string {
  const normalized = (code + " " + detail).toLowerCase();
  if (normalized.includes("missing_code")) {
    return "ลิงก์เข้าสู่ระบบไม่สมบูรณ์ กรุณาเริ่มเข้าสู่ระบบใหม่";
  }
  if (normalized.includes("access_denied")) {
    return "การเข้าสู่ระบบถูกยกเลิก กรุณาลองใหม่อีกครั้ง";
  }
  if (normalized.includes("expired") || normalized.includes("invalid")) {
    return "ลิงก์ยืนยันตัวตนหมดอายุหรือใช้ไม่ได้แล้ว กรุณาเริ่มเข้าสู่ระบบใหม่";
  }
  return "ยืนยันตัวตนไม่สำเร็จ กรุณาเข้าสู่ระบบใหม่อีกครั้ง";
}

export default function LunaLoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("mode") === "signup") setMode("signup");
    const callbackCode = params.get("error");
    const callbackDetail = params.get("error_description") ?? "";
    if (callbackCode) {
      setError(callbackErrorMessage(callbackCode, callbackDetail));
      // Keep the safe next path, but remove provider error details from the address bar.
      params.delete("error");
      params.delete("error_description");
      const query = params.toString();
      window.history.replaceState({}, "", window.location.pathname + (query ? "?" + query : "") + window.location.hash);
    }
  }, []);

  const next = useMemo(() => {
    if (typeof window === "undefined") return "/luna";
    const value = new URLSearchParams(window.location.search).get("next");
    if (!value) return "/luna";

    try {
      const candidate = new URL(value, window.location.origin);
      if (candidate.origin !== window.location.origin) return "/luna";
      return candidate.pathname + candidate.search + candidate.hash;
    } catch {
      return "/luna";
    }
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
        : await supabase.auth.signUp({
            email,
            password,
            options: {
              // Email confirmation must return through the server callback so
              // PKCE code exchange persists the LUNA session cookie before the dashboard loads.
              emailRedirectTo: new URL(
                "/auth/callback?next=" + encodeURIComponent(next),
                window.location.origin,
              ).toString(),
            },
          });

      if (result.error) throw result.error;

      if (mode === "signup" && !result.data.session) {
        setMessage("สมัครสำเร็จ — กรุณาตรวจสอบอีเมลเพื่อยืนยันบัญชีก่อนเข้าสู่ระบบ");
        return;
      }

      if (!result.data.session) {
        setError("ยังไม่ได้รับเซสชันเข้าสู่ระบบ กรุณาลองใหม่อีกครั้ง");
        return;
      }

      // A full navigation lets the browser persist the SSR cookie session
      // before the server-rendered control room and protected API routes are requested.
      window.location.replace(next);
    } catch (e) {
      setError(friendlyAuthError(e));
    } finally {
      setBusy(false);
    }
  }


  return (
    <main className="luna-login-page min-h-[calc(100vh-4rem)] min-h-[calc(100dvh-4rem)] bg-[#f7f7f4] px-5 py-12 sm:px-8">
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
                  className="h-12 w-full bg-transparent text-[16px] outline-none" style={{ fontSize: "16px" }} autoComplete="email" />
              </span>
            </label>

            <label className="block">
              <span className="mb-2 block text-xs font-medium text-[#55574f]">Password</span>
              <input required minLength={6} type="password" value={password} onChange={(e)=>setPassword(e.target.value)}
                className="h-12 w-full rounded-2xl border border-[#dcdcd4] bg-[#fafaf7] px-4 text-[16px] outline-none focus:border-[#9b9d93]"
                style={{ fontSize: "16px" }} autoComplete={mode === "signin" ? "current-password" : "new-password"} />
            </label>

            {error && <div role="alert" className="rounded-2xl border border-[#efd4d0] bg-[#fff7f5] px-4 py-3 text-sm text-[#8a3f35]">{error}</div>}
            {message && <div role="status" className="rounded-2xl border border-[#dfe5cf] bg-[#f8faef] px-4 py-3 text-sm text-[#56633a]">{message}</div>}

            <button disabled={busy} style={{ minHeight: 48 }} className="h-12 w-full rounded-2xl bg-[#171817] text-sm font-medium text-white disabled:opacity-50">
              {busy ? "กำลังดำเนินการ…" : mode === "signin" ? "Sign in" : "Create account"}
            </button>
          </form>

          <button onClick={()=>{setMode(mode === "signin" ? "signup" : "signin");setError("");setMessage("");}} style={{ minHeight: 44 }}
            className="mt-5 min-h-11 w-full rounded-xl px-3 py-2 text-sm text-[#55574f] underline underline-offset-4">
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
