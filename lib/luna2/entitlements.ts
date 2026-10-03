import type { Entitlement } from "./domain";

export const LUNA_PLANS = ["FREE", "INVESTOR", "PRO", "QUANT", "ENTERPRISE"] as const;

const PLAN_FEATURES: Record<(typeof LUNA_PLANS)[number], readonly Entitlement[]> = {
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
  plan: (typeof LUNA_PLANS)[number],
): readonly Entitlement[] {
  return PLAN_FEATURES[plan];
}

export function hasEntitlement(
  plan: (typeof LUNA_PLANS)[number],
  feature: string,
): boolean {
  return entitlementsForPlan(plan).some((item) => item.feature === feature);
}
