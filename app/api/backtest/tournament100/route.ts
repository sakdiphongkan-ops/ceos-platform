import { NextResponse } from "next/server";
import {
  ENTRY_PCT,
  FEE_BPS,
  INITIAL,
  MAX_CANDIDATES,
  MAX_GROSS_PCT,
  MAX_POSITION_PCT,
  makeStrategies,
  buildSeries,
  fetchBars,
  runLuna2SignalStudy,
  runSignalStudy,
  runStrategy,
  costCurve,
  SELL_TAX_BPS,
  SLIPPAGE_BPS,
  SYMBOLS,
  type Bar,
} from "../../../../lib/tournament100-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LIQUID10 = ["PTT","CPALL","ADVANC","AOT","KBANK","KTB","SCB","GULF","DELTA","BDMS"] as const;
const LOOKBACK_DAYS = 10;
const FETCH_CONCURRENCY = 8;
const DATA_CACHE_TTL_MS = 30_000;

type ResearchMode = "portfolio" | "signal" | "luna2" | "cost";
type MarketData = { barsBySymbol: Map<string, Bar[]>; errors: string[] };
type CachedMarketData = MarketData & { expiresAt: number };

const marketDataCache = new Map<string, CachedMarketData>();

function getMode(value: string | null): ResearchMode {
  if (value === "signal" || value === "luna2" || value === "cost") return value;
  return "portfolio";
}

function getUniverse(value: string | null) {
  return value === "liquid10"
    ? { name: "liquid10", symbols: [...LIQUID10] }
    : { name: "full", symbols: [...SYMBOLS] };
}

function dateOnly(epochSeconds: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(epochSeconds * 1000));
}

function buildCacheKey(symbols: string[], start: number, end: number): string {
  return [start, end, symbols.join(",")].join(":");
}

async function loadMarketData(symbols: string[], start: number, end: number): Promise<MarketData> {
  const key = buildCacheKey(symbols, start, end);
  const cached = marketDataCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return { barsBySymbol: new Map(cached.barsBySymbol), errors: [...cached.errors] };
  }

  const barsBySymbol = new Map<string, Bar[]>();
  const errors: string[] = [];

  for (let offset = 0; offset < symbols.length; offset += FETCH_CONCURRENCY) {
    const chunk = symbols.slice(offset, offset + FETCH_CONCURRENCY);
    const results = await Promise.allSettled(chunk.map((symbol) => fetchBars(symbol, start, end)));

    results.forEach((result, index) => {
      const symbol = chunk[index];
      if (result.status === "fulfilled") barsBySymbol.set(symbol, result.value);
      else errors.push(symbol);
    });
  }

  marketDataCache.set(key, { barsBySymbol, errors, expiresAt: Date.now() + DATA_CACHE_TTL_MS });
  return { barsBySymbol, errors };
}

function summarizeData(universe: string, universeCount: number, data: MarketData) {
  return {
    universe,
    universeCount,
    symbolsReturned: data.barsBySymbol.size,
    symbolsFailed: data.errors.length,
    bars15m: Array.from(data.barsBySymbol.values()).reduce((total, bars) => total + bars.length, 0),
    errors: data.errors,
  };
}

function buildResearchRules(costBps: number) {
  return {
    entry: "completed 15m close -> next 15m open",
    fixedHorizonBars: 4,
    costModelBps: costBps,
    lookahead: false,
  };
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Research request failed";
  return NextResponse.json({ status: "FAILED", mode: "RESEARCH_ONLY", error: message }, { status: 500 });
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const mode = getMode(url.searchParams.get("mode"));
    const universe = getUniverse(url.searchParams.get("universe"));
    const batch = Math.max(0, Math.min(4, Number(url.searchParams.get("batch") ?? "0")));

    const end = Math.floor(Date.now() / 1000);
    const start = end - LOOKBACK_DAYS * 24 * 60 * 60;
    const period = { start: dateOnly(start), end: dateOnly(end), sessions: LOOKBACK_DAYS };

    const marketData = await loadMarketData(universe.symbols, start, end);
    const seriesBySymbol = new Map(
      Array.from(marketData.barsBySymbol.entries()).map(([symbol, bars]) => [symbol, buildSeries(bars)]),
    );
    const strategies = makeStrategies();
    const dataSummary = summarizeData(universe.name, universe.symbols.length, marketData);
    const referenceCostBps = 2 * SLIPPAGE_BPS + FEE_BPS + SELL_TAX_BPS;

    if (mode === "signal") {
      const results = strategies
        .map((strategy) => ({
          ...runSignalStudy(strategy, marketData.barsBySymbol, seriesBySymbol),
          id: strategy.id, family: strategy.family, name: strategy.name, source: strategy.source,
        }))
        .sort((a, b) => b.totalNetBps - a.totalNetBps);

      return NextResponse.json({
        status: "COMPLETED", mode: "RESEARCH_ONLY", testType: "100-STRATEGY-SIGNAL-STUDY",
        period, data: dataSummary, rules: buildResearchRules(referenceCostBps),
        strategiesTested: results.length, top20: results.slice(0, 20), allResults: results,
      });
    }

    if (mode === "luna2") {
      const result = runLuna2SignalStudy(marketData.barsBySymbol, seriesBySymbol, referenceCostBps);
      const curve = [0, 10, 15, 20, 30, 45].map((costBps) => ({
        costBps,
        ...runLuna2SignalStudy(marketData.barsBySymbol, seriesBySymbol, costBps),
      }));

      return NextResponse.json({
        status: "COMPLETED", mode: "RESEARCH_ONLY",
        testType: "LUNA-2-REGIME-AWARE-OPPORTUNITY-STUDY",
        period, data: dataSummary,
        rules: {
          ...buildResearchRules(referenceCostBps),
          regime: "TREND / HIGH_VOL / RANGE / LOW_VOL",
          filters: ["relative strength", "volatility expansion", "volume confirmation", "minimum opportunity vs cost"],
        },
        result, costCurve: curve,
      });
    }

    if (mode === "cost") {
      const orb15 = strategies.find((strategy) => strategy.family === "ORB" && strategy.p.n === 15);
      if (!orb15) {
        return NextResponse.json(
          { status: "FAILED", mode: "RESEARCH_ONLY", error: "ORB-15 strategy unavailable" },
          { status: 500 },
        );
      }

      return NextResponse.json({
        status: "COMPLETED", mode: "RESEARCH_ONLY", testType: "COST-SENSITIVITY",
        strategy: "Opening range breakout 15", period, data: dataSummary,
        curve: costCurve(orb15, marketData.barsBySymbol, seriesBySymbol, [0, 10, 15, 20, 30, 45]),
      });
    }

    const subset = strategies.slice(batch * 20, batch * 20 + 20);
    const results = subset
      .map((strategy) => runStrategy(strategy, marketData.barsBySymbol, seriesBySymbol))
      .sort((a, b) => b.netPnl - a.netPnl);

    const grouped = results.reduce((groups, row) => {
      const family = groups.get(row.family) ?? [];
      family.push(row);
      groups.set(row.family, family);
      return groups;
    }, new Map<string, typeof results>());

    const byFamily = Array.from(grouped.values())
      .map((family) => [...family].sort((a, b) => b.netPnl - a.netPnl)[0])
      .filter(Boolean)
      .sort((a, b) => b.netPnl - a.netPnl);

    return NextResponse.json({
      status: "COMPLETED", mode: "RESEARCH_ONLY", testType: "100-STRATEGY-TOURNAMENT-BATCH",
      batch, batchSize: subset.length, totalStrategies: strategies.length, period,
      data: dataSummary,
      rules: {
        initialCapital: INITIAL, positionCapPct: MAX_POSITION_PCT, entryPct: ENTRY_PCT,
        maxGrossPct: MAX_GROSS_PCT, feeBps: FEE_BPS, sellTaxBps: SELL_TAX_BPS,
        slippageBps: SLIPPAGE_BPS, maxCandidates: MAX_CANDIDATES,
        signalExecution: "completed 15m close -> next 15m open", lookahead: false,
      },
      strategiesTested: results.length,
      rankBy: "net P&L after fees and slippage",
      top10: results.slice(0, 10), bottom10: results.slice(-10), byFamily, allResults: results,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
