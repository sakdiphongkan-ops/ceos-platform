import type {Quote,Signal} from "./types.js";

export const VERSION="luna-th1h-bootstrap-0.1.0";

export function evaluate(q:Quote):Signal{
  return {
    symbol:q.symbol,
    ts:q.ts,
    action:"HOLD",
    reason:"Bootstrap strategy: no live signal until validated strategy rules are installed.",
    strategyVersion:VERSION
  };
}
