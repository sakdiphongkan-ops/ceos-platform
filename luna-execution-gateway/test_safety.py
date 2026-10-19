import os
import time

os.environ["LIVE_TRADING_ARMED"] = "true"
os.environ["LUNA_PAPER_ONLY_MODE"] = "false"  # explicitly test the live-gate internals in isolation
os.environ["LUNA_GATEWAY_KEY"] = "test"
os.environ["LUNA_GATEWAY_ORDER_GATE_ENABLED"] = "true"
os.environ["LUNA_GATEWAY_KILL_SWITCH"] = "false"
os.environ["LUNA_GATEWAY_MAX_ORDER_NOTIONAL"] = "50000"
os.environ["LUNA_GATEWAY_MAX_ORDERS_PER_MINUTE"] = "10"
os.environ["LUNA_GATEWAY_MAX_QUOTE_AGE_SEC"] = "2"
os.environ["LUNA_GATEWAY_MAX_PRICE_DEVIATION_BPS"] = "75"

import app

# Unit-test the downstream order guards in isolation; connectivity proof is covered separately.
app._connectivity_proof = lambda: {
    "live_execution_ready": True,
}
app._selected_provider = "SETTRADE"

def assert_invalid_place_order(**overrides):
    payload = {
        "client_order_id": "validation-test-1",
        "session_id": "validation-session-1",
        "strategy_version": "validation-test",
        "symbol": "AAA",
        "side": "BUY",
        "price": 100.1,
        "volume": 1,
    }
    payload.update(overrides)
    try:
        app.PlaceOrder(**payload)
    except Exception:
        return
    raise AssertionError("invalid place-order payload was accepted")

assert_invalid_place_order(price=True)
assert_invalid_place_order(price="100")
assert_invalid_place_order(price=float("nan"))
assert_invalid_place_order(price=float("inf"))
assert_invalid_place_order(volume=True)
assert_invalid_place_order(volume=1.5)
# Integer-valued share prices are valid and must not be rejected.
integer_price = app.PlaceOrder(
    client_order_id="integer-price-test",
    session_id="validation-session-1",
    strategy_version="validation-test",
    symbol="AAA",
    side="BUY",
    price=100,
    volume=1,
)
assert integer_price.price == 100.0

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
        "source": "settrade-open-api-realtime",
        "source_ts": None,
        "book_received_ts": app._now_iso(),
        "book_source_ts": None,
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

# Cancels are prohibited under paper-only, unarmed, kill-switch, and disabled-gate states.
previous = (
    app.PAPER_ONLY_MODE, app.LIVE_ARMED, app.GATEWAY_KILL_SWITCH,
    app.GATEWAY_ORDER_GATE_ENABLED
)
try:
    for paper_only, armed, kill, gate, expected_code in [
        (True, False, False, True, "live_trading_not_armed"),
        (False, False, False, True, "live_trading_not_armed"),
        (False, True, True, True, "gateway_kill_switch_active"),
        (False, True, False, False, "hard_order_gate_disabled"),
    ]:
        app.PAPER_ONLY_MODE = paper_only
        app.LIVE_ARMED = armed
        app.GATEWAY_KILL_SWITCH = kill
        app.GATEWAY_ORDER_GATE_ENABLED = gate
        try:
            app._hard_cancel_gate()
        except Exception as exc:
            assert getattr(exc, "status_code", None) == 423
            assert exc.detail["code"] == expected_code
        else:
            raise AssertionError("cancel gate failed to block an unsafe state")
finally:
    (app.PAPER_ONLY_MODE, app.LIVE_ARMED, app.GATEWAY_KILL_SWITCH,
     app.GATEWAY_ORDER_GATE_ENABLED) = previous

print("gateway safety guard tests: PASS")
