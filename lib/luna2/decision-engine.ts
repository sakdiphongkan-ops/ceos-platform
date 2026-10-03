import type {
  DecisionRequest,
  DecisionResponse,
  EvidenceRef,
  FundamentalSnapshot,
  FactorObservation,
  InvestmentDecision,
  PortfolioContext,
  RiskAssessment,
  ValuationResult,
} from "./domain";

export type DecisionInputs = {
  value?: ValuationResult[];
  fundamental?: FundamentalSnapshot;
  market?: FactorObservation[];
  risk?: RiskAssessment;
  portfolio?: PortfolioContext;
  evidence: EvidenceRef[];
  audit: InvestmentDecision["audit"];
};

function hasEvidence(items: EvidenceRef[] | undefined): boolean {
  return Array.isArray(items) && items.length > 0;
}

function normalizeAction(
  request: DecisionRequest,
  inputs: DecisionInputs,
): InvestmentDecision["action"] {
  if (!hasEvidence(inputs.evidence)) return "BLOCK";
  if (inputs.risk?.level === "BLOCKED" || (inputs.risk?.blockers?.length ?? 0) > 0) {
    return "BLOCK";
  }
  if (request.objective === "RESEARCH") return "WATCH";
  if (request.objective === "PORTFOLIO_REVIEW") return "HOLD";
  return "WATCH";
}

/**
 * Deterministic, evidence-first decision shell.
 *
 * It intentionally does not invent scores or market conclusions.
 * A strategy/model adapter must supply the actual evidence.
 */
export function evaluateDecision(
  request: DecisionRequest,
  inputs: DecisionInputs,
): DecisionResponse {
  const action = normalizeAction(request, inputs);
  const blockers: string[] = [];

  if (!hasEvidence(inputs.evidence)) blockers.push("NO_EVIDENCE");
  if (inputs.risk?.blockers?.length) blockers.push(...inputs.risk.blockers);

  const decision: InvestmentDecision = {
    decisionId: "DEC-" + request.instrumentId + "-" + request.asOf,
    instrumentId: request.instrumentId,
    createdAt: request.asOf,
    action,
    value: inputs.value,
    fundamental: inputs.fundamental,
    market: inputs.market,
    risk: inputs.risk,
    portfolio: inputs.portfolio,
    evidence: inputs.evidence,
    audit: inputs.audit,
  };

  const paperOnly = request.objective !== "LIVE_ORDER";
  const promotionEligible =
    action !== "BLOCK" &&
    blockers.length === 0 &&
    paperOnly;

  return {
    decision,
    promotionEligible,
    blockers,
  };
}
