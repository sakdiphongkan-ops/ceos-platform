import os
import time

os.environ["LIVE_TRADING_ARMED"] = "true"
os.environ["LUNA_GATEWAY_KEY"] = "test"
os.environ["LUNA_GATEWAY_ORDER_GATE_ENABLED"] = "true"
os.environ["LUNA_GATEWAY_KILL_SWITCH"] = "false"
os.environ["LUNA_GATEWAY_MAX_ORDER_NOTIONAL"] = "50000"
os.environ["LUNA_GATEWAY_MAX_ORDERS_PER_MINUTE"] = "10"
os.environ["LUNA_GATEWAY_MAX_QUOTE_AGE_SEC"] = "2"
os.environ["LUNA_GATEWAY_MAX_PRICE_DEVIATION_BPS"] = "75"

import app

class Payload:
    def __init__(self, client_order_id="test-order-1", symbol="AAA", side="BUY", price=100.1, volume=100):
        self.client_order_id = client_order_id
        self.symbol = symbol
        self.side = side
        self.price = price
        self.volume = volume

app.market_phase_now = lambda: "ACTIVE"
with app._quote_lock:
    app._quotes["AAA"] = {
        "symbol": "AAA",
        "bid": 99.9,
        "ask": 100.1,
        "bid_size": 1000,
        "ask_size": 1000,
        "_ingested_ts": time.time(),
    }

app._hard_order_gate(Payload())

try:
    app._hard_order_gate(Payload(volume=600))
    raise AssertionError("max notional guard did not block")
except Exception as exc:
    assert getattr(exc, "status_code", None) == 422

try:
    app._hard_order_gate(Payload(price=105.0, client_order_id="price-bad"))
    raise AssertionError("price deviation guard did not block")
except Exception as exc:
    assert getattr(exc, "status_code", None) == 423

app._record_broker_failure("a")
app._record_broker_failure("b")
app._record_broker_failure("c")
assert app._safety_snapshot()["broker_circuit_tripped"] is True

try:
    app._hard_order_gate(Payload(client_order_id="circuit-blocked"))
    raise AssertionError("circuit breaker did not block")
except Exception as exc:
    assert getattr(exc, "status_code", None) == 503

print("gateway safety guard tests: PASS")
