export interface Stock {
  id: string;
  symbol: string;
  market: 'SET' | 'US';
  companyName?: string;
  sector?: string;
}

export interface StockScore {
  stockId: string;
  qualityScore: number;
  growthScore: number;
  valuationScore: number;
  riskScore: number;
  momentumScore: number;
  alphaScore: number;
}

export interface PortfolioPosition {
  stockId: string;
  quantity: number;
  avgCost: number;
  targetWeight: number;
}
