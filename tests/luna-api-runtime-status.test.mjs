import test from "node:test";
import assert from "node:assert/strict";
import { describeSourceFailure, resolveRuntimeStatus, resolveServiceKey } from "../supabase/functions/luna-api/runtime-status.mjs";

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


test("canonical Supabase service-role JWT takes precedence over configured default API key", () => {
  assert.equal(resolveServiceKey("service-role-jwt", "sb_secret_configured_default"), "service-role-jwt");
});

test("configured default key is a fallback only when the service-role key is absent", () => {
  assert.equal(resolveServiceKey("", "fallback-key"), "fallback-key");
  assert.equal(resolveServiceKey(null, "fallback-key"), "fallback-key");
});

test("source failure diagnostics expose safe code/status, not raw error messages", () => {
  assert.deepEqual(
    describeSourceFailure({
      status: "fulfilled",
      value: { error: { code: "PGRST301", status: 401, message: "sensitive internal detail" } }
    }),
    { failure_code: "PGRST301", http_status: 401 }
  );
});

test("fetch-body timeout is classified without exposing the raw error message", () => {
  assert.deepEqual(
    describeSourceFailure({ status: "rejected", reason: new Error("FETCH_BODY_TIMEOUT") }),
    { failure_code: "FETCH_BODY_TIMEOUT", http_status: null }
  );
});

test("missing statuses fail closed to UNKNOWN", () => {
  assert.equal(resolveRuntimeStatus({}), "UNKNOWN");
});
