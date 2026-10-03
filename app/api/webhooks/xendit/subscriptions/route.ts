import { NextResponse } from "next/server";
import {
  mapXenditSubscriptionState,
  subscriptionReference,
  type XenditWebhook,
} from "../../../../../lib/luna2/billing/xendit";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const payload = (await request.json()) as XenditWebhook;
  const event = payload.event ?? "unknown";
  const state = mapXenditSubscriptionState(payload.event);
  const referenceId = subscriptionReference(payload);

  // Intentionally acknowledgement-only until the webhook verification secret
  // is provisioned. Do not mutate subscriptions from an unverified callback.
  return NextResponse.json({
    ok: true,
    provider: "xendit",
    apiVersion: payload.api_version ?? "2026-01-01",
    event,
    referenceId,
    mappedState: state,
    applied: false,
    reason: "WEBHOOK_VERIFICATION_SECRET_NOT_CONFIGURED",
  });
}
