import { NextResponse } from "next/server";

export const dynamic = "force-static";

export function GET() {
  return NextResponse.json({
    ok: true,
    platform: "LUNA",
    architecture: "LUNA 2.0",
    contractVersion: "1.0.0",
    execution: {
      liveMoney: false,
      paperSupported: true,
      customFormulaExecution: false,
    },
    layers: [
      "market",
      "fundamental",
      "quant",
      "decision",
      "risk",
      "portfolio",
      "execution",
      "evidence",
      "billing",
      "agents",
    ],
    researchLifecycle: [
      "DRAFT",
      "RESEARCH",
      "VALIDATED",
      "PAPER",
      "PROMOTED",
      "LIVE",
      "RETIRED",
    ],
    agentDefaultPermission: "L3_PREPARE",
  });
}
