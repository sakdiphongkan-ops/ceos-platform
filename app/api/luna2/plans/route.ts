import { NextResponse } from "next/server";

export const dynamic = "force-static";

const plans = [
  {
    code: "FREE",
    name: "Free",
    monthlyPriceTHB: 0,
    billingInterval: "month",
    features: ["market.basic", "portfolio.basic"],
  },
  {
    code: "INVESTOR",
    name: "Investor",
    monthlyPriceTHB: 590,
    billingInterval: "month",
    features: ["market.realtime", "portfolio.full", "research.summary"],
  },
  {
    code: "PRO",
    name: "Pro",
    monthlyPriceTHB: 1990,
    billingInterval: "month",
    features: ["portfolio.full", "risk.advanced", "paper.trading", "research.advanced"],
  },
  {
    code: "QUANT",
    name: "Quant",
    monthlyPriceTHB: 4990,
    billingInterval: "month",
    features: ["formula.lab", "backtest", "oos.holdout.walkforward", "paper.trading"],
  },
  {
    code: "ENTERPRISE",
    name: "Enterprise",
    monthlyPriceTHB: null,
    billingInterval: "custom",
    features: ["enterprise.workspace", "api", "audit.export", "governance"],
  },
] as const;

export function GET() {
  return NextResponse.json({
    ok: true,
    currency: "THB",
    plans,
    billingProvider: "PROVIDER_NEUTRAL",
    liveMoney: false,
  });
}
