import { NextResponse } from "next/server";
import { getLunaUser } from "./auth";

type BucketState = { startedAt: number; count: number };

const state = new Map<string, BucketState>();
const WINDOW_MS = 60_000;
const LIMITS: Record<string, number> = {
  "ceos-snapshot": 5,
  "multitimeframe": 3,
  "tournament100": 3,
  "walkforward60": 2,
  yahoo: 5,
};

export async function requireBacktestAccess(request: Request, bucket: keyof typeof LIMITS) {
  try {
    const user = await getLunaUser();
    if (!user) {
      return {
        user: null,
        response: NextResponse.json(
          { ok: false, error: "AUTHENTICATION_REQUIRED" },
          { status: 401, headers: { "Cache-Control": "no-store" } },
        ),
      };
    }

    const now = Date.now();
    const key = bucket + ":" + user.id;
    const current = state.get(key);
    const limit = LIMITS[bucket] ?? 3;

    if (!current || now - current.startedAt >= WINDOW_MS) {
      state.set(key, { startedAt: now, count: 1 });
    } else {
      current.count += 1;
      if (current.count > limit) {
        const retryAfter = Math.max(1, Math.ceil((WINDOW_MS - (now - current.startedAt)) / 1000));
        return {
          user,
          response: NextResponse.json(
            { ok: false, error: "RATE_LIMITED" },
            { status: 429, headers: { "Retry-After": String(retryAfter), "Cache-Control": "no-store" } },
          ),
        };
      }
    }

    return { user, response: null };
  } catch {
    return {
      user: null,
      response: NextResponse.json(
        { ok: false, error: "AUTH_BACKEND_NOT_CONFIGURED" },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      ),
    };
  }
}
