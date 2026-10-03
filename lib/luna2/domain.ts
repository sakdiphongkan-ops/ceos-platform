/**
 * LUNA 2.0 Unified Domain Contracts
 *
 * These interfaces are contracts only. They do not execute trades.
 * Evidence and audit references are first-class so every consequential
 * decision can be traced back to source data and model versions.
 */

export type ISODateTime = string;
export type EntityId = string;

export type EvidenceRef = {
  evidenceId: EntityId;
  kind:
    | "DATA_SNAPSHOT"
    | "FUNDAMENTAL"
    | "VALUATION"
    | "FORMULA"
    | "BACKTEST"
    | "OOS"
    | "HOLDOUT"
    | "WALK_FORWARD"
    | "ROBUSTNESS"
    | "SIGNAL"
    | "RISK"
    | "PORTFOLIO"
    | "ORDER"
    | "FILL"
    | "OUTCOME";
  version: string;
  source: string;
  capturedAt: ISODateTime;
  contentHash?: string;
};

export type AuditRef = {
  auditId: EntityId;
  actorType: "USER" | "AGENT" | "SYSTEM";
  actorId: EntityId;
  action: string;
  occurredAt: ISODateTime;
  authorization?: string;
};

export type Instrument = {
  instrumentId: EntityId;
  symbol: string;
  venue: "SET" | "mai" | string;
  currency: "THB" | string;
  active: boolean;
};

export type MarketObservation = {
  instrumentId: EntityId;
  timestamp: ISODateTime;
  timeframe: "1m" | "5m" | "15m" | "1h" | "1d" | string;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
  source: string;
  sourceTimestamp?: ISODateTime;
  evidence: EvidenceRef;
};

export type ValuationResult = {
  model: "DCF" | "DDM" | "SOTP" | "MULTIPLES" | string;
  version: string;
  asOf: ISODateTime;
  fairValue?: number;
  downsideOrUpsidePct?: number;
  marginOfSafetyPct?: number;
  scenario?: "BEAR" | "BASE" | "BULL" | string;
  evidence: EvidenceRef[];
};

export type FundamentalSnapshot = {
  instrumentId: EntityId;
  asOf: ISODateTime;
  quality?: Record<string, number | string | boolean>;
  valuation: ValuationResult[];
  evidence: EvidenceRef[];
};

export type FactorObservation = {
  factorId: EntityId;
  name: string;
  value: number;
  asOf: ISODateTime;
  source: string;
  evidence: EvidenceRef;
};

export type FormulaSpec = {
  formulaId: EntityId;
  version: string;
  canonical: string;
  hash: string;
  factors: Array<{
    factorId: EntityId;
    operator: "+" | "-" | "×";
    weight: number;
  }>;
};

export type ResearchRun = {
  runId: EntityId;
  kind: "BACKTEST" | "OOS" | "HOLDOUT" | "WALK_FORWARD" | "ROBUSTNESS";
  status: "PENDING" | "COMPLETED" | "BLOCKED" | "FAILED";
  strategyVersionId: EntityId;
  startedAt: ISODateTime;
  completedAt?: ISODateTime;
  lookahead: false;
  costModelBps?: number;
  resultHash?: string;
  evidence: EvidenceRef[];
};

export type StrategyVersion = {
  strategyId: EntityId;
  versionId: EntityId;
  lifecycle:
    | "DRAFT"
    | "RESEARCH"
    | "VALIDATED"
    | "PAPER"
    | "PROMOTED"
    | "LIVE"
    | "RETIRED";
  formula?: FormulaSpec;
  researchRuns: EntityId[];
  createdAt: ISODateTime;
  immutable: true;
};

export type RiskAssessment = {
  riskId: EntityId;
  assessedAt: ISODateTime;
  level: "LOW" | "MEDIUM" | "HIGH" | "BLOCKED" | string;
  drawdownPct?: number;
  liquidityRisk?: number;
  concentrationRisk?: number;
  executionRisk?: number;
  blockers: string[];
  evidence: EvidenceRef[];
};

export type PortfolioContext = {
  portfolioId: EntityId;
  asOf: ISODateTime;
  cash: number;
  marketValue: number;
  grossExposure: number;
  positions: Array<{
    instrumentId: EntityId;
    quantity: number;
    averageCost?: number;
    weightPct?: number;
  }>;
  evidence: EvidenceRef[];
};

export type InvestmentDecision = {
  decisionId: EntityId;
  instrumentId: EntityId;
  createdAt: ISODateTime;
  action: "BUY" | "SELL" | "HOLD" | "WATCH" | "REDUCE" | "BLOCK";
  value?: ValuationResult[];
  fundamental?: FundamentalSnapshot;
  market?: FactorObservation[];
  risk?: RiskAssessment;
  portfolio?: PortfolioContext;
  evidence: EvidenceRef[];
  audit: AuditRef;
};

export type OrderIntent = {
  orderIntentId: EntityId;
  decisionId: EntityId;
  instrumentId: EntityId;
  side: "BUY" | "SELL";
  quantity: number;
  limitPrice?: number;
  mode: "PAPER" | "LIVE";
  approvalRequired: boolean;
  executionBlocked: boolean;
  blockers: string[];
};

export type ExecutionOutcome = {
  outcomeId: EntityId;
  orderIntentId: EntityId;
  status: "FILLED" | "PARTIAL" | "REJECTED" | "CANCELLED";
  fillPrice?: number;
  fillQuantity?: number;
  slippageBps?: number;
  fees?: number;
  completedAt: ISODateTime;
  evidence: EvidenceRef[];
};

export type Entitlement = {
  plan: "FREE" | "INVESTOR" | "PRO" | "QUANT" | "ENTERPRISE";
  feature: string;
  limit?: number;
  unit?: "MONTH" | "DAY" | "RUN" | "API_CALL" | "GB";
};

export type AgentAuthorization = {
  agentId: EntityId;
  permissionLevel: "L0_READ" | "L1_ANALYZE" | "L2_RECOMMEND" | "L3_PREPARE" | "L4_APPROVED_EXECUTE" | "L5_AUTONOMOUS";
  allowedFeatures: string[];
  requiresHumanApproval: boolean;
};

export type DecisionRequest = {
  instrumentId: EntityId;
  asOf: ISODateTime;
  objective: "RESEARCH" | "PORTFOLIO_REVIEW" | "SIGNAL_REVIEW" | "PAPER_ORDER" | "LIVE_ORDER";
};

export type DecisionResponse = {
  decision: InvestmentDecision;
  orderIntent?: OrderIntent;
  promotionEligible: boolean;
  blockers: string[];
};
