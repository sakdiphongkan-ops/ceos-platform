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
    <main className="luna-login-page">
      <div className="luna-login-layout">
        <Link href="/luna" className="luna-login-back">
          <ArrowLeft size={14} /> Back to LUNA
        </Link>

        <section className="luna-login-card">
          <div className="luna-login-mark">
            <LockKeyhole size={20} />
          </div>
          <div className="luna-login-eyebrow">LUNA ACCOUNT</div>
          <h1 className="luna-login-title">
            {mode === "signin" ? "Welcome back." : "Create your account."}
          </h1>
          <p className="luna-login-description">
            Secure account access for your LUNA workspace. Trading remains paper-only and live money stays locked.
          </p>

          <form onSubmit={submit} className="luna-login-form">
            <label className="luna-login-field">
              <span className="luna-login-label">Email</span>
              <span className="luna-login-email-control">
                <Mail size={16} className="luna-login-mail-icon" />
                <input required type="email" value={email} onChange={(e)=>setEmail(e.target.value)}
                  className="luna-login-input luna-login-email" autoComplete="email" />
              </span>
            </label>

            <label className="luna-login-field">
              <span className="luna-login-label">Password</span>
              <input required minLength={6} type="password" value={password} onChange={(e)=>setPassword(e.target.value)}
                className="luna-login-input luna-login-password"
                autoComplete={mode === "signin" ? "current-password" : "new-password"} />
            </label>

            {error && <div role="alert" className="luna-login-alert luna-login-error">{error}</div>}
            {message && <div role="status" className="luna-login-alert luna-login-success">{message}</div>}

            <button disabled={busy} className="luna-login-button luna-login-submit">
              {busy ? "กำลังดำเนินการ…" : mode === "signin" ? "Sign in" : "Create account"}
            </button>
          </form>

          <div className="luna-login-separator">
            <span className="luna-login-separator-line" /> OR <span className="luna-login-separator-line" />
          </div>

          <button type="button" onClick={signInWithGoogle} disabled={busy}
            className="luna-login-button luna-login-google">
            Continue with Google
          </button>

          <button type="button" onClick={()=>{setMode(mode === "signin" ? "signup" : "signin");setError("");setMessage("");}}
            className="luna-login-mode-switch">
            {mode === "signin" ? "Create a new LUNA account" : "I already have an account"}
          </button>

          <div className="luna-login-security">
            <ShieldCheck size={17} className="luna-login-security-icon" />
            <p className="luna-login-security-copy">
              Authentication is separated from trading execution. No live-money permission is granted by signing in.
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
