import { NextResponse } from "next/server";
import { createClient } from "../../../lib/supabase/server";

function safeNextPath(raw: string | null, origin: string): string {
  if (!raw) return "/luna";

  try {
    const candidate = new URL(raw, origin);
    if (candidate.origin !== origin) return "/luna";
    if (!candidate.pathname.startsWith("/") || candidate.pathname.startsWith("//")) return "/luna";
    return candidate.pathname + candidate.search + candidate.hash;
  } catch {
    return "/luna";
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = safeNextPath(url.searchParams.get("next"), url.origin);

  if (!code) {
    return NextResponse.redirect(new URL("/luna/login?error=missing_code", url.origin));
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    return NextResponse.redirect(
      new URL("/luna/login?error=auth_callback_failed", url.origin),
    );
  }

  return NextResponse.redirect(new URL(next, url.origin));
}
