export interface CapitalAllocationInput {
  cashAvailable: number;
  stocks: {
    symbol: string;
    alphaScore: number;
    compounderScore: number;
    valuationScore: number;
    dividendScore: number;
    riskScore: number;
  }[];
}

export interface AllocationResult {
  symbol: string;
  allocationPercent: number;
  reason: string;
}

/**
 * CEOS Capital Allocation Engine v1
 * CIO-style decision layer
 */
export function allocateCapital(
  input: CapitalAllocationInput
): AllocationResult[] {
  const ranked = input.stocks.map((stock) => {
    const score =
      stock.alphaScore * 0.35 +
      stock.compounderScore * 0.3 +
      stock.valuationScore * 0.2 +
      stock.dividendScore * 0.1 -
      stock.riskScore * 0.05;

    return {
      ...stock,
      capitalScore: score,
    };
  });

  const totalScore = ranked.reduce(
    (sum, stock) => sum + Math.max(stock.capitalScore, 0),
    0
  );

  return ranked
    .sort((a, b) => b.capitalScore - a.capitalScore)
    .map((stock) => ({
      symbol: stock.symbol,
      allocationPercent: Number(
        ((Math.max(stock.capitalScore, 0) / totalScore) * 100).toFixed(2)
      ),
      reason:
        stock.compounderScore >= 85
          ? 'High conviction compounder'
          : stock.dividendScore >= 80
          ? 'Quality income asset'
          : 'Balanced alpha opportunity',
    }));
}
