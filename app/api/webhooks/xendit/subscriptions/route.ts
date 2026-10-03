import { NextResponse } from "next/server";
import {
  mapXenditSubscriptionState,
  subscriptionReference,
  type XenditWebhook,
} from "../../../../../lib/luna2/billing/xendit";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  const contentLength = Number(request.headers.get("content-length") || 0);

  if (!contentType.toLowerCase().includes("application/json")) {
    return NextResponse.json(
      { ok: false, error: "UNSUPPORTED_MEDIA_TYPE" },
      { status: 415, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (contentLength > 32_000) {
    return NextResponse.json(
      { ok: false, error: "PAYLOAD_TOO_LARGE" },
      { status: 413, headers: { "Cache-Control": "no-store" } },
    );
  }

  let payload: XenditWebhook;
  try {
    const raw = await request.json();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return NextResponse.json(
        { ok: false, error: "INVALID_PAYLOAD" },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    payload = raw as XenditWebhook;
  } catch {
    return NextResponse.json(
      { ok: false, error: "INVALID_JSON" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const event = payload.event ?? "unknown";
  const state = mapXenditSubscriptionState(payload.event);
  const referenceId = subscriptionReference(payload);

  // Acknowledgement-only until provider verification is configured.
  // Never mutate subscriptions from an unverified callback.
  return NextResponse.json({
    ok: true,
    provider: "xendit",
    apiVersion: payload.api_version ?? "2026-01-01",
    event,
    referenceId: referenceId ? String(referenceId).slice(0, 200) : null,
    mappedState: state,
    applied: false,
    reason: "WEBHOOK_VERIFICATION_SECRET_NOT_CONFIGURED",
  }, { status: 202, headers: { "Cache-Control": "no-store" } });
}
