// A quote timestamp is the provider's observation time, not its API response time.
export function isFreshTickObservationAgeMs(
  ageMs,
  maxAgeMs = 50_000,
  maxFutureSkewMs = 30_000,
) {
  return Number.isFinite(ageMs)
    && ageMs <= maxAgeMs
    && ageMs >= -maxFutureSkewMs;
}
