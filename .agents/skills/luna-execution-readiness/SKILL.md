---
name: luna-execution-readiness
description: Review LUNA's market evidence and explain blocked/ready states without weakening any execution or risk gate.
---

# LUNA execution readiness

## Review sequence
1. Confirm the intended market, active universe, trading session and as-of time.
2. Separate source-event time from ingestion time; an ingestion heartbeat does not prove fresh source data.
3. Count only unique observations that satisfy the relevant provider contract and data-quality checks.
4. Verify two-sided book levels, positive sizes, tick/book timestamp alignment and best-price parity where the adapter exposes both records.
5. Report numerator, denominator, coverage percentage, timestamp of the measurement, failure reasons and remaining blockers.

## Required language
- State partial coverage explicitly when the universe is not fully covered or does not meet its configured threshold.
- A coverage threshold passing is not equivalent to readiness or permission to place orders.
- Keep candidates, emitted signals, orders and fills as different states.
- A display fallback quote is not execution-grade evidence.
- If evidence is missing, return `INSUFFICIENT_EVIDENCE`; never infer that a feed is healthy from a successful HTTP status alone.

## Hard constraints
- Keep LUNA paper/research-only unless the owner explicitly authorizes a separately reviewed change to the broker and execution configuration.
- Do not arm live execution, create live orders, disable a kill switch, or modify order routing during data-quality or research work.
- Never use stale data, response-generation timestamps or synthetic fixtures to increase reported coverage.
- Keep existing provider-specific freshness thresholds and execution gates authoritative; this skill does not replace them.
