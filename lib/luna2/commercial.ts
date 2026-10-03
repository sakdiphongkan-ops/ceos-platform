import type { Entitlement } from "./domain";

export type CommercialPlan =
  | "FREE"
  | "INVESTOR"
  | "PRO"
  | "QUANT"
  | "ENTERPRISE";

export type SubscriptionState =
  | "TRIALING"
  | "ACTIVE"
  | "PAST_DUE"
  | "CANCELLED"
  | "EXPIRED";

export type CustomerSubscription = {
  plan: CommercialPlan;
  status: SubscriptionState;
  currentPeriodEnd?: string;
};

export type UsageSnapshot = {
  entitlement: string;
  used: number;
  limit?: number;
};

export type EntitlementDecision = {
  allowed: boolean;
  plan: CommercialPlan;
  entitlement: string;
  reason: "GRANTED" | "PLAN_MISSING" | "SUBSCRIPTION_INACTIVE" | "LIMIT_REACHED";
  remaining?: number;
};

const catalog: Record<CommercialPlan, readonly Entitlement[]> = {
  FREE: [
    { plan: "FREE", feature: "market.basic", limit: 1, unit: "DAY" },
    { plan: "FREE", feature: "portfolio.basic", limit: 1, unit: "DAY" },
  ],
  INVESTOR: [
    { plan: "INVESTOR", feature: "market.realtime", limit: 1, unit: "DAY" },
    { plan: "INVESTOR", feature: "portfolio.full" },
    { plan: "INVESTOR", feature: "research.summary", limit: 50, unit: "MONTH" },
  ],
  PRO: [
    { plan: "PRO", feature: "portfolio.full" },
    { plan: "PRO", feature: "risk.advanced" },
    { plan: "PRO", feature: "paper.trading" },
    { plan: "PRO", feature: "research.advanced", limit: 250, unit: "MONTH" },
  ],
  QUANT: [
    { plan: "QUANT", feature: "formula.lab" },
    { plan: "QUANT", feature: "backtest", limit: 250, unit: "MONTH" },
    { plan: "QUANT", feature: "oos.holdout.walkforward" },
    { plan: "QUANT", feature: "paper.trading" },
  ],
  ENTERPRISE: [
    { plan: "ENTERPRISE", feature: "enterprise.workspace" },
    { plan: "ENTERPRISE", feature: "api" },
    { plan: "ENTERPRISE", feature: "audit.export" },
    { plan: "ENTERPRISE", feature: "governance" },
  ],
};

export function entitlementsForPlan(
  plan: CommercialPlan,
): readonly Entitlement[] {
  return catalog[plan];
}

export function authorizeEntitlement(
  subscription: CustomerSubscription | null,
  entitlement: string,
  usage?: UsageSnapshot,
): EntitlementDecision {
  if (!subscription) {
    return { allowed: false, plan: "FREE", entitlement, reason: "SUBSCRIPTION_INACTIVE" };
  }

  if (!["TRIALING", "ACTIVE"].includes(subscription.status)) {
    return { allowed: false, plan: subscription.plan, entitlement, reason: "SUBSCRIPTION_INACTIVE" };
  }

  const rule = entitlementsForPlan(subscription.plan).find(
    (item) => item.feature === entitlement,
  );

  if (!rule) {
    return { allowed: false, plan: subscription.plan, entitlement, reason: "PLAN_MISSING" };
  }

  if (rule.limit != null && usage && usage.used >= rule.limit) {
    return {
      allowed: false,
      plan: subscription.plan,
      entitlement,
      reason: "LIMIT_REACHED",
      remaining: 0,
    };
  }

  return {
    allowed: true,
    plan: subscription.plan,
    entitlement,
    reason: "GRANTED",
    remaining:
      rule.limit == null || !usage
        ? undefined
        : Math.max(0, rule.limit - usage.used),
  };
}
