import test from "node:test";
import assert from "node:assert/strict";
import { resolveRuntimeStatus } from "../supabase/functions/luna-api/runtime-status.mjs";

test("readiness BLOCKED overrides a fresh RUNNING heartbeat", () => {
  assert.equal(resolveRuntimeStatus({
    paper_live: { status: "RUNNING", runtime_fresh: true },
    system_readiness: {
      status: "BLOCKED",
      blockers: ["NO_OPEN_SESSION_FOR_TRADE_DATE", "NO_VERIFIED_EXECUTION_GRADE_MARKET_FEED"]
    }
  }), "BLOCKED");
});

test("ready paper-only system reports readiness rather than runtime heartbeat", () => {
  assert.equal(resolveRuntimeStatus({
    paper_live: { status: "RUNNING", runtime_fresh: true },
    system_readiness: { status: "READY_FOR_PAPER_ONLY" }
  }), "READY_FOR_PAPER_ONLY");
});

test("stale runtime heartbeat remains visible when readiness is not decisive", () => {
  assert.equal(resolveRuntimeStatus({
    paper_live: { status: "STALE_HEARTBEAT" },
    system_readiness: { status: "UNKNOWN" }
  }), "STALE_HEARTBEAT");
});

test("missing statuses fail closed to UNKNOWN", () => {
  assert.equal(resolveRuntimeStatus({}), "UNKNOWN");
});
