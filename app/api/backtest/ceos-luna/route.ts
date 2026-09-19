import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SYMBOLS = ["ADVANC","AOT","CPALL","DELTA","GULF","KBANK","PTT","SCB","TOP","TRUE"];
const INITIAL = 1_000_000;

export async function GET() {
  return NextResponse.json({
    status: "READY_FOR_RUN",
    engine: "CEOS_X_LUNA",
    universe: SYMBOLS,
    capital: INITIAL,
    experiments: [
      "LUNA_BASELINE_ORB12",
      "CEOS60_ORB12",
      "CEOS70_ORB12",
      "CEOS85_ORB12",
      "LUNA_BASELINE_ATR5x1.5",
      "CEOS60_ATR5x1.5",
      "CEOS70_ATR5x1.5",
      "CEOS85_ATR5x1.5"
    ],
    rules: {
      timeframe: "15m",
      entry: "completed 15m close -> next 15m open",
      costBpsRoundTrip: 45,
      stopPct: 0.5,
      takePct: 1,
      maxHoldBars: 4,
      maxPositionPct: 20,
      maxConcurrentPositions: 5
    },
    note: "This endpoint is the integration contract. The production run must use point-in-time SET/SETSMART fundamentals; the current public-Finnomena proxy is research-only."
  });
}