"""Regression tests for gateway bid/ask freshness tracking; no network or order side effects."""
import app as gateway_app
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch


def test_gateway_env_parsers_fail_closed():
    assert gateway_app._num(True) is None
    assert gateway_app._num(False) is None
    assert gateway_app._num({"price": 31.8}) is None
    assert gateway_app._num([31.8]) is None
    assert gateway_app._num("NaN") is None
    assert gateway_app._num("Infinity") is None
    assert gateway_app._num("31.8") == 31.8
    assert gateway_app._env_bool("not-a-bool", True) is True
    assert gateway_app._env_bool("not-a-bool", False) is False
    assert gateway_app._env_bool("false", True) is False
    assert gateway_app._env_bool("TRUE", False) is True
    assert gateway_app._bounded_float("NaN", 2.0, 0.1, 60.0) == 2.0
    assert gateway_app._bounded_float("Infinity", 2.0, 0.1, 60.0) == 2.0
    assert gateway_app._bounded_float("oops", 2.0, 0.1, 60.0) == 2.0
    assert gateway_app._bounded_float("-1", 2.0, 0.1, 60.0) == 2.0
    assert gateway_app._bounded_int("2.5", 3, 1, 10) == 3
    assert gateway_app._bounded_int("NaN", 3, 1, 10) == 3
    assert gateway_app._bounded_int("oops", 3, 1, 10) == 3


def test_zero_coverage_cannot_make_empty_feed_ready():
    symbol = "LUNA_EMPTY_COVERAGE_TEST"
    old_symbols = gateway_app.SYMBOLS
    old_provider = gateway_app._selected_provider
    old_min_coverage = gateway_app.LUNA_LIVE_MIN_REALTIME_COVERAGE
    old_quotes = dict(gateway_app._quotes)
    try:
        gateway_app.SYMBOLS = [symbol]
        gateway_app._selected_provider = "SETTRADE"
        gateway_app.LUNA_LIVE_MIN_REALTIME_COVERAGE = 0.0
        with gateway_app._quote_lock:
            gateway_app._quotes.clear()
        proof = gateway_app._connectivity_proof()
        assert proof["coverage"]["fresh_quote_count"] == 0
        assert proof["coverage"]["verified_book_count"] == 0
        assert proof["checks"]["fresh_coverage_sufficient"] is True
        assert proof["checks"]["fresh_quotes_present"] is False
        assert proof["checks"]["verified_book_present"] is False
        assert proof["live_execution_ready"] is False
        assert gateway_app._system_status() == "LOCKED"
    finally:
        with gateway_app._quote_lock:
            gateway_app._quotes.clear()
            gateway_app._quotes.update(old_quotes)
        gateway_app.SYMBOLS = old_symbols
        gateway_app._selected_provider = old_provider
        gateway_app.LUNA_LIVE_MIN_REALTIME_COVERAGE = old_min_coverage


def test_price_only_event_does_not_refresh_order_book_age():
    symbol = "LUNA_BOOK_FRESHNESS_TEST"
    gateway_app._quotes.pop(symbol, None)
    try:
        gateway_app._quote_payload(
            symbol=symbol, bid=31.75, ask=31.80, bid_size=100, ask_size=200,
            source="settrade-open-api-realtime", source_ts=None,
            book_snapshot=True,
        )
        first = dict(gateway_app._quotes[symbol])
        assert first["book_received_ts"] is not None
        # Source time must not be fabricated from local receive time.
        assert first["book_source_ts"] is None

        gateway_app._quote_payload(
            symbol=symbol, last=31.80,
            source="settrade-open-api-realtime", source_ts=None,
        )
        second = dict(gateway_app._quotes[symbol])
        assert second["book_received_ts"] == first["book_received_ts"]
        assert second["book_source_ts"] is None
        assert second["bid"] == 31.75 and second["ask"] == 31.80

        gateway_app._quote_payload(
            symbol=symbol, bid=31.76, ask=None, bid_size=100, ask_size=None,
            source="settrade-open-api-realtime", source_ts=None,
            book_snapshot=True,
        )
        partial = dict(gateway_app._quotes[symbol])
        assert partial["bid"] is None and partial["ask"] is None
        assert partial["bid_size"] is None and partial["ask_size"] is None
        assert partial["book_received_ts"] is None
        assert partial["book_source_ts"] is None

        # Boolean prices are malformed provider data, not the numeric value 1.
        gateway_app._quote_payload(
            symbol=symbol, bid=True, ask=31.80, bid_size=100, ask_size=200,
            source="settrade-open-api-realtime", source_ts=None,
            book_snapshot=True,
        )
        invalid = dict(gateway_app._quotes[symbol])
        assert invalid["bid"] is None and invalid["ask"] is None
        assert invalid["bid_size"] is None and invalid["ask_size"] is None
        assert invalid["book_received_ts"] is None
        assert invalid["book_source_ts"] is None
    finally:
        gateway_app._quotes.pop(symbol, None)


def test_hard_order_gate_rejects_reingested_but_stale_source_quote():
    symbol = "LUNA_STALE_ORDER_GATE_TEST"
    old_quote = gateway_app._quotes.get(symbol)
    now = datetime.now(timezone.utc)
    stale_source = (now - timedelta(seconds=120)).isoformat()
    fresh_receive = now.isoformat()
    quote = {
        "symbol": symbol,
        "source": "set-market-data-api-realtime",
        "_ingested_ts": now.timestamp(),
        "source_ts": stale_source,
        "book_received_ts": fresh_receive,
        "book_source_ts": fresh_receive,
        "bid": 31.75, "ask": 31.80, "bid_size": 100, "ask_size": 100,
    }
    with gateway_app._quote_lock:
        gateway_app._quotes[symbol] = quote
    payload = SimpleNamespace(
        client_order_id="stale-source-test-01",
        symbol=symbol, side="BUY", price=31.80, volume=1
    )
    try:
        with patch.object(gateway_app, "GATEWAY_ORDER_GATE_ENABLED", True), \
             patch.object(gateway_app, "GATEWAY_KILL_SWITCH", False), \
             patch.object(gateway_app, "LIVE_ARMED", True), \
             patch.object(gateway_app, "_selected_provider", "SET_API"), \
             patch.object(gateway_app, "_connectivity_proof", return_value={"live_execution_ready": True}), \
             patch.object(gateway_app, "market_phase_now", return_value="ACTIVE"):
            try:
                gateway_app._hard_order_gate(payload)
            except gateway_app.HTTPException as exc:
                assert exc.status_code == 503
                assert exc.detail["code"] == "quote_source_stale_or_unverified"
            else:
                raise AssertionError("stale source timestamp must block order validation")
    finally:
        with gateway_app._quote_lock:
            if old_quote is None:
                gateway_app._quotes.pop(symbol, None)
            else:
                gateway_app._quotes[symbol] = old_quote


def test_stale_provider_timestamp_cannot_count_as_fresh_quote():
    symbol = "LUNA_SOURCE_FRESHNESS_TEST"
    old_symbols = gateway_app.SYMBOLS
    old_provider = gateway_app._selected_provider
    old_quotes = dict(gateway_app._quotes)
    try:
        gateway_app.SYMBOLS = [symbol]
        gateway_app._selected_provider = "SET_API"
        with gateway_app._quote_lock:
            gateway_app._quotes.clear()

        stale_source_ts = (
            datetime.now(timezone.utc) - timedelta(seconds=120)
        ).isoformat()
        gateway_app._quote_payload(
            symbol=symbol,
            last=31.80,
            source="set-market-data-api-realtime",
            source_ts=stale_source_ts,
        )
        stale = gateway_app._quote_coverage_snapshot()
        assert stale["fresh_quote_count"] == 0

        fresh_source_ts = datetime.now(timezone.utc).isoformat()
        gateway_app._quote_payload(
            symbol=symbol,
            last=31.81,
            source="set-market-data-api-realtime",
            source_ts=fresh_source_ts,
        )
        fresh = gateway_app._quote_coverage_snapshot()
        assert fresh["fresh_quote_count"] == 1

        gateway_app._quote_payload(
            symbol=symbol,
            last=31.82,
            source="set-market-data-api-realtime-spoof",
            source_ts=datetime.now(timezone.utc).isoformat(),
        )
        spoof = gateway_app._quote_coverage_snapshot()
        assert spoof["fresh_quote_count"] == 0
    finally:
        with gateway_app._quote_lock:
            gateway_app._quotes.clear()
            gateway_app._quotes.update(old_quotes)
        gateway_app.SYMBOLS = old_symbols
        gateway_app._selected_provider = old_provider


if __name__ == "__main__":
    test_price_only_event_does_not_refresh_order_book_age()
    test_stale_provider_timestamp_cannot_count_as_fresh_quote()
    print("gateway book freshness regression: PASS")
