from broker_timing import extract_broker_native_submitted_at_ms

assert extract_broker_native_submitted_at_ms({"data":{"submitted_at_ms":1760000000123}})==1760000000123
assert _extract_broker_native_submitted_at_ms({"data":{"created_at":"2026-09-22T13:00:00Z"}})==1790082000000
assert _extract_broker_native_submitted_at_ms({"data":{"foo":"bar"}}) is None
print("gateway broker timestamp test: PASS")
