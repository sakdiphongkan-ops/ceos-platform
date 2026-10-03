import type {
  EvidenceRef,
  FactorObservation,
  MarketObservation,
  PortfolioContext,
  RiskAssessment,
} from "../domain";

type FeedRow = Record<string, unknown>;

function stringValue(row: FeedRow, key: string): string | undefined {
  const value = row[key];
  return value == null ? undefined : String(value);
}

function numberValue(row: FeedRow, key: string): number | undefined {
  const value = Number(row[key]);
  return Number.isFinite(value) ? value : undefined;
}

export function evidence(
  evidenceId: string,
  kind: EvidenceRef["kind"],
  source: string,
  capturedAt: string,
  version = "1.0.0",
): EvidenceRef {
  return { evidenceId, kind, source, capturedAt, version };
}

export function mapTickToMarketObservation(
  tick: FeedRow,
  instrumentId: string,
): MarketObservation | null {
  const timestamp = stringValue(tick, "ts") ?? stringValue(tick, "created_at");
  const close =
    numberValue(tick, "last") ??
    numberValue(tick, "close") ??
    numberValue(tick, "bid") ??
    numberValue(tick, "ask");

  if (!timestamp || close == null) return null;

  const source = stringValue(tick, "source") ?? "LUNA_FEED";
  return {
    instrumentId,
    timestamp,
    timeframe: "15m",
    open: numberValue(tick, "open"),
    high: numberValue(tick, "high"),
    low: numberValue(tick, "low"),
    close,
    volume: numberValue(tick, "volume"),
    source,
    sourceTimestamp: stringValue(tick, "source_ts"),
    evidence: evidence(
      "MKT-" + instrumentId + "-" + timestamp,
      "DATA_SNAPSHOT",
      source,
      timestamp,
    ),
  };
}

export function mapSignalToFactor(
  signal: FeedRow,
  instrumentId: string,
): FactorObservation | null {
  const asOf = stringValue(signal, "ts") ?? stringValue(signal, "created_at");
  const value =
    numberValue(signal, "score") ??
    numberValue(signal, "confidence") ??
    numberValue(signal, "value");

  if (!asOf || value == null) return null;

  const action = stringValue(signal, "action") ?? "UNKNOWN";
  return {
    factorId: "SIGNAL-" + instrumentId,
    name: "LUNA_SIGNAL_" + action,
    value,
    asOf,
    source: stringValue(signal, "source") ?? "LUNA_SIGNAL",
    evidence: evidence(
      "SIG-" + instrumentId + "-" + asOf,
      "SIGNAL",
      stringValue(signal, "source") ?? "LUNA_SIGNAL",
      asOf,
    ),
  };
}

export function mapExecutionControlToRisk(
  executionControl: FeedRow | null,
  asOf: string,
): RiskAssessment {
  const blockersValue = executionControl?.blockers;
  const blockers = Array.isArray(blockersValue)
    ? blockersValue.map(String)
    : [];

  const blocked =
    blockers.length > 0 ||
    executionControl?.allowed === false ||
    executionControl?.live_allowed === false;

  return {
    riskId: "RISK-" + asOf,
    assessedAt: asOf,
    level: blocked ? "BLOCKED" : "MEDIUM",
    blockers,
    evidence: [
      evidence(
        "RISK-" + asOf,
        "RISK",
        "LUNA_EXECUTION_CONTROL",
        asOf,
      ),
    ],
  };
}

export function mapSessionToPortfolio(
  session: FeedRow,
  positions: FeedRow[],
  asOf: string,
): PortfolioContext {
  const cash = numberValue(session, "cash") ?? numberValue(session, "initial_capital") ?? 0;
  const marketValue = numberValue(session, "market_value") ?? 0;

  return {
    portfolioId: stringValue(session, "id") ?? "LUNA-PAPER",
    asOf,
    cash,
    marketValue,
    grossExposure: marketValue,
    positions: positions
      .map((position) => ({
        instrumentId: stringValue(position, "symbol") ?? "UNKNOWN",
        quantity: numberValue(position, "qty") ?? numberValue(position, "quantity") ?? 0,
        averageCost:
          numberValue(position, "avg_price") ??
          numberValue(position, "average_cost"),
      }))
      .filter((position) => position.quantity !== 0),
    evidence: [
      evidence(
        "PORT-" + (stringValue(session, "id") ?? asOf),
        "PORTFOLIO",
        "LUNA_SESSION",
        asOf,
      ),
    ],
  };
}
