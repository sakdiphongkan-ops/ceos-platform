import { NextResponse } from "next/server";

type ClientErrorBody = {
  source?: string;
  name?: string;
  message?: string;
};

const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 20;
const rateState = new Map<string, { startedAt: number; count: number }>();

function getClientKey(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "anonymous";
}

function sanitize(value: unknown, max = 500): string {
  return String(value ?? "")
    .replace(/https?:\/\/\S+/gi, "[url-redacted]")
    .replace(/(bearer\s+)[a-z0-9._-]+/gi, "$1[redacted]")
    .replace(/(access[_-]?token|refresh[_-]?token|password|secret|api[_-]?key|authorization|cookie|session(?:[_-]?id)?)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email-redacted]")
    .replace(/(?:\+?\d[\d\s().-]{7,}\d)/g, "[phone-redacted]")
    .slice(0, max);
}

export async function POST(request: Request) {
  let body: ClientErrorBody;

  try {
    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > 8_000) {
      return NextResponse.json({ ok: false, error: "PAYLOAD_TOO_LARGE" }, { status: 413 });
    }

    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object") {
      return NextResponse.json({ ok: false, error: "INVALID_PAYLOAD" }, { status: 400 });
    }
    body = parsed as ClientErrorBody;
  } catch {
    return NextResponse.json({ ok: false, error: "INVALID_PAYLOAD" }, { status: 400 });
  }

  const now = Date.now();
  const key = getClientKey(request);
  const current = rateState.get(key);

  if (!current || now - current.startedAt >= WINDOW_MS) {
    rateState.set(key, { startedAt: now, count: 1 });
  } else {
    current.count += 1;
    if (current.count > MAX_REQUESTS_PER_WINDOW) {
      const retryAfter = Math.max(1, Math.ceil((WINDOW_MS - (now - current.startedAt)) / 1000));
      return NextResponse.json(
        { ok: false, error: "RATE_LIMITED" },
        { status: 429, headers: { "Retry-After": String(retryAfter), "Cache-Control": "no-store" } },
      );
    }
  }

  const safeEvent = {
    source: sanitize(body.source, 40),
    name: sanitize(body.name, 100),
    message: sanitize(body.message, 500),
  };

  console.error("[LUNA_CLIENT_ERROR]", safeEvent);

  return NextResponse.json(
    { ok: true, accepted: true },
    { status: 202, headers: { "Cache-Control": "no-store" } },
  );
}
