export interface CompounderInput {
  revenueCagr: number;
  earningsCagr: number;
  roic: number;
  grossMargin: number;
  debtToEquity: number;
  moatScore: number;
  managementScore: number;
  futureTrendScore: number;
}

export interface CompounderResult {
  compounderScore: number;
  category: 'Potential Multibagger' | 'Quality Compounder' | 'Monitor' | 'Reject';
}

/**
 * CEOS Hidden Compounder Hunter v1
 * Designed to identify long-term wealth creators
 */
export function detectCompounder(
  input: CompounderInput
): CompounderResult {
  const financialQuality =
    input.revenueCagr * 0.15 +
    input.earningsCagr * 0.2 +
    input.roic * 0.2 +
    input.grossMargin * 0.1;

  const businessQuality =
    input.moatScore * 0.15 +
    input.managementScore * 0.1 +
    input.futureTrendScore * 0.1;

  const penalty = Math.min(input.debtToEquity * 5, 20);

  const score = Math.max(
    0,
    financialQuality + businessQuality - penalty
  );

  let category: CompounderResult['category'];

  if (score >= 85) category = 'Potential Multibagger';
  else if (score >= 70) category = 'Quality Compounder';
  else if (score >= 50) category = 'Monitor';
  else category = 'Reject';

  return {
    compounderScore: Number(score.toFixed(2)),
    category,
  };
}
