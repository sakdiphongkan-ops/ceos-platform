export interface PositionSizingInput {
  alphaScore: number;
  compounderScore: number;
  valuationScore: number;
  riskScore: number;
  portfolioValue: number;
  currentWeight: number;
}

export interface PositionSizingResult {
  recommendedWeight: number;
  action: 'Increase' | 'Hold' | 'Reduce';
  maxAllocation: number;
}

/**
 * CEOS Position Sizing & Risk Engine v1
 * Controls portfolio concentration risk
 */
export function calculatePositionSize(
  input: PositionSizingInput
): PositionSizingResult {
  const convictionScore =
    input.alphaScore * 0.4 +
    input.compounderScore * 0.35 +
    input.valuationScore * 0.25;

  const riskAdjustment = Math.max(
    0.5,
    1 - input.riskScore / 200
  );

  const maxAllocation = Math.min(
    25,
    convictionScore * 0.25 * riskAdjustment
  );

  const recommendedWeight = Number(maxAllocation.toFixed(2));

  return {
    recommendedWeight,
    maxAllocation: Number(maxAllocation.toFixed(2)),
    action:
      recommendedWeight > input.currentWeight + 2
        ? 'Increase'
        : recommendedWeight < input.currentWeight - 2
        ? 'Reduce'
        : 'Hold',
  };
}
