export interface DecisionInput {
  alphaScore: number;
  compounderScore: number;
  marginOfSafety: number;
  valuationStatus: string;
  currentWeight: number;
  recommendedWeight: number;
  riskScore: number;
}

export interface DecisionResult {
  action: 'BUY NOW' | 'ACCUMULATE' | 'HOLD' | 'TRIM' | 'EXIT';
  conviction: number;
  explanation: string;
}

/**
 * CEOS Buy/Sell Decision Engine v1
 * Converts analysis signals into portfolio actions
 */
export function generateInvestmentDecision(
  input: DecisionInput
): DecisionResult {
  const conviction =
    input.alphaScore * 0.3 +
    input.compounderScore * 0.3 +
    Math.max(input.marginOfSafety, 0) * 0.25 +
    (100 - input.riskScore) * 0.15;

  let action: DecisionResult['action'];
  let explanation: string;

  if (conviction >= 85 && input.marginOfSafety >= 25) {
    action = 'BUY NOW';
    explanation = 'High conviction opportunity with attractive valuation';
  } else if (conviction >= 70) {
    action = 'ACCUMULATE';
    explanation = 'Quality asset suitable for gradual accumulation';
  } else if (conviction >= 50) {
    action = 'HOLD';
    explanation = 'Maintain position while monitoring fundamentals';
  } else if (input.currentWeight > input.recommendedWeight) {
    action = 'TRIM';
    explanation = 'Portfolio weight exceeds calculated allocation';
  } else {
    action = 'EXIT';
    explanation = 'Risk-adjusted return is below CEOS threshold';
  }

  return {
    action,
    conviction: Number(conviction.toFixed(2)),
    explanation,
  };
}
