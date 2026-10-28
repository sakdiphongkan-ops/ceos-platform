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
