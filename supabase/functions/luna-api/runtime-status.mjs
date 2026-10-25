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

// Prefer the standard Supabase service-role JWT when the Edge Function runtime
// provides it. A configured API secret may be a newer sb_secret_* API key, which
// is not interchangeable with the JWT used as Authorization: Bearer by supabase-js.
export function resolveServiceKey(serviceRoleKey, configuredDefaultKey) {
  const serviceRole = String(serviceRoleKey ?? "").trim();
  if (serviceRole) return serviceRole;
  return String(configuredDefaultKey ?? "").trim();
}

// Surface only sanitized, non-secret error metadata for public-safe feed diagnostics.
// Never return database error messages, hints, connection strings or credentials.
export function describeSourceFailure(result) {
  const failure = result?.status === "rejected"
    ? result.reason
    : result?.value?.error;
  if (!failure) return {};

  const rawMessage = String(failure?.message ?? "");
  let failureCode = String(failure?.code ?? "").trim();
  if (!failureCode && /FETCH_BODY_TIMEOUT/i.test(rawMessage)) failureCode = "FETCH_BODY_TIMEOUT";
  if (!failureCode && /AbortError|TimeoutError/i.test(String(failure?.name ?? ""))) failureCode = "REQUEST_TIMEOUT";
  if (!failureCode) failureCode = String(failure?.name ?? "UNKNOWN").slice(0, 48);

  const status = Number(failure?.status ?? failure?.statusCode);
  return {
    failure_code: failureCode.slice(0, 64),
    http_status: Number.isFinite(status) && status > 0 ? status : null
  };
}

// Ensure PostgREST recognizes a hard client timeout as an abort, not a retryable network failure.
export function createFetchTimeoutAbortReason() {
  return new DOMException("FETCH_BODY_TIMEOUT", "AbortError");
}
