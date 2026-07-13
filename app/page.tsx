import { calculateAlphaScore } from '@/lib/engine/alpha-score';
import { calculatePortfolioHealth } from '@/lib/engine/portfolio-health';
import { calculateFairValue } from '@/lib/engine/valuation-engine';

export default function Home() {
  const alpha = calculateAlphaScore({
    quality: 90,
    growth: 85,
    valuation: 75,
    risk: 80,
    momentum: 70,
  });

  const health = calculatePortfolioHealth({
    positions: [
      { symbol: 'CEOS Demo', weight: 0.2, alphaScore: alpha.alphaScore, riskScore: 20 },
    ],
  });

  const valuation = calculateFairValue({
    eps: 5,
    peMultiple: 20,
    bookValue: 50,
    pbMultiple: 2,
    currentPrice: 80,
  });

  return (
    <main className="min-h-screen p-8">
      <h1 className="text-4xl font-bold">CEOS AI Investment System</h1>
      <p className="mt-2">Capital Allocation & Intelligence Platform</p>

      <div className="grid gap-4 mt-8 md:grid-cols-3">
        <Card title="Alpha Score" value={`${alpha.alphaScore} (${alpha.rating})`} />
        <Card title="Portfolio Health" value={`${health.healthScore} (${health.status})`} />
        <Card title="Fair Value" value={`${valuation.fairValue} / ${valuation.valuationStatus}`} />
      </div>
    </main>
  );
}

function Card({ title, value }: { title: string; value: string }) {
  return (
    <div className="rounded-xl border p-6">
      <h2 className="font-semibold">{title}</h2>
      <p className="mt-3 text-2xl">{value}</p>
    </div>
  );
}
