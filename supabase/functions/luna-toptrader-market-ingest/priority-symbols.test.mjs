import assert from "node:assert/strict";
import test from "node:test";
import { buildPrioritySymbols } from "./priority-symbols.mjs";

test("all held active positions are prioritized ahead of queued and candidate symbols", () => {
  const result = buildPrioritySymbols({
    activeSymbols: ["PTT", "CPALL", "AOT", "DELTA"],
    heldSymbols: ["CPALL", "PTT", "CPALL"],
    queuedSymbols: ["AOT", "PTT"],
    signalSymbols: ["DELTA", "AOT"],
    limit: 3,
  });

  assert.deepEqual(result.symbols, ["CPALL", "PTT", "AOT"]);
  assert.deepEqual(result.heldSymbols, ["CPALL", "PTT"]);
  assert.equal(result.heldCount, 2);
  assert.equal(result.limitExceededByHoldings, false);
});

test("all held positions survive when held count exceeds the normal priority limit", () => {
  const held = Array.from({ length: 35 }, (_, i) => `SYM${i}`);
  const result = buildPrioritySymbols({
    activeSymbols: held,
    heldSymbols: held,
    queuedSymbols: ["SYM0"],
    signalSymbols: ["SYM34"],
    limit: 30,
  });

  assert.deepEqual(result.symbols, held);
  assert.equal(result.heldCount, 35);
  assert.equal(result.priorityCount, 35);
  assert.equal(result.limitExceededByHoldings, true);
});

test("inactive or missing-universe held symbols are surfaced rather than silently scheduled", () => {
  const result = buildPrioritySymbols({
    activeSymbols: ["PTT", "CPALL"],
    heldSymbols: ["PTT", "DELISTED"],
    queuedSymbols: ["AOT"],
    signalSymbols: ["CPALL"],
    limit: 30,
  });

  assert.deepEqual(result.symbols, ["PTT", "CPALL"]);
  assert.deepEqual(result.heldSymbolsOutsideActiveUniverse, ["DELISTED"]);
  assert.equal(result.heldSymbolsOutsideActiveUniverseCount, 1);
});
