// Build the per-minute TopTrader priority queue without starving open holdings.
// Held positions are always first; queued orders and verified candidates use remaining capacity.
const normalize = (value) => String(value ?? "").trim().toUpperCase();

const uniqueSymbols = (values) => {
  const seen = new Set();
  const result = [];
  for (const value of values ?? []) {
    const symbol = normalize(value);
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    result.push(symbol);
  }
  return result;
};

/**
 * @typedef {Object} PrioritySymbolsOptions
 * @property {string[]} [activeSymbols]
 * @property {string[]} [heldSymbols]
 * @property {string[]} [queuedSymbols]
 * @property {string[]} [signalSymbols]
 * @property {number} [limit]
 */

/**
 * @param {PrioritySymbolsOptions} [options]
 * @returns {{
 *   symbols: string[],
 *   heldSymbols: string[],
 *   heldSymbolsOutsideActiveUniverse: string[],
 *   heldCount: number,
 *   heldSymbolsOutsideActiveUniverseCount: number,
 *   priorityCount: number,
 *   limitExceededByHoldings: boolean
 * }}
 */
export function buildPrioritySymbols({
  activeSymbols = [],
  heldSymbols = [],
  queuedSymbols = [],
  signalSymbols = [],
  limit = 30,
} = {}) {
  const active = new Set(uniqueSymbols(activeSymbols));
  const allHeld = uniqueSymbols(heldSymbols);
  const held = allHeld.filter((symbol) => active.has(symbol));
  const heldSet = new Set(held);
  const heldSymbolsOutsideActiveUniverse = allHeld.filter((symbol) => !active.has(symbol));

  const otherPriority = uniqueSymbols([...(queuedSymbols ?? []), ...(signalSymbols ?? [])])
    .filter((symbol) => active.has(symbol) && !heldSet.has(symbol));

  const requestedLimit = Number.isFinite(Number(limit)) ? Math.max(0, Math.floor(Number(limit))) : 30;
  // If the account holds more symbols than the normal queue limit, preserve all held
  // symbols and drop non-held priorities rather than starving a position's valuation.
  const effectiveLimit = Math.max(requestedLimit, held.length);
  const symbols = [...held, ...otherPriority.slice(0, Math.max(0, effectiveLimit - held.length))];

  return {
    symbols,
    heldSymbols: held,
    heldSymbolsOutsideActiveUniverse,
    heldCount: held.length,
    heldSymbolsOutsideActiveUniverseCount: heldSymbolsOutsideActiveUniverse.length,
    priorityCount: symbols.length,
    limitExceededByHoldings: held.length > requestedLimit,
  };
}
