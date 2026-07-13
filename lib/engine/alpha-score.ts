export interface StockFactorInput {
  quality: number;
  growth: number;
  valuation: number;
  risk: number;
  momentum: number;
}

export interface AlphaScoreResult {
  alphaScore: number;
  rating: 'Elite' | 'Strong' | 'Watch' | 'Avoid';
}

/**
 * CEOS Alpha Engine v1
 * Weight model:
 * Quality 35%
 * Growth 25%
 * Valuation 20%
 * Risk 10%
 * Momentum 10%
 */
export function calculateAlphaScore(input: StockFactorInput): AlphaScoreResult {
  const score =
    input.quality * 0.35 +
    input.growth * 0.25 +
    input.valuation * 0.2 +
    input.risk * 0.1 +
    input.momentum * 0.1;

  let rating: AlphaScoreResult['rating'];

  if (score >= 85) rating = 'Elite';
  else if (score >= 70) rating = 'Strong';
  else if (score >= 50) rating = 'Watch';
  else rating = 'Avoid';

  return {
    alphaScore: Number(score.toFixed(2)),
    rating,
  };
}
