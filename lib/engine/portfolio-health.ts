export interface PortfolioInput {
  positions: {
    symbol: string;
    weight: number;
    alphaScore: number;
    riskScore: number;
  }[];
}

export interface PortfolioHealthResult {
  healthScore: number;
  diversificationScore: number;
  alphaQualityScore: number;
  riskScore: number;
  status: 'Excellent' | 'Healthy' | 'Review';
}

/**
 * CEOS Portfolio Intelligence Engine v1
 * Evaluates portfolio quality using:
 * - Alpha quality
 * - Diversification
 * - Risk control
 */
export function calculatePortfolioHealth(
  input: PortfolioInput
): PortfolioHealthResult {
  if (!input.positions.length) {
    return {
      healthScore: 0,
      diversificationScore: 0,
      alphaQualityScore: 0,
      riskScore: 0,
      status: 'Review',
    };
  }

  const alphaQualityScore =
    input.positions.reduce((sum, p) => sum + p.alphaScore, 0) /
    input.positions.length;

  const concentration = Math.max(...input.positions.map((p) => p.weight));
  const diversificationScore = Math.max(0, 100 - concentration * 100);

  const riskScore =
    100 -
    input.positions.reduce((sum, p) => sum + p.riskScore, 0) /
      input.positions.length;

  const healthScore =
    alphaQualityScore * 0.5 +
    diversificationScore * 0.3 +
    riskScore * 0.2;

  return {
    healthScore: Number(healthScore.toFixed(2)),
    diversificationScore: Number(diversificationScore.toFixed(2)),
    alphaQualityScore: Number(alphaQualityScore.toFixed(2)),
    riskScore: Number(riskScore.toFixed(2)),
    status:
      healthScore >= 85
        ? 'Excellent'
        : healthScore >= 65
        ? 'Healthy'
        : 'Review',
  };
}
