import { assertEquals, assert } from "jsr:@std/assert@1";
import {
  emptyWsChunkMetrics,
  normalizeSubscriptionMode,
  summarizeWsChunk,
  classifyTickBookMismatch,
} from "./coverage-diagnostics.ts";

Deno.test("subscription mode defaults to the current dual-subscription behavior", () => {
  assertEquals(normalizeSubscriptionMode(undefined), "both");
  assertEquals(normalizeSubscriptionMode("unsupported"), "both");
  assertEquals(normalizeSubscriptionMode("BOTH"), "both");
});

Deno.test("query and message subscription can be isolated in diagnostic-only mode", () => {
  assertEquals(normalizeSubscriptionMode("query"), "query");
  assertEquals(normalizeSubscriptionMode("message"), "message");
});

Deno.test("chunk summary exposes event rejection counts without quote payloads", () => {
  const metrics = emptyWsChunkMetrics();
  metrics.tickFrames = 12;
  metrics.bookFrames = 8;
  metrics.validTickFrames = 10;
  metrics.validBookFrames = 7;
  metrics.framesWithoutSymbol = 1;

  const summary = summarizeWsChunk({
    chunkIndex: 2,
    requestedSymbols: ["PTT", "KBANK", "AOT"],
    subscriptionMode: "both",
    opened: true,
    explicitSubscribeSent: true,
    frameMessages: 21,
    tickSymbols: 3,
    bookSymbols: 2,
    metrics,
    errors: ["NON_JSON_FRAME", "SECOND_ERROR", "THIRD_ERROR"],
  });

  assertEquals(summary.i, 2);
  assertEquals(summary.n, 3);
  assertEquals(summary.query, true);
  assertEquals(summary.subscribe, true);
  assertEquals(summary.m.valid_tick, 10);
  assertEquals(summary.errors, ["NON_JSON_FRAME", "SECOND_ERROR"]);
  assert(!("bid" in summary) && !("ask" in summary) && !("raw" in summary));
});

Deno.test("message-only mode is reported as not using a query-string subscription", () => {
  const summary = summarizeWsChunk({
    chunkIndex: 1,
    requestedSymbols: ["PTT"],
    subscriptionMode: "message",
    opened: true,
    explicitSubscribeSent: true,
    frameMessages: 1,
    tickSymbols: 0,
    bookSymbols: 0,
    metrics: emptyWsChunkMetrics(),
    errors: [],
  });
  assertEquals(summary.query, false);
  assertEquals(summary.subscribe, true);
});


Deno.test("matching tick and book with positive depth has no mismatch", () => {
  assertEquals(classifyTickBookMismatch({
    tickBid: 10,
    tickAsk: 10.1,
    bookBid: 10,
    bookAsk: 10.1,
    bidSize: 100,
    askSize: 120,
  }), null);
});

Deno.test("best bid and ask mismatches are classified without exposing prices", () => {
  const result = classifyTickBookMismatch({
    tickBid: 10,
    tickAsk: 10.1,
    bookBid: 9.99,
    bookAsk: 10.11,
    bidSize: 100,
    askSize: 120,
  });
  assert(result !== null);
  assertEquals(result.reasons, ["BEST_BID_PRICE_MISMATCH", "BEST_ASK_PRICE_MISMATCH"]);
  assert(Math.abs((result.bidDiffAbs ?? 0) - 0.01) < 1e-12);
  assert(Math.abs((result.askDiffAbs ?? 0) - 0.01) < 1e-12);
});

Deno.test("missing book sides and nonpositive depth are classified", () => {
  const result = classifyTickBookMismatch({
    tickBid: 10,
    tickAsk: 10.1,
    bookBid: null,
    bookAsk: 10.1,
    bidSize: null,
    askSize: 120,
  });
  assert(result !== null);
  assertEquals(result.reasons, ["MISSING_BOOK_BID", "NONPOSITIVE_BOOK_DEPTH"]);
  assertEquals(result.bidDiffAbs, null);
  assertEquals(result.askDiffAbs, 0);
});
