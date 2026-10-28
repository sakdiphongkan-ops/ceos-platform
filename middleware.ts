import { type NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./lib/supabase/public-config";

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = SUPABASE_URL;
  const key = SUPABASE_PUBLISHABLE_KEY;

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        // Update the request cookie view first, then create one response and attach
        // every auth cookie. Recreating the response per cookie drops earlier cookies.
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
        response.headers.set("Cache-Control", "private, no-store");
      },
    },
  });

  const { data: { user } } = await supabase.auth.getUser();

  const protectedPaths = ["/luna/account"];
  const isProtected = protectedPaths.some(
    (path) => request.nextUrl.pathname === path || request.nextUrl.pathname.startsWith(path + "/"),
  );

  if (isProtected && !user) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/luna/login";
    loginUrl.searchParams.set("next", request.nextUrl.pathname);
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

export const config = {
  matcher: ["/luna/account/:path*", "/api/luna/market-bars", "/auth/callback"],
};
