export interface DividendInput {
  dividendYield: number;
  payoutRatio: number;
  dividendGrowth: number;
  roe: number;
}

export function calculateDividendQuality(input: DividendInput) {
  const score =
    input.dividendGrowth * 0.35 +
    input.dividendYield * 0.3 +
    (100 - input.payoutRatio) * 0.2 +
    input.roe * 0.15;

  return {
    dividendScore: Number(score.toFixed(2)),
    classification:
      score >= 80
        ? 'Dividend Compounder'
        : score >= 60
        ? 'Income Quality'
        : 'Weak Dividend',
  };
}
