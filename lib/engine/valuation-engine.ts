export interface ValuationInput {
  eps: number;
  peMultiple: number;
  bookValue: number;
  pbMultiple: number;
  dcfValue?: number;
  currentPrice: number;
}

export interface ValuationResult {
  fairValue: number;
  marginOfSafety: number;
  valuationStatus: 'Strong Buy Zone' | 'Fair Value' | 'Expensive';
}

/**
 * CEOS Valuation Intelligence Engine v1
 * Combines PE, PB and DCF valuation methods
 */
export function calculateFairValue(
  input: ValuationInput
): ValuationResult {
  const peValue = input.eps * input.peMultiple;
  const pbValue = input.bookValue * input.pbMultiple;

  const values = [peValue, pbValue];

  if (input.dcfValue) {
    values.push(input.dcfValue);
  }

  const fairValue =
    values.reduce((sum, value) => sum + value, 0) / values.length;

  const marginOfSafety =
    ((fairValue - input.currentPrice) / fairValue) * 100;

  return {
    fairValue: Number(fairValue.toFixed(2)),
    marginOfSafety: Number(marginOfSafety.toFixed(2)),
    valuationStatus:
      marginOfSafety >= 25
        ? 'Strong Buy Zone'
        : marginOfSafety >= 0
        ? 'Fair Value'
        : 'Expensive',
  };
}
