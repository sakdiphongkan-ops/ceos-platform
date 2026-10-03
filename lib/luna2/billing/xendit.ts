export type XenditSubscriptionEvent =
  | "recurring.plan.activated"
  | "recurring.plan.inactivated"
  | "recurring.cycle.created"
  | "recurring.cycle.retrying"
  | "recurring.cycle.succeeded"
  | "recurring.cycle.failed"
  | "recurring.cycle.force_attempt_failed";

export type XenditWebhook = {
  event?: XenditSubscriptionEvent | string;
  business_id?: string;
  created?: string;
  api_version?: string;
  data?: {
    id?: string;
    reference_id?: string;
    plan_id?: string;
    customer_id?: string;
    status?: string;
    cycle_number?: number;
    amount?: number;
    currency?: string;
    [key: string]: unknown;
  };
};

export type LumaBillingState =
  | "TRIALING"
  | "ACTIVE"
  | "PAST_DUE"
  | "CANCELLED"
  | "EXPIRED";

export function mapXenditSubscriptionState(
  event: XenditSubscriptionEvent | string | undefined,
): LumaBillingState | null {
  switch (event) {
    case "recurring.plan.activated":
    case "recurring.cycle.succeeded":
      return "ACTIVE";
    case "recurring.cycle.retrying":
    case "recurring.cycle.failed":
    case "recurring.cycle.force_attempt_failed":
      return "PAST_DUE";
    case "recurring.plan.inactivated":
      return "CANCELLED";
    default:
      return null;
  }
}

export function subscriptionReference(webhook: XenditWebhook): string | null {
  const reference = webhook.data?.reference_id;
  return typeof reference === "string" && reference.length > 0 ? reference : null;
}
