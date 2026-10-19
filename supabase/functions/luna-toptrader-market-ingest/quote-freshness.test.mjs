import assert from "node:assert/strict";
import test from "node:test";
import { isFreshTickObservationAgeMs } from "./quote-freshness.mjs";

test("accepts a current tick observation", () => {
  assert.equal(isFreshTickObservationAgeMs(0), true);
});
test("accepts the configured maximum age boundary", () => {
  assert.equal(isFreshTickObservationAgeMs(50_000), true);
});
test("rejects observations older than the configured maximum", () => {
  assert.equal(isFreshTickObservationAgeMs(50_001), false);
});
test("allows small provider clock skew into the future", () => {
  assert.equal(isFreshTickObservationAgeMs(-30_000), true);
});
test("rejects observations beyond the allowed future skew", () => {
  assert.equal(isFreshTickObservationAgeMs(-30_001), false);
});
test("rejects non-finite age values", () => {
  assert.equal(isFreshTickObservationAgeMs(Number.NaN), false);
  assert.equal(isFreshTickObservationAgeMs(Number.POSITIVE_INFINITY), false);
});
