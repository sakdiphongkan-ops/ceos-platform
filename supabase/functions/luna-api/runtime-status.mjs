export function resolveRuntimeStatus(body) {
  const readiness = String(body?.system_readiness?.status ?? "").toUpperCase();
  const runtime = String(body?.paper_live?.status ?? "").toUpperCase();

  // Readiness is the safety authority. A fresh heartbeat must not make a blocked
  // paper runtime look ready when there is no open session or verified market feed.
  if (readiness === "BLOCKED") return "BLOCKED";
  if (readiness === "READY_FOR_PAPER_ONLY") return "READY_FOR_PAPER_ONLY";
  if (runtime) return runtime;
  if (readiness) return readiness;
  return "UNKNOWN";
}
