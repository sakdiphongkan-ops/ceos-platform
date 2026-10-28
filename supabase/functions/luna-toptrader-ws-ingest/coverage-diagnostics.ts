export type SubscriptionMode = "both" | "query" | "message";

export function normalizeSubscriptionMode(value: unknown): SubscriptionMode {
  const mode = String(value ?? "").trim().toLowerCase();
  return mode === "query" || mode === "message" ? mode : "both";
}

export type WsChunkMetrics = {
  tickFrames: number;
  bookFrames: number;
  otherTypeFrames: number;
  framesWithoutSymbol: number;
  framesOutsideRequestedSymbols: number;
  missingOrInvalidTimestampFrames: number;
  futureTimestampFrames: number;
  invalidTickFrames: number;
  invalidBookFrames: number;
  validTickFrames: number;
  validBookFrames: number;
  olderTickFramesIgnored: number;
  olderBookFramesIgnored: number;
  parseErrors: number;
};

export function emptyWsChunkMetrics(): WsChunkMetrics {
  return {
    tickFrames: 0,
    bookFrames: 0,
    otherTypeFrames: 0,
    framesWithoutSymbol: 0,
    framesOutsideRequestedSymbols: 0,
    missingOrInvalidTimestampFrames: 0,
    futureTimestampFrames: 0,
    invalidTickFrames: 0,
    invalidBookFrames: 0,
    validTickFrames: 0,
    validBookFrames: 0,
    olderTickFramesIgnored: 0,
    olderBookFramesIgnored: 0,
    parseErrors: 0,
  };
}

export function summarizeWsChunk(input: {
  chunkIndex: number;
  requestedSymbols: string[];
  subscriptionMode: SubscriptionMode;
  opened: boolean;
  explicitSubscribeSent: boolean;
  frameMessages: number;
  tickSymbols: number;
  bookSymbols: number;
  metrics: WsChunkMetrics;
  errors: string[];
}) {
  // Keep summaries compact enough for the bounded HTTP diagnostic history.
  return {
    i: input.chunkIndex,
    n: input.requestedSymbols.length,
    symbols: [
      input.requestedSymbols[0] ?? null,
      input.requestedSymbols[input.requestedSymbols.length - 1] ?? null,
    ],
    opened: input.opened,
    query: input.subscriptionMode !== "message",
    subscribe: input.explicitSubscribeSent,
    frames: input.frameMessages,
    ticks: input.tickSymbols,
    books: input.bookSymbols,
    m: {
      tick: input.metrics.tickFrames,
      book: input.metrics.bookFrames,
      other: input.metrics.otherTypeFrames,
      no_symbol: input.metrics.framesWithoutSymbol,
      outside: input.metrics.framesOutsideRequestedSymbols,
      bad_ts: input.metrics.missingOrInvalidTimestampFrames,
      future: input.metrics.futureTimestampFrames,
      invalid_tick: input.metrics.invalidTickFrames,
      invalid_book: input.metrics.invalidBookFrames,
      valid_tick: input.metrics.validTickFrames,
      valid_book: input.metrics.validBookFrames,
      older_tick: input.metrics.olderTickFramesIgnored,
      older_book: input.metrics.olderBookFramesIgnored,
      parse_errors: input.metrics.parseErrors,
    },
    errors: input.errors.slice(0, 2),
  };
}


export type PairMismatchReason =
  | "MISSING_BOOK_BID"
  | "MISSING_BOOK_ASK"
  | "BEST_BID_PRICE_MISMATCH"
  | "BEST_ASK_PRICE_MISMATCH"
  | "NONPOSITIVE_BOOK_DEPTH";

export type PairMismatchClassification = {
  reasons: PairMismatchReason[];
  bidDiffAbs: number | null;
  askDiffAbs: number | null;
};

/**
 * Classifies tick-to-best-book rejection without including actual quote prices.
 * This function is diagnostic only and never determines whether a quote is accepted.
 */
export function classifyTickBookMismatch(input: {
  tickBid: number;
  tickAsk: number;
  bookBid: number | null;
  bookAsk: number | null;
  bidSize: number | null;
  askSize: number | null;
  tolerance?: number;
}): PairMismatchClassification | null {
  const tolerance = input.tolerance ?? 0.000001;
  const reasons: PairMismatchReason[] = [];
  const bidDiffAbs = input.bookBid == null ? null : Math.abs(input.tickBid - input.bookBid);
  const askDiffAbs = input.bookAsk == null ? null : Math.abs(input.tickAsk - input.bookAsk);

  if (input.bookBid == null) reasons.push("MISSING_BOOK_BID");
  else if (bidDiffAbs !== null && bidDiffAbs > tolerance) reasons.push("BEST_BID_PRICE_MISMATCH");

  if (input.bookAsk == null) reasons.push("MISSING_BOOK_ASK");
  else if (askDiffAbs !== null && askDiffAbs > tolerance) reasons.push("BEST_ASK_PRICE_MISMATCH");

  if (input.bidSize == null || input.askSize == null || input.bidSize <= 0 || input.askSize <= 0) {
    reasons.push("NONPOSITIVE_BOOK_DEPTH");
  }

  return reasons.length
    ? { reasons, bidDiffAbs, askDiffAbs }
    : null;
}
